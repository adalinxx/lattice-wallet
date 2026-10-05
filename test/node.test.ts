// Node URLs, the node client, and recursive endpoint discovery, over a
// scripted fetch: no default node, named refusals, and an endpoint accepted
// only when it serves the block its parent commits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNodeURL, parseChainPath, originPattern } from "../src/lib/config.ts";
import { NodeClient, NodeError, type Fetch } from "../src/lib/rpc/client.ts";
import { discover } from "../src/lib/rpc/discovery.ts";
import { loadSettings, recordSent, DEFAULT_SETTINGS } from "../src/lib/wallet/settings.ts";

test("no default node, and only https or loopback http", async () => {
  assert.deepEqual((await loadSettings({ get: async () => ({}), set: async () => {} })).endpoints, {});
  assert.deepEqual(DEFAULT_SETTINGS.endpoints, {});
  assert.equal(normalizeNodeURL("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(normalizeNodeURL("https://reads.example.org/base/"), "https://reads.example.org/base");
  for (const bad of ["http://reads.example.org", "ftp://x", "https://u:p@x.org", "https://x.org/?q=1", "x.org"]) {
    assert.equal(normalizeNodeURL(bad), null, bad);
  }
  assert.equal(originPattern("http://127.0.0.1:8080"), "http://127.0.0.1/*");
  assert.deepEqual(parseChainPath("Nexus/testnet"), ["Nexus", "testnet"]);
  assert.equal(parseChainPath("testnet"), null);
  assert.equal(parseChainPath("Nexus//x"), null);
});

test("recordSent keeps newest first, deduplicated", () => {
  let s = recordSent(DEFAULT_SETTINGS, "Nexus", { cid: "a", to: "t", amount: "1", at: 1 });
  s = recordSent(s, "Nexus", { cid: "b", to: "t", amount: "1", at: 2 });
  s = recordSent(s, "Nexus", { cid: "a", to: "t", amount: "1", at: 3 });
  assert.deepEqual(s.sent.Nexus.map((t) => t.cid), ["a", "b"]);
});

type Route = (url: URL, init?: RequestInit) => { status: number; body: unknown } | undefined;
function scripted(routes: Route): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      const answer = routes(new URL(input), init) ?? { status: 404, body: { error: { message: "Not Found" } } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    },
  };
}

test("reads name their chain and refusals keep the node's name", async () => {
  const { fetch, calls } = scripted((url, init) => {
    if (url.pathname === "/api/state/account/bafyx") return { status: 200, body: { owner: "bafyx", balance: 7, nonce: 2 } };
    if (url.pathname === "/transactions" && init?.method === "POST") return { status: 400, body: { error: { message: "feeTooLow" } } };
  });
  const client = new NodeClient("http://127.0.0.1:8080", ["Nexus", "testnet"], fetch);
  assert.deepEqual(await client.account("bafyx"), { owner: "bafyx", balance: 7, nonce: 2 });
  assert.equal(calls[0], "GET http://127.0.0.1:8080/api/state/account/bafyx?chainPath=Nexus%2Ftestnet");
  await assert.rejects(client.submit("{}"), (e: unknown) => e instanceof NodeError && e.status === 400 && e.refusal === "feeTooLow");
  assert.equal(calls[1], "POST http://127.0.0.1:8080/transactions");
});

test("discovery walks Nexus -> A -> B, accepting only endpoints that serve the committed block", async () => {
  const committedA = "bafyA", committedB = "bafyB";
  const { fetch } = scripted((url) => {
    const host = url.host, path = url.pathname, chain = url.searchParams.get("chainPath");
    if (host === "start.example" && path === "/api/chain/endpoints" && chain === "Nexus/A") {
      return { status: 200, body: { chainPath: ["Nexus", "A"], committedBlock: committedA,
        endpoints: ["https://liar.example", "https://a.example"], submitEndpoints: ["https://a.example"] } };
    }
    if (host === "a.example" && path === "/api/block/bafyA" && chain === "Nexus/A") return { status: 200, body: { hash: committedA, height: 3 } };
    if (host === "liar.example" && path === "/api/block/bafyA") return { status: 200, body: { hash: "bafyOther", height: 3 } };
    if (host === "a.example" && path === "/api/chain/endpoints" && chain === "Nexus/A/B") {
      // An older node: no submitEndpoints.
      return { status: 200, body: { chainPath: ["Nexus", "A", "B"], committedBlock: committedB, endpoints: ["https://b.example"] } };
    }
    if (host === "b.example" && path === "/api/block/bafyB" && chain === "Nexus/A/B") return { status: 200, body: { hash: committedB, height: 1 } };
    if (host === "b.example" && path === "/api/chain/info") return { status: 200, body: { chain: ["Nexus", "A", "B"], acceptsSubmit: true } };
  });
  const a = await discover("https://start.example", ["Nexus", "A"], fetch);
  assert.deepEqual(a.map((e) => e.url), ["https://a.example"], "the liar does not serve the committed block");
  assert.equal(a[0].acceptsSubmit, false, "declared but its own /api/chain/info does not confirm");
  const b = await discover("https://start.example", ["Nexus", "A", "B"], fetch);
  assert.deepEqual(b.map((e) => [e.url, e.acceptsSubmit]), [["https://b.example", false]], "an undeclared submit is not assumed");
});
