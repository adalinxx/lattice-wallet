// A lattice://write request: records to write and payments to make on one
// chain, for whichever account the person chooses. A page hands it over with
// `lattice.openRequest`, or anyone pastes or scans it into the wallet. Like a
// lattice://order, it is untrusted data: decoding it authorizes nothing, and
// it carries no keys, nonces or node addresses; the wallet chooses those. Its
// fee, like a page write's, is a proposal the review shows; without one the
// wallet uses its own default for the chain.
//
//   lattice://write?v=1&intent=<base64url JSON>
//   { version: 1, chainPath, actions: [{ key, oldValue?, newValue?, ifAbsent? }],
//     payments?: [{ to, amount }], fee?, expiresAt, label? }
//
// `{account}` in a key or a new value stands for the chosen account. An
// action with `ifAbsent` creates its key, or is left out when the key already
// holds a value; the chain refuses the whole write if that changes before it
// lands, so nothing is overwritten.

import { parseChainPath } from "../config.ts";
import { decodeBase64url, MAX_HANDOFF_LENGTH } from "./order.ts";
import { messageError, parsePayments, parseRecordsWrite, type Payment, type RecordAction, type WriteRequest } from "./provider.ts";

export const ACCOUNT = "{account}";
export const MAX_LABEL_LENGTH = 64;

export interface RequestAction extends RecordAction { ifAbsent?: true }

export interface WriteIntent {
  version: 1;
  chainPath: string[];
  actions: RequestAction[];
  payments: Payment[];
  /** Decimal. */
  fee?: string;
  expiresAt: string;
  /** What the request says it is: shown as its own words, never as a verified name. */
  label?: string;
}

const object = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
};
const optionalString = (value: unknown) => value === undefined || typeof value === "string";

/** Decode an untrusted lattice://write request. This validates data only. */
export function decodeWriteRequest(input: string, now = Date.now()): WriteIntent {
  const raw = input.trim();
  if (!raw || raw.length > MAX_HANDOFF_LENGTH) throw new Error("The request is empty or too large");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Paste a lattice://write request"); }
  if (url.protocol !== "lattice:" || url.hostname !== "write" || url.pathname !== "" || url.searchParams.get("v") !== "1") {
    throw new Error("This is not a supported Lattice write request");
  }
  const encoded = url.searchParams.get("intent");
  if (!encoded) throw new Error("The request has no intent");
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(decodeBase64url(encoded)), "The request"); } catch (e) {
    if (e instanceof SyntaxError) throw new Error("The request JSON is invalid");
    throw e;
  }
  if (value.version !== 1) throw new Error("The request version is unsupported");
  if (typeof value.expiresAt !== "string") throw new Error("The request expiry is invalid");
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) throw new Error("This request has expired");
  // Each part on its own: joined, a part holding "/" would pass as two.
  const chainPath = Array.isArray(value.chainPath) && value.chainPath.every((part) => typeof part === "string" && !part.includes("/"))
    ? parseChainPath(value.chainPath.join("/")) : null;
  if (!chainPath) throw new Error("The request's chain is invalid");

  if (!Array.isArray(value.actions) || value.actions.length === 0) throw new Error("The request writes nothing");
  const actions = value.actions.map((entry, index): RequestAction => {
    const name = `Record ${index + 1}`;
    const { key, oldValue, newValue, ifAbsent } = object(entry, name);
    if (typeof key !== "string" || !key || !optionalString(oldValue) || !optionalString(newValue) || (ifAbsent !== undefined && ifAbsent !== true)) {
      throw new Error(`${name} is malformed`);
    }
    if (oldValue === undefined && newValue === undefined) throw new Error(`${name} changes nothing`);
    if (typeof oldValue === "string" && oldValue.includes(ACCOUNT)) throw new Error(`${name}: ${ACCOUNT} may appear only in keys and new values`);
    if (ifAbsent && (oldValue !== undefined || newValue === undefined)) throw new Error(`${name}: a record written only if absent must be new`);
    return {
      key,
      ...(oldValue === undefined ? {} : { oldValue: oldValue as string }),
      ...(newValue === undefined ? {} : { newValue: newValue as string }),
      ...(ifAbsent ? { ifAbsent: true as const } : {}),
    };
  });

  // Payees, amounts and their total are checked as for any page write.
  const payments = parsePayments(value.payments, 0n);
  if ("error" in payments) throw new Error(payments.error);

  if (value.fee !== undefined && (typeof value.fee !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value.fee))) {
    throw new Error("The request's fee is invalid");
  }
  if (value.label !== undefined && (typeof value.label !== "string" || !value.label || value.label.length > MAX_LABEL_LENGTH
    || value.label.includes("\n") || messageError(value.label))) {
    throw new Error("The request's label is invalid");
  }
  return { version: 1, chainPath, actions, payments, ...(value.fee === undefined ? {} : { fee: value.fee as string }), expiresAt: value.expiresAt, ...(value.label === undefined ? {} : { label: value.label as string }) };
}

/** The keys of the records written only if absent, as `account` would write them. */
export const absentKeys = (intent: WriteIntent, account: string): string[] =>
  intent.actions.filter((a) => a.ifAbsent).map((a) => a.key.replaceAll(ACCOUNT, account));

/**
 * The write `intent` makes as `account` at `fee`: `{account}` filled in, and
 * the records written only if absent left out where `present` holds their
 * key. Checked again as any page's write.
 */
export function fillWriteRequest(intent: WriteIntent, account: string, present: ReadonlySet<string>, fee: string): WriteRequest {
  if (intent.payments.some((p) => p.to === account)) throw new Error("This request pays the account you chose. Choose another account.");
  const fill = (text: string) => text.replaceAll(ACCOUNT, account);
  const actions = intent.actions
    .map((a) => ({ ...a, key: fill(a.key), ...(a.newValue === undefined ? {} : { newValue: fill(a.newValue) }) }))
    .filter((a) => !(a.ifAbsent && present.has(a.key)))
    .map(({ ifAbsent: _, ...action }) => action);
  const write = parseRecordsWrite({ chainPath: intent.chainPath, actions, payments: intent.payments, fee });
  if ("error" in write) throw new Error(write.error);
  return write;
}
