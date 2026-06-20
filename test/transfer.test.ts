// Offline proof that the signed payload satisfies the node's acceptance rules
// (Transaction.signaturesAreValid + signaturesMatchSigners + valueConservation),
// without needing the live node. Mirrors what the background signer produces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";
import { buildTransferBody, bodyPreimage } from "../src/lib/tx/build.ts";
import { signPreimage, verifyPreimage } from "../src/lib/crypto/ed25519.ts";
import { addressFromMultikey } from "../src/lib/crypto/address.ts";
import { decodeMultikeyEd25519 } from "../src/lib/crypto/multikey.ts";

test("signed transfer satisfies node acceptance rules", () => {
  const sender = importPrivateKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const to = "bafyreianmyrb5lb4gyj77tfdflvgaalaq2fhnncv2wxnbdzpdh753ynn34";
  const amount = 1000n, fee = 5n, nonce = 3n, chainPath = ["Nexus"];

  const body = buildTransferBody({ from: sender.address, to, amount, fee, nonce, chainPath });
  const { bodyCID, preimage } = bodyPreimage(body);
  const sig = signPreimage(preimage, sender.privateKey);

  // what the worker returns:
  const signatures = { [sender.publicKey]: sig };

  // 1. signaturesMatchSigners: { createAddress(pubkey) } === Set(signers)
  const derived = new Set(Object.keys(signatures).map(addressFromMultikey));
  assert.deepEqual([...derived], body.signers, "signatures map to signer addresses");

  // 2. signaturesAreValid: each sig verifies over the preimage(body, bodyCID)
  for (const [pub, s] of Object.entries(signatures)) {
    assert.ok(verifyPreimage(preimage, s, decodeMultikeyEd25519(pub)), "signature verifies");
  }

  // 3. valueConservation: debits === credits + fee
  const debits = body.accountActions.filter((a) => a.delta < 0n).reduce((s, a) => s - a.delta, 0n);
  const credits = body.accountActions.filter((a) => a.delta > 0n).reduce((s, a) => s + a.delta, 0n);
  assert.equal(debits, credits + fee, "value conserved");

  // 4. every debit owner is a signer
  for (const a of body.accountActions) if (a.delta < 0n) assert.ok(body.signers.includes(a.owner));

  assert.match(bodyCID, /^bafy/);
});
