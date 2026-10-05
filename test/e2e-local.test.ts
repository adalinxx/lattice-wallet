// End to end against LOCAL lattice-node processes this test starts and stops
// (never a live chain). Build adalinxx/lattice-node main, then:
//
//   LATTICE_NODE_BIN=<lattice-node>/.build/debug node --test test/e2e-local.test.ts
//
// Skipped unless LATTICE_NODE_BIN is set. Each node runs isolated
// (--no-default-peers, no --peer) on throwaway storage. The harness mines (as
// the node's operator would) only to fund the wallet; everything else goes
// through the wallet's own signer (session.signTransfer) and node plane
// (wallet/node.ts, i.e. the SDK's NodeClient and HTTPTransactionSubmitter).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SubmissionError } from "@adalinxx/lattice-relay";
import { importPrivateKey, type Account } from "../src/lib/crypto/accounts.ts";
import { signTransfer } from "../src/lib/wallet/session.ts";
import { reader, submitter, submitChecked, sentStatus, statusText, feeWarning, describe } from "../src/lib/wallet/node.ts";

const bin = process.env.LATTICE_NODE_BIN;
const run = promisify(execFile);
const chainPath = ["Nexus"];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function until<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface LocalNode { operator: string; publicListener?: string; stop(): Promise<void>; log(): string }

