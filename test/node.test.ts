// The wallet's node plane over a scripted fetch: no default node, configurable
// fees warned (never clamped) against the endpoint's relay floor, named
// refusals in words, inclusion status, and discovery through the SDK resolver.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SubmissionError } from "@adalinxx/lattice-relay";
import { NodeError } from "@adalinxx/lattice-client";
import { normalizeNodeURL, parseChainPath, originPattern, isLoopbackNodeURL } from "../src/lib/config.ts";
import { loadSettings, recordOpenDeposit, completeOpenDeposit, recordOpenPurchase, archiveOpenPurchase, recordSent, forgetSent, recordPendingSubmission, completePendingSubmission, archivePendingSubmission, recordWithdrawalAttempt, forgetWithdrawalAttempt, defaultFee, parseFee, DEFAULT_SETTINGS, FALLBACK_FEE, type Settings } from "../src/lib/wallet/settings.ts";
import type { SignedSubmit } from "../src/lib/wallet/types.ts";
import { reader, submitter, submitChecked, CIDMismatchError, isDefiniteSubmissionRefusal, shouldOfferFeeReplacement, isTransientSubmissionRefusal, isTooLargeRefusal, discover, describe, feeWarning, sentStatus, statusText, OPERATOR_DECLARED, verifySparseProof } from "../src/lib/wallet/node.ts";
import type { VolumeEntry } from "@adalinxx/lattice-volumes";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";
import { signTransfer } from "../src/lib/wallet/session.ts";

const proofEntry = (cid: string, data: string): VolumeEntry => ({ cid, bytes: Uint8Array.from(Buffer.from(data, "base64")) });
const goldenProofs = JSON.parse(readFileSync(
  new URL("./fixtures/cross-chain-state-proofs.json", import.meta.url), "utf8",
)) as Record<string, { dictionaryRoot: string; claims: Array<{ key: string; value?: string }>; witness: Array<{ cid: string; data: string }> }>;

test("Swift cashew proof vectors verify compressed-prefix existence and absence", () => {
  // Emitted by lattice-node's Swift StateDictionaryProof builder from real
  // DepositState and ReceiptState tries. These deliberately exercise cashew's
  // edge-inclusive compressed prefixes, not a TypeScript-built imitation.
  const entries = (proof: typeof goldenProofs[string]) => proof.witness.map(({ cid, data }) => proofEntry(cid, data));
  const deposit = goldenProofs.deposit!;
  const depositClaim = deposit.claims[0]!;
  assert.equal(verifySparseProof(deposit.dictionaryRoot, depositClaim.key, BigInt(depositClaim.value!), entries(deposit)), true);
  assert.equal(verifySparseProof(deposit.dictionaryRoot, depositClaim.key, undefined, entries(deposit)), false);

  const present = goldenProofs.receiptExists!;
  const presentClaim = present.claims[0]!;
  assert.equal(verifySparseProof(present.dictionaryRoot, presentClaim.key, presentClaim.value!, entries(present)), true);
  assert.equal(verifySparseProof(present.dictionaryRoot, presentClaim.key, undefined, entries(present)), false, "an existing receipt cannot be forged as absent");
  const compressed = goldenProofs.receiptCompressedAbsence!;
  assert.equal(verifySparseProof(compressed.dictionaryRoot, compressed.claims[0]!.key, undefined, entries(compressed)), true, "divergence inside the compressed prefix");
  const missing = goldenProofs.receiptMissingRouteAbsence!;
  assert.equal(verifySparseProof(missing.dictionaryRoot, missing.claims[0]!.key, undefined, entries(missing)), true, "missing routing character");
});

