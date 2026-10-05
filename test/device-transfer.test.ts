// Device-to-device transfer: X25519 + HKDF + AES-GCM with a short
// authentication string; tampering, replay, expiry and wrong sessions fail.
// Also the boundary: no response the signer gives the page carries a secret.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { newOffer, seal, open, encodeOffer, decodeOffer, encodeEnvelope, decodeEnvelope, OFFER_TTL_SECONDS } from "../src/lib/wallet/pairing.ts";
import { createSigner, type VaultStorage } from "../src/lib/wallet/signer.ts";
import { walletClient } from "../src/lib/wallet/client.ts";
import { compactSeedQR, standardSeedQR } from "../src/lib/qr/seedqr.ts";
import type { Vault } from "../src/lib/crypto/keystore.ts";
import type { Request, Response } from "../src/lib/wallet/types.ts";

const MNEMONIC = "forum undo fragile fade shy sign arrest garment culture tube off merit";
const PRIV = "c3".repeat(32);
const COOKIE = "__cookie__:f00dfacecafe";

function memory(): VaultStorage {
  let vault: Vault | null = null;
  return { load: async () => vault, save: async (v) => { vault = v; }, remove: async () => { vault = null; } };
}

test("both sides derive the same key and code; the payload round-trips", async () => {
  const { offer, secret } = newOffer(1000);
  const scanned = decodeOffer(encodeOffer(offer));
  const payload = new TextEncoder().encode("an encrypted backup");
  const { envelope, sas } = await seal(scanned, payload, 1000);
  assert.match(sas, /^\d{6}$/);
  const got = await open(offer, secret, decodeEnvelope(encodeEnvelope(envelope)), 1001);
  assert.deepEqual(got.payload, payload);
  assert.equal(got.sas, sas);
});

test("every byte is bound: tampering with any field fails, and a MITM key changes the code", async () => {
  const { offer, secret } = newOffer(1000);
  const { envelope, sas } = await seal(offer, new Uint8Array(64).fill(7), 1000);
  const flip = (u: Uint8Array, i = 0) => { const c = u.slice(); c[i]! ^= 1; return c; };
  await assert.rejects(open(offer, secret, { ...envelope, ct: flip(envelope.ct) }, 1000), /did not decrypt/);
  await assert.rejects(open(offer, secret, { ...envelope, ct: flip(envelope.ct, envelope.ct.length - 1) }, 1000), /did not decrypt/, "tag");
  await assert.rejects(open(offer, secret, { ...envelope, iv: flip(envelope.iv) }, 1000), /did not decrypt/);
  await assert.rejects(open(offer, secret, { ...envelope, publicKey: flip(envelope.publicKey) }, 1000), /did not decrypt|Invalid/);
  await assert.rejects(open(offer, secret, { ...envelope, sid: flip(envelope.sid) }, 1000), /different session/);
  // A receiver key the attacker substituted: the sender's code differs from the real receiver's.
  const mitm = newOffer(1000);
  const toAttacker = await seal({ ...offer, publicKey: mitm.offer.publicKey }, new Uint8Array([1]), 1000);
  const attackerReseal = await seal(offer, new Uint8Array([1]), 1000);
  const real = await open(offer, secret, attackerReseal.envelope, 1000);
  assert.notEqual(toAttacker.sas, sas);
  assert.equal(real.sas, attackerReseal.sas);
  // A low-order (all-zero shared secret) key is refused.
  await assert.rejects(seal({ ...offer, publicKey: new Uint8Array(32) }, new Uint8Array([1]), 1000), /Invalid|invalid|zero/);
});

test("offers expire", async () => {
  const { offer, secret } = newOffer(1000);
  await assert.rejects(seal(offer, new Uint8Array([1]), 1000 + OFFER_TTL_SECONDS + 1), /expired/);
  const { envelope } = await seal(offer, new Uint8Array([1]), 1000);
  await assert.rejects(open(offer, secret, envelope, 1000 + OFFER_TTL_SECONDS + 1), /expired/);
  assert.throws(() => decodeOffer(hexToBytes("a0")), /Not a pairing code/);
  assert.throws(() => decodeEnvelope(encodeOffer(offer)), /Not a transfer/);
});

