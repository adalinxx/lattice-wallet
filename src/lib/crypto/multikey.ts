// Multikey encoding for ed25519 public keys, matching treehauslabs/Multikey as
// used by the node: multicodec ed25519-pub (0xed) varint-encoded as bytes
// [0xed, 0x01], followed by the 32-byte raw public key. Rendered as hex, e.g.
// "ed01" + 64 hex chars.

import { hexToBytes, bytesToHex } from "./bytes.ts";

const ED25519_PREFIX = Uint8Array.of(0xed, 0x01); // varint(0xed)

export function encodeMultikeyEd25519(pubKey: Uint8Array): string {
  if (pubKey.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return "ed01" + bytesToHex(pubKey);
}

export function decodeMultikeyEd25519(multikeyHex: string): Uint8Array {
  const bytes = hexToBytes(multikeyHex);
  if (bytes.length !== 34 || bytes[0] !== ED25519_PREFIX[0] || bytes[1] !== ED25519_PREFIX[1]) {
    throw new Error("not an ed25519 multikey");
  }
  return bytes.slice(2);
}
