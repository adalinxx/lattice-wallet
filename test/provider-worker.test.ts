// The worker between web pages and the signer: the origin is the one Chrome
// reports, each connection and write waits for the person in the wallet's own
// window, and that window can answer its request and nothing more.

import { test } from "node:test";
import assert from "node:assert/strict";
import { signedTransactionCID, type TransactionBody } from "@adalinxx/lattice-core";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const prefix = "chrome-extension://wallet-id/";
type Sender = { id: string; url?: string; origin?: string; frameId?: number; tab?: object };
type Answer = { ok: boolean; error?: string; [key: string]: unknown };

test("pages connect and write only through the person's approval", async () => {
  let listener!: (msg: unknown, sender: Sender, reply: (r: Answer) => void) => boolean;
  let onWindowClosed!: (id: number) => void;
  const opened: string[] = [];
  const data: Record<string, unknown> = {};
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "wallet-id", getURL: (path: string) => prefix + path, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }, sendMessage: async () => {} },
    storage: { local: {
      get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)); },
      remove: async (keys: string[]) => { for (const k of keys) delete data[k]; },
    } },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    windows: { create: async ({ url }: { url: string }) => { opened.push(url); return { id: opened.length }; }, onRemoved: { addListener: (fn: typeof onWindowClosed) => { onWindowClosed = fn; } } },
  } });
  // The node the window read the nonce from: it takes what it is sent, or
  // refuses it when `refuse` is set.
  const submitted: { url: string; body: { transaction: { signatures: Record<string, string>; body: Record<string, any> } } }[] = [];
  let refuse = false;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body);
    if (refuse) return new Response(JSON.stringify({ error: "belowMinRelayFee" }), { status: 400 });
    submitted.push({ url: String(url), body: payload });
    const wire = payload.transaction.body;
    const body: TransactionBody = { ...wire, nonce: BigInt(wire.nonce), accountActions: wire.accountActions.map((a: { owner: string; delta: string }) => ({ owner: a.owner, delta: BigInt(a.delta) })) };
    return new Response(JSON.stringify({ transactionCID: signedTransactionCID(payload.transaction.signatures, body) }), { status: 200 });
  } });
  await import("../src/background/service-worker.ts");

  const send = (msg: unknown, sender: Sender) => new Promise<Answer>((resolve, reject) => {
    if (!listener(msg, sender, resolve)) reject(new Error("ignored"));
  });
  const stoa: Sender = { id: "wallet-id", url: "https://stoa.example/app/", origin: "https://stoa.example", frameId: 0, tab: {} };
  const page = (call: unknown, from = stoa) => send({ type: "provider", call }, from);
  const popup = (msg: unknown) => send(msg, { id: "wallet-id", url: prefix + "popup/index.html" });
  const approval = (msg: unknown) => send(msg, { id: "wallet-id", url: opened.at(-1) });
  const requestId = () => new URL(opened.at(-1)!).searchParams.get("id");
  const writeCall = { method: "writeRecords", params: { chainPath: ["Nexus", "stoa"], actions: [{ key: "k", newValue: "v" }], fee: "1" } };
  // The window read these from the person's node (approve.ts); the page never sends one.
  const read = { nonce: "3", stateNonce: "2", node: "https://node.example" };

  const created = await popup({ type: "createWallet", password: "pw", mnemonic: MNEMONIC });
  const address = (created.state as { accounts: { address: string }[] }).accounts[0].address;

  await assert.rejects(page({ method: "address" }, { ...stoa, frameId: 2 }), /ignored/, "an iframe is not asked");
  await assert.rejects(page({ method: "address" }, { ...stoa, origin: undefined }), /ignored/);
  assert.deepEqual(await page({ method: "address" }), { ok: true, address: null });
  assert.equal((await page(writeCall)).error, "Not connected: call connect() first");
  assert.equal(opened.length, 0, "no window for a page that is not connected");

  // Connect: a window opens; the approval names the origin Chrome reported.
  const connecting = page({ method: "connect", origin: "https://bank.example" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(opened.length, 1);
  assert.ok(opened[0].startsWith(prefix + "approve/index.html?id="));
  const shown = await approval({ type: "pending", id: requestId() });
  assert.equal(shown.origin, "https://stoa.example");
  assert.equal((await approval({ type: "decide", id: requestId(), approve: true, address: "bafy-not-ours" })).ok, false);
  assert.equal((await approval({ type: "exportBackup", password: "pw" })).error, "Not allowed here");
  assert.equal((await approval({ type: "signRecords", from: address, ...writeCall.params })).error, "Not allowed here");
  assert.deepEqual(await approval({ type: "decide", id: requestId(), approve: true, address }), { ok: true });
  assert.deepEqual(await connecting, { ok: true, address });
  assert.deepEqual(await page({ method: "connect" }), { ok: true, address }, "asked once per site");
  assert.equal(opened.length, 1);
  assert.deepEqual(await page({ method: "address" }, { ...stoa, origin: "https://other.example" }), { ok: true, address: null });

  // A write the person closes the window on is declined.
  const closed = page(writeCall);
  await new Promise((r) => setTimeout(r, 10));
  onWindowClosed(opened.length);
  assert.deepEqual(await closed, { ok: false, error: "The person declined" });
  assert.equal((await approval({ type: "pending", id: requestId() })).ok, false, "the request is gone");

  // A site just declined waits before it can ask again.
  assert.equal((await page(writeCall)).error, "The person just declined; ask again in a moment");
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  skew = 6000;

  // A write the person signs: locked first, so the window unlocks and signs.
  await popup({ type: "lock" });
  const writing = page(writeCall);
  await new Promise((r) => setTimeout(r, 10));
  const id = requestId();
  assert.deepEqual((await approval({ type: "pending", id })).call, writeCall);
  assert.equal((await approval({ type: "decide", id, approve: true, ...read })).error, "Locked");
  assert.equal((await approval({ type: "unlock", password: "pw" })).ok, true);
  assert.equal((await approval({ type: "decide", id, approve: true })).error, "The wallet has not read this account's nonce");
  data.pageWrites = [{ chain: "Nexus/stoa", from: address, nonce: "1" }, { chain: "Nexus/other", from: address, nonce: "0" }];
  assert.deepEqual(await approval({ type: "decide", id, approve: true, ...read }), { ok: true });
  const signed = await writing;
  assert.ok(signed.ok);
  const body = (signed.signedSubmit as { payload: { transaction: { body: { signers: string[]; accountActions: unknown[]; nonce: string } } } }).payload.transaction.body;
  assert.deepEqual(body.signers, [address]);
  assert.deepEqual(body.accountActions, [{ owner: address, delta: "-1" }]);
  assert.equal(body.nonce, "3", "signed with the nonce the wallet read");
  assert.equal(submitted.length, 1, "the wallet submitted it, to the node it read the nonce from");
  assert.equal(submitted[0].url, "https://node.example/transactions");
  assert.equal(signed.transactionCID, (signed.signedSubmit as { transactionCID: string }).transactionCID);
  assert.deepEqual(data.pageWrites, [{ chain: "Nexus/other", from: address, nonce: "0" }, { chain: "Nexus/stoa", from: address, nonce: "3" }],
    "the write is remembered as pending; one the chain has passed is forgotten");

  // A nonce already taken by a page write is refused before signing; a
  // write the node refuses reaches the page as refused and is not recorded.
  const taken = page(writeCall);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await approval({ type: "decide", id: requestId(), approve: true, ...read })).error, "That nonce was just taken; check again");
  refuse = true;
  assert.match(String((await approval({ type: "decide", id: requestId(), approve: true, ...read, nonce: "4" })).error), /refused/);
  assert.match(String((await taken).error), /The node refused it/);
  assert.equal(submitted.length, 1);
  assert.deepEqual((data.pageWrites as { nonce: string }[]).map((p) => p.nonce), ["0", "3"], "a refused write is not pending");
  refuse = false;

  // One waiting request per site; and a write signs only as the account it
  // showed, while the site is still connected to it.
  const first = page(writeCall);
  await new Promise((r) => setTimeout(r, 10));
  const firstId = requestId();
  assert.equal((await page(writeCall)).error, "A request from this site is already waiting in the wallet");
  assert.equal((await page({ method: "connect" })).ok, true, "a connected site's connect() opens nothing");
  assert.equal((await approval({ type: "pending", id: firstId })).address, address);
  await page({ method: "disconnect" });
  assert.match(String((await approval({ type: "decide", id: firstId, approve: true })).error), /connection changed/);
  assert.deepEqual(await first, { ok: false, error: "The site's connection changed; ask again" });
  const reconnecting = page({ method: "connect" });
  await new Promise((r) => setTimeout(r, 10));
  await approval({ type: "decide", id: requestId(), approve: true, address });
  assert.equal((await reconnecting).address, address);

  // Disconnect forgets the site.
  assert.deepEqual(await page({ method: "disconnect" }), { ok: true, address: null });
  assert.equal((await page(writeCall)).error, "Not connected: call connect() first");
});
