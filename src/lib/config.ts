// Chain paths and node URLs. The wallet ships NO node URL: the user supplies
// their own node, or picks an endpoint discovered from a node they chose.

import { normalizeNodeURL as sdkNormalizeNodeURL } from "@adalinxx/lattice-client";

export const ROOT_CHAIN = "Nexus";
/** Optional public Nexus endpoint. It is never selected until the user chooses
 * it and the wallet verifies both the served chain and submission support. */
export const LATTICE_BUILD_RPC = "https://rpc.lattice.build";
/** Optional public Nexus/testnet submit endpoint. It is presented alongside
 * automatic discovery and custom-node entry, never silently selected. */
export const LATTICE_TESTNET_RPC = "https://lattice-mainnet-testnet.fly.dev";
/** Nexus read service used by the explorer and as the default bootstrap for
 * child-chain endpoint discovery. It is never used to submit transactions. */
export const LATTICE_EXPLORER_RPC = "https://lattice-mainnet-read.fly.dev";

/** "Nexus/Alpha" -> ["Nexus","Alpha"]; null unless Nexus-rooted with plain names. */
export function parseChainPath(text: string): string[] | null {
  const parts = text.trim().split("/");
  if (parts[0] !== ROOT_CHAIN) return null;
  if (!parts.every((p) => /^[A-Za-z0-9_-]{1,64}$/.test(p))) return null;
  return parts;
}

export const chainKey = (path: string[]) => path.join("/");

/**
 * A node base URL the user typed: the SDK's rule (absolute https, or http on
 * loopback only, which is exactly what the extension's CSP allows; no
 * credentials, query or fragment), without a trailing slash; null when not
 * acceptable. Declared (discovered) URLs are judged by the SDK's
 * EndpointResolver, which also refuses private hosts.
 */
export function normalizeNodeURL(text: string): string | null {
  let url: string;
  try {
    url = sdkNormalizeNodeURL(text.trim()).replace(/\/+$/, "");
  } catch {
    return null;
  }
  // The CSP's connect-src names these three loopback hosts and no others.
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" || CSP_LOOPBACK.has(hostname) ? url : null;
}

const CSP_LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The host-permission match pattern for a node URL (match patterns carry no port). */
export function originPattern(nodeURL: string): string {
  const url = new URL(nodeURL);
  return `${url.protocol}//${url.hostname}/*`;
}
