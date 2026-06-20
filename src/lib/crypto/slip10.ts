// SLIP-0010 HD derivation for ed25519. ed25519 supports HARDENED derivation
// only (the signing scalar is a hash of the seed, not a linear multiplier), so
// every path index is hardened. Master key uses HMAC-SHA512 with key
// "ed25519 seed"; each child is HMAC-SHA512(chainCode, 0x00 || key || ser32(i')).

import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { utf8, concatBytes } from "./bytes.ts";

const HARDENED = 0x80000000;

interface Node {
  key: Uint8Array; // 32-byte private scalar seed
  chainCode: Uint8Array;
}

function ser32(i: number): Uint8Array {
  return Uint8Array.of((i >>> 24) & 0xff, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff);
}

function master(seed: Uint8Array): Node {
  const I = hmac(sha512, utf8("ed25519 seed"), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function ckdPriv(parent: Node, index: number): Node {
  // hardened only: data = 0x00 || key || ser32(index | HARDENED)
  const data = concatBytes(Uint8Array.of(0x00), parent.key, ser32((index | HARDENED) >>> 0));
  const I = hmac(sha512, parent.chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/** Derive the 32-byte ed25519 private key (seed) for a path of unhardened
 * indices; every level is hardened per SLIP-0010 ed25519. */
export function derivePrivateKey(seed: Uint8Array, path: number[]): Uint8Array {
  let node = master(seed);
  for (const index of path) node = ckdPriv(node, index);
  return node.key;
}
