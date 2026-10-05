// Offline proof that what the worker signs (session.signTransfer, built on the
// SDK) satisfies the node's acceptance rules: signatures match signers and
// verify over the lattice-tx-v1 envelope of the body's CID; the fee is the
// balance excess; the POST /transactions payload carries exact decimal strings.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressFromMultikey, decodeEd25519Multikey, encodeTransactionBody, transactionSigningPreimage, verifyPreimage,
} from "@adalinxx/lattice-core";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";
import { signTransfer } from "../src/lib/wallet/session.ts";

const sender = importPrivateKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const to = "bafyreianmyrb5lb4gyj77tfdflvgaalaq2fhnncv2wxnbdzpdh753ynn34";

test("a signed transfer satisfies node acceptance rules, with the fee as the excess", () => {
  const amount = 1000n, fee = 37n, nonce = 3n, chainPath = ["Nexus", "testnet"];
  const { payload, bodyCID } = signTransfer(sender, { to, amount, fee, nonce, chainPath });
  const body = payload.transaction.body;
  assert.equal("fee" in body, false, "no fee field: the fee is the balance excess");
  assert.deepEqual(body.signers, [sender.address]);
  assert.deepEqual(body.chainPath, chainPath);
  assert.equal(body.nonce, "3");
  const deltas = body.accountActions.map((a) => BigInt(a.delta));
  assert.equal(-deltas.reduce((s, d) => s + d, 0n), fee, "debits over credits == the chosen fee");

  // The CID of the body as the node decodes it from the payload.
  const decoded = {
    ...body,
    accountActions: body.accountActions.map((a) => ({ owner: a.owner, delta: BigInt(a.delta) })),
    depositActions: [], receiptActions: [], withdrawalActions: [], nonce: BigInt(body.nonce),
  };
  assert.equal(encodeTransactionBody(decoded).cid, bodyCID);
  const envelope = transactionSigningPreimage(bodyCID, chainPath, nonce);
  const signatures = Object.entries(payload.transaction.signatures);
  assert.deepEqual(signatures.map(([key]) => addressFromMultikey(key)), body.signers, "signatures map to signers");
  for (const [key, signature] of signatures) assert.ok(verifyPreimage(envelope, signature, decodeEd25519Multikey(key)));
});

test("the payload carries exact integers as decimal strings", () => {
  const big = (1n << 62n) + 1n; // not representable as a double
  const { payload } = signTransfer(sender, { to, amount: big, fee: 0n, nonce: 9007199254740993n, chainPath: ["Nexus"] });
  const json = JSON.stringify(payload);
  assert.ok(json.includes(`"delta":"${big}"`), json);
  assert.ok(json.includes(`"delta":"-${big}"`), json);
  assert.ok(json.includes(`"nonce":"9007199254740993"`), json);
  assert.deepEqual(Object.keys(payload.transaction).sort(), ["body", "signatures"]);
});

test("the builder refuses what the node would", () => {
  const base = { to, amount: 1n, fee: 1n, nonce: 0n, chainPath: ["Nexus"] };
  assert.throws(() => signTransfer(sender, { ...base, amount: 0n }));
  assert.throws(() => signTransfer(sender, { ...base, fee: -1n }));
  assert.throws(() => signTransfer(sender, { ...base, to: sender.address }));
  assert.throws(() => signTransfer(sender, { ...base, amount: 1n << 63n }));
});
