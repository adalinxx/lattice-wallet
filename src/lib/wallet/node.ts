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
import { assertCID, decodeDagCbor, type DagCborValue } from "@adalinxx/lattice-core";
import { verifyVolume, type VolumeEntry } from "@adalinxx/lattice-volumes";
import { sha256 } from "@noble/hashes/sha2.js";
import { ROOT_CHAIN } from "../config.ts";
import type { SignedSubmit } from "./types.ts";

// A browser's fetch must be called unbound from any other object (the SDK
// stores it as a field): always hand the SDK this wrapper.
export const browserFetch: Fetch = (input, init) => fetch(input, init);

/** `authorization`: a paired node's cookie header (its operator port requires it). */
export function reader(url: string, chainPath: string[], fetchImpl: Fetch = browserFetch, authorization?: string): NodeClient {
  return new NodeClient(url, chainPath, { fetch: fetchImpl, ...(authorization === undefined ? {} : { authorization }) });
}

export function submitter(url: string, fetchImpl: Fetch = browserFetch, authorization?: string): HTTPTransactionSubmitter {
  return new HTTPTransactionSubmitter(`${url}/transactions`, { fetch: fetchImpl, ...(authorization === undefined ? {} : { authorization }) });
}

export interface ActiveDeposit {
  demander: string;
  amountDemanded: bigint;
  depositNonce: bigint;
  amountDeposited: bigint;
}

function unsigned(value: unknown, name: string, hexadecimal = false): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== "string" || !(hexadecimal ? /^[0-9a-f]+$/i : /^(0|[1-9][0-9]*)$/).test(value)) {
    throw new TypeError(`${name} must be an unsigned ${hexadecimal ? "hex" : "decimal"} integer`);
  }
  return BigInt(hexadecimal ? `0x${value}` : value);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function base64(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new TypeError(`${name} must be base64`);
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function headerCID(value: unknown, name: string): string {
  const header = object(value, name);
  if (typeof header.rawCID !== "string") throw new TypeError(`${name}.rawCID must be a string`);
  return header.rawCID;
}

function proofEntries(value: unknown, name: string, bytesField = "bytes"): VolumeEntry[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value.map((entry, index) => {
    const row = object(entry, `${name}[${index}]`);
    if (typeof row.cid !== "string") throw new TypeError(`${name}[${index}].cid must be a string`);
    return { cid: row.cid, bytes: base64(row[bytesField], `${name}[${index}].${bytesField}`) };
  });
}

function verifyStateProof(value: unknown, kind: "deposits" | "receipts", expectedTip: string): Map<string, string | null> {
  const proof = object(value, "state proof");
  if (proof.blockHash !== expectedTip || proof.dictionary !== kind || typeof proof.stateRoot !== "string"
      || typeof proof.dictionaryRoot !== "string") throw new TypeError("state proof must match the current tip and dictionary");
  const blockNode = object(proof.block, "state proof.block");
  if (blockNode.cid !== expectedTip) throw new TypeError("state proof block CID must match the current tip");
  const blockBytes = base64(blockNode.data, "state proof.block.data");
  assertCID(expectedTip, blockBytes);
  const block = object(decodeDagCbor(blockBytes), "anchor block");
  const blockHeight = unsigned(proof.blockHeight, "state proof.blockHeight");
  if (block.height !== blockHeight) throw new TypeError("anchor block height must match the anchored block");
  if (headerCID(block.postState, "anchor block.postState") !== proof.stateRoot) {
    throw new TypeError("anchor post-state must match the anchored block");
  }
  const entries = proofEntries(proof.witness, "state proof.witness", "data");
  let volume;
  try { volume = verifyVolume({ rootCID: proof.stateRoot, entries }); } catch { throw new TypeError("state proof witness must be content-addressed"); }
  const state = object(volume.decodeRoot(), "anchor state");
  const property = kind === "deposits" ? "depositState" : "receiptState";
  if (headerCID(state[property], `anchor state.${property}`) !== proof.dictionaryRoot) {
    throw new TypeError("state proof dictionary must match the anchored state");
  }
  if (!Array.isArray(proof.claims)) throw new TypeError("state proof.claims must be an array");
  const claims = new Map<string, string | null>();
  for (const [index, raw] of proof.claims.entries()) {
    const claim = object(raw, `state proof.claims[${index}]`);
    if (typeof claim.key !== "string" || !(typeof claim.value === "string" || claim.value === null)) {
      throw new TypeError(`state proof.claims[${index}] must contain a string key and optional value`);
    }
    if (claims.has(claim.key)) throw new TypeError("state proof claims must not repeat a key");
    const expected = claim.value === null ? undefined : kind === "deposits"
      ? unsigned(claim.value, `state proof.claims[${index}].value`) : claim.value;
    if (!verifySparseProof(proof.dictionaryRoot, claim.key, expected, entries)) throw new TypeError("state proof claim must verify");
    claims.set(claim.key, claim.value);
  }
  return claims;
}

function referencedCID(value: DagCborValue | undefined): string | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) return undefined;
  return typeof (value as Record<string, DagCborValue>).rawCID === "string"
    ? (value as Record<string, DagCborValue>).rawCID as string : undefined;
}

