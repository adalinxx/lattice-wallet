// Pure session logic: turn decrypted WalletData into live accounts (with private
// keys, held only in worker memory) and the secret-free AccountView list. Kept
// dependency-light and pure so it is unit-testable without the extension.

import { deriveAccount, importPrivateKey, type Account } from "../crypto/accounts.ts";
import { buildTransfer, signTransactionBody, transactionPayload } from "@adalinxx/lattice-core";
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
 * the lattice-tx-v1 envelope, and signs; the payload is plain JSON.
 */
export function signTransfer(
  acct: Account,
  args: { to: string; amount: bigint; fee: bigint; nonce: bigint; chainPath: string[] },
): SignedSubmit {
  const body = buildTransfer({ from: acct.address, ...args });
  const { bodyCID, publicKey, signature } = signTransactionBody(body, acct.privateKey);
  return { payload: transactionPayload({ [publicKey]: signature }, body), bodyCID };
}
