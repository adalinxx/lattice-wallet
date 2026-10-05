// Offline proof that the signed payload satisfies the node's acceptance rules
// (signatures match signers and verify over the lattice-tx-v1 envelope; the
// fee is the balance excess), and that the POST /transactions body carries
// exact integers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";
import { buildTransferBody, bodyPreimage, submitRequestJSON } from "../src/lib/tx/build.ts";
import { signPreimage, verifyPreimage } from "../src/lib/crypto/ed25519.ts";
import { addressFromMultikey } from "../src/lib/crypto/address.ts";
import { decodeMultikeyEd25519 } from "../src/lib/crypto/multikey.ts";

const sender = importPrivateKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const to = "bafyreianmyrb5lb4gyj77tfdflvgaalaq2fhnncv2wxnbdzpdh753ynn34";

test("signed transfer satisfies node acceptance rules", () => {
  const amount = 1000n, fee = 5n, nonce = 3n, chainPath = ["Nexus", "testnet"];
  const body = buildTransferBody({ from: sender.address, to, amount, fee, nonce, chainPath });
  assert.equal("fee" in body, false, "no fee field: the fee is the balance excess");
  const { preimage } = bodyPreimage(body);
  assert.match(preimage, /^domain:13:lattice-tx-v1\nchainPath.count:2\n/);
  const signatures = { [sender.publicKey]: signPreimage(preimage, sender.privateKey) };

  assert.deepEqual(Object.keys(signatures).map(addressFromMultikey), body.signers, "signatures map to signers");
  for (const [pub, s] of Object.entries(signatures)) assert.ok(verifyPreimage(preimage, s, decodeMultikeyEd25519(pub)));
  const debits = body.accountActions.filter((a) => a.delta < 0n).reduce((s, a) => s - a.delta, 0n);
  const credits = body.accountActions.filter((a) => a.delta > 0n).reduce((s, a) => s + a.delta, 0n);
  assert.equal(debits - credits, fee, "the miner's fee is the excess");
});

test("the submit body is the node's shape with exact integers", () => {
  const big = (1n << 62n) + 1n; // not representable as a double
  const body = buildTransferBody({ from: sender.address, to, amount: big, fee: 0n, nonce: 9007199254740993n, chainPath: ["Nexus"] });
  const json = submitRequestJSON({ [sender.publicKey]: "ab" }, body);
  assert.ok(json.includes(`"delta":${big}`), json);
  assert.ok(json.includes(`"delta":-${big}`), json);
  assert.ok(json.includes(`"nonce":9007199254740993`), json);
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed.transaction).sort(), ["body", "signatures"]);
  assert.deepEqual(Object.keys(parsed.transaction.body).sort(), [
    "accountActions", "actions", "chainPath", "depositActions", "nonce", "receiptActions", "signers", "withdrawalActions",
  ]);
});

test("the builder refuses what the node would", () => {
  const base = { from: sender.address, to, amount: 1n, fee: 1n, nonce: 0n, chainPath: ["Nexus"] };
  assert.throws(() => buildTransferBody({ ...base, amount: 0n }));
  assert.throws(() => buildTransferBody({ ...base, fee: -1n }));
  assert.throws(() => buildTransferBody({ ...base, to: sender.address }));
  assert.throws(() => buildTransferBody({ ...base, amount: 1n << 63n }));
});
