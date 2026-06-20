// CIDv1 for dag-cbor blocks: codec 0x71 (dag-cbor), multihash sha2-256
// (0x12, len 0x20), multibase base32 lower with 'b' prefix. Matches the CIDs
// the node produces (e.g. "bafyrei...").

import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "./bytes.ts";

const B32 = "abcdefghijklmnopqrstuvwxyz234567"; // RFC4648 base32 lowercase

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1 (dag-cbor, sha2-256) of raw block bytes. */
export function cidV1DagCbor(blockBytes: Uint8Array): string {
  const digest = sha256(blockBytes);
  const multihash = concatBytes(Uint8Array.of(0x12, 0x20), digest); // sha2-256, 32 bytes
  const cidBytes = concatBytes(Uint8Array.of(0x01, 0x71), multihash); // v1, dag-cbor
  return "b" + base32(cidBytes); // multibase 'b' = base32 lower (no padding)
}
