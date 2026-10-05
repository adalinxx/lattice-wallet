// Conformance gate, now exercising the SDK the wallet signs with
// (@adalinxx/lattice-core): reproduce Lattice's published conformance vectors
// (Lattice/Vectors, copied from the pinned Lattice 44.0.0 that lattice-node
// builds against) bit for bit: addresses, TransactionBody DAG-CBOR bytes and
// CIDs, the lattice-tx-v1 signing envelope, and RFC 8032 signatures. Negative
// vectors must fail. Refresh by copying Vectors/{addresses,encoding,signing}.json
// from the Lattice release lattice-node pins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  bytesToHex, hexToBytes, utf8, publicKeyFromPrivate, signPreimage, verifyPreimage, SIGNATURE_DOMAIN,
  encodeEd25519Multikey as encodeMultikeyEd25519, decodeEd25519Multikey as decodeMultikeyEd25519,
  addressFromMultikey, encodeDagCbor, cidV1DagCbor, buildTransfer, encodeTransactionBody,
  transactionSigningPreimage as buildPreimage, type DagCborValue,
} from "@adalinxx/lattice-core";

const encode = (value: unknown) => encodeDagCbor(value as DagCborValue);

const load = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./vectors/${name}`, import.meta.url)), "utf8"));
const addresses = load("addresses.json");
const encoding = load("encoding.json");
const signing = load("signing.json");

const privateKeyOf = new Map<string, string>(
  addresses.vectors.filter((v: { privateKey?: string }) => v.privateKey).map((v: { publicKey: string; privateKey: string }) => [v.publicKey, v.privateKey]),
);

/** DAG-CBOR integers in `value` are JSON numbers; carry them as bigints. */
function asCbor(value: unknown): unknown {
  if (typeof value === "number") return BigInt(value);
  if (Array.isArray(value)) return value.map(asCbor);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asCbor(v)]));
  return value;
}

for (const v of addresses.vectors) {
  test(`address: ${v.name}`, () => {
    assert.equal(encodeMultikeyEd25519(hexToBytes(v.publicKeyEd25519Hex)), v.publicKey, "multikey");
    assert.equal(bytesToHex(encode({ key: v.publicKey })), v.publicKeyNodeDagCborHex, "PublicKey node");
    assert.equal(addressFromMultikey(v.publicKey), v.address, "address");
    if (v.privateKey) assert.equal(encodeMultikeyEd25519(publicKeyFromPrivate(hexToBytes(v.privateKey))), v.publicKey);
  });
}

for (const v of encoding.vectors.filter((v: { type: string }) => v.type === "TransactionBody")) {
  test(`encoding: ${v.name}`, () => {
    const bytes = encode(asCbor(v.value));
    assert.equal(bytesToHex(bytes), v.dagCborHex, "DAG-CBOR bytes");
    assert.equal(cidV1DagCbor(bytes), v.cid, "CID");
  });
}

test("encoding: the transfer builder the wallet signs with reproduces transaction-body/account-action", () => {
  const v = encoding.vectors.find((v: { name: string }) => v.name === "transaction-body/account-action");
  const [debit, credit] = v.value.accountActions;
  const body = buildTransfer({
    from: debit.owner, to: credit.owner, amount: BigInt(credit.delta), fee: BigInt(-debit.delta - credit.delta),
    nonce: BigInt(v.value.nonce), chainPath: v.value.chainPath,
  });
  const { cid, bytes } = encodeTransactionBody(body);
  assert.equal(bytesToHex(bytes), v.dagCborHex);
  assert.equal(cid, v.cid);
});

const bodiesByCID = new Map<string, { nonce: number; chainPath: string[] }>(
  encoding.vectors.filter((v: { type: string }) => v.type === "TransactionBody").map((v: { cid: string; value: { nonce: number; chainPath: string[] } }) => [v.cid, v.value]),
);

for (const v of signing.vectors) {
  test(`signing: ${v.name}`, () => {
    assert.equal(bytesToHex(utf8(SIGNATURE_DOMAIN + v.message)), v.signedBytesHex, "signed bytes");
    let verifies = false;
    try {
      verifies = /^[0-9a-f]{128}$/.test(v.signature) && verifyPreimage(v.message, v.signature, decodeMultikeyEd25519(v.publicKey));
    } catch {
      verifies = false;
    }
    if (v.scheme === "transaction") {
      assert.equal(cidV1DagCbor(hexToBytes(v.transactionBodyDagCborHex)), v.transactionBodyCid, "body CID");
      // The only valid signing input is the lattice-tx-v1 envelope of the body.
      const body = bodiesByCID.get(v.transactionBodyCid);
      if (body) {
        const envelope = buildPreimage(v.transactionBodyCid, body.chainPath, BigInt(body.nonce));
        verifies = verifies && v.message === envelope;
      }
    }
    assert.equal(verifies, v.valid, "verifies exactly when valid");
    const privateKey = privateKeyOf.get(v.publicKey);
    if (v.valid && privateKey) {
      // RFC 8032 is deterministic: our signature is the committed one, byte for byte.
      assert.equal(signPreimage(v.message, hexToBytes(privateKey)), v.signature, "signature bytes");
    }
  });
}
