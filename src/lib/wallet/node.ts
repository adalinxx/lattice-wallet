// The wallet's use of the SDK's node plane: reads (NodeClient), discovery
// (EndpointResolver), submission (HTTPTransactionSubmitter), and how their
// answers read to the user. Nothing here names a node: every URL is the user's.

import {
  EndpointResolver,
  NodeClient,
  NodeError,
  OPERATOR_DECLARED,
  type Fetch,
  type ResolvedEndpoint,
} from "@adalinxx/lattice-client";
import { HTTPTransactionSubmitter, SubmissionError, type SubmissionRefusal, type TransactionSubmitter } from "@adalinxx/lattice-relay";
import { ROOT_CHAIN } from "../config.ts";
import type { SignedSubmit } from "./types.ts";

// A browser's fetch must be called unbound from any other object (the SDK
// stores it as a field): always hand the SDK this wrapper.
export const browserFetch: Fetch = (input, init) => fetch(input, init);

export function reader(url: string, chainPath: string[], fetchImpl: Fetch = browserFetch): NodeClient {
  return new NodeClient(url, chainPath, { fetch: fetchImpl });
}

export function submitter(url: string, fetchImpl: Fetch = browserFetch): HTTPTransactionSubmitter {
  return new HTTPTransactionSubmitter(`${url}/transactions`, { fetch: fetchImpl });
}

/** Verified-declared endpoints of `chainPath`, walked down from a Nexus node the user chose. */
export function discover(startURL: string, chainPath: string[], fetchImpl: Fetch = browserFetch): Promise<ResolvedEndpoint[]> {
  return new EndpointResolver(reader(startURL, [ROOT_CHAIN], fetchImpl), { fetch: fetchImpl }).resolve(chainPath);
}
export { OPERATOR_DECLARED };

const REFUSALS: Record<SubmissionRefusal, string> = {
  belowMinRelayFee: "the fee is below this node's minimum relay fee; raise the fee or use another node",
  feeTooLow: "a transaction with this nonce is already pending; a replacement must pay a higher fee",
  conflictingNonce: "this nonce is taken by a conflicting pending transaction",
  invalidState: "the chain's current state rejects it (balance or nonce changed?)",
  tooLarge: "the transaction is too large for this node's pool",
  full: "this node's pool is full; try later or raise the fee",
  unresolved: "the node could not resolve the transaction's content",
  contextChanged: "the chain moved while the node checked it; try again",
  unknownChain: "this node does not host that chain",
  shuttingDown: "the node is shutting down",
  requestTooLarge: "the request is too large for this node",
};

/** A node answered a submission with a CID other than the one the wallet computed. */
export class CIDMismatchError extends Error {
  readonly expected: string;
  readonly reported: string;
  constructor(expected: string, reported: string) {
    super(`the node reported transaction ${reported}, not ${expected}`);
    this.expected = expected;
    this.reported = reported;
  }
}

/**
 * Submit a signed transfer and hold the node to the CID computed locally: the
 * returned CID is the wallet's own, never taken on the node's word.
 */
export async function submitChecked(relay: TransactionSubmitter, signed: SignedSubmit): Promise<string> {
  const { transactionCID } = await relay.submit(signed.payload);
  if (transactionCID !== signed.transactionCID) throw new CIDMismatchError(signed.transactionCID, transactionCID);
  return signed.transactionCID;
}

/** A refusal or failure, in words, keeping the node's own name for it. */
export function describe(e: unknown): string {
  if (e instanceof CIDMismatchError) return "unexpected answer from node: " + e.message;
  if (e instanceof SubmissionError) {
    if (e.reason) return `refused (${e.reason}): ${REFUSALS[e.reason]}`;
    if (e.status === 404 && !e.refusal) return "refused: this endpoint does not accept transactions";
    if (e.status === 429) return "refused: " + (e.refusal ?? "rate limited");
    return "refused: " + (e.refusal ?? `HTTP ${e.status}`);
  }
  if (e instanceof NodeError) {
    if (e.status === 404 && !e.refusal) return "not found (this node does not serve that chain or route)";
    if (e.status === 429) return "refused: " + (e.refusal ?? "rate limited");
    return "refused: " + (e.refusal ?? `HTTP ${e.status}`);
  }
  if (isWireMismatch(e)) return "unexpected answer from node: " + e.message;
  return "node unreachable";
}

/** The SDK's wire parsers throw TypeError("<field> must be …"); fetch's network failures are TypeErrors too. */
function isWireMismatch(e: unknown): e is TypeError {
  return e instanceof TypeError && / must (?:be|not) /.test(e.message);
}

/**
 * A fee under the endpoint's own relay floor (its policy, never consensus):
 * a warning to show, not a value to clamp. Undefined when the fee clears it or
 * the endpoint reports none.
 */
export function feeWarning(fee: bigint, minRelayFee: bigint | undefined): string | undefined {
  if (minRelayFee === undefined || fee >= minRelayFee) return undefined;
  return `This node relays only fees of at least ${minRelayFee}; it will likely refuse a fee of ${fee}.`;
}

export type SentStatus =
  | { kind: "included"; height: bigint; hash: string }
  | { kind: "pending" }
  | { kind: "nonce spent" }
  | { kind: "replaced" }
  | { kind: "pending or dropped" }
  | { kind: "unknown to node" };

export function statusText(s: SentStatus): string {
  switch (s.kind) {
    case "included": return `included in block ${s.height}`;
    case "pending": return "pending";
    case "nonce spent": return "nonce spent (this node does not report inclusion)";
    case "replaced": return "not included; its nonce was spent by another transaction";
    case "pending or dropped": return "pending or dropped";
    case "unknown to node": return "unknown to node";
  }
}

/**
 * Where a sent transaction stands. The node reports inclusion on the
 * canonical chain (`blockHeight`/`blockHash`); without it the transaction is
 * pending while in the pool. Only a node too old to report inclusion (its
 * answer does not parse as the current wire) falls back to the signer's
 * nonce, which needs the sender and nonce the wallet recorded.
 */
export async function sentStatus(
  client: NodeClient,
  cid: string,
  recorded?: { from: string; nonce: bigint },
): Promise<SentStatus> {
  let blockHeight: bigint | undefined, blockHash: string | undefined;
  let signer = recorded?.from, nonce = recorded?.nonce;
  let reportsInclusion = true;
  try {
    const tx = await client.transaction(cid);
    ({ blockHeight, blockHash } = tx);
    signer = tx.signers[0];
    nonce = tx.nonce;
  } catch (e) {
    if (e instanceof NodeError && e.status === 404) return { kind: "unknown to node" };
    if (!isWireMismatch(e) || recorded === undefined) throw e;
    reportsInclusion = false;
  }
  if (blockHeight !== undefined && blockHash !== undefined) return { kind: "included", height: blockHeight, hash: blockHash };
  if ((await client.mempool()).transactions.includes(cid)) return { kind: "pending" };
  if (signer !== undefined && nonce !== undefined && (await client.account(signer)).nonce > nonce) {
    if (!reportsInclusion) return { kind: "nonce spent" };
    // It may have been mined between the first read and this one.
    const again = await client.transaction(cid);
    if (again.blockHeight !== undefined && again.blockHash !== undefined) {
      return { kind: "included", height: again.blockHeight, hash: again.blockHash };
    }
    return { kind: "replaced" };
  }
  // The mempool listing is bounded: absence from it is not proof of absence.
  return { kind: "pending or dropped" };
}