async function startNode(options: { publicSubmit: boolean; minRelayFee?: bigint }): Promise<LocalNode> {
  const directory = mkdtempSync(join(tmpdir(), "nexus-wallet-e2e-"));
  const [rpc, read, overlay] = [await freePort(), await freePort(), await freePort()];
  const operator = `http://127.0.0.1:${rpc}`;
  const publicListener = options.publicSubmit ? `http://127.0.0.1:${read}` : undefined;
  const logPath = join(directory, "node.log");
  const node: ChildProcess = spawn(join(bin!, "lattice-node"), [
    ...["--data-directory", join(directory, "data")],
    ...["--identity-key", join(directory, "identity.key")],
    "--no-default-peers",
    ...["--listen-port", String(overlay)],
    ...["--rpc-port", String(rpc)],
    ...(options.publicSubmit
      ? ["--public-read-port", String(read), "--public-submit", "--public-read-rate", "0", "--public-read-expensive-rate", "0",
        "--public-read-max-rate", "0", "--public-submit-rate", "0"]
      : []),
    ...(options.minRelayFee === undefined ? [] : ["--min-relay-fee", options.minRelayFee.toString()]),
  ], { stdio: ["ignore", openSync(logPath, "a"), openSync(logPath, "a")] });
  await until(async () => (await fetch(`${operator}/health`)).ok || undefined, "node health");
  if (publicListener) await until(async () => (await fetch(`${publicListener}/health`)).ok || undefined, "public listener");
  return {
    operator,
    ...(publicListener ? { publicListener } : {}),
    log: () => readFileSync(logPath, "utf8"),
    async stop() {
      if (node.exitCode === null) {
        const exited = new Promise((resolve) => node.once("exit", resolve));
        node.kill("SIGTERM");
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Mine (as the operator) until the tip is `blocks` higher, crediting `to`. */
async function mine(node: LocalNode, to: Account, blocks: number): Promise<void> {
  const reads = reader(node.operator, chainPath, fetch);
  const target = ((await reads.chainInfo()).height ?? 0n) + BigInt(blocks);
  await until(async () => {
    await run(join(bin!, "lattice-mining-coordinator"), [
      "--node", node.operator, "--workers", "2", "--recipient", `Nexus=${to.address}`, "--once", "--no-stale-probe",
    ]);
    return ((await reads.chainInfo()).height ?? 0n) >= target || undefined;
  }, `height ${target}`);
}

async function refusal(submission: Promise<unknown>): Promise<SubmissionError> {
  return submission.then(() => assert.fail("expected a refusal"), (e: unknown) => {
    assert.ok(e instanceof SubmissionError, String(e));
    return e;
  });
}

const alice = importPrivateKey("a1".repeat(32));
const bob = importPrivateKey("b0".repeat(32));

test("own node (loopback, no relay floor): fund by mining, send with a custom fee, see its block", { skip: !bin, timeout: 300_000 }, async () => {
  const node = await startNode({ publicSubmit: false });
  try {
    const reads = reader(node.operator, chainPath, fetch);
    const info = await reads.chainInfo();
    assert.equal(info.acceptsSubmit, true, "the operator API accepts its owner's submits");
    assert.equal(info.minRelayFee ?? 0n, 0n);
    await mine(node, alice, 2);
    const funded = await reads.account(alice.address);
    assert.ok(funded.balance > 0n, "mined to the wallet");

    const fee = 17n; // the user's choice, not an estimate
    assert.equal(feeWarning(fee, info.minRelayFee), undefined);
    const signed = signTransfer(alice, { to: bob.address, amount: 1_000n, fee, nonce: funded.nonce, chainPath });
    // The node must report exactly the CID the wallet computed.
    const sent = { transactionCID: await submitChecked(submitter(node.operator, fetch), signed) };
    assert.deepEqual(await sentStatus(reads, sent.transactionCID), { kind: "pending" });
    const before = (await reads.chainInfo()).height!;
    await mine(node, alice, 1);
    const status = await until(async () => {
      const s = await sentStatus(reads, sent.transactionCID);
      return s.kind === "included" ? s : undefined;
    }, "inclusion");
    assert.ok(status.kind === "included" && status.height > before);
    const block = await reads.block(status.height);
    assert.equal(block.hash, status.hash);
    console.log(`[e2e own node] ${sent.transactionCID}: ${statusText(status)} (${status.hash}), fee ${fee}`);
    assert.equal((await reads.account(bob.address)).balance, 1_000n);
  } catch (e) {
    console.error(node.log().slice(-4000));
    throw e;
  } finally {
    await node.stop();
  }
});

test("public submit with --min-relay-fee 1: below-floor fee warned and refused, custom fee included", { skip: !bin, timeout: 300_000 }, async () => {
  const node = await startNode({ publicSubmit: true, minRelayFee: 1n });
  try {
    const operatorReads = reader(node.operator, chainPath, fetch);
    const reads = reader(node.publicListener!, chainPath, fetch);
    const info = await reads.chainInfo();
    assert.equal(info.acceptsSubmit, true, "the operator declared public submit");
    assert.equal(info.minRelayFee, 1n);
    await mine(node, alice, 2);
    const { nonce } = await reads.account(alice.address);
    const relay = submitter(node.publicListener!, fetch);

    // Fee 0 is the user's to try: the wallet warns, never clamps; the node refuses by name.
    assert.match(feeWarning(0n, info.minRelayFee)!, /at least 1/);
    const below = await refusal(relay.submit(signTransfer(alice, { to: bob.address, amount: 10n, fee: 0n, nonce, chainPath }).payload));
    assert.equal(below.reason, "belowMinRelayFee");
    console.log(`[e2e public] fee 0 -> ${describe(below)}`);

    const fee = 5n;
    const sent = await relay.submit(signTransfer(alice, { to: bob.address, amount: 2_000n, fee, nonce, chainPath }).payload);
    const cheaper = await refusal(relay.submit(signTransfer(alice, { to: bob.address, amount: 1_999n, fee: 2n, nonce, chainPath }).payload));
    assert.equal(cheaper.reason, "feeTooLow");
    await mine(node, alice, 1);
    const status = await until(async () => {
      const s = await sentStatus(reads, sent.transactionCID);
      return s.kind === "included" ? s : undefined;
    }, "inclusion");
    assert.ok(status.kind === "included");
    assert.equal((await operatorReads.block(status.height)).hash, status.hash);
    console.log(`[e2e public] ${sent.transactionCID}: ${statusText(status)} (${status.hash}), fee ${fee}`);
    assert.equal((await reads.account(bob.address)).balance, 2_000n);
  } catch (e) {
    console.error(node.log().slice(-4000));
    throw e;
  } finally {
    await node.stop();
  }
});
