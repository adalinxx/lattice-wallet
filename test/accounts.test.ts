// Regression lock for HD derivation. The node has no HD scheme to cross-check
// against, so we freeze the derived address for a fixed test mnemonic: if the
// derivation path, SLIP-0010, or encoding ever changes, this breaks loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAccount, importPrivateKey, isValidMnemonic, COIN_TYPE, path } from "../src/lib/crypto/accounts.ts";
import { bytesToHex } from "../src/lib/crypto/bytes.ts";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("frozen derivation path", () => {
  assert.equal(COIN_TYPE, 7878);
  assert.deepEqual(path(0), [44, 7878, 0]);
});

test("mnemonic validation", () => {
  assert.ok(isValidMnemonic(TEST_MNEMONIC));
  assert.ok(!isValidMnemonic("not a real mnemonic phrase at all"));
});

test("derivation is deterministic + distinct per account", () => {
  const a0 = deriveAccount(TEST_MNEMONIC, 0);
  const a0again = deriveAccount(TEST_MNEMONIC, 0);
  const a1 = deriveAccount(TEST_MNEMONIC, 1);
  assert.equal(bytesToHex(a0.privateKey), bytesToHex(a0again.privateKey), "stable");
  assert.equal(a0.address, a0again.address);
  assert.notEqual(a0.address, a1.address, "distinct accounts");
  assert.match(a0.publicKey, /^ed01[0-9a-f]{64}$/);
  // FROZEN value for the all-`abandon` test mnemonic — locks the derivation path.
  assert.equal(a0.address, "bafyreigsucgdpgsycj3aalba422glkmkneyok6jhf6gpuws4l3osaxvvi4");
});

test("raw key import", () => {
  const acct = importPrivateKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  assert.equal(acct.publicKey, "ed0103a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8");
  assert.equal(acct.address, "bafyreihdco2idzkxhhki4c3qfqqjxowwscizt6ebycgi3sf7uzfq7rtbre");
  assert.equal(acct.index, -1);
});
