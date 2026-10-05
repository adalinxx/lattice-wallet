// The shared signer over an in-memory vault store: what the extension worker
// and the desktop page both run. Secrets stay inside; the vault is the
// extension keystore format; CLI key files import as standalone accounts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSigner, type VaultStorage } from "../src/lib/wallet/signer.ts";
import { walletClient } from "../src/lib/wallet/client.ts";
import { decryptVault, type Vault } from "../src/lib/crypto/keystore.ts";
import { importPrivateKey, keyFilePrivateKey } from "../src/lib/crypto/accounts.ts";
import type { WalletData } from "../src/lib/wallet/types.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function memory(): VaultStorage & { vault: Vault | null } {
  const box = {
    vault: null as Vault | null,
    load: async () => box.vault,
    save: async (v: Vault) => { box.vault = v; },
    remove: async () => { box.vault = null; },
  };
  return box;
}

const keyFile = (priv: string) => {
  const a = importPrivateKey(priv);
  return JSON.stringify({ address: a.address, privateKey: priv, publicKey: a.publicKey });
};

test("create, lock, unlock, wrong password; the vault is the keystore format and holds no plaintext", async () => {
  const vaults = memory();
  let touched = 0;
  const signer = createSigner(vaults, () => { touched += 1; });
  const wallet = walletClient(signer.handle);
  const created = await wallet.create("correct horse", { mnemonic: MNEMONIC });
  assert.ok(created.ok && created.state.accounts.length === 1 && !created.state.locked);
  assert.ok(touched > 0, "key use re-arms the idle lock");
  assert.equal(vaults.vault?.v, 1);
  assert.equal(JSON.stringify(vaults.vault).includes("abandon"), false);
  const data = await decryptVault<WalletData>("correct horse", vaults.vault!);
  assert.equal(data.mnemonic, MNEMONIC);

  signer.lock();
  const locked = await wallet.getState();
  assert.ok(locked.ok && locked.state.locked && locked.state.accounts.length === 0);
  assert.deepEqual(await wallet.unlock("wrong"), { ok: false, error: "Wrong password" });
  const unlocked = await wallet.unlock("correct horse");
  assert.ok(unlocked.ok && unlocked.state.accounts[0]!.address === created.state.accounts[0]!.address);
  assert.equal((await wallet.create("x", { mnemonic: MNEMONIC })).ok, false, "one vault");
});

test("a CLI key file imports as a standalone account; a mismatched one is refused", async () => {
  const priv = "c3".repeat(32);
  assert.equal(keyFilePrivateKey(keyFile(priv)), priv);
  const tampered = JSON.parse(keyFile(priv));
  tampered.address = importPrivateKey("d4".repeat(32)).address;
  assert.throws(() => keyFilePrivateKey(JSON.stringify(tampered)), /does not match/);
  assert.throws(() => keyFilePrivateKey("{}"), /needs address/);
  assert.throws(() => keyFilePrivateKey("{"), /invalid JSON/);

  const wallet = walletClient(createSigner(memory()).handle);
  await wallet.create("pw-pw-pw-pw", { mnemonic: MNEMONIC });
  const imported = await wallet.importKey(keyFilePrivateKey(keyFile(priv)));
  assert.ok(imported.ok);
  const view = imported.state.accounts.find((a) => a.kind === "imported")!;
  assert.equal(view.address, importPrivateKey(priv).address);
  assert.equal(imported.state.active, view.address);
  assert.equal(JSON.stringify(imported).includes(priv), false, "no secret crosses the boundary");
});

test("signing goes through the signer and returns the locally computed CID", async () => {
  const wallet = walletClient(createSigner(memory()).handle);
  const created = await wallet.create("pw-pw-pw-pw", { privHex: "a1".repeat(32) });
  assert.ok(created.ok);
  const signed = await wallet.signTransfer({
    from: created.state.active!, to: importPrivateKey("b0".repeat(32)).address,
    amount: "1000", fee: "17", nonce: "0", chainPath: ["Nexus"],
  });
  assert.ok(signed.ok);
  assert.equal(signed.signedSubmit.transactionCID, "bafyreifnzr5tuuz2s6stx4zipfozsxejtms42rmvhwkleyd7y2s7e2fru4");
  assert.deepEqual(await walletClient(createSigner(memory()).handle).signTransfer({
    from: created.state.active!, to: "x", amount: "1", fee: "1", nonce: "0", chainPath: ["Nexus"],
  }), { ok: false, error: "Locked" });
});
