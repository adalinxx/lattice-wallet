// Address derivation. An address is the CIDv1 of dag-cbor(PublicKey{key})
// where `key` is the Multikey-encoded public key hex (CryptoUtils.createAddress).

import { encode } from "./dagcbor.ts";
import { cidV1DagCbor } from "./cid.ts";
import { encodeMultikeyEd25519 } from "./multikey.ts";

/** Address from a Multikey public-key hex string ("ed01..."). */
export function addressFromMultikey(multikeyHex: string): string {
  return cidV1DagCbor(encode({ key: multikeyHex }));
}

/** Address from a raw 32-byte ed25519 public key. */
export function addressFromPublicKey(pubKey: Uint8Array): string {
  return addressFromMultikey(encodeMultikeyEd25519(pubKey));
}
