// Regression lock for HD derivation. The node has no HD scheme to cross-check
// against, so we freeze the derived address for a fixed test mnemonic: if the
// derivation path, SLIP-0010, or encoding ever changes, this breaks loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mnemonicToSeedSync } from "@scure/bip39";
import { addressFromMultikey, addressFromPublicKey, bytesToHex, publicKeyFromPrivate } from "@adalinxx/lattice-core";
import { deriveAccount, importPrivateKey, isValidMnemonic, COIN_TYPE, path } from "../src/lib/crypto/accounts.ts";
import { derivePrivateKey } from "../src/lib/crypto/slip10.ts";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// FROZEN vectors for m/44'/7878'/n' (cross-checked against the pre-SDK
// wallet's own encoder when the SDK replaced it). Changing any of these moves
// every user's funds: never update them to make a test pass.
const FROZEN = [
  { n: 0, publicKey: "ed01f3b9bbfa402794936f6fd24c4261a8a91b40e38401141a6b3bae73ab69131b00", address: "bafyreigsucgdpgsycj3aalba422glkmkneyok6jhf6gpuws4l3osaxvvi4" },
  { n: 1, publicKey: "ed01aabd075c75ea727335a9903e74123cff1b7514c9ff9cfe6316ea7bd523d5cc89", address: "bafyreif7j3lv63cxezrwnsfbu7bo2qwyy7pffy7rmq7gyxbhnd43qweeau" },
  { n: 2, publicKey: "ed01233301b4896e29082ba004136a08d2eaf2d6a857a2f8cdbbc4bd6b178163a690", address: "bafyreihm62pyiohb4snwythcngcmbrfmqysv6bgyhrolfaqkmxu7xpmwoa" },
];

test("coin type 7878 is FROZEN and the path is m/44'/7878'/n'", () => {
  assert.equal(COIN_TYPE, 7878, "coin type 7878 can never change");
  for (const n of [0, 1, 2, 0x7fffffff]) assert.deepEqual(path(n), [44, 7878, n]);
  // Any other coin type lands somewhere else: the vectors pin this one.
  const seed = mnemonicToSeedSync(TEST_MNEMONIC);
  assert.notEqual(addressFromPublicKey(publicKeyFromPrivate(derivePrivateKey(seed, [44, 7877, 0]))), FROZEN[0].address);
});

for (const v of FROZEN) {
  test(`frozen path vector m/44'/7878'/${v.n}': wallet derivation == SDK address derivation`, () => {
    const acct = deriveAccount(TEST_MNEMONIC, v.n);
    assert.equal(acct.publicKey, v.publicKey);
    assert.equal(acct.address, v.address);
    // The SDK, from the wallet's derived key alone, names the same address.
    const fromKey = derivePrivateKey(mnemonicToSeedSync(TEST_MNEMONIC), [44, 7878, v.n]);
    assert.equal(addressFromPublicKey(publicKeyFromPrivate(fromKey)), v.address);
    assert.equal(addressFromMultikey(v.publicKey), v.address);
  });
}

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
  assert.equal(importPrivateKey("0x000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F").address, acct.address, "0x and upper case");
  assert.throws(() => importPrivateKey("0001"));
});
