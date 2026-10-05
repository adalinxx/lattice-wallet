// Endpoint discovery, one level at a time from a node the user chose, as the
// explorer does it: a node hosting P answers /api/chain/endpoints for P/D with
// the URLs D's hosts declared (UNVERIFIED) beside the D block P commits. An
// endpoint is accepted only if it serves that committed block at P/D. Each
// level is then asked through an accepted endpoint of the level above.

import { NodeClient, type Fetch } from "./client.ts";
import { normalizeNodeURL, isPublicHost } from "../config.ts";

export interface DiscoveredEndpoint {
  url: string;
  chainPath: string[];
  /** The host declares POST /transactions there (confirmed by its own /api/chain/info). */
  acceptsSubmit: boolean;
  /** Served the block its parent commits: the only check made. */
  committedBlock: string | null;
}

/** Accept a declared URL only if it serves `committedBlock` at `path`. */
async function serves(url: string, path: string[], committedBlock: string | null, fetchImpl: Fetch): Promise<boolean> {
  if (!committedBlock) return false;
  try {
    const block = await new NodeClient(url, path, fetchImpl).block(committedBlock);
    return block.hash === committedBlock;
  } catch {
    return false;
  }
}

async function confirmsSubmit(url: string, path: string[], fetchImpl: Fetch): Promise<boolean> {
  try {
    return (await new NodeClient(url, path, fetchImpl).info()).acceptsSubmit === true;
  } catch {
    return false;
  }
}

/** The accepted endpoints of the child `path`, asked of `parent` (a node hosting path's parent). */
export async function discoverLevel(parent: NodeClient, path: string[], fetchImpl: Fetch): Promise<DiscoveredEndpoint[]> {
  const answer = await parent.endpoints(path);
  const declaredSubmit = new Set((answer.submitEndpoints ?? []).map(normalizeNodeURL).filter((u) => u !== null));
  // A declared URL is a stranger's claim: never one naming the user's own
  // network (loopback, private, link-local), never a duplicate.
  const urls = [...new Set(answer.endpoints.slice(0, 16).map(normalizeNodeURL)
    .filter((u): u is string => u !== null && isPublicHost(u)))];
  const probed = await Promise.all(urls.map(async (url) => {
    if (!(await serves(url, path, answer.committedBlock, fetchImpl))) return null;
    const acceptsSubmit = declaredSubmit.has(url) && (await confirmsSubmit(url, path, fetchImpl));
    return { url, chainPath: path, acceptsSubmit, committedBlock: answer.committedBlock };
  }));
  return probed.filter((e): e is DiscoveredEndpoint => e !== null);
}

/**
 * Walk from `startURL` (a Nexus node the user chose) down to `target`,
 * asking each level through the first accepted endpoint of the level above.
 * Returns the accepted endpoints of `target`.
 */
export async function discover(startURL: string, target: string[], fetchImpl: Fetch): Promise<DiscoveredEndpoint[]> {
  let parentURL = startURL;
  let found: DiscoveredEndpoint[] = [];
  for (let depth = 2; depth <= target.length; depth++) {
    const path = target.slice(0, depth);
    found = await discoverLevel(new NodeClient(parentURL, path.slice(0, -1), fetchImpl), path, fetchImpl);
    if (depth < target.length) {
      // Any accepted endpoint of this level may answer for the next: try each.
      const next = target.slice(0, depth + 1);
      let asked: string | null = null;
      for (const e of found) {
        try {
          await new NodeClient(e.url, path, fetchImpl).endpoints(next);
          asked = e.url;
          break;
        } catch {
          continue;
        }
      }
      if (!asked) throw new Error(`no endpoint of ${path.join("/")} answers for ${next.join("/")}`);
      parentURL = asked;
    }
  }
  return found;
}
