// The encrypted wallet backup (`ur:lattice-vault`): the vault's contents
// re-encrypted with a password in the keystore's own format (Argon2id or
// PBKDF2 -> AES-256-GCM), packed as CBOR so it fits QR codes. Format in
// docs/qr-formats.md. Decrypting, validating and merging run in the signer.

import { encryptVault, decryptVault, type Vault } from "../crypto/keystore.ts";
import { cborEncode, cborDecode, type Cbor } from "../qr/ur.ts";
import { isValidMnemonic, importPrivateKey, deriveAccount } from "../crypto/accounts.ts";
import { deriveAccounts } from "./session.ts";
import type { WalletData } from "./types.ts";

export const VAULT_UR_TYPE = "lattice-vault";
const VERSION = 1;
const KDF_ARGON2ID = 1;
const KDF_PBKDF2 = 2;
// A backup names its own KDF cost; refuse costs no wallet of ours writes, so a
// hostile backup cannot pin the signer (Argon2id memory is in KiB).
const MAX_ARGON = { m: 65_536, t: 4, p: 1 };
const MAX_PBKDF2 = 2_000_000;

const b64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The wallet contents a backup carries: node cookies only when the user opts in. */
export function backupContents(data: WalletData, includeNodeCookies: boolean): WalletData {
  const { nodeCookies, ...rest } = data;
  return includeNodeCookies && nodeCookies && Object.keys(nodeCookies).length ? { ...rest, nodeCookies } : rest;
}

export async function encryptBackup(password: string, data: WalletData): Promise<Uint8Array> {
  return vaultToCbor(await encryptVault(password, data));
}

/** Decrypt and validate a backup. Throws "Wrong password" or a format error. */
export async function decryptBackup(password: string, cbor: Uint8Array): Promise<WalletData> {
  const vault = cborToVault(cbor);
  let raw: unknown;
  try {
    raw = await decryptVault(password, vault);
  } catch {
    throw new Error("Wrong password");
  }
  return validWalletData(raw);
}

function vaultToCbor(v: Vault): Uint8Array {
  const params = v.kdf === "argon2id" ? [v.argon!.m, v.argon!.t, v.argon!.p] : [v.pbkdf2!.iterations];
  return cborEncode(new Map<number, Cbor>([
    [1, VERSION],
    [2, v.kdf === "argon2id" ? KDF_ARGON2ID : KDF_PBKDF2],
    [3, params],
    [4, unb64(v.salt)],
    [5, unb64(v.iv)],
    [6, unb64(v.ct)],
  ]));
}

