import { test } from "node:test";
import assert from "node:assert/strict";
import { createSigner } from "../src/lib/wallet/signer.ts";
import { chooseBuyOffers } from "../src/popup/app.ts";
import { validWalletData } from "../src/lib/wallet/backup.ts";
import type { Vault } from "../src/lib/crypto/keystore.ts";
import { decryptVault, encryptVault } from "../src/lib/crypto/keystore.ts";

test("concurrent creation yields one vault and one matching signing session", async () => {
  let vault: Vault | null = null;
  const signer = createSigner({ load: async () => vault, save: async (v) => { vault = v; }, remove: async () => { vault = null; } });
  const results = await Promise.all([
    signer.handle({ type: "createWallet", password: "first password", privHex: "a1".repeat(32) }),
    signer.handle({ type: "createWallet", password: "second password", privHex: "b0".repeat(32) }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  const before = await signer.handle({ type: "getState" });
  signer.lock();
  const after = await signer.handle({ type: "unlock", password: "first password" });
  assert.deepEqual(after, before);
});

test("concurrent export guesses lock after five failures and cannot export later", async () => {
  let vault: Vault | null = null;
  const signer = createSigner({ load: async () => vault, save: async (v) => { vault = v; }, remove: async () => { vault = null; } });
  await signer.handle({ type: "createWallet", password: "correct password", privHex: "a1".repeat(32) });
  const failures = await Promise.all(Array.from({ length: 8 }, (_, i) => signer.handle({ type: "exportBackup", password: `wrong ${i}` })));
  assert.ok(failures.every((r) => !r.ok));
  assert.deepEqual(await signer.handle({ type: "exportBackup", password: "correct password" }), { ok: false, error: "Locked" });
});

test("market buys reject bait prices without spending the full budget", () => {
  const offers = [
    { demander: "honest", amountDeposited: 100n, amountDemanded: 100n, depositNonce: 1n },
    { demander: "bait", amountDeposited: 1n, amountDemanded: 900n, depositNonce: 2n },
  ];
  const order = { version: 1 as const, parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], asset: "LAT" as const,
    expiresAt: "2099-01-01", side: "buy_child" as const, orderType: "market" as const, maxAmountDemanded: "1000" };
  assert.deepEqual(chooseBuyOffers(order, offers), [offers[0]]);
});

test("oversized backups fail before deriving any accounts", () => {
  assert.throws(() => validWalletData({ mnemonic: null, hd: [], imported: Array(257).fill({ priv: "a1".repeat(32), label: "x" }) }), /256-account limit/);
});

test("vault readers reject unknown versions and excessive KDF cost", async () => {
  const vault = await encryptVault("correct password", { value: 1 });
  await assert.rejects(decryptVault("correct password", { ...vault, v: 2 } as unknown as Vault), /version/);
  await assert.rejects(decryptVault("correct password", { ...vault, argon: { m: 65537, t: 3, p: 1 } }), /KDF parameters/);
});

test("a failed vault save leaves no unlocked session with unpersisted keys", async () => {
  const signer = createSigner({ load: async () => null, save: async () => { throw new Error("storage failed"); }, remove: async () => {} });
  await assert.rejects(signer.handle({ type: "createWallet", password: "correct password", privHex: "a1".repeat(32) }), /storage failed/);
  assert.deepEqual(await signer.handle({ type: "getState" }), { ok: true, state: { initialized: false, locked: true, accounts: [], active: null } });
});

test("an idle lock during key derivation cannot resurrect an unlocked session", async () => {
  let vault: Vault | null = null;
  const signer = createSigner({ load: async () => vault, save: async (v) => { vault = v; }, remove: async () => {} });
  const pending = signer.handle({ type: "createWallet", password: "correct password", privHex: "a1".repeat(32) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  signer.lock();
  await assert.rejects(pending, /locked during operation/);
  assert.equal(vault, null);
});