test("no default node, and only https or the CSP's loopback http", async () => {
  const defaults = await loadSettings({ get: async () => ({}), set: async () => {} });
  assert.deepEqual(defaults.endpoints, {});
  assert.equal(defaults.nodeMode, "automatic");
  assert.deepEqual(DEFAULT_SETTINGS.endpoints, {});
  assert.equal(normalizeNodeURL("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(normalizeNodeURL(" https://reads.example.org/base/ "), "https://reads.example.org/base");
  for (const bad of ["http://reads.example.org", "http://127.0.0.2:8080", "ftp://x", "https://u:p@x.org", "https://x.org/?q=1", "x.org"]) {
    assert.equal(normalizeNodeURL(bad), null, bad);
  }
  assert.equal(originPattern("http://127.0.0.1:8080"), "http://127.0.0.1/*");
  assert.deepEqual(parseChainPath("Nexus/testnet"), ["Nexus", "testnet"]);
  assert.equal(parseChainPath("testnet"), null);
  assert.equal(parseChainPath("Nexus//x"), null);
});

test("only a node on this computer counts as the user's own", () => {
  for (const own of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080", "https://localhost"]) assert.equal(isLoopbackNodeURL(own), true, own);
  for (const other of ["https://rpc.lattice.build", "https://127.0.0.1.example.com", "https://localhost.example.com", "https://192.168.1.10", "not a url", ""]) {
    assert.equal(isLoopbackNodeURL(other), false, other);
  }
});

test("recordSent keeps newest first, deduplicated", () => {
  let s = recordSent(DEFAULT_SETTINGS, "Nexus", { cid: "a", to: "t", amount: "1", at: 1 });
  s = recordSent(s, "Nexus", { cid: "b", to: "t", amount: "1", at: 2 });
  s = recordSent(s, "Nexus", { cid: "a", to: "t", amount: "1", at: 3 });
  assert.deepEqual(s.sent.Nexus.map((t) => t.cid), ["a", "b"]);
  s = forgetSent(s, "Nexus", "a");
  assert.deepEqual(s.sent.Nexus.map((t) => t.cid), ["b"]);
});

test("open deposits are self-contained, deduplicated and never trimmed with sent history", () => {
  const deposit = {
    transactionCID: "deposit-cid", demander: "seller", depositNonce: "42",
    amountDeposited: "200", amountDemanded: "300", fee: "1", transactionNonce: "7",
    childChain: ["Nexus", "testnet"], parentChain: ["Nexus"], createdAt: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  let s = recordOpenDeposit(DEFAULT_SETTINGS, deposit);
  for (let i = 0; i < 75; i++) s = recordSent(s, "Nexus/testnet", { cid: `send-${i}`, to: "t", amount: "1", at: i });
  s = recordOpenDeposit(s, { ...deposit, createdAt: 2 });
  assert.equal(s.sent["Nexus/testnet"].length, 50);
  assert.deepEqual(s.openDeposits, [deposit], "a duplicate CID cannot overwrite its earlier recovery record");
  s = completeOpenDeposit(s, deposit.transactionCID);
  assert.deepEqual(s.openDeposits, []);
});

test("pending signed submissions survive trimmed display history until explicitly completed", () => {
  const signedSubmit = { transactionCID: "pending" } as unknown as SignedSubmit;
  let s = recordPendingSubmission(DEFAULT_SETTINGS, {
    cid: "pending", chain: "Nexus", to: "recipient", amount: "2", at: 1,
    from: "sender", fee: "1", nonce: "7", signedSubmit,
  });
  for (let i = 0; i < 75; i++) s = recordSent(s, "Nexus", { cid: `send-${i}`, to: "t", amount: "1", at: i });
  assert.equal(s.sent.Nexus.length, 50);
  assert.equal(s.pendingSubmissions.length, 1);
  assert.equal(s.pendingSubmissions[0]?.signedSubmit.transactionCID, "pending");
  s = completePendingSubmission(s, "pending");
  assert.equal(s.pendingSubmissions.length, 0);
});

test("deep confirmation archives recovery bytes until explicit dismissal", () => {
  const signedSubmit = { transactionCID: "pending" } as unknown as SignedSubmit;
  let s = recordPendingSubmission(DEFAULT_SETTINGS, {
    cid: "pending", chain: "Nexus", to: "recipient", amount: "2", at: 1,
    from: "sender", fee: "1", nonce: "7", signedSubmit,
  });
  s = archivePendingSubmission(s, "pending");
  assert.equal(s.pendingSubmissions.length, 0);
  assert.equal(s.confirmedSubmissions[0]?.signedSubmit, signedSubmit);
  for (let i = 0; i < 55; i++) {
    const item = { ...signedSubmit, transactionCID: `confirmed-${i}` } as SignedSubmit;
    s = recordPendingSubmission(s, { cid: item.transactionCID, chain: "Nexus", to: "r", amount: "1", at: i,
      from: "s", fee: "1", nonce: String(i), signedSubmit: item });
    s = archivePendingSubmission(s, item.transactionCID);
  }
  assert.equal(s.confirmedSubmissions.length, 56);
  s = recordOpenPurchase(s, { receiptCID: "receipt", receiptSubmit: signedSubmit, withdrawer: "buyer", offers: [],
    parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], createdAt: 1 });
  s = archiveOpenPurchase(s, "receipt");
  assert.equal(s.openPurchases.length, 0);
  assert.equal(s.confirmedPurchases[0]?.receiptSubmit, signedSubmit);
});

test("withdrawal fee replacements retain every earlier transaction CID", () => {
  const receipt = { transactionCID: "receipt" } as unknown as SignedSubmit;
  const attempt = (transactionCID: string, nonce = "7") => ({ transactionCID, payload: { transaction: { body: { nonce } } } }) as unknown as SignedSubmit;
  const first = attempt("withdraw-1");
  const replacement = attempt("withdraw-2");
  let s: Settings = { ...DEFAULT_SETTINGS, openPurchases: [{
    receiptCID: "receipt", receiptSubmit: receipt, withdrawer: "buyer", offers: [],
    parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], createdAt: 1,
  }] };
  s = recordWithdrawalAttempt(s, "receipt", first);
  s = recordWithdrawalAttempt(s, "receipt", replacement);
  assert.deepEqual(s.openPurchases[0]?.withdrawalAttempts?.map((attempt) => attempt.transactionCID), ["withdraw-1", "withdraw-2"]);
  assert.equal(s.openPurchases[0]?.withdrawalCID, "withdraw-2");
  s = recordOpenPurchase(s, {
    receiptCID: "receipt", receiptSubmit: receipt, withdrawer: "buyer", offers: [],
    parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], createdAt: 2,
  });
  assert.deepEqual(s.openPurchases[0]?.withdrawalAttempts?.map((attempt) => attempt.transactionCID), ["withdraw-1", "withdraw-2"],
    "retrying the same receipt cannot overwrite saved withdrawal attempts");
  s = forgetWithdrawalAttempt(s, "receipt", "withdraw-2");
  assert.deepEqual(s.openPurchases[0]?.withdrawalAttempts?.map((attempt) => attempt.transactionCID), ["withdraw-1"]);
  assert.equal(s.openPurchases[0]?.withdrawalCID, "withdraw-1");
  const newNonce = attempt("withdraw-3", "8");
  s = recordWithdrawalAttempt(s, "receipt", newNonce);
  s = forgetWithdrawalAttempt(s, "receipt", "withdraw-3");
  assert.equal(s.openPurchases[0]?.withdrawalCID, undefined, "a refused new-nonce attempt cannot restore a stale-nonce attempt as current");
  assert.deepEqual(s.openPurchases[0]?.withdrawalAttempts?.map((item) => item.transactionCID), ["withdraw-1"]);
});

test("load migrates a legacy current withdrawal into the durable attempts list", async () => {
  const legacy = { transactionCID: "withdraw", payload: { transaction: { body: { nonce: "7" } } } } as unknown as SignedSubmit;
  const loaded = await loadSettings({ get: async () => ({ settings: { ...DEFAULT_SETTINGS, openPurchases: [{
    receiptCID: "receipt", receiptSubmit: legacy, withdrawalCID: "withdraw", withdrawalSubmit: legacy,
    withdrawer: "buyer", offers: [], parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], createdAt: 1,
  }] } }), set: async () => {} });
  assert.deepEqual(loaded.openPurchases[0]?.withdrawalAttempts, [legacy]);
  assert.equal("withdrawalSubmit" in loaded.openPurchases[0]!, false);
});

