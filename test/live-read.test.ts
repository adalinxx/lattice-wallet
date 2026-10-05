// Read-only smoke against a live node the tester names (never submits):
//
//   LATTICE_LIVE_READ=https://<a public read endpoint> node --test test/live-read.test.ts
//
// Skipped unless LATTICE_LIVE_READ is set; the wallet itself names no node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reader, discover, sentStatus, OPERATOR_DECLARED } from "../src/lib/wallet/node.ts";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";

const live = process.env.LATTICE_LIVE_READ;

test("live reads and discovery (read-only)", { skip: !live, timeout: 60_000 }, async () => {
  const nexus = reader(live!, ["Nexus"], fetch);
  const info = await nexus.chainInfo();
  assert.deepEqual(info.chain, ["Nexus"]);
  console.log(`[live] Nexus height ${info.height} tip ${info.tipCID} minRelayFee ${info.minRelayFee} acceptsSubmit ${info.acceptsSubmit}`);
  const latest = await nexus.latestBlock();
  assert.equal((await nexus.block(latest.hash)).hash, latest.hash);
  const account = await nexus.account(importPrivateKey("a1".repeat(32)).address);
  assert.equal(typeof account.balance, "bigint");
  // A well-formed CID that names no transaction.
  assert.equal((await sentStatus(nexus, account.owner)).kind, "unknown to node");

  const testnet = await discover(live!, ["Nexus", "testnet"], fetch);
  assert.ok(testnet.length > 0, "Nexus/testnet has a verified declared endpoint");
  for (const e of testnet) {
    assert.equal(e.trust, OPERATOR_DECLARED);
    const child = await reader(e.url, ["Nexus", "testnet"], fetch).chainInfo();
    assert.deepEqual(child.chain, ["Nexus", "testnet"]);
    console.log(`[live] Nexus/testnet -> ${e.url} (committed ${e.committedBlock}; declares submit: ${e.declaresSubmit}; height ${child.height})`);
  }
});
