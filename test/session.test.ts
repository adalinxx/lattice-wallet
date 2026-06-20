import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAccounts, toView, nextHdLabel } from "../src/lib/wallet/session.ts";
import type { WalletData } from "../src/lib/wallet/types.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("deriveAccounts: hd + imported, no secrets in view", () => {
  const data: WalletData = {
    mnemonic: MNEMONIC,
    hd: [{ index: 0, label: "Account 1" }, { index: 1, label: "Account 2" }],
    imported: [{ priv: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", label: "Imported 1" }],
    active: null,
  };
  const accts = deriveAccounts(data);
  assert.equal(accts.length, 3);
  assert.equal(accts[0].address, "bafyreigsucgdpgsycj3aalba422glkmkneyok6jhf6gpuws4l3osaxvvi4");
  assert.equal(accts[2].address, "bafyreihdco2idzkxhhki4c3qfqqjxowwscizt6ebycgi3sf7uzfq7rtbre");
  const v = toView(accts[0]);
  assert.ok(!("privateKey" in v), "view must not carry the private key");
  assert.equal(v.kind, "hd");
});

test("nextHdLabel advances", () => {
  const data: WalletData = { mnemonic: MNEMONIC, hd: [{ index: 0, label: "Account 1" }], imported: [], active: null };
  assert.deepEqual(nextHdLabel(data), { index: 1, label: "Account 2" });
});