test("fees: per-chain default, whole units, warned below the node's floor but never clamped", async () => {
  const stored = await loadSettings({ get: async () => ({ settings: { chain: "Nexus", chains: ["Nexus"], endpoints: {}, sent: {} } }), set: async () => {} });
  assert.deepEqual(stored.fees, {}, "settings saved before fees existed still load");
  assert.equal(defaultFee(stored, "Nexus"), FALLBACK_FEE);
  assert.equal(defaultFee({ ...stored, fees: { "Nexus/testnet": "25" } }, "Nexus/testnet"), "25");
  assert.equal(parseFee("0"), 0n);
  assert.equal(parseFee(" 42 "), 42n);
  for (const bad of ["", "-1", "1.5", "01", "1e3", "abc"]) assert.equal(parseFee(bad), null, bad);
  assert.equal(feeWarning(5n, undefined), undefined, "no floor reported");
  assert.equal(feeWarning(5n, 5n), undefined);
  assert.match(feeWarning(4n, 5n)!, /at least 5/);
});

type Route = (url: URL, init?: RequestInit) => { status: number; body: unknown } | undefined;
function scripted(routes: Route) {
  const calls: string[] = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${input}`);
    const answer = routes(new URL(input), init) ?? { status: 404, body: { error: { message: "Not Found" } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  return { fetch, calls };
}

test("reads name their chain and read exact UInt64 decimal strings", async () => {
  const { fetch, calls } = scripted((url) => {
    if (url.pathname === "/api/state/account/bafybig") {
      return { status: 200, body: { owner: "bafybig", balance: "18446744073709551615", nonce: "9007199254740993" } };
    }
    if (url.pathname === "/api/chain/info") return { status: 200, body: { chain: ["Nexus", "testnet"], minRelayFee: "3", acceptsSubmit: true } };
  });
  const client = reader("http://127.0.0.1:8080", ["Nexus", "testnet"], fetch);
  const account = await client.account("bafybig");
  assert.equal(account.balance, 18446744073709551615n);
  assert.equal(account.nonce, 9007199254740993n);
  assert.equal(calls[0], "GET http://127.0.0.1:8080/api/state/account/bafybig?chainPath=Nexus%2Ftestnet");
  const info = await client.chainInfo();
  assert.equal(info.minRelayFee, 3n);
  assert.equal(info.acceptsSubmit, true);
});

test("submission posts the signer's payload to /transactions; refusals are typed and worded", async () => {
  const sender = importPrivateKey("a1".repeat(32));
  const { payload } = signTransfer(sender, { to: importPrivateKey("b0".repeat(32)).address, amount: 5n, fee: 0n, nonce: 0n, chainPath: ["Nexus"] });
  let posted: unknown;
  const { fetch, calls } = scripted((url, init) => {
    if (url.pathname === "/transactions" && init?.method === "POST") {
      posted = JSON.parse(String(init.body));
      return { status: 400, body: { error: { message: "belowMinRelayFee" } } };
    }
  });
  const error = await submitter("http://127.0.0.1:8080", fetch).submit(payload).then(() => assert.fail("refused"), (e: unknown) => e);
  assert.equal(calls[0], "POST http://127.0.0.1:8080/transactions");
  assert.deepEqual(posted, payload);
  assert.ok(error instanceof SubmissionError && error.reason === "belowMinRelayFee");
  assert.match(describe(error), /^refused \(belowMinRelayFee\): the fee is below this node's minimum relay fee/);
  assert.match(describe(new SubmissionError(400, "feeTooLow")), /higher fee/);
  assert.match(describe(new SubmissionError(404)), /does not accept transactions/);
  // A node naming the transaction as too big for it is told apart from other
  // refusals, so a purchase of too many sell orders can say so.
  assert.equal(isTooLargeRefusal(new SubmissionError(400, "tooLarge")), true);
  assert.equal(isTooLargeRefusal(new SubmissionError(413, "requestTooLarge")), true);
  assert.equal(isTooLargeRefusal(new SubmissionError(413)), false, "a proxy's bare 413 is not the node's word");
  assert.equal(isTooLargeRefusal(new SubmissionError(400, "feeTooLow")), false);
  assert.equal(isTooLargeRefusal(new TypeError("Failed to fetch")), false);
  assert.equal(describe(new SubmissionError(500, "something new")), "refused: something new");
  // A local node's operator port: unpaired or stale cookie, or this origin not listed.
  assert.match(describe(new SubmissionError(401)), /needs its cookie/);
  assert.match(describe(new NodeError(401)), /needs its cookie/);
  assert.match(describe(new NodeError(403)), /rpcAllowedOrigins/);
  assert.equal(isDefiniteSubmissionRefusal(new SubmissionError(400, "belowMinRelayFee")), true);
  assert.equal(isDefiniteSubmissionRefusal(new SubmissionError(429, "rate limited")), false);
  assert.equal(isDefiniteSubmissionRefusal(new SubmissionError(403)), false);
  assert.equal(isDefiniteSubmissionRefusal(new SubmissionError(400, "unknown reason")), false);
  assert.equal(isDefiniteSubmissionRefusal(new SubmissionError(408)), false);
  assert.equal(isDefiniteSubmissionRefusal(new SubmissionError(500)), false);
  assert.equal(isDefiniteSubmissionRefusal(new TypeError("connection lost")), false);
  assert.equal(shouldOfferFeeReplacement(new SubmissionError(400, "belowMinRelayFee")), true);
  assert.equal(shouldOfferFeeReplacement(new SubmissionError(400, "feeTooLow")), true);
  assert.equal(shouldOfferFeeReplacement(new SubmissionError(401)), false);
  assert.equal(shouldOfferFeeReplacement(new SubmissionError(429, "rate limited")), false);
  assert.equal(shouldOfferFeeReplacement(new SubmissionError(503, "shuttingDown")), false);
  assert.equal(isTransientSubmissionRefusal(new SubmissionError(401)), true);
  assert.equal(isTransientSubmissionRefusal(new SubmissionError(429, "rate limited")), true);
  assert.equal(isTransientSubmissionRefusal(new SubmissionError(400, "full")), true);
});

const projection = (extra: Record<string, unknown> = {}) => ({
  txCID: "bafytx", nonce: "4", signers: ["bafyalice"], chainPath: ["Nexus"],
  accountActions: [], depositActions: [], receiptActions: [], withdrawalActions: [], ...extra,
});

test("status: included in block N, pending, replaced, unknown", async () => {
  let tx: object = projection();
  let mempool: string[] = ["bafytx"];
  let accountNonce = "4";
  const { fetch } = scripted((url) => {
    if (url.pathname === "/api/transaction/bafytx") return { status: 200, body: tx };
    if (url.pathname === "/api/mempool") return { status: 200, body: { count: mempool.length, transactions: mempool } };
    if (url.pathname === "/api/state/account/bafyalice") return { status: 200, body: { owner: "bafyalice", balance: "0", nonce: accountNonce } };
  });
  const client = reader("http://127.0.0.1:8080", ["Nexus"], fetch);
  assert.deepEqual(await sentStatus(client, "bafytx"), { kind: "pending" });
  mempool = [];
  assert.deepEqual(await sentStatus(client, "bafytx"), { kind: "pending or dropped" });
  accountNonce = "5";
  assert.deepEqual(await sentStatus(client, "bafytx"), { kind: "replaced" }, "nonce spent but not on the canonical chain");
  tx = projection({ blockHeight: "12", blockHash: "bafyblock", timestamp: "1" });
  const included = await sentStatus(client, "bafytx");
  assert.deepEqual(included, { kind: "included", height: 12n, hash: "bafyblock" });
  assert.equal(statusText(included), "included in block 12");
  assert.deepEqual(await sentStatus(client, "bafyunknown"), { kind: "unknown to node" });
  assert.deepEqual(await sentStatus(client, "bafyunknown", { from: "bafyalice", nonce: 4n }), { kind: "nonce advanced" },
    "a pruned or never-admitted transaction remains explicitly ambiguous after its nonce advances");
});

test("status falls back to the nonce only for a node that does not report inclusion", async () => {
  // A pre-decimal-string node: numbers where the wire now has strings.
  const old = { ...projection(), nonce: 4, blockHeight: null };
  const { fetch } = scripted((url) => {
    if (url.pathname === "/api/transaction/bafytx") return { status: 200, body: old };
    if (url.pathname === "/api/mempool") return { status: 200, body: { count: 0, transactions: [] } };
    if (url.pathname === "/api/state/account/bafyalice") return { status: 200, body: { owner: "bafyalice", balance: "0", nonce: "5" } };
  });
  const client = reader("http://127.0.0.1:8080", ["Nexus"], fetch);
  const fallback = await sentStatus(client, "bafytx", { from: "bafyalice", nonce: 4n });
  assert.deepEqual(fallback, { kind: "nonce advanced" });
  assert.match(statusText(fallback), /unknown/);
  await assert.rejects(sentStatus(client, "bafytx"), TypeError, "without a record there is nothing to fall back on");
});

test("a failed nonce lookup after transaction 404 remains unknown instead of blocking recovery", async () => {
  const { fetch } = scripted((url) => {
    if (url.pathname === "/api/state/account/bafyalice") return { status: 500, body: "unavailable" };
  });
  const client = reader("http://127.0.0.1:8080", ["Nexus"], fetch);
  assert.deepEqual(await sentStatus(client, "bafymissing", { from: "bafyalice", nonce: 4n }), { kind: "unknown to node" });
});

const blockView = (hash: string, chain: string[]) => ({
  height: "3", hash, timestamp: "1", transactionCount: 0, childBlockCount: 0, nonce: "0", version: 1,
  target: "0x1", nextTarget: "0x1", transactionsCID: "bafyt", postStateCID: "bafys", chain,
});

test("discovery walks Nexus -> A -> B through the SDK resolver, accepting only hosts serving the committed block", async () => {
  const { fetch, calls } = scripted((url) => {
    const host = url.host, path = url.pathname, chain = url.searchParams.get("chainPath");
    if (host === "start.example" && path === "/api/chain/endpoints" && chain === "Nexus/A") {
      return { status: 200, body: { chainPath: ["Nexus", "A"], committedBlock: "bafyA",
        endpoints: ["https://liar.example", "https://a.example", "http://127.0.0.1:8080", "https://10.0.0.5", "https://169.254.169.254"],
        submitEndpoints: ["https://a.example/"] } };
    }
    if (host === "a.example" && path === "/api/block/bafyA" && chain === "Nexus/A") return { status: 200, body: blockView("bafyA", ["Nexus", "A"]) };
    if (host === "liar.example" && path === "/api/block/bafyA") return { status: 200, body: blockView("bafyOther", ["Nexus", "A"]) };
    if (host === "a.example" && path === "/api/chain/endpoints" && chain === "Nexus/A/B") {
      return { status: 200, body: { chainPath: ["Nexus", "A", "B"], committedBlock: "bafyB", endpoints: ["https://b.example"] } };
    }
    if (host === "b.example" && path === "/api/block/bafyB" && chain === "Nexus/A/B") return { status: 200, body: blockView("bafyB", ["Nexus", "A", "B"]) };
  });
  const a = await discover("https://start.example", ["Nexus", "A"], fetch);
  assert.deepEqual(a.map((e) => [e.url, e.declaresSubmit, e.trust]), [["https://a.example", true, OPERATOR_DECLARED]]);
  assert.ok(!calls.some((c) => /127\.0\.0\.1|10\.0\.0\.5|169\.254/.test(c)), "private hosts are never dialed:\n" + calls.join("\n"));
  const b = await discover("https://start.example", ["Nexus", "A", "B"], fetch);
  assert.deepEqual(b.map((e) => [e.url, e.declaresSubmit]), [["https://b.example", false]], "an undeclared submit is not assumed");
});

test("a submission is held to the CID the wallet computed", async () => {
  const signer = importPrivateKey("11".repeat(32));
  const signed = signTransfer(signer, { to: importPrivateKey("22".repeat(32)).address, amount: 5n, fee: 1n, nonce: 0n, chainPath: ["Nexus"] });
  const answering = (transactionCID: string) => ({ submit: async () => ({ transactionCID }) });
  assert.equal(await submitChecked(answering(signed.transactionCID), signed), signed.transactionCID);
  const other = "bafyreidog6lzal3gjfvbvmmdccp3ibyndsy3hcvb22fhvtmxivsrmodiyy";
  const refused = await submitChecked(answering(other), signed).then(() => undefined, (e: unknown) => e);
  assert.ok(refused instanceof CIDMismatchError);
  assert.match(describe(refused), /unexpected answer from node: .*reported transaction bafyreidog/);
});