export function verifySparseProof(rootCID: string, key: string, expected: bigint | string | undefined, entries: VolumeEntry[]): boolean {
  let volume;
  try { volume = verifyVolume({ rootCID, entries }); } catch { return false; }
  let cid = rootCID;
  let remaining = key;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(cid)) return false;
    visited.add(cid);
    const bytes = volume.bytes(cid);
    if (bytes === undefined) return false;
    let node: Record<string, DagCborValue>;
    try { node = object(decodeDagCbor(bytes), "proof node") as Record<string, DagCborValue>; } catch { return false; }
    if (node.prefix !== undefined) {
      if (typeof node.prefix !== "string") return false;
      if (!remaining.startsWith(node.prefix)) return expected === undefined;
      remaining = remaining.slice(node.prefix.length);
    }
    if (remaining.length === 0) return node.value === undefined ? expected === undefined : node.value === expected;
    if (!Array.isArray(node.children)) return false;
    let next: string | undefined;
    for (const childValue of node.children) {
      if (!childValue || typeof childValue !== "object" || Array.isArray(childValue) || childValue instanceof Uint8Array) return false;
      const child = childValue as Record<string, DagCborValue>;
      if (typeof child.key !== "string" || child.key.length !== 1) return false;
      const childCID = referencedCID(child.value);
      if (childCID === undefined) return false;
      if (child.key === remaining[0]) { if (next !== undefined) return false; next = childCID; }
    }
    if (next === undefined) return expected === undefined;
    if (!volume.has(next)) return false;
    cid = next;
  }
}

