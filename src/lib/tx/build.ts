// Trustless transaction construction. The wallet builds the TransactionBody,
// serializes it with our DAG-CBOR encoder, computes bodyCID locally, derives
// the signing preimage, and signs — never trusting the node for what is signed.

import { encode } from "../crypto/dagcbor.ts";
import { cidV1DagCbor } from "../crypto/cid.ts";
import { buildPreimage } from "./preimage.ts";

export interface AccountAction {
  owner: string;
  delta: bigint;
}

export interface TransactionBody {
  accountActions: { owner: string; delta: bigint }[];
  actions: never[];
  depositActions: never[];
  genesisActions: never[];
  receiptActions: never[];
  withdrawalActions: never[];
  signers: string[];
  fee: bigint;
  nonce: bigint;
  chainPath: string[];
}

/** Build a TransactionBody for a single-sender payment.
 * Conservation rule (TransactionBody.valueConservation): debits = credits + fee,
 * so the sender pays amount + fee and the recipient receives amount. */
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
  if (fee <= 0n) throw new Error("fee must be positive");
  return {
    accountActions: [
      { owner: from, delta: -(amount + fee) },
      { owner: to, delta: amount },
    ],
    actions: [],
    depositActions: [],
    genesisActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [from],
    fee,
    nonce,
    chainPath,
  };
}

/** Serialize a body to canonical bytes (for bodyData) and its CID. */
export function encodeBody(body: TransactionBody): { bytes: Uint8Array; cid: string } {
  // bigint deltas/fee/nonce are encoded as CBOR integers by the dag-cbor encoder.
  const bytes = encode(body as unknown as Record<string, unknown> as never);
  return { bytes, cid: cidV1DagCbor(bytes) };
}

/** Full preimage for a body (computes bodyCID, then the preimage string). */
export function bodyPreimage(body: TransactionBody): { bodyCID: string; bytes: Uint8Array; preimage: string } {
  const { bytes, cid } = encodeBody(body);
  return { bodyCID: cid, bytes, preimage: buildPreimage(cid, body.chainPath, body.nonce) };
}
