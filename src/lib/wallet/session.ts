// Pure session logic: turn decrypted WalletData into live accounts (with private
// keys, held only in worker memory) and the secret-free AccountView list. Kept
// dependency-light and pure so it is unit-testable without the extension.

import { deriveAccount, importPrivateKey, type Account } from "../crypto/accounts.ts";
import { buildTransfer, signTransactionBody, signedTransactionCID, transactionPayload, type TransactionBody } from "@adalinxx/lattice-core";
import type { WalletData, AccountView, SignedSubmit } from "./types.ts";

export interface LiveAccount extends Account {
  label: string;
  kind: "hd" | "imported";
}

/** Reconstruct every account (incl. private keys) from decrypted wallet data. */
export function deriveAccounts(data: WalletData): LiveAccount[] {
  const out: LiveAccount[] = [];
  if (data.mnemonic) {
    for (const { index, label } of data.hd) {
      out.push({ ...deriveAccount(data.mnemonic, index), label, kind: "hd" });
    }
  }
  data.imported.forEach(({ priv, label }, i) => {
    const acct = importPrivateKey(priv);
    out.push({ ...acct, index: i, label, kind: "imported" });
  });
  return out;
}

export function toView(a: LiveAccount): AccountView {
  return { address: a.address, publicKey: a.publicKey, label: a.label, kind: a.kind, index: a.index };
}

export function nextHdLabel(data: WalletData): { index: number; label: string } {
  const index = data.hd.reduce((m, h) => Math.max(m, h.index + 1), 0);
  return { index, label: `Account ${index + 1}` };
}

/**
 * Build and sign a transfer (runs in the worker, the key's only home). The SDK
 * builds the body (fee = debit over credit), encodes it, derives its CID and
 * the lattice-tx-v1 envelope, and signs; the payload is plain JSON. The
 * transaction's CID is computed here, so the node's answer can be checked.
 */
export function signTransfer(
  acct: Account,
  args: { to: string; amount: bigint; fee: bigint; nonce: bigint; chainPath: string[] },
): SignedSubmit {
  const body = buildTransfer({ from: acct.address, ...args });
  const { bodyCID, publicKey, signature } = signTransactionBody(body, acct.privateKey);
  const signatures = { [publicKey]: signature };
  return { payload: transactionPayload(signatures, body), bodyCID, transactionCID: signedTransactionCID(signatures, body) };
}

export function signDeposit(
  acct: Account,
  args: { amountDeposited: bigint; amountDemanded: bigint; depositNonce: bigint; fee: bigint; nonce: bigint; chainPath: string[] },
): SignedSubmit {
  const { amountDeposited, amountDemanded, depositNonce, fee, nonce, chainPath } = args;
  const int64Max = (1n << 63n) - 1n;
  const uint64Max = (1n << 64n) - 1n;
  if (amountDeposited <= 0n) throw new Error("deposited amount must be positive");
  if (amountDemanded <= 0n) throw new Error("demanded amount must be positive");
  if (amountDemanded > uint64Max) throw new Error("demanded amount is out of range");
  if (fee < 0n) throw new Error("fee must not be negative");
  if (amountDeposited + fee > int64Max) throw new Error("deposited amount plus fee is too large");
  if (depositNonce < 0n || depositNonce > uint64Max) throw new Error("deposit nonce is out of range");
  if (chainPath.length < 2) throw new Error("deposits require a child chain");
  const body: TransactionBody = {
    accountActions: [{ owner: acct.address, delta: -(amountDeposited + fee) }],
    actions: [],
    depositActions: [{ nonce: depositNonce, demander: acct.address, amountDemanded, amountDeposited }],
    receiptActions: [], withdrawalActions: [], signers: [acct.address], nonce, chainPath,
  };
  const { bodyCID, publicKey, signature } = signTransactionBody(body, acct.privateKey);
  const signatures = { [publicKey]: signature };
  return { payload: transactionPayload(signatures, body), bodyCID, transactionCID: signedTransactionCID(signatures, body) };
}