function receiptStorageKey(directory: string, demander: string, amountDemanded: bigint, nonce: bigint): string {
  const logical = `${directory}/${demander}/${amountDemanded}/${nonce}`;
  return [...sha256(new TextEncoder().encode(`lattice/receipt-state/v1\0${logical}`))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function nodeJSON(
  url: string, path: string, chainPath: readonly string[], fetchImpl: Fetch, authorization?: string,
): Promise<unknown> {
  const target = new URL(path, `${url}/`);
  target.searchParams.set("chainPath", chainPath.join("/"));
  const response = await fetchImpl(target, { headers: authorization ? { authorization } : undefined });
  if (!response.ok) throw new NodeError(response.status, await response.text());
  return response.json();
}

/** Active, unwithdrawn child deposits advertised as sell offers. */
export async function activeDeposits(
  url: string, chainPath: readonly string[], fetchImpl: Fetch = browserFetch, authorization?: string, expectedTip?: string,
): Promise<ActiveDeposit[]> {
  const info = await reader(url, [...chainPath], fetchImpl, authorization).chainInfo();
  if (info.tipCID === undefined) throw new TypeError("chain tip must be available");
  if (expectedTip !== undefined && info.tipCID !== expectedTip) throw new TypeError("child tip must match its parent-chain commitment");
  const result: ActiveDeposit[] = [];
  let after: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (after !== undefined) query.set("after", after);
    const body = object(await nodeJSON(url, `/api/deposits?${query}`, chainPath, fetchImpl, authorization), "deposits response");
    if (!Array.isArray(body.deposits)) throw new TypeError("deposits response must contain deposits");
    const claims = verifyStateProof(body.proof, "deposits", info.tipCID);
    for (const [index, entry] of body.deposits.entries()) {
      const row = object(entry, `deposits[${index}]`);
      if (typeof row.key !== "string" || typeof row.demander !== "string") throw new TypeError(`deposits[${index}] must contain key and demander`);
      const amountDemanded = unsigned(row.amountDemanded, `deposits[${index}].amountDemanded`);
      const depositNonce = unsigned(row.nonce, `deposits[${index}].nonce`);
      const amountDeposited = unsigned(row.amountDeposited, `deposits[${index}].amountDeposited`);
      if (row.key !== `${row.demander}/${amountDemanded}/${depositNonce}`) throw new TypeError(`deposits[${index}].key must match its fields`);
      if (claims.get(row.key) !== amountDeposited.toString()) throw new TypeError(`deposits[${index}] must have a valid state claim`);
      result.push({ demander: row.demander, amountDemanded, depositNonce, amountDeposited });
    }
    if (body.next === null) return result;
    if (typeof body.next !== "string" || body.next === after) throw new TypeError("deposits response next must advance");
    after = body.next;
  }
  throw new TypeError("deposits response has too many pages");
}

export async function receiptWithdrawer(
  url: string, parentChain: readonly string[], childChain: readonly string[], offer: ActiveDeposit,
  fetchImpl: Fetch = browserFetch, authorization?: string, expectedTip?: string,
): Promise<string | null> {
  const info = await reader(url, [...parentChain], fetchImpl, authorization).chainInfo();
  if (info.tipCID === undefined) throw new TypeError("chain tip must be available");
  if (expectedTip !== undefined && info.tipCID !== expectedTip) throw new TypeError("receipt state must match the current parent tip");
  const path = new URL("/api/receipt-state", `${url}/`);
  path.searchParams.set("demander", offer.demander);
  path.searchParams.set("amount", offer.amountDemanded.toString());
  path.searchParams.set("nonce", offer.depositNonce.toString());
  path.searchParams.set("chainPath", childChain.join("/"));
  const response = await fetchImpl(path, { headers: authorization ? { authorization } : undefined });
  if (!response.ok) throw new NodeError(response.status, await response.text());
  const value = object(await response.json(), "receipt response");
  const claims = verifyStateProof(value.proof, "receipts", info.tipCID);
  const proof = object(value.proof, "receipt proof");
  const directory = childChain.at(-1);
  if (directory === undefined || typeof proof.dictionaryRoot !== "string") throw new TypeError("receipt proof must match the anchored state");
  const receiptKey = receiptStorageKey(directory, offer.demander, offer.amountDemanded, offer.depositNonce);
  const withdrawer = value.exists === false && value.withdrawer === null ? undefined
    : value.exists === true && typeof value.withdrawer === "string" ? value.withdrawer
    : (() => { throw new TypeError("receipt response is malformed"); })();
  if (claims.get(receiptKey) !== (withdrawer ?? null)) {
    throw new TypeError("receipt response must have a valid state proof");
  }
  return withdrawer ?? null;
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
  if ((e instanceof SubmissionError || e instanceof NodeError) && (e.status === 401 || e.status === 403)) return authRefusal(e.status);
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

/** A local node's operator port refused: unpaired, a stale cookie, or this origin not allowed. */
function authRefusal(status: number): string {
  return status === 401
    ? "refused: this node needs its cookie (pair it on the Node screen; the cookie changes when the node restarts)"
    : "refused: this node does not allow this wallet's origin (add it to the node's rpcAllowedOrigins)";
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
