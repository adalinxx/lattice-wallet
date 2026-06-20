// Account model: BIP39 mnemonic -> seed -> SLIP-0010 ed25519 derivation on a
// single FROZEN path, plus raw 32-byte key import for node/miner keys.
//
// Frozen path: m/44'/COIN_TYPE'/account'  (3-level, all hardened). Deliberately
// flattened (not a 5-level path) to avoid the documented Solana-style path
// ambiguity. COIN_TYPE is provisional pending a SLIP-44 registration; it is a
// frozen constant + regression-tested so it can never silently drift.

import { mnemonicToSeedSync, generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { derivePrivateKey } from "./slip10.ts";
import { publicKeyFromPrivate } from "./ed25519.ts";
import { encodeMultikeyEd25519 } from "./multikey.ts";
import { addressFromMultikey } from "./address.ts";
import { hexToBytes, bytesToHex } from "./bytes.ts";

export const COIN_TYPE = 7878; // provisional; freeze before mainnet scale
const PURPOSE = 44;

export interface Account {
  index: number; // account' index; -1 for an imported raw key
  privateKey: Uint8Array; // 32-byte ed25519 seed — secret
  publicKey: string; // multikey hex ("ed01...")
  address: string; // CIDv1 address
}

export function path(account: number): number[] {
  return [PURPOSE, COIN_TYPE, account];
}

function accountFromPrivate(privateKey: Uint8Array, index: number): Account {
  const publicKey = encodeMultikeyEd25519(publicKeyFromPrivate(privateKey));
  return { index, privateKey, publicKey, address: addressFromMultikey(publicKey) };
}

export function newMnemonic(strength: 128 | 256 = 128): string {
  return generateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic.trim(), wordlist);
}

/** Derive account N from a mnemonic (optional BIP39 passphrase). */
export function deriveAccount(mnemonic: string, account: number, passphrase = ""): Account {
  const seed = mnemonicToSeedSync(mnemonic.trim(), passphrase);
  return accountFromPrivate(derivePrivateKey(seed, path(account)), account);
}

/** Import a raw 32-byte ed25519 private key (hex). Lives outside the HD tree. */
export function importPrivateKey(hex: string): Account {
  const priv = hexToBytes(hex);
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  return accountFromPrivate(priv, -1);
}

export { bytesToHex };
