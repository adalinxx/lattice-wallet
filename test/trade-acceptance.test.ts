import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCommittedChild } from "./helpers/committed-child.ts";

test("funded acceptance permits a child beyond its parent commitment and rejects a fork", async () => {
  const parent = { children: async () => [{ directory: "testnet", blockHash: "committed" }] } as Parameters<typeof assertCommittedChild>[0];
  const reads: (string | bigint)[] = [];
  let fork = false;
  const child = { block: async (key: string | bigint) => {
    reads.push(key);
    return { hash: key === 5n && fork ? "other-branch" : "committed", height: 5n };
  } } as Parameters<typeof assertCommittedChild>[1];
  await assertCommittedChild(parent, child, "parent-tip", "testnet");
  assert.deepEqual(reads, ["committed", 5n], "ancestry is checked by height, without requiring the latest child tip");
  fork = true;
  await assert.rejects(assertCommittedChild(parent, child, "parent-tip", "testnet"), /current chain/);
  await assert.rejects(assertCommittedChild(parent, child, "parent-tip", "missing-child"), /must commit/);
});
