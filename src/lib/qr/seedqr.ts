// SeedQR (SeedSigner's format, docs/seed_qr in SeedSigner/seedsigner): a
// BIP39 mnemonic (12 or 24 English words) as a QR code, for offline paper
// backups. Standard SeedQR: each word's 0-based wordlist index as 4 digits
// (numeric mode). CompactSeedQR: the mnemonic's raw entropy bytes (byte mode;
// the checksum word's extra bits are recomputed on import). This is the
// plaintext secret; only the signer builds it, and only after re-auth.

import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export type SeedQRFormat = "standard" | "compact";

const wordsOf = (mnemonic: string) => mnemonic.trim().split(/\s+/);

function checkSupported(mnemonic: string) {
  const n = wordsOf(mnemonic).length;
  if ((n !== 12 && n !== 24) || !validateMnemonic(wordsOf(mnemonic).join(" "), wordlist)) {
    throw new Error("SeedQR holds a valid 12- or 24-word English recovery phrase");
  }
}

/** Standard SeedQR digit stream. */
export function standardSeedQR(mnemonic: string): string {
  checkSupported(mnemonic);
  return wordsOf(mnemonic).map((w) => String(wordlist.indexOf(w)).padStart(4, "0")).join("");
}

/** CompactSeedQR payload: the entropy (16 or 32 bytes). */
export function compactSeedQR(mnemonic: string): Uint8Array {
  checkSupported(mnemonic);
  return mnemonicToEntropy(wordsOf(mnemonic).join(" "), wordlist);
}

/**
 * A scanned SeedQR back to its mnemonic. `scanned` is the QR payload with byte
 * segments read as Latin-1 (one char per byte), so a CompactSeedQR arrives as
 * 16 or 32 chars and a Standard one as 48 or 96 digits. Null if it is neither.
 */
export function seedQRToMnemonic(scanned: string): string | null {
  if (/^\d+$/.test(scanned) && (scanned.length === 48 || scanned.length === 96)) {
    const words: string[] = [];
    for (let i = 0; i < scanned.length; i += 4) {
      const w = wordlist[Number(scanned.slice(i, i + 4))];
      if (!w) return null;
      words.push(w);
    }
    const m = words.join(" ");
    return validateMnemonic(m, wordlist) ? m : null;
  }
  if (scanned.length === 16 || scanned.length === 32) {
    const bytes = Uint8Array.from(scanned, (c) => c.charCodeAt(0));
    if (bytes.some((b, i) => b !== scanned.charCodeAt(i))) return null; // not Latin-1
    return entropyToMnemonic(bytes, wordlist);
  }
  return null;
}

/** Bytes as a Latin-1 string (one char per byte): the byte-mode text for the QR encoder. */
export const latin1 = (bytes: Uint8Array): string => String.fromCharCode(...bytes);
/** The QR encoder's byte-mode encoder for Latin-1 text (the inverse of `latin1`). */
export const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
