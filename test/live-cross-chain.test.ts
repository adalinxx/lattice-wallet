// Read-only verification of an actual wallet-driven trade. Never signs or submits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { activeDeposits, depositValues, reader, receiptWithdrawer, sentStatus } from "../src/lib/wallet/node.ts";
import { isAccountAddress } from "../src/lib/wallet/session.ts";
import { dagCborCIDBytes } from "@adalinxx/lattice-core";

const evidenceFile = process.env.LATTICE_TRADE_EVIDENCE;
test("deployed funded trade: inclusion, receipt owner, and spent deposit proofs", { skip: !evidenceFile, timeout: 120_000 }, async () => {
  const e = JSON.parse(await readFile(evidenceFile!, "utf8"));
  assert.ok(Array.isArray(e.parentChain) && e.parentChain.length > 0);
  assert.ok(Array.isArray(e.childChain) && e.childChain.length === e.parentChain.length + 1);
  assert.deepEqual(e.childChain.slice(0, -1), e.parentChain);
  assert.ok([...e.parentChain, ...e.childChain].every((part) => typeof part === "string" && /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".."));
  assert.ok(isAccountAddress(e.buyer) && isAccountAddress(e.seller));
  for (const cid of [e.depositCID, e.receiptCID, e.withdrawalCID]) dagCborCIDBytes(cid);
  for (const value of [e.amountDemanded, e.amountDeposited, e.depositNonce]) assert.match(value, /^(0|[1-9][0-9]*)$/);
  const offer = { demander: e.seller, amountDemanded: BigInt(e.amountDemanded), amountDeposited: BigInt(e.amountDeposited), depositNonce: BigInt(e.depositNonce) };
  assert.ok(offer.amountDemanded > 0n && offer.amountDeposited > 0n);
  const parent = reader(e.parentURL, e.parentChain);
  const child = reader(e.childURL, e.childChain);
  assert.deepEqual((await parent.chainInfo()).chain, e.parentChain);
  assert.deepEqual((await child.chainInfo()).chain, e.childChain);
  let stable = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parentTip = await parent.latestBlock();
    const childTip = await child.latestBlock();
    try {
      const commitment = (await parent.children(parentTip.hash)).find((entry) => entry.directory === e.childChain.at(-1));
      assert.equal(commitment?.blockHash, childTip.hash, "child must match the parent-reported commitment");
      const statuses = await Promise.all([
        sentStatus(child, e.depositCID), sentStatus(parent, e.receiptCID), sentStatus(child, e.withdrawalCID),
      ]);
      for (const [index, status] of statuses.entries()) {
        assert.equal(status.kind, "included", `transaction ${index} must be included`);
        if (status.kind !== "included") throw new Error("missing inclusion");
        const tip = index === 1 ? parentTip : childTip;
        assert.ok(tip.height - status.height + 1n >= 6n, "wait for six confirmations");
        assert.equal((await (index === 1 ? parent : child).block(status.height)).hash, status.hash, "inclusion must match current node chain");
      }
      assert.equal(await receiptWithdrawer(e.parentURL, e.parentChain, e.childChain, offer, fetch, undefined, parentTip.hash), e.buyer);
      const key = `${offer.demander}/${offer.amountDemanded}/${offer.depositNonce}`;
      assert.equal((await depositValues(e.childURL, e.childChain, [key], fetch, undefined, childTip.hash)).get(key), 0n);
      assert.ok(!(await activeDeposits(e.childURL, e.childChain, fetch, undefined, childTip.hash)).some((row) => row.demander === offer.demander && row.amountDemanded === offer.amountDemanded && row.depositNonce === offer.depositNonce), "spent offer must not be advertised");
      if ((await parent.latestBlock()).hash !== parentTip.hash || (await child.latestBlock()).hash !== childTip.hash) continue;
      stable = true;
      console.log("[funded trade] verified operator-reported inclusion and proof consistency; not independent consensus verification");
      break;
    } catch (error) {
      if ((await parent.latestBlock()).hash === parentTip.hash && (await child.latestBlock()).hash === childTip.hash) throw error;
    }
  }
  assert.ok(stable, "tips kept moving; rerun without paying again");
});
