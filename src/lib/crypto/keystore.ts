// Encrypted vault: AES-256-GCM over a key derived from the user's password.
// KDF is Argon2id (hash-wasm, memory-hard) with a zero-dependency PBKDF2-SHA256
// (600k) fallback if wasm is unavailable. A fresh 12-byte IV per encryption.
// The vault header records which KDF/params were used so decrypt can reproduce
// the key. Plaintext is an arbitrary JSON-serializable object (the wallet data).

import { argon2id } from "hash-wasm";

export type Kdf = "argon2id" | "pbkdf2";

export interface Vault {
  v: 1;
  kdf: Kdf;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64 (AES-GCM ciphertext + tag)
  argon?: { m: number; t: number; p: number };
  pbkdf2?: { iterations: number };
}

const ARGON = { m: 19456, t: 2, p: 1 }; // 19 MiB, OWASP 2025 baseline
const PBKDF2_ITERS = 600_000;

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder();
const dec = new TextDecoder();
// WebCrypto wants a BufferSource backed by ArrayBuffer; the lib.dom generic
// Uint8Array<ArrayBufferLike> trips the checker. Runtime is unaffected.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deriveArgon2id(password: string, salt: Uint8Array, p = ARGON): Promise<Uint8Array> {
  return argon2id({
    password,
    salt,
    parallelism: p.p,
    iterations: p.t,
    memorySize: p.m,
    hashLength: 32,
    outputType: "binary",
  });
}

async function derivePbkdf2(password: string, salt: Uint8Array, iterations = PBKDF2_ITERS): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", bs(enc.encode(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bs(salt), iterations }, base, 256);
  return new Uint8Array(bits);
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bs(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Derive the AES key for a fresh vault, preferring Argon2id, falling back to PBKDF2. */
async function deriveForNew(password: string, salt: Uint8Array): Promise<{ kdf: Kdf; key: CryptoKey }> {
  try {
    return { kdf: "argon2id", key: await aesKey(await deriveArgon2id(password, salt)) };
  } catch {
    return { kdf: "pbkdf2", key: await aesKey(await derivePbkdf2(password, salt)) };
  }
}

async function deriveForVault(password: string, vault: Vault): Promise<CryptoKey> {
  const salt = unb64(vault.salt);
  const raw =
    vault.kdf === "argon2id"
      ? await deriveArgon2id(password, salt, vault.argon ?? ARGON)
      : await derivePbkdf2(password, salt, vault.pbkdf2?.iterations ?? PBKDF2_ITERS);
  return aesKey(raw);
}

export async function encryptVault(password: string, data: unknown): Promise<Vault> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const { kdf, key } = await deriveForNew(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(enc.encode(JSON.stringify(data)))));
  const vault: Vault = { v: 1, kdf, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  if (kdf === "argon2id") vault.argon = ARGON;
  else vault.pbkdf2 = { iterations: PBKDF2_ITERS };
  return vault;
}

/** Decrypt a vault. Throws on a wrong password (GCM auth failure). */
export async function decryptVault<T = unknown>(password: string, vault: Vault): Promise<T> {
  const key = await deriveForVault(password, vault);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(unb64(vault.iv)) }, key, bs(unb64(vault.ct)));
  return JSON.parse(dec.decode(pt)) as T;
}
