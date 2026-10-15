// How the approval window puts a page's request into words. Everything here
// comes from the request and the wallet's own accounts: nothing is read from
// a node, and nothing about any app is known. Pure, so it is testable without
// the extension.

import type { Payment, RecordAction } from "./provider.ts";

/** An address in groups of four, so it can be compared a group at a time. */
export const addressGroups = (address: string): string[] => address.match(/.{1,4}/g) ?? [];

/** The start and end of an address, as the popup shows one. Never the only check: Details has all of it. */
export const shortAddress = (address: string) => (address.length <= 22 ? address : `${address.slice(0, 12)}…${address.slice(-8)}`);

/**
 * The record that names each payee: the first whose old value holds the
 * payee's address, or null. A write whose old value is not the chain's is
 * refused, so a payee named this way really is in a record the write
 * changes; one named by no record is an address the page alone chose.
 */
export function payeeRecords(actions: readonly RecordAction[], payments: readonly Payment[]): (string | null)[] {
  return payments.map((p) => actions.find((a) => a.oldValue?.includes(p.to))?.key ?? null);
}

/**
 * The payments in the order to show them: those no record names first, as
 * the ones to check most, then the rest, each group as the page sent it.
 */
export function paymentsToShow(actions: readonly RecordAction[], payments: readonly Payment[]): Payment[] {
  const named = payeeRecords(actions, payments);
  return [...payments.filter((_, i) => named[i] === null), ...payments.filter((_, i) => named[i] !== null)];
}

/**
 * What the window calls each address it knows: the signer is "you", a payee
 * is "payee" (numbered when there are several), another of the wallet's
 * accounts is its label.
 */
export function addressNames(you: string, payments: readonly Payment[], accounts: readonly { address: string; label: string }[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const a of accounts) names.set(a.address, a.label);
  payments.forEach((p, i) => names.set(p.to, payments.length === 1 ? "payee" : `payee ${i + 1}`));
  names.set(you, "you");
  return names;
}

export type Segment = { text: string } | { name: string; address: string };

/** `text` split around the addresses in `names`, so each can be shown as its name. */
export function nameAddresses(text: string, names: ReadonlyMap<string, string>): Segment[] {
  const known = [...names.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!known.length) return text ? [{ text }] : [];
  const pattern = new RegExp(known.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const out: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index) });
    out.push({ name: names.get(match[0])!, address: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * Hosts a message names, other than the one asking (or its subdomains and
 * parents): those in URLs, and the site in a Sign-In with Ethereum style
 * first line ("example.com wants you to sign in"), which that standard asks
 * wallets to check. A message for another site, signed here, is the usual
 * phishing shape. Bare words with dots ("notes.txt") are not hosts here: a
 * warning that fires on them would teach people to skip it.
 */
export function otherHosts(text: string, origin: string): string[] {
  const asking = new URL(origin).hostname.toLowerCase();
  const related = (host: string) => host === asking || host.endsWith(`.${asking}`) || asking.endsWith(`.${host}`);
  const found = [
    ...[...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/?#@]*@)?(\[[^\]\s]*\]|[^\s/?#:]+)/gi)].map((m) => m[1]),
    ...[...text.matchAll(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^\s/:]+)(?::\d+)? wants you to sign in/gim)].map((m) => m[1]),
  ].map((host) => host.toLowerCase().replace(/\.$/, ""));
  return [...new Set(found)].filter((host) => !related(host));
}
