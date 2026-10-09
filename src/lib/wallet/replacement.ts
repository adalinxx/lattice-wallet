import { buildTransfer, encodeTransactionBody, signedTransactionCID, transactionPayload } from "@adalinxx/lattice-core";
import type { PendingSubmission } from "./settings.ts";
import { isAccountAddress } from "./session.ts";

/** Only reproduce an ordinary transfer whose saved display metadata agrees
 * with its complete signed body and CIDs. Never reinterpret a cross-chain action. */
export function replacementTransfer(record: PendingSubmission) {
  try {
    if (!isAccountAddress(record.from) || !isAccountAddress(record.to)) return null;
    if (![record.amount, record.fee, record.nonce].every((value) => /^(0|[1-9][0-9]*)$/.test(value))) return null;
    const args = { from: record.from, to: record.to, amount: BigInt(record.amount), fee: BigInt(record.fee), nonce: BigInt(record.nonce), chainPath: record.chain.split("/") };
    const body = buildTransfer(args);
    const signed = record.signedSubmit;
    if (JSON.stringify(transactionPayload(signed.payload.transaction.signatures, body).transaction.body) !== JSON.stringify(signed.payload.transaction.body)
      || encodeTransactionBody(body).cid !== signed.bodyCID
      || signedTransactionCID(signed.payload.transaction.signatures, body) !== signed.transactionCID
      || record.cid !== signed.transactionCID) return null;
    return args;
  } catch { return null; }
}
