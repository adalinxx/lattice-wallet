// Encrypted backup (ur:lattice-vault): round trip, wrong password, hostile
// headers, and the signer's export / restore / merge / replace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { encryptBackup, decryptBackup, mergeWalletData, validWalletData, VAULT_UR_TYPE } from "../src/lib/wallet/backup.ts";
import { cborDecode, cborEncode, encodeUR, urDecoder, urEncoder, type Cbor } from "../src/lib/qr/ur.ts";
import { createSigner, type VaultStorage } from "../src/lib/wallet/signer.ts";
import { walletClient } from "../src/lib/wallet/client.ts";
import { decryptVault, type Vault } from "../src/lib/crypto/keystore.ts";
import { importPrivateKey, deriveAccount } from "../src/lib/crypto/accounts.ts";
import type { WalletData } from "../src/lib/wallet/types.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER = "forum undo fragile fade shy sign arrest garment culture tube off merit";
const PRIV = "c3".repeat(32);

function memory(): VaultStorage & { vault: Vault | null } {
  const box = { vault: null as Vault | null, load: async () => box.vault, save: async (v: Vault) => { box.vault = v; }, remove: async () => { box.vault = null; } };
  return box;
}
const data = (over: Partial<WalletData> = {}): WalletData => ({
  mnemonic: MNEMONIC, hd: [{ index: 0, label: "Account 1" }, { index: 3, label: "Savings" }],
  imported: [{ priv: PRIV, label: "Miner" }], active: deriveAccount(MNEMONIC, 3).address, ...over,
});

test("backup round-trips through CBOR and a UR (single and animated); wrong password fails closed", async () => {
  const cbor = await encryptBackup("correct horse", data());
  const m = cborDecode(cbor) as Map<number, Cbor>;
  assert.equal(m.get(1), 1, "version");
  assert.equal(m.get(2), 1, "argon2id");
  assert.deepEqual(m.get(3), [19456, 2, 1], "KDF params travel with it");
  assert.equal(bytesToHex(cbor).includes(Buffer.from("abandon").toString("hex")), false, "no plaintext");
  assert.deepEqual(await decryptBackup("correct horse", cbor), data());
  await assert.rejects(decryptBackup("wrong horse", cbor), /Wrong password/);

  const single = urDecoder([VAULT_UR_TYPE]);
  single.receive(encodeUR(VAULT_UR_TYPE, cbor));
  assert.deepEqual(single.result, cbor);
  const enc = urEncoder(VAULT_UR_TYPE, cbor, 40);
  const multi = urDecoder([VAULT_UR_TYPE]);
  for (let i = 0; !multi.result && i < 200; i++) { const p = enc.nextPart(); if (i % 2) multi.receive(p); }
  assert.deepEqual(multi.result, cbor);
});

test("tampered or hostile backups are refused before any expensive work", async () => {
  const cbor = await encryptBackup("pw", data());
  const m = cborDecode(cbor) as Map<number, Cbor>;
  const with_ = (k: number, v: Cbor) => cborEncode(new Map(m).set(k, v));
  await assert.rejects(decryptBackup("pw", with_(3, [4_000_000, 2, 1])), /cost out of range/, "a 4 GiB Argon2 cost");
  await assert.rejects(decryptBackup("pw", with_(1, 2)), /version/);
  await assert.rejects(decryptBackup("pw", with_(5, new Uint8Array(11))), /Not a wallet backup/);
  const ct = (m.get(6) as Uint8Array).slice(); ct[0]! ^= 1;
  await assert.rejects(decryptBackup("pw", with_(6, ct)), /Wrong password/, "AEAD catches a flipped bit");
  await assert.rejects(decryptBackup("pw", new Uint8Array([1, 2, 3])), /Not a wallet backup/);
});

test("decrypted contents are validated", () => {
  assert.throws(() => validWalletData({ mnemonic: "not words", hd: [], imported: [] }));
  assert.throws(() => validWalletData({ mnemonic: null, hd: [{ index: 0, label: "x" }], imported: [] }), /not a wallet/);
  assert.throws(() => validWalletData({ mnemonic: null, hd: [], imported: [{ priv: "zz", label: "x" }] }));
  assert.throws(() => validWalletData({ mnemonic: MNEMONIC, hd: [{ index: -1, label: "x" }], imported: [] }));
  assert.equal(validWalletData({ mnemonic: null, hd: [], imported: [{ priv: PRIV.toUpperCase(), label: "k" }], active: "nope" }).active, importPrivateKey(PRIV).address);
});