test("signer to signer: send, open once, import with the sender's password", async () => {
  const sender = walletClient(createSigner(memory()).handle);
  await sender.create("sender-pw", { mnemonic: MNEMONIC });
  await sender.importKey(PRIV);
  await sender.setNodeCookie("http://127.0.0.1:8080", COOKIE);
  const receiver = walletClient(createSigner(memory()).handle);

  const offer = await receiver.transferOffer();
  assert.ok(offer.ok);
  assert.deepEqual(await sender.transferSend(offer.offer, "wrong"), { ok: false, error: "Wrong password" });
  const sent = await sender.transferSend(offer.offer, "sender-pw");
  assert.ok(sent.ok);

  // Tampered in transit: refused, and the session is spent.
  const env = hexToBytes(sent.envelope); env[env.length - 1]! ^= 1;
  const bad = await receiver.transferOpen(bytesToHex(env));
  assert.equal(bad.ok, false);
  assert.deepEqual(await receiver.transferOpen(sent.envelope), { ok: false, error: "No transfer session; start a new one" }, "single use");

  const offer2 = await receiver.transferOffer();
  assert.ok(offer2.ok);
  const sent2 = await sender.transferSend(offer2.offer, "sender-pw");
  assert.ok(sent2.ok);
  assert.equal((await receiver.transferOpen(sent.envelope)).ok, false, "an old session's transfer does not open a new one");
  const offer3 = await receiver.transferOffer();
  assert.ok(offer3.ok);
  const sent3 = await sender.transferSend(offer3.offer, "sender-pw");
  assert.ok(sent3.ok);
  const opened = await receiver.transferOpen(sent3.envelope);
  assert.ok(opened.ok);
  assert.equal(opened.sas, sent3.sas, "both screens show the same code");
  const imported = await receiver.importBackup(opened.backup, "sender-pw", "merge");
  assert.ok(imported.ok);
  assert.equal(imported.state.accounts.length, 2);
  assert.equal((await receiver.nodeAuthorization("http://127.0.0.1:8080") as { authorization?: string }).authorization, undefined, "node cookies are not transferred");
});

test("boundary: no response to the page ever carries a secret", async () => {
  const seen: string[] = [];
  const signer = createSigner(memory());
  const page = (s: ReturnType<typeof createSigner>) => walletClient(async (msg: Request) => {
    const r: Response = await s.handle(msg);
    seen.push(JSON.stringify(r));
    return r;
  });
  const w = page(signer);
  await w.create("pw-pw-pw-pw", { mnemonic: MNEMONIC });
  await w.addAccount();
  await w.importKey(PRIV);
  await w.setNodeCookie("http://127.0.0.1:8080", COOKIE);
  await w.exportBackup("pw-pw-pw-pw", true);
  await w.exportBackup("pw-pw-pw-pw");
  await w.exportSeedQR("pw-pw-pw-pw", "compact");
  await w.exportSeedQR("pw-pw-pw-pw", "standard");
  await w.getState();
  const other = page(createSigner(memory()));
  const offer = await other.transferOffer();
  assert.ok(offer.ok);
  const sent = await w.transferSend(offer.offer, "pw-pw-pw-pw");
  assert.ok(sent.ok);
  const opened = await other.transferOpen(sent.envelope);
  assert.ok(opened.ok);
  await other.importBackup(opened.backup, "pw-pw-pw-pw", "merge");
  await other.getState();

  const secrets = [
    // The phrase, and any two adjacent words of it.
    ...MNEMONIC.split(" ").slice(1).map((w, i) => `${MNEMONIC.split(" ")[i]} ${w}`), MNEMONIC, PRIV, PRIV.toUpperCase(), COOKIE, "f00dfacecafe",
    standardSeedQR(MNEMONIC), bytesToHex(compactSeedQR(MNEMONIC)), "pw-pw-pw-pw",
  ];
  const all = seen.join("\n");
  assert.ok(seen.length >= 14);
  for (const s of secrets) assert.equal(all.toLowerCase().includes(s.toLowerCase()), false, `leaked: ${s.slice(0, 12)}…`);
});
