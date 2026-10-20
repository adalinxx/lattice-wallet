// What a web page may ask of the wallet through `window.lattice`, checked
// before any of it reaches a person or the signer. Pure, so it is testable
// without the extension.

import { parseChainPath } from "../config.ts";
import { isAccountAddress } from "./session.ts";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { decodeWriteRequest, type WriteIntent } from "./write-request.ts";

export interface RecordAction { key: string; oldValue?: string; newValue?: string }
/** Coin from the connected account to `to`, in the same transaction as the records. */
export interface Payment { to: string; amount: string } // amount: decimal, above zero

/**
 * A page's request to write records: approved by a person, every time. No
 * nonce: the wallet chooses it (see nonce.ts).
 */
export interface WriteRequest {
  chainPath: string[];
  actions: RecordAction[];
  /** Absent when the write pays no one. */
  payments?: Payment[];
  fee: string; // decimal
}

export type ProviderCall =
  | { method: "connect" }
  | { method: "address" }
  | { method: "disconnect" }
  | { method: "writeRecords"; params: WriteRequest }
  /** A lattice://write request, signed as the account the person chooses: no connection needed. */
  | { method: "openRequest"; params: WriteIntent }
  | { method: "signMessage"; params: { text: string } };

const INT64_MAX = (1n << 63n) - 1n;
export const MAX_PAYMENTS = 16;
export const MAX_MESSAGE_BYTES = 4096;

const decimal = (value: unknown, max: bigint): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= max;
const optionalString = (value: unknown) => value === undefined || typeof value === "string";

/** The call, or why it is refused. Nothing outside these shapes is passed on. */
export function parseProviderCall(raw: unknown): ProviderCall | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "Malformed request" };
  const { method, params } = raw as { method?: unknown; params?: unknown };
  if (method === "connect" || method === "address" || method === "disconnect") return { method };
  if (method === "signMessage") {
    const text = (params as { text?: unknown } | null)?.text;
    const refused = messageError(text);
    return refused ? { error: refused } : { method, params: { text: text as string } };
  }
  if (method === "openRequest") {
    const uri = (params as { uri?: unknown } | null)?.uri;
    if (typeof uri !== "string") return { error: "openRequest needs a lattice://write request" };
    try { return { method, params: decodeWriteRequest(uri) }; } catch (e) { return { error: (e as Error).message }; }
  }
  if (method !== "writeRecords") return { error: `Unknown method: ${String(method)}` };
  if (typeof params !== "object" || params === null) return { error: "writeRecords needs params" };
  const { chainPath, actions, payments, fee } = params as Record<string, unknown>;
  // Each part on its own: joined, a part holding "/" would pass as two.
  const path = Array.isArray(chainPath) && chainPath.every((part) => typeof part === "string" && !part.includes("/"))
    ? parseChainPath(chainPath.join("/")) : null;
  if (!path) return { error: "Invalid chain path" };
  if (!Array.isArray(actions) || actions.length === 0) return { error: "Nothing to write" };
  const clean: RecordAction[] = [];
  for (const action of actions) {
    if (typeof action !== "object" || action === null) return { error: "Malformed action" };
    const { key, oldValue, newValue } = action as Record<string, unknown>;
    if (typeof key !== "string" || !key || !optionalString(oldValue) || !optionalString(newValue)) return { error: "Malformed action" };
    if (oldValue === undefined && newValue === undefined) return { error: "An action must change its key" };
    clean.push({ key, ...(oldValue === undefined ? {} : { oldValue: oldValue as string }), ...(newValue === undefined ? {} : { newValue: newValue as string }) });
  }
  if (!decimal(fee, INT64_MAX)) return { error: "fee must be a decimal integer" };
  const paid = parsePayments(payments, BigInt(fee));
  if ("error" in paid) return paid;
  return { method, params: { chainPath: path, actions: clean, ...(paid.length ? { payments: paid } : {}), fee } };
}

/** Each payee a canonical address, once; each amount above zero; all of it and the fee within one debit. */
export function parsePayments(raw: unknown, fee: bigint): Payment[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PAYMENTS) return { error: `payments must be a list of at most ${MAX_PAYMENTS}` };
  const clean: Payment[] = [];
  let total = fee;
  for (const payment of raw) {
    const { to, amount } = (payment ?? {}) as Record<string, unknown>;
    if (typeof to !== "string" || !isAccountAddress(to)) return { error: "A payment must go to a Lattice account address" };
    if (clean.some((p) => p.to === to)) return { error: "Each payee may appear once" };
    if (!decimal(amount, INT64_MAX) || amount === "0") return { error: "A payment amount must be a decimal integer above zero" };
    total += BigInt(amount);
    if (total > INT64_MAX) return { error: "The payments and fee together are too large" };
    clean.push({ to, amount });
  }
  return clean;
}

/** What a debit of the connected account comes to: every payment plus the fee. */
export const totalDebit = (write: Pick<WriteRequest, "payments" | "fee">): bigint =>
  (write.payments ?? []).reduce((sum, p) => sum + BigInt(p.amount), BigInt(write.fee));

// ---- signed messages ----
// The signed bytes start "lattice-message:", and a transaction's start
// "lattice-tx-v1:" (the SDK's SIGNATURE_DOMAIN), so a message signature is
// never a transaction signature. The page's origin is inside, so a
// signature taken on one site does not verify for another.

export const MESSAGE_PREFIX = "lattice-message:";

/** Why a message text is refused, or null. Printable only, so nothing in it is hidden from the person. */
export function messageError(text: unknown): string | null {
  if (typeof text !== "string" || !text) return "signMessage needs text";
  if (utf8ToBytes(text).length > MAX_MESSAGE_BYTES) return `A message may be at most ${MAX_MESSAGE_BYTES} bytes`;
  // Line breaks are allowed; other controls, format characters (bidi
  // overrides, zero-width), lone surrogates and blank look-alikes are not.
  if (/[^\S ]|[\p{C}\p{Zl}\p{Zp}\u115f\u1160\u2800\u3164\uffa0]/u.test(text.replaceAll("\n", ""))) {
    return "A message may hold only printable text and line breaks";
  }
  return null;
}

/** The bytes signed for `text` asked by `origin`; a verifier rebuilds them with the origin it expects. */
export const messageBytes = (origin: string, text: string): Uint8Array => utf8ToBytes(`${MESSAGE_PREFIX}${origin}\n${text}`);

/** A nonce as the signer takes it: a decimal UInt64. */
export const isNonce = (value: unknown): value is string => decimal(value, (1n << 64n) - 1n);

export function parseRecordsWrite(params: unknown): WriteRequest | { error: string } {
  const call = parseProviderCall({ method: "writeRecords", params });
  return "error" in call ? call : call.method === "writeRecords" ? call.params : { error: "Malformed request" };
}

/** The origin a request comes from: only a top-level http(s) page. */
export function pageOrigin(sender: { origin?: string; frameId?: number; tab?: unknown }): string | null {
  if (!sender.tab || sender.frameId !== 0 || !sender.origin) return null;
  try {
    const url = new URL(sender.origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === sender.origin ? sender.origin : null;
  } catch {
    return null;
  }
}
