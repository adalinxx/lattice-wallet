// The wallet, not the page, chooses a write's nonce.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chosenNodes, knownPending, livePageWrites, nextNonce } from "../src/lib/wallet/nonce.ts";
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

test("every transaction the wallet knows may be pending takes its nonce: sends, deposits, receipts, withdrawals, page writes", () => {
  const signed = (chainPath: string[], signer: string, nonce: string) =>
    ({ payload: { transaction: { signatures: {}, body: { chainPath, signers: [signer], nonce } } } }) as never;
  const settings = {
    ...DEFAULT_SETTINGS,
    pendingSubmissions: [{ chain: "Nexus", from: "a", nonce: "1", cid: "c", to: "b", amount: "1", fee: "1", at: 0, signedSubmit: signed(["Nexus"], "a", "1") }],
    openDeposits: [{ childChain: ["Nexus", "x"], parentChain: ["Nexus"], demander: "a", transactionNonce: "2" } as never],
    openPurchases: [{ receiptSubmit: signed(["Nexus"], "a", "3"), withdrawalAttempts: [signed(["Nexus", "x"], "a", "4"), signed(["Nexus", "x"], "a", "5")] } as never],
  };
  const pending = knownPending(settings, [{ chain: "Nexus/x", from: "a", nonce: "6" }]);
  assert.equal(nextNonce(1n, "Nexus", "a", pending), 2n, "send 1 taken");
  assert.equal(nextNonce(2n, "Nexus", "a", pending), 2n);
  assert.equal(nextNonce(3n, "Nexus", "a", pending), 4n, "receipt 3 taken");
  assert.equal(nextNonce(2n, "Nexus/x", "a", pending), 3n, "deposit 2 taken");
  assert.equal(nextNonce(4n, "Nexus/x", "a", pending), 7n, "withdrawals 4, 5 and page write 6 taken");
});

test("a page write keeps its nonce only while the node's pool holds it", () => {
  const writes = [
    { chain: "Nexus/s", from: "a", nonce: "4", cid: "in-pool" },
    { chain: "Nexus/s", from: "a", nonce: "5", cid: "never-admitted" },
    { chain: "Nexus/s", from: "a", nonce: "2", cid: "landed" },
    { chain: "Nexus/t", from: "a", nonce: "9", cid: "other-chain" },
  ];
  const live = livePageWrites(writes, "Nexus/s", 4n, new Set(["in-pool"]));
  assert.deepEqual(live.map((w) => w.cid), ["in-pool", "other-chain"]);
  assert.equal(nextNonce(4n, "Nexus/s", "a", live), 5n, "5 is free again: its write never reached the pool");
});
