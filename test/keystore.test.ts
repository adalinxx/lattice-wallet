import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptVault, decryptVault } from "../src/lib/crypto/keystore.ts";

test("vault round-trips with correct password", async () => {
  const data = { mnemonic: "abandon abandon about", imported: ["aa", "bb"], n: 3 };
  const vault = await encryptVault("correct horse", data);
  assert.equal(vault.v, 1);
  assert.equal(vault.kdf, "argon2id"); // wasm available in this runtime
  const out = await decryptVault<typeof data>("correct horse", vault);
  assert.deepEqual(out, data);
});

test("wrong password fails closed", async () => {
  const vault = await encryptVault("right", { secret: 1 });
  await assert.rejects(() => decryptVault("wrong", vault));
});

test("each encryption uses a fresh IV/salt", async () => {
  const a = await encryptVault("pw", { x: 1 });
  const b = await encryptVault("pw", { x: 1 });
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.ct, b.ct);
});
