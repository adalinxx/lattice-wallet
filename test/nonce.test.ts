// The wallet, not the page, chooses a write's nonce.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chosenNodes, nextNonce } from "../src/lib/wallet/nonce.ts";
import { DEFAULT_SETTINGS } from "../src/lib/wallet/settings.ts";

test("the next nonce skips every transaction this wallet knows is pending on that chain, from that account", () => {
  const pending = [
    { chain: "Nexus/stoa", from: "a", nonce: "5" },
    { chain: "Nexus/stoa", from: "a", nonce: "6" },
    { chain: "Nexus/stoa", from: "b", nonce: "7" },
    { chain: "Nexus", from: "a", nonce: "7" },
    { chain: "Nexus/stoa", from: "a", nonce: "3" },
  ];
  assert.equal(nextNonce(5n, "Nexus/stoa", "a", pending), 7n);
  assert.equal(nextNonce(4n, "Nexus/stoa", "a", pending), 4n, "a gap is free");
  assert.equal(nextNonce(7n, "Nexus/stoa", "a", pending), 7n, "another account's or chain's pending does not count");
  assert.equal(nextNonce(0n, "Nexus/x", "a", []), 0n);
});

test("nodes are the person's choices: the chain's, then its ancestors', deepest first", () => {
  const settings = { ...DEFAULT_SETTINGS, endpoints: {
    Nexus: { url: "https://nexus.example", acceptsSubmit: true, source: "user" as const },
    "Nexus/stoa": { url: "https://stoa.example", acceptsSubmit: true, source: "discovered" as const },
    "Nexus/stoa/bitcoin": { url: "https://nexus.example", acceptsSubmit: true, source: "user" as const },
  } };
  assert.deepEqual(chosenNodes(settings, ["Nexus", "stoa", "bitcoin"]), ["https://nexus.example", "https://stoa.example"]);
  assert.deepEqual(chosenNodes(settings, ["Nexus", "stoa", "rust"]), ["https://stoa.example", "https://nexus.example"]);
  assert.deepEqual(chosenNodes(DEFAULT_SETTINGS, ["Nexus", "x"]), []);
});
