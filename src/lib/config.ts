// Chain paths and node URLs. The wallet ships NO node URL: the user supplies
// their own node, or picks an endpoint discovered from a node they chose.

export const ROOT_CHAIN = "Nexus";

/** "Nexus/Alpha" -> ["Nexus","Alpha"]; null unless Nexus-rooted with plain names. */
export function parseChainPath(text: string): string[] | null {
  const parts = text.trim().split("/");
  if (parts[0] !== ROOT_CHAIN) return null;
  if (!parts.every((p) => /^[A-Za-z0-9_-]{1,64}$/.test(p))) return null;
  return parts;
}

export const chainKey = (path: string[]) => path.join("/");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A node base URL: absolute https, or http on loopback only (the extension's
 * CSP allows exactly that), with no credentials, query or fragment. Returned
 * without a trailing slash; null when not acceptable.
 */
export function normalizeNodeURL(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/**
 * A host a stranger may name without making the wallet dial the user's own
 * network: no loopback, private, link-local, CGNAT or ULA literal, no
 * localhost / .local / .internal name. Applies to DISCOVERED URLs only; a URL
 * the user typed may be anything normalizeNodeURL accepts.
 */
export function isPublicHost(nodeURL: string): boolean {
  const host = new URL(nodeURL).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (host.includes(":")) {
    return !(host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:"));
  }
  return true;
}

/** The host-permission match pattern for a node URL (match patterns carry no port). */
export function originPattern(nodeURL: string): string {
  const url = new URL(nodeURL);
  return `${url.protocol}//${url.hostname}/*`;
}
