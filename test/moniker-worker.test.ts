// The worker names an account after the handle it sets for itself on Moniker,
// once the node took the write; and the approval window may add an account to
// connect.

import { test } from "node:test";
import assert from "node:assert/strict";
import { signedTransactionCID, type TransactionBody } from "@adalinxx/lattice-core";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const prefix = "chrome-extension://wallet-id/";
type Sender = { id: string; url?: string; origin?: string; frameId?: number; tab?: { id: number }; documentId?: string };
type Answer = { ok: boolean; error?: string; [key: string]: unknown };
type State = { active: string; accounts: { address: string; label: string }[] };

test("a sent write setting the signer's own handle on Moniker names the account", async () => {
  let listener!: (msg: unknown, sender: Sender, reply: (r: Answer) => void) => boolean;
  const opened: string[] = [];
  const data: Record<string, unknown> = {};
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "wallet-id", getURL: (path: string) => prefix + path, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }, sendMessage: async () => {} },
    storage: { local: {
      get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)); },
      remove: async (keys: string[]) => { for (const k of keys) delete data[k]; },
    } },
    tabs: { sendMessage: async () => ({ origin: "https://moniker.example" }) },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    windows: { create: async ({ url }: { url: string }) => { opened.push(url); return { id: opened.length }; }, onRemoved: { addListener: () => {} } },
  } });
  // The node takes what it is sent; or refuses it, or does not answer.
  let node: "takes" | "refuses" | "silent" = "takes";
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_url: string, init: { body: string }) => {
    if (node === "refuses") return new Response(JSON.stringify({ error: "belowMinRelayFee" }), { status: 400 });
    if (node === "silent") throw new TypeError("network down");
    const payload = JSON.parse(init.body);
    const wire = payload.transaction.body;
    const body: TransactionBody = { ...wire, nonce: BigInt(wire.nonce), accountActions: wire.accountActions.map((a: { owner: string; delta: string }) => ({ owner: a.owner, delta: BigInt(a.delta) })) };
    return new Response(JSON.stringify({ transactionCID: signedTransactionCID(payload.transaction.signatures, body) }), { status: 200 });
  } });
  await import("../src/background/service-worker.ts");

  const send = (msg: unknown, sender: Sender) => new Promise<Answer>((resolve, reject) => {
    if (!listener(msg, sender, resolve)) reject(new Error("ignored"));
  });
  const site: Sender = { id: "wallet-id", url: "https://moniker.example/", origin: "https://moniker.example", frameId: 0, tab: { id: 7 }, documentId: "doc-1" };
  const page = (call: unknown) => send({ type: "provider", call }, site);
  const popup = (msg: unknown) => send(msg, { id: "wallet-id", url: prefix + "popup/index.html" });
  const approval = (msg: unknown) => send(msg, { id: "wallet-id", url: opened.at(-1) });
  const requestId = () => new URL(opened.at(-1)!).searchParams.get("id");
  const state = async () => ((await popup({ type: "getState" })).state as State);
  const labelOf = async (address: string) => (await state()).accounts.find((a) => a.address === address)!.label;

  await popup({ type: "createWallet", password: "pw", mnemonic: MNEMONIC });
  const first = (await state()).accounts[0]!.address;

  // Connecting: the window adds an account (named by default, never as the window says) and connects it.
  const connecting = page({ method: "connect" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await approval({ type: "addAccount", label: "Chosen by the window" })).ok, true);
  const after = await state();
  const me = after.active;
  assert.notEqual(me, first);
  assert.equal(await labelOf(me), "Account 2");
  assert.deepEqual(await approval({ type: "decide", id: requestId(), approve: true, address: me }), { ok: true });
  assert.deepEqual(await connecting, { ok: true, address: me });

  let nonce = 0;
  const write = async (chainPath: string[], actions: unknown[]) => {
    const writing = page({ method: "writeRecords", params: { chainPath, actions, fee: "1" } });
    await new Promise((r) => setTimeout(r, 10));
    nonce += 1;
    await approval({ type: "decide", id: requestId(), approve: true, nonce: String(nonce), stateNonce: String(nonce - 1), node: "https://node.example" });
    return writing;
  };
  const moniker = ["Nexus", "moniker"];
  const name = (handle: string, account = me) => [{ key: `user/${account}/name`, newValue: handle }];

  node = "refuses";
  assert.equal((await write(moniker, name("rae"))).ok, false);
  assert.equal(await labelOf(me), "Account 2", "a refused write renames nothing");
  node = "silent";
  assert.equal((await write(moniker, name("rae"))).ok, false);
  assert.equal(await labelOf(me), "Account 2", "nor one the node did not confirm");
  node = "takes";
  assert.ok((await write(["Nexus", "stoa"], name("rae"))).ok);
  assert.equal(await labelOf(me), "Account 2", "nor one on another chain");
  assert.ok((await write(moniker, name("rae", first))).ok);
  assert.equal(await labelOf(me), "Account 2", "nor another account's handle");
  assert.ok((await write(moniker, name("Rae!"))).ok);
  assert.equal(await labelOf(me), "Account 2", "nor what is not a handle");

  assert.ok((await write(moniker, name("rae"))).ok);
  assert.equal(await labelOf(me), "@rae");
  assert.ok((await write(moniker, [{ key: `user/${me}/name`, oldValue: "rae" }])).ok);
  assert.equal(await labelOf(me), "@rae", "a delete leaves it");
  assert.ok((await write(moniker, name("bo"))).ok);
  assert.equal(await labelOf(me), "@bo", "a new handle replaces the old");

  await popup({ type: "renameAccount", address: me, label: "Work" });
  assert.ok((await write(moniker, name("cy"))).ok);
  assert.equal(await labelOf(me), "Work", "a name the person chose stays");
  assert.equal(await labelOf(first), "Account 1");

  // An opened request names the account the person chose in the window.
  const uri = `lattice://write?v=1&intent=${Buffer.from(JSON.stringify({
    version: 1, chainPath: moniker, expiresAt: "2030-01-01T00:00:00Z", actions: [{ key: "user/{account}/name", newValue: "dee" }],
  })).toString("base64url")}`;
  const opening = page({ method: "openRequest", params: { uri } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await approval({ type: "decide", id: requestId(), approve: true, address: first, present: [], fee: "1", nonce: "1", stateNonce: "0", node: "https://node.example" }), { ok: true });
  assert.ok((await opening).ok);
  assert.equal(await labelOf(first), "@dee");
  assert.equal(await labelOf(me), "Work");
});
