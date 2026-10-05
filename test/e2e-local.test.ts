// End to end against a LOCAL node the tester runs (never a live chain):
//
//   lattice-node --data-directory <tmp> --no-default-peers --rpc-port 18080 \
//     --public-read-port 18081 --public-submit
//   LATTICE_E2E_RPC=http://127.0.0.1:18080 LATTICE_E2E_PUBLIC=http://127.0.0.1:18081 \
//     node --test test/e2e-local.test.ts
//
// Skipped unless LATTICE_E2E_RPC is set. The harness mines (as the node's
// operator would) only to fund the wallet; everything else goes through the
// wallet's own client, builder and signer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";
import { buildTransferBody, bodyPreimage, submitRequestJSON } from "../src/lib/tx/build.ts";
import { signPreimage } from "../src/lib/crypto/ed25519.ts";
import { NodeClient, NodeError, sentStatus } from "../src/lib/rpc/client.ts";

const rpc = process.env.LATTICE_E2E_RPC;
const publicURL = process.env.LATTICE_E2E_PUBLIC;
const chainPath = ["Nexus"];

async function mine(address: string) {
  const template = await (await fetch(rpc + "/mining/templates", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipients: [{ chainPath, address }] }),
  })).json();
  assert.equal(template.searchTarget, "0x" + "f".repeat(64), "a fresh local chain at the maximum target");
  const work = await (await fetch(rpc + "/mining/work", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workID: template.workID, nonce: 0 }),
  })).json();
  assert.equal(work.accepted, true, JSON.stringify(work));
}

function signed(from: ReturnType<typeof importPrivateKey>, to: string, amount: bigint, fee: bigint, nonce: bigint) {
  const body = buildTransferBody({ from: from.address, to, amount, fee, nonce, chainPath });
  const { preimage } = bodyPreimage(body);
  return submitRequestJSON({ [from.publicKey]: signPreimage(preimage, from.privateKey) }, body);
}

test("wallet against a local node: read, sign, submit (loopback and public), named refusals, confirm", { skip: !rpc }, async () => {
  const alice = importPrivateKey("a1".repeat(32));
  const bob = importPrivateKey("b0".repeat(32));
  await mine(alice.address);
  const local = new NodeClient(rpc!, chainPath);
  const funded = await local.account(alice.address);
  assert.ok(funded.balance > 0, "mined to the wallet");
  const nonce = BigInt(funded.nonce);
  assert.equal((await local.info()).acceptsSubmit, true, "the operator API accepts its own submits");

  // Public submit, when the operator turned it on; else the loopback route.
  const submitter = publicURL ? new NodeClient(publicURL, chainPath) : local;
  if (publicURL) assert.equal((await submitter.info()).acceptsSubmit, true);
  const answer = await submitter.submit(signed(alice, bob.address, 1000n, 2n, nonce));
  assert.match(answer.transactionCID, /^bafy/);

  // Named refusals, in the node's words.
  await assert.rejects(submitter.submit(signed(alice, bob.address, 999n, 2n, nonce)),
    (e: unknown) => e instanceof NodeError && e.refusal === "feeTooLow");
  const elsewhere = buildTransferBody({ from: alice.address, to: bob.address, amount: 1n, fee: 1n, nonce, chainPath: ["Nexus", "NotHosted"] });
  const elsewhereJSON = submitRequestJSON({ [alice.publicKey]: signPreimage(bodyPreimage(elsewhere).preimage, alice.privateKey) }, elsewhere);
  await assert.rejects(submitter.submit(elsewhereJSON),
    (e: unknown) => e instanceof NodeError && e.status === 404 && e.refusal === "unknownChain");

  // Pending, then included by the next block (its nonce is spent).
  assert.equal(await sentStatus(local, answer.transactionCID), "pending");
  await mine(alice.address);
  assert.equal(await sentStatus(local, answer.transactionCID), "nonce spent");
  assert.equal((await local.account(bob.address)).balance, 1000);
  assert.equal((await local.account(alice.address)).nonce, Number(nonce) + 1);
});
