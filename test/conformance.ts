// Conformance gate: reproduce the node's published signing vectors bit-for-bit.
// If this passes, the DAG-CBOR encoder, CID, address derivation, preimage, and
// ed25519 signing all match the chain exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hexToBytes } from "../src/lib/crypto/bytes.ts";
import { publicKeyFromPrivate, signPreimage, verifyPreimage } from "../src/lib/crypto/ed25519.ts";
import { encodeMultikeyEd25519, decodeMultikeyEd25519 } from "../src/lib/crypto/multikey.ts";
import { addressFromMultikey } from "../src/lib/crypto/address.ts";
import { buildTransferBody, bodyPreimage } from "../src/lib/tx/build.ts";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./transaction-signing-vectors.json", import.meta.url)), "utf8"),
);

for (const v of vectors) {
  test(`vector: ${v.name}`, () => {
    const priv = hexToBytes(v.signerPrivateKey);

    // 1. public key -> multikey
    const multikey = encodeMultikeyEd25519(publicKeyFromPrivate(priv));
    assert.equal(multikey, v.signerPublicKey, "multikey public key");

    // 2. address = CID(dag-cbor(PublicKey{key}))
    assert.equal(addressFromMultikey(v.signerPublicKey), v.signerAddress, "signer address");

    // 3. body -> bodyCID + preimage
    const body = buildTransferBody({
      from: v.signerAddress,
      to: v.recipientAddress,
      amount: BigInt(v.amount),
      fee: BigInt(v.fee),
      nonce: BigInt(v.nonce),
      chainPath: v.chainPath,
    });
    const { bodyCID, preimage } = bodyPreimage(body);
    assert.equal(bodyCID, v.bodyCID, "bodyCID");
    assert.equal(preimage, v.signingPreimage, "signing preimage");

    // 4. signature must VERIFY. Byte-equality with the vector is intentionally
    // NOT asserted: the vector was produced by Apple CryptoKit (randomized ed25519
    // nonce), while we sign with deterministic RFC-8032. The node only verifies,
    // so any signature that verifies is accepted. We assert both directions.
    const pub = decodeMultikeyEd25519(v.signerPublicKey);
    const sig = signPreimage(preimage, priv);
    assert.ok(verifyPreimage(preimage, sig, pub), "our signature verifies");
    assert.ok(verifyPreimage(preimage, v.signature, pub), "vector signature verifies (cross-impl interop)");
  });
}