function cborToVault(bytes: Uint8Array): Vault {
  let m: Cbor;
  try { m = cborDecode(bytes); } catch { throw new Error("Not a wallet backup"); }
  if (!(m instanceof Map)) throw new Error("Not a wallet backup");
  if (m.get(1) !== VERSION) throw new Error("Unsupported backup version");
  const kdf = m.get(2), params = m.get(3), salt = m.get(4), iv = m.get(5), ct = m.get(6);
  if (!Array.isArray(params) || !params.every((x) => typeof x === "number")) throw new Error("Not a wallet backup");
  if (!(salt instanceof Uint8Array) || salt.length < 16 || !(iv instanceof Uint8Array) || iv.length !== 12 || !(ct instanceof Uint8Array) || ct.length < 16) {
    throw new Error("Not a wallet backup");
  }
  const base = { v: 1 as const, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  const p = params as number[];
  if (kdf === KDF_ARGON2ID && p.length === 3) {
    const [mm, t, pp] = p as [number, number, number];
    if (mm < 8 * pp || mm > MAX_ARGON.m || t < 1 || t > MAX_ARGON.t || pp < 1 || pp > MAX_ARGON.p) throw new Error("Backup KDF cost out of range");
    return { ...base, kdf: "argon2id", argon: { m: mm, t, p: pp } };
  }
  if (kdf === KDF_PBKDF2 && p.length === 1) {
    if (p[0]! < 100_000 || p[0]! > MAX_PBKDF2) throw new Error("Backup KDF cost out of range");
    return { ...base, kdf: "pbkdf2", pbkdf2: { iterations: p[0]! } };
  }
  throw new Error("Unsupported backup KDF");
}

const isLabel = (x: unknown): x is string => typeof x === "string" && x.length <= 64;

/** Decrypted backup contents, checked field by field before the signer uses them. */
export function validWalletData(raw: unknown): WalletData {
  const bad = () => new Error("Backup contents are not a wallet");
  if (!raw || typeof raw !== "object") throw bad();
  const r = raw as Record<string, unknown>;
  const mnemonic = r.mnemonic ?? null;
  if (mnemonic !== null && (typeof mnemonic !== "string" || !isValidMnemonic(mnemonic))) throw bad();
  if (!Array.isArray(r.hd) || !Array.isArray(r.imported)) throw bad();
  if (r.hd.length + r.imported.length > 256) throw new Error("Backup exceeds the 256-account limit");
  const hd = r.hd.map((e) => {
    const { index, label } = (e ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= 2 ** 31 || !isLabel(label)) throw bad();
    return { index: index as number, label };
  });
  if (hd.length && !mnemonic) throw bad();
  if (new Set(hd.map((e) => e.index)).size !== hd.length) throw bad();
  const imported = r.imported.map((e) => {
    const { priv, label } = (e ?? {}) as Record<string, unknown>;
    if (typeof priv !== "string" || !/^[0-9a-fA-F]{64}$/.test(priv) || !isLabel(label)) throw bad();
    return { priv: priv.toLowerCase(), label };
  });
  const data: WalletData = { mnemonic: mnemonic as string | null, hd, imported, active: null };
  if (r.nodeCookies !== undefined) {
    if (!r.nodeCookies || typeof r.nodeCookies !== "object") throw bad();
    const cookies: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.nodeCookies)) {
      if (typeof v !== "string") throw bad();
      cookies[k] = v;
    }
    data.nodeCookies = cookies;
  }
  const accounts = deriveAccounts(data);
  if (!accounts.length) throw bad();
  data.active = accounts.some((a) => a.address === r.active) ? (r.active as string) : accounts[0]!.address;
  return data;
}

/**
 * Merge a backup into the open wallet: the backup's accounts are added, the
 * open wallet's labels, active account and node cookies win. A wallet holds
 * one recovery phrase, so two different phrases cannot merge (replace instead).
 */
export function mergeWalletData(current: WalletData, incoming: WalletData): WalletData {
  const norm = (m: string) => m.trim().split(/\s+/).join(" ");
  if (current.mnemonic && incoming.mnemonic && norm(current.mnemonic) !== norm(incoming.mnemonic)) {
    throw new Error("The backup has a different recovery phrase; a wallet holds one. Replace instead, or import its keys separately.");
  }
  const mnemonic = current.mnemonic ?? incoming.mnemonic;
  const hd = [...current.hd];
  for (const e of incoming.hd) if (!hd.some((x) => x.index === e.index)) hd.push(e);
  hd.sort((a, b) => a.index - b.index);
  if (hd.length > 256) throw new Error("256-account limit reached");
  const have = new Set(deriveAccounts({ ...current, mnemonic, hd, imported: [] }).map((a) => a.address));
  const imported: WalletData["imported"] = [];
  for (const e of [...current.imported, ...incoming.imported]) {
    const address = importPrivateKey(e.priv).address;
    if (!have.has(address)) { imported.push(e); have.add(address); }
    if (hd.length + imported.length > 256) throw new Error("256-account limit reached");
  }
  const cookies = { ...(incoming.nodeCookies ?? {}), ...(current.nodeCookies ?? {}) };
  const merged: WalletData = { mnemonic, hd, imported, active: current.active };
  if (Object.keys(cookies).length) merged.nodeCookies = cookies;
  if (!merged.active && mnemonic && hd.length) merged.active = deriveAccount(mnemonic, hd[0]!.index).address;
  return merged;
}
