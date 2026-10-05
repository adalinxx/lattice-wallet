// UR / Bytewords / fountain codes: byte-for-byte against the reference
// (BCR-2020-005's published part and vectors from the reference port), and
// fountain recovery with dropped frames.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bytewordsEncode, bytewordsDecode, cborEncode, cborDecode, crc32, encodeUR, urEncoder, urDecoder, type Cbor } from "../src/lib/qr/ur.ts";

const vectors = JSON.parse(readFileSync(new URL("./vectors/ur.json", import.meta.url), "utf8")) as {
  bytewords: { hex: string; minimal: string }[];
  vectors: { messageHex: string; cborHex: string; maxFragmentLen: number; parts: string[] }[];
};

test("CRC-32 and Bytewords minimal match the reference", () => {
  assert.equal(crc32(new TextEncoder().encode("Hello, world!")), 0xebe6c6e6);
  for (const v of vectors.bytewords) {
    assert.equal(bytewordsEncode(hexToBytes(v.hex)), v.minimal);
    assert.equal(bytesToHex(bytewordsDecode(v.minimal)), v.hex);
    assert.equal(bytesToHex(bytewordsDecode(v.minimal.toUpperCase())), v.hex, "case-insensitive");
  }
  const good = vectors.bytewords[1]!.minimal;
  assert.throws(() => bytewordsDecode(good.slice(0, -2) + (good.endsWith("ae") ? "ad" : "ae")), /checksum/);
  assert.throws(() => bytewordsDecode(good.slice(1)), /length/);
});

test("the published multi-part vector: ur:bytes/1-9 of the 'Wolf' message", () => {
  const v = vectors.vectors.find((x) => x.messageHex.startsWith("916ec65c"));
  assert.ok(v, "Wolf vector present");
  const enc = urEncoder("bytes", hexToBytes(v.cborHex), 30);
  assert.equal(enc.nextPart(), "ur:bytes/1-9/lpadascfadaxcywenbpljkhdcahkadaemejtswhhylkepmykhhtsytsnoyoyaxaedsuttydmmhhpktpmsrjtdkgslpgh");
});

test("encoder output equals the reference implementation's, part for part", () => {
  for (const v of vectors.vectors) {
    const cbor = hexToBytes(v.cborHex);
    assert.equal(bytesToHex(cborEncode(hexToBytes(v.messageHex))), v.cborHex, "CBOR byte string head");
    const enc = urEncoder("bytes", cbor, v.maxFragmentLen);
    for (const want of v.parts) assert.equal(enc.nextPart(), want);
    if (v.parts.length === 1) assert.equal(encodeUR("bytes", cbor), v.parts[0]);
  }
});

test("fountain decoding recovers the message with frames dropped, duplicated and shuffled", () => {
  for (const v of vectors.vectors.filter((x) => x.parts.length > 1)) {
    const cbor = hexToBytes(v.cborHex);
    // A camera that misses every third frame, sees some twice, and starts mid-loop.
    const enc = urEncoder("bytes", cbor, v.maxFragmentLen);
    const stream = Array.from({ length: v.parts.length * 4 }, () => enc.nextPart()).filter((_, i) => i % 3 !== 1);
    const seen = [...stream.slice(4), ...stream.slice(0, 4)].flatMap((p, i) => (i % 5 === 0 ? [p, p] : [p]));
    const dec = urDecoder(["bytes"]);
    for (const p of seen) { dec.receive(p); if (dec.result) break; }
    assert.equal(bytesToHex(dec.result ?? new Uint8Array()), v.cborHex);
    assert.equal(dec.progress(), 1);
    // And the reference's own parts decode here too.
    const ref = urDecoder(["bytes"]);
    for (const p of v.parts) { ref.receive(p); if (ref.result) break; }
    assert.equal(bytesToHex(ref.result!), v.cborHex);
  }
});

test("round-trip through our own encoder with only fountain (mixed) parts", () => {
  const msg = cborEncode(new Uint8Array(3000).map((_, i) => (i * 7) % 256));
  const enc = urEncoder("lattice-vault", msg, 150);
  for (let i = 0; i < enc.seqLen; i++) enc.nextPart(); // the receiver missed every pure fragment
  const dec = urDecoder(["lattice-vault"]);
  let n = 0;
  while (!dec.result && n < enc.seqLen * 4) { dec.receive(enc.nextPart().toUpperCase()); n++; }
  assert.deepEqual(dec.result, msg);
});

test("the decoder ignores other types, other messages, malformed and hostile parts", () => {
  const msg = cborEncode(new Uint8Array(500).fill(9));
  const enc = urEncoder("lattice-vault", msg, 100);
  const other = urEncoder("lattice-vault", cborEncode(new Uint8Array(400).fill(1)), 100);
  const dec = urDecoder(["lattice-vault"]);
  assert.equal(dec.receive("ur:bytes/" + bytewordsEncode(msg)), false, "wrong type");
  assert.equal(dec.receive("https://example.com"), false);
  assert.equal(dec.receive("ur:lattice-vault/1-5/zzzz"), false);
  assert.equal(dec.receive(enc.nextPart()), true);
  assert.equal(dec.receive(other.nextPart()), false, "a different message's part");
  // A part claiming a huge message is refused before any allocation.
  const huge = cborEncode([1, 9999, 100_000_000, 1, new Uint8Array(10)]);
  assert.equal(dec.receive(`ur:lattice-vault/1-9999/${bytewordsEncode(huge)}`), false);
  while (!dec.result) dec.receive(enc.nextPart());
  assert.deepEqual(dec.result, msg);
});

test("minimal CBOR: canonical maps, strict decoding", () => {
  const m = new Map<number, Uint8Array | number>([[2, new Uint8Array([1, 2])], [1, 7]]);
  const bytes = cborEncode(m);
  assert.equal(bytesToHex(bytes), "a20107024201" + "02");
  assert.deepEqual(cborDecode(bytes), new Map<number, Cbor>([[1, 7], [2, new Uint8Array([1, 2])]]));
  assert.throws(() => cborDecode(new Uint8Array([...bytes, 0])), /trailing/);
  assert.throws(() => cborDecode(hexToBytes("a2010101")), /bad map key/, "duplicate key");
  assert.throws(() => cborDecode(hexToBytes("a20101")), /truncated/);
  assert.throws(() => cborDecode(hexToBytes("60")), /unsupported/);
});
