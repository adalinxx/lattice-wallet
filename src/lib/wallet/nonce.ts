// The nonce a page's write is signed with, chosen by the wallet: a page that
// chose it could take the nonce of one of the person's pending transactions
// and cancel it. Pure, so it is testable without the extension.

import { ROOT_CHAIN } from "../config.ts";
import type { Settings } from "./settings.ts";

/** A transaction this wallet signed whose outcome it has not seen yet. */
export interface KnownPending { chain: string; from: string; nonce: string }

/**
 * The next nonce free for `from` on `chain`: the account's nonce on chain,
 * moved past every transaction this wallet knows is pending there.
 */
export function nextNonce(stateNonce: bigint, chain: string, from: string, pending: readonly KnownPending[]): bigint {
  const taken = new Set(pending.filter((p) => p.chain === chain && p.from === from).map((p) => BigInt(p.nonce)));
  let nonce = stateNonce;
  while (taken.has(nonce)) nonce += 1n;
  return nonce;
}

/**
 * Nodes to read `chainPath` from, the person's own choices first: the node
 * chosen for the chain, then those chosen for its ancestors, deepest first
 * (a node that hosts a chain often hosts its children).
 */
export function chosenNodes(settings: Settings, chainPath: readonly string[]): string[] {
  const urls: string[] = [];
  for (let depth = chainPath.length; depth >= 1; depth--) {
    const url = settings.endpoints[chainPath.slice(0, depth).join("/")]?.url;
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** Where discovery starts: the person's Nexus node, else the hosted reader. */
export const discoveryStart = (settings: Settings, fallback: string) => settings.endpoints[ROOT_CHAIN]?.url ?? fallback;
