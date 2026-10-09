import { isAccountAddress } from "./session.ts";

const MAX_HANDOFF_LENGTH = 16_384;
const UINT64_MAX = (1n << 64n) - 1n;

interface OrderBase {
  readonly version: 1;
  readonly parentChain: readonly string[];
  readonly childChain: readonly string[];
  readonly asset: "LAT";
  readonly expiresAt: string;
}

export interface SellOrder extends OrderBase {
  readonly side: "sell_child";
  readonly orderType: "limit";
  readonly amountDeposited: string;
  readonly amountDemanded: string;
}

/** One sell deposit, named by the exact terms consensus keys it with. */
export interface SelectedDeposit {
  readonly demander: string;
  readonly amountDemanded: string;
  readonly amountDeposited: string;
  readonly depositNonce: string;
}

/** Buy exactly these deposits, each whole. The list is the requester's claim:
 * the wallet proves every one, and that it is unpaid, before it signs. */
export interface BuyOrder extends OrderBase {
  readonly side: "buy_child";
  readonly orderType: "take";
  readonly deposits: readonly SelectedDeposit[];
}

export type OrderRequest = SellOrder | BuyOrder;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The request is not an object");
  return value as Record<string, unknown>;
};

function chain(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error(`${name} is invalid`);
  }
  if (value[0] !== "Nexus") throw new Error(`${name} must begin with Nexus`);
  return value as string[];
}

function amount(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} is invalid`);
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > UINT64_MAX) throw new Error(`${name} is out of range`);
  return value;
}

function decodeBase64url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("The request encoding is invalid");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
  } catch {
    throw new Error("The request encoding is invalid");
  }
}

/** Decode an untrusted lattice://order handoff. This validates data only; it
 * neither trusts the website nor authorizes a transaction. */
export function decodeOrderRequest(input: string, now = Date.now()): OrderRequest {
  const raw = input.trim();
  if (!raw || raw.length > MAX_HANDOFF_LENGTH) throw new Error("The request is empty or too large");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Paste a lattice://order request"); }
  if (url.protocol !== "lattice:" || url.hostname !== "order" || url.pathname !== "" || url.searchParams.get("v") !== "1") {
    throw new Error("This is not a supported Lattice order request");
  }
  const encoded = url.searchParams.get("intent");
  if (!encoded) throw new Error("The request has no intent");
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(decodeBase64url(encoded))); } catch (e) {
    if (e instanceof SyntaxError) throw new Error("The request JSON is invalid");
    throw e;
  }
  if (value.version !== 1 || value.asset !== "LAT") throw new Error("The request version or asset is unsupported");
  if (typeof value.expiresAt !== "string") throw new Error("The request expiry is invalid");
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) throw new Error("This request has expired");
  const parentChain = chain(value.parentChain, "Parent chain");
  const childChain = chain(value.childChain, "Child chain");
  if (childChain.length !== parentChain.length + 1 || !parentChain.every((part, i) => childChain[i] === part)) {
    throw new Error("The request must use a child chain and its direct parent");
  }
  const base = { version: 1 as const, parentChain, childChain, asset: "LAT" as const, expiresAt: value.expiresAt };
  if (value.side === "sell_child" && value.orderType === "limit") {
    return { ...base, side: value.side, orderType: value.orderType, amountDeposited: amount(value.amountDeposited, "Child amount"), amountDemanded: amount(value.amountDemanded, "Parent amount") };
  }
  if (value.side === "buy_child" && value.orderType === "take") {
    if (!Array.isArray(value.deposits) || value.deposits.length === 0) throw new Error("A buy request must name the sell orders to buy");
    const seen = new Set<string>();
    const deposits = value.deposits.map((entry, index) => {
      const name = `Sell order ${index + 1}`;
      const deposit = record(entry);
      if (typeof deposit.demander !== "string" || !isAccountAddress(deposit.demander)) throw new Error(`${name} has an invalid seller address`);
      if (typeof deposit.depositNonce !== "string" || !/^(0|[1-9]\d*)$/.test(deposit.depositNonce) || BigInt(deposit.depositNonce) > UINT64_MAX) {
        throw new Error(`${name} has an invalid nonce`);
      }
      const selected = {
        demander: deposit.demander,
        amountDemanded: amount(deposit.amountDemanded, `${name} parent amount`),
        amountDeposited: amount(deposit.amountDeposited, `${name} child amount`),
        depositNonce: deposit.depositNonce,
      };
      const key = `${selected.demander}/${selected.amountDemanded}/${selected.depositNonce}`;
      if (seen.has(key)) throw new Error("The request names a sell order twice");
      seen.add(key);
      return selected;
    });
    return { ...base, side: value.side, orderType: value.orderType, deposits };
  }
  if (value.side === "buy_child" && value.orderType === "market") {
    throw new Error("Buying by amount is no longer supported. Choose the sell orders to buy and create a new request.");
  }
  throw new Error("The order side or type is unsupported");
}
