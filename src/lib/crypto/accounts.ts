// Account model: BIP39 mnemonic -> seed -> SLIP-0010 ed25519 derivation on a
// single FROZEN path, plus raw 32-byte key import for node/miner keys.
//
// Frozen path: m/44'/COIN_TYPE'/account'  (3-level, all hardened). Deliberately
// flattened (not a 5-level path) to avoid the documented Solana-style path
// ambiguity. COIN_TYPE 7878 is FROZEN (it is not SLIP-44 registered); it is
// regression-tested so it can never silently drift.

import { mnemonicToSeedSync, generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { accountFromPrivateKey, hexToBytes } from "@adalinxx/lattice-core";
import { derivePrivateKey } from "./slip10.ts";

export const COIN_TYPE = 7878; // FROZEN: changing it moves every HD account (test/accounts.test.ts)
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

/** Keys, Multikey and address come from the SDK; only the HD path is the wallet's. */
function accountFromPrivate(privateKey: Uint8Array, index: number): Account {
  return { index, ...accountFromPrivateKey(privateKey) };
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
  const priv = hexToBytes(hex.trim().toLowerCase());
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  return accountFromPrivate(priv, -1);
}

/**
 * The private key of a `lattice key generate` key file
 * (`{ address, privateKey, publicKey }`), refused unless the key derives the
 * file's own address and public key.
 */
export function keyFilePrivateKey(text: string): string {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("not a key file (invalid JSON)");
  }
  const { address, privateKey, publicKey } = (file ?? {}) as Record<string, unknown>;
  if (typeof address !== "string" || typeof privateKey !== "string" || typeof publicKey !== "string") {
    throw new Error("not a key file (needs address, privateKey, publicKey)");
  }
  const account = importPrivateKey(privateKey);
  if (account.address !== address || account.publicKey !== publicKey.toLowerCase()) {
    throw new Error("key file does not match its own address");
  }
  return privateKey.trim().toLowerCase();
}
