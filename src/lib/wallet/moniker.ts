// Moniker, the shared profile chain where accounts hold @handles. An
// account's default handle is the record `user/<account>/name`. The wallet
// learns it only from what the account signs there, never by asking a node:
// looking up every account of a wallet on one node would link them.

import type { AccountView } from "./types.ts";

/** Moniker's chains. The trial path changes when the trial chain is relaunched; the old one stays while apps move. */
export const MONIKER_CHAINS: readonly (readonly string[])[] = [["Nexus", "moniker"], ["Nexus", "testnet", "moniker-da6f57"], ["Nexus", "testnet", "moniker-8eb926"]];

const HANDLE = /^[a-z0-9_]+$/;

export const isMonikerChain = (chainPath: readonly string[]) =>
  MONIKER_CHAINS.some((chain) => chain.join("/") === chainPath.join("/"));

/** A label the wallet chose: the default name, or a handle it took from a write. */
export function automaticLabel(account: Pick<AccountView, "kind" | "index" | "label">): boolean {
  const fallback = account.kind === "hd" ? `Account ${account.index + 1}` : `Imported ${account.index + 1}`;
  return account.label === fallback || (account.label.startsWith("@") && HANDLE.test(account.label.slice(1)));
}

/**
 * The label `account` takes after a write it signed lands: "@<handle>" when the
 * write sets its own default handle on Moniker and its label is still one the
 * wallet chose; else null.
 */
export function handleLabel(write: { chainPath: readonly string[]; actions: readonly { key: string; newValue?: string }[] },
  account: Pick<AccountView, "address" | "kind" | "index" | "label">): string | null {
  if (!isMonikerChain(write.chainPath) || !automaticLabel(account)) return null;
  const handle = write.actions.filter((a) => a.key === `user/${account.address}/name`).at(-1)?.newValue;
  if (handle === undefined || !HANDLE.test(handle) || account.label === `@${handle}`) return null;
  return `@${handle}`;
}