test("merge adds accounts and keeps the open wallet's choices; two phrases do not merge", () => {
  const current: WalletData = { mnemonic: MNEMONIC, hd: [{ index: 0, label: "Mine" }], imported: [], active: deriveAccount(MNEMONIC, 0).address, nodeCookies: { "http://127.0.0.1:1": "__cookie__:a" } };
  const merged = mergeWalletData(current, data({ nodeCookies: { "http://127.0.0.1:1": "__cookie__:old", "http://127.0.0.1:2": "__cookie__:b" } }));
  assert.deepEqual(merged.hd, [{ index: 0, label: "Mine" }, { index: 3, label: "Savings" }]);
  assert.deepEqual(merged.imported, [{ priv: PRIV, label: "Miner" }]);
  assert.equal(merged.active, current.active);
  assert.deepEqual(merged.nodeCookies, { "http://127.0.0.1:1": "__cookie__:a", "http://127.0.0.1:2": "__cookie__:b" });
  assert.deepEqual(mergeWalletData(merged, data()).imported.length, 1, "no duplicate keys");
  assert.throws(() => mergeWalletData(current, data({ mnemonic: OTHER, hd: [{ index: 0, label: "x" }], imported: [], active: null })), /different recovery phrase/);
  // An import-only wallet takes the backup's phrase.
  const keysOnly: WalletData = { mnemonic: null, hd: [], imported: [{ priv: "d4".repeat(32), label: "k" }], active: importPrivateKey("d4".repeat(32)).address };
  assert.equal(mergeWalletData(keysOnly, data()).mnemonic, MNEMONIC);
});

test("signer: export needs the password again; restore, merge and replace", async () => {
  const a = createSigner(memory());
  const wa = walletClient(a.handle);
  await wa.create("pw-a-pw-a", { mnemonic: MNEMONIC });
  await wa.addAccount();
  await wa.importKey(PRIV);
  await wa.setNodeCookie("http://127.0.0.1:8080", "__cookie__:secret123");

  assert.deepEqual(await wa.exportBackup("nope"), { ok: false, error: "Wrong password" });
  a.lock();
  assert.deepEqual(await wa.exportBackup("pw-a-pw-a"), { ok: false, error: "Locked" });
  await wa.unlock("pw-a-pw-a");
  const plain = await wa.exportBackup("pw-a-pw-a");
  assert.ok(plain.ok);
  const contents = await decryptBackup("pw-a-pw-a", hexToBytes(plain.backup));
  assert.equal(contents.nodeCookies, undefined, "cookies stay unless opted in");
  assert.equal(contents.hd.length, 2);
  const withCookies = await wa.exportBackup("pw-a-pw-a", true);
  assert.ok(withCookies.ok);
  assert.deepEqual((await decryptBackup("pw-a-pw-a", hexToBytes(withCookies.backup))).nodeCookies, { "http://127.0.0.1:8080": "__cookie__:secret123" });

  // Restore on a fresh device: the backup's password becomes the wallet's.
  const bVaults = memory();
  const wb = walletClient(createSigner(bVaults).handle);
  assert.deepEqual(await wb.importBackup(plain.backup, "wrong", "merge"), { ok: false, error: "Wrong password" });
  const restored = await wb.importBackup(plain.backup, "pw-a-pw-a", "merge");
  assert.ok(restored.ok && restored.state.accounts.length === 3 && !restored.state.locked);
  assert.equal((await decryptVault<WalletData>("pw-a-pw-a", bVaults.vault!)).mnemonic, MNEMONIC);

  // Merge into a different-phrase wallet is refused; replace works and keeps this device's password.
  const cVaults = memory();
  const c = createSigner(cVaults);
  const wc = walletClient(c.handle);
  await wc.create("pw-c-pw-c", { mnemonic: OTHER });
  assert.equal((await wc.importBackup(plain.backup, "pw-a-pw-a", "merge")).ok, false);
  const replaced = await wc.importBackup(plain.backup, "pw-a-pw-a", "replace");
  assert.ok(replaced.ok && replaced.state.accounts.length === 3);
  assert.equal((await decryptVault<WalletData>("pw-c-pw-c", cVaults.vault!)).mnemonic, MNEMONIC);
  c.lock();
  assert.deepEqual(await wc.importBackup(plain.backup, "pw-a-pw-a", "merge"), { ok: false, error: "Unlock first" });
});

test("signer: SeedQR export re-checks the password and needs a phrase", async () => {
  const w = walletClient(createSigner(memory()).handle);
  await w.create("pw-pw-pw-pw", { mnemonic: MNEMONIC });
  assert.deepEqual(await w.exportSeedQR("x", "compact"), { ok: false, error: "Wrong password" });
  const r = await w.exportSeedQR("pw-pw-pw-pw", "standard");
  assert.ok(r.ok && r.svg.startsWith("<svg"));
  const keys = walletClient(createSigner(memory()).handle);
  await keys.create("pw-pw-pw-pw", { privHex: PRIV });
  assert.deepEqual(await keys.exportSeedQR("pw-pw-pw-pw", "compact"), { ok: false, error: "This wallet has no recovery phrase" });
});
