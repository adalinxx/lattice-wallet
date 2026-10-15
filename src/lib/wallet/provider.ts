// What a web page may ask of the wallet through `window.lattice`, checked
// before any of it reaches a person or the signer. Pure, so it is testable
// without the extension.

import { parseChainPath } from "../config.ts";

export interface RecordAction { key: string; oldValue?: string; newValue?: string }

/** A page's request to write records: approved by a person, every time. */
export interface WriteRequest {
  chainPath: string[];
  actions: RecordAction[];
  fee: string; // decimal
  nonce: string; // decimal
}

export type ProviderCall =
  | { method: "connect" }
  | { method: "address" }
  | { method: "disconnect" }
  | { method: "writeRecords"; params: WriteRequest };

const decimal = (value: unknown, max: bigint): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= max;
const optionalString = (value: unknown) => value === undefined || typeof value === "string";

/** The call, or why it is refused. Nothing outside these shapes is passed on. */
export function parseProviderCall(raw: unknown): ProviderCall | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "Malformed request" };
  const { method, params } = raw as { method?: unknown; params?: unknown };
  if (method === "connect" || method === "address" || method === "disconnect") return { method };
  if (method !== "writeRecords") return { error: `Unknown method: ${String(method)}` };
  if (typeof params !== "object" || params === null) return { error: "writeRecords needs params" };
  const { chainPath, actions, fee, nonce } = params as Record<string, unknown>;
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
  if (!decimal(fee, (1n << 63n) - 1n)) return { error: "fee must be a decimal integer" };
  if (!decimal(nonce, (1n << 64n) - 1n)) return { error: "nonce must be a decimal integer" };
  return { method, params: { chainPath: path, actions: clean, fee, nonce } };
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
