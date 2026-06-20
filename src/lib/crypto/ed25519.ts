// ed25519 signing over the Lattice domain. The node signs the UTF-8 bytes of
// ("lattice-tx-v1:" + preimage); signatures are deterministic RFC-8032 ed25519.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { utf8, bytesToHex, hexToBytes } from "./bytes.ts";

// noble v3 needs sha512 wired explicitly (no Node/WebCrypto sync sha512).
if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

export const SIGNATURE_DOMAIN = "lattice-tx-v1:";

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return ed.getPublicKey(privateKey);
}

/** Sign a Lattice signing preimage; returns 64-byte signature as hex. */
export function signPreimage(preimage: string, privateKey: Uint8Array): string {
  const message = utf8(SIGNATURE_DOMAIN + preimage);
  return bytesToHex(ed.sign(message, privateKey));
}

export function verifyPreimage(preimage: string, signatureHex: string, publicKey: Uint8Array): boolean {
  const message = utf8(SIGNATURE_DOMAIN + preimage);
  try {
    return ed.verify(hexToBytes(signatureHex), message, publicKey);
  } catch {
    return false;
  }
}
