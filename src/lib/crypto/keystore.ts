// Encrypted vault: AES-256-GCM over a key derived from the user's password.
// KDF is Argon2id (hash-wasm, memory-hard) with a zero-dependency PBKDF2-SHA256
// (600k) legacy reader. New encryption fails closed if wasm is unavailable.
// A fresh 12-byte IV per encryption.
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

const ARGON = { m: 65536, t: 3, p: 1 };
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

/** New vaults always use Argon2id; legacy PBKDF2 vaults remain readable. */
async function deriveForNew(password: string, salt: Uint8Array): Promise<{ kdf: Kdf; key: CryptoKey }> {
  const raw = await deriveArgon2id(password, salt);
  try { return { kdf: "argon2id", key: await aesKey(raw) }; } finally { raw.fill(0); }
}

export async function deriveForVault(password: string, vault: Vault): Promise<CryptoKey> {
  if (vault.v !== 1 || !["argon2id", "pbkdf2"].includes(vault.kdf)) throw new Error("Unsupported vault format");
  const salt = unb64(vault.salt);
  if (salt.length !== 16 || unb64(vault.iv).length !== 12) throw new Error("Invalid vault header");
  if (vault.kdf === "argon2id") {
    const p = vault.argon ?? ARGON;
    if (!Number.isInteger(p.m) || p.m < 8 * p.p || p.m > 65536 || !Number.isInteger(p.t) || p.t < 1 || p.t > 4
      || !Number.isInteger(p.p) || p.p !== 1) throw new Error("Unsupported vault KDF parameters");
  } else {
    const n = vault.pbkdf2?.iterations ?? PBKDF2_ITERS;
    if (!Number.isInteger(n) || n < 100000 || n > 2000000) throw new Error("Unsupported vault KDF parameters");
  }
  const raw =
    vault.kdf === "argon2id"
      ? await deriveArgon2id(password, salt, vault.argon ?? ARGON)
      : await derivePbkdf2(password, salt, vault.pbkdf2?.iterations ?? PBKDF2_ITERS);
  try { return await aesKey(raw); } finally { raw.fill(0); }
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
  if (vault.v !== 1) throw new Error("Unsupported vault version");
  const key = await deriveForVault(password, vault);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(unb64(vault.iv)) }, key, bs(unb64(vault.ct)));
  return JSON.parse(dec.decode(pt)) as T;
}

/** Persist an unlocked vault without retaining its password. The derived key
 * is non-extractable; every write gets a fresh AEAD nonce. */
export async function encryptWithVaultKey(key: CryptoKey, header: Vault, data: unknown): Promise<Vault> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(enc.encode(JSON.stringify(data)))));
  return { ...header, iv: b64(iv), ct: b64(ct) };
}
