// Trustless transaction construction. The wallet builds the TransactionBody,
// serializes it with our DAG-CBOR encoder, computes bodyCID locally, derives
// the lattice-tx-v1 envelope, and signs — never trusting the node for what is
// signed.

import { encode } from "../crypto/dagcbor.ts";
import { cidV1DagCbor } from "../crypto/cid.ts";
import { buildPreimage } from "./preimage.ts";

export interface TransactionBody {
  accountActions: { owner: string; delta: bigint }[];
  actions: never[];
  depositActions: never[];
  receiptActions: never[];
  withdrawalActions: never[];
  signers: string[];
  nonce: bigint;
  chainPath: string[];
}

const INT64_MAX = (1n << 63n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

/** A single-sender payment. The fee is the balance excess: the sender is
 * debited amount + fee and the recipient credited amount; the miner collects
 * the difference. There is no fee field. */
export function buildTransferBody(args: {
  from: string;
  to: string;
  amount: bigint;
  fee: bigint;
  nonce: bigint;
  chainPath: string[];
}): TransactionBody {
  const { from, to, amount, fee, nonce, chainPath } = args;
  if (amount <= 0n) throw new Error("amount must be positive");
  if (fee < 0n) throw new Error("fee must not be negative");
  if (amount + fee > INT64_MAX) throw new Error("amount + fee too large");
  if (nonce < 0n || nonce > UINT64_MAX) throw new Error("nonce out of range");
  if (from === to) throw new Error("sender and recipient are the same");
  return {
    accountActions: [
      { owner: from, delta: -(amount + fee) },
      { owner: to, delta: amount },
    ],
    actions: [],
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [from],
    nonce,
    chainPath,
  };
}

/** Serialize a body to canonical bytes and its CID. */
export function encodeBody(body: TransactionBody): { bytes: Uint8Array; cid: string } {
  const bytes = encode(body as unknown as Record<string, unknown> as never);
  return { bytes, cid: cidV1DagCbor(bytes) };
}

/** The body's CID and its lattice-tx-v1 signing envelope. */
export function bodyPreimage(body: TransactionBody): { bodyCID: string; bytes: Uint8Array; preimage: string } {
  const { bytes, cid } = encodeBody(body);
  return { bodyCID: cid, bytes, preimage: buildPreimage(cid, body.chainPath, body.nonce) };
}

/** JSON with bigints written as exact integer literals (never through a double). */
function json(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return "[" + value.map(json).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ":" + json(v)).join(",") + "}";
  }
  return JSON.stringify(value);
}

/** The `POST /transactions` body: `{"transaction":{"signatures":{...},"body":{...}}}`. */
export function submitRequestJSON(signatures: Record<string, string>, body: TransactionBody): string {
  return json({ transaction: { signatures, body } });
}
