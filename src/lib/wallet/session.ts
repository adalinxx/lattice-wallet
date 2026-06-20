// Pure session logic: turn decrypted WalletData into live accounts (with private
// keys, held only in worker memory) and the secret-free AccountView list. Kept
// dependency-light and pure so it is unit-testable without the extension.

import { deriveAccount, importPrivateKey, type Account } from "../crypto/accounts.ts";
import type { WalletData, AccountView } from "./types.ts";

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
