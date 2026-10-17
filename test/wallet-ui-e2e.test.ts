import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { WalletClient } from "../src/lib/wallet/client.ts";
import { DEFAULT_SETTINGS } from "../src/lib/wallet/settings.ts";
import type { WalletState } from "../src/lib/wallet/types.ts";
import { startWallet } from "../src/popup/app.ts";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";
import { signTransfer as signTestTransfer } from "../src/lib/wallet/session.ts";
import { createSigner } from "../src/lib/wallet/signer.ts";
import { walletClient } from "../src/lib/wallet/client.ts";
import type { Vault } from "../src/lib/crypto/keystore.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 24; i += 1) await tick(); }

function installDOM() {
  const dom = new JSDOM('<button id="settings-button"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
  for (const name of ["window", "document", "navigator", "Node", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "KeyboardEvent", "Event", "DOMParser"]) {
    Object.defineProperty(globalThis, name, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
  }
  return dom;
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent === text || item.getAttribute("aria-label") === text || item.getAttribute("data-row") === text);
  assert.ok(found, `button ${text} exists; page was: ${document.body.textContent}`);
  return found as HTMLButtonElement;
}

function input(placeholder: string): HTMLInputElement {
  const found = document.querySelector(`input[placeholder="${placeholder}"]`);
  assert.ok(found, `input ${placeholder} exists`);
  return found as HTMLInputElement;
}

const alice = importPrivateKey("a1".repeat(32)).address;
const bob = importPrivateKey("b0".repeat(32)).address;
const openState = (): WalletState => ({
  initialized: true, locked: false,
  accounts: [{ address: alice, publicKey: "ed01" + "00".repeat(32), label: "Account 1", kind: "hd", index: 0 }],
  active: alice,
});

test("transactions UI: empty history is accessible from Activity", async () => {
  installDOM();
  const store = memoryStore();
  await startWallet({ wallet: walletFor(openState()), store: store.api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch(), requestOrigins: async () => true });
  await settle(); button("Activity").click();
  button("Transactions").click();
  assert.equal(document.querySelector("h1")?.textContent, "Transactions");
  assert.match(document.body.textContent ?? "", /No transactions yet/);
  assert.match(document.body.textContent ?? "", /Not a complete on-chain history/);
  button("Back").click();
  assert.equal(document.querySelector("h1")?.textContent, "Activity");
});

test("transactions RBF: higher fee, same payment and nonce, both attempts saved before a refusal", async () => {
  installDOM();
  const account = importPrivateKey("a1".repeat(32));
  const original = signTestTransfer(account, { to: bob, amount: 10n, fee: 1n, nonce: 3n, chainPath: ["Nexus"] });
  const record = { cid: original.transactionCID, from: alice, to: bob, amount: "10", fee: "1", nonce: "3", chain: "Nexus", at: 1, signedSubmit: original };
  const store = memoryStore({ pendingSubmissions: [record] });
  let signs = 0, posts = 0;
  const wallet = walletFor(openState(), { signTransfer: async (args) => {
    signs += 1;
    assert.equal(args.nonce, "3"); assert.equal(args.to, bob); assert.equal(args.amount, "10"); assert.equal(args.fee, "2");
    return { ok: true, summary: args, signedSubmit: signTestTransfer(account, { to: args.to, amount: BigInt(args.amount), fee: BigInt(args.fee), nonce: BigInt(args.nonce), chainPath: args.chainPath }) };
  } });
  await startWallet({ wallet, store: store.api, fetch: nodeFetch({ submitRefusal: "feeTooLow", onSubmit: () => {
    posts += 1;
    assert.equal(store.value.settings.pendingSubmissions.length, 2, "save occurs before broadcast");
  } }), requestOrigins: async () => true });
  await settle(); button("Activity").click();
  button("Transactions").click(); await settle();
  button("Increase fee").click();
  const fee = document.querySelector('[aria-label="Replacement fee"]') as HTMLInputElement;
  fee.value = "1"; button("Sign replacement").click(); await settle();
  assert.equal(signs, 0); assert.equal(posts, 0);
  assert.match(document.body.textContent ?? "", /higher than 1/);
  fee.value = "2"; button("Sign replacement").click(); button("Sign replacement").click();
  await settle();
  assert.equal(signs, 1); assert.equal(posts, 1);
  assert.match(document.body.textContent ?? "", /Replacement refused.*Both attempts remain saved/s);
  assert.deepEqual(store.value.settings.pendingSubmissions.find((item: { cid: string }) => item.cid === record.cid)?.signedSubmit, original);
  assert.equal(store.value.settings.pendingSubmissions[0]?.replacesCID, record.cid);
});

test("transactions UI: included rows show confirmations and accessible signed details", async () => {
  installDOM();
  const account = importPrivateKey("a1".repeat(32));
  const signed = signTestTransfer(account, { to: bob, amount: 10n, fee: 1n, nonce: 3n, chainPath: ["Nexus"] });
  const record = { cid: signed.transactionCID, from: alice, to: bob, amount: "10", fee: "1", nonce: "3", chain: "Nexus", at: 1, signedSubmit: signed };
  const store = memoryStore({ pendingSubmissions: [record] });
  const normal = nodeFetch();
  const fetch = async (raw: string | URL, init?: RequestInit) => {
    const path = new URL(raw).pathname;
    if (path === `/api/transaction/${record.cid}`) return json({ txCID: record.cid, nonce: "3", signers: [alice], chainPath: ["Nexus"], accountActions: [], depositActions: [], receiptActions: [], withdrawalActions: [], blockHeight: "7", blockHash: "bafyblock" });
    if (path === "/api/block/7") return json({ height: "7", hash: "bafyblock", timestamp: "1", transactionCount: 1, childBlockCount: 0, nonce: "0", version: 1, target: "0x1", nextTarget: "0x1", transactionsCID: "bafyt", postStateCID: "bafys", chain: ["Nexus"] });
    return normal(raw, init);
  };
  await startWallet({ wallet: walletFor(openState()), store: store.api, fetch, requestOrigins: async () => true });
  await settle(); button("Activity").click(); button("Transactions").click(); await settle();
  assert.match(document.body.textContent ?? "", /2 confirmations/);
  assert.match(document.body.textContent ?? "", /Confirmations \(node-reported\)/);
  assert.equal([...document.querySelectorAll("button")].some((b) => b.textContent === "Increase fee"), false);
  assert.deepEqual(JSON.parse(document.querySelector(".transaction-payload")!.textContent!), signed.payload);
});

test("transactions RBF: advanced nonce and failed recovery save prevent broadcast", async () => {
  for (const failure of ["nonce", "storage"] as const) {
    installDOM();
    const account = importPrivateKey("a1".repeat(32));
    const signed = signTestTransfer(account, { to: bob, amount: 10n, fee: 1n, nonce: 3n, chainPath: ["Nexus"] });
    const record = { cid: signed.transactionCID, from: alice, to: bob, amount: "10", fee: "1", nonce: "3", chain: "Nexus", at: 1, signedSubmit: signed };
    const store = memoryStore({ pendingSubmissions: [record] });
    let signs = 0, posts = 0, advanced = false;
    const normal = nodeFetch({ onSubmit: () => { posts += 1; } });
    const fetch = async (raw: string | URL, init?: RequestInit) => advanced && new URL(raw).pathname === `/api/state/account/${alice}`
      ? json({ owner: alice, balance: "100", nonce: "4" }) : normal(raw, init);
    const wallet = walletFor(openState(), { signTransfer: async (args) => {
      signs += 1;
      store.api.set = async () => { throw new Error("storage failure"); };
      return { ok: true, summary: args, signedSubmit: signTestTransfer(account, { to: args.to, amount: BigInt(args.amount), fee: BigInt(args.fee), nonce: BigInt(args.nonce), chainPath: args.chainPath }) };
    } });
    await startWallet({ wallet, store: store.api, fetch, requestOrigins: async () => true });
    await settle(); button("Activity").click(); button("Transactions").click(); await settle();
    button("Increase fee").click();
    advanced = failure === "nonce";
    button("Sign replacement").click(); await settle();
    assert.equal(signs, failure === "nonce" ? 0 : 1);
    assert.equal(posts, 0);
    assert.equal(store.value.settings.pendingSubmissions.length, 1);
    assert.match(document.body.textContent ?? "", failure === "nonce" ? /nonce has already been used/ : /storage failure/);
    assert.equal(button("Sign replacement").disabled, false);
  }
});

test("transactions UI: disconnected recovery remains visible, archived rows deduplicate and copy full IDs", async () => {
  const dom = installDOM();
  let copied = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  const recovery = { transactionCID: "bafyarchived", bodyCID: "bafybody", payload: {} };
  const archived = { cid: "bafyarchived", from: alice, to: bob, amount: "15", fee: "1", nonce: "2", at: 2000, chain: "Nexus", signedSubmit: recovery };
  const missing = { ...archived, cid: "bafymissing", chain: "Nexus/offline", at: 3000, signedSubmit: { ...recovery, transactionCID: "bafymissing" } };
  const store = memoryStore({ pendingSubmissions: [missing], confirmedSubmissions: [archived], sent: { Nexus: [archived] } });
  const normalFetch = nodeFetch();
  const failedStatus = async (raw: string | URL, init?: RequestInit) => new URL(raw).pathname.includes("bafyarchived")
    ? json({ error: { message: "temporary status failure" } }, 500) : normalFetch(raw, init);
  await startWallet({ wallet: walletFor(openState()), store: store.api, fetch: failedStatus, requestOrigins: async () => true });
  await settle(); button("Activity").click();
  button("Transactions").click();
  await settle();
  const rows = [...document.querySelectorAll(".transaction-item")] as HTMLDetailsElement[];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => !row.open));
  assert.match(rows[0]!.textContent ?? "", /Nexus\/offline.*Not connected/s);
  assert.equal(rows[0]!.querySelectorAll("button").length, 2, "copy and dismiss work without an endpoint");
  assert.match(rows[1]!.textContent ?? "", /Archived locally/);
  assert.match(rows[1]!.textContent ?? "", /Status unavailable|unknown to node/);
  assert.ok(rows[1]!.querySelectorAll("button").length >= 3, "read failure cannot hide exact recovery");
  rows[1]!.open = true;
  (rows[1]!.querySelector('[aria-label="Copy transaction ID"]') as HTMLButtonElement).click();
  await settle();
  assert.equal(copied, archived.cid);
  dom.window.confirm = () => false;
  (rows[0]!.querySelector(".text-action") as HTMLButtonElement).click();
  await settle();
  assert.equal(store.value.settings.pendingSubmissions.length, 1, "cancelled dismissal retains recovery");
});

function memoryStore(overrides: Record<string, unknown> = {}) {
  let value = { settings: { ...DEFAULT_SETTINGS, endpoints: { Nexus: { url: "https://node.test", acceptsSubmit: true, source: "user" as const } }, ...overrides } };
  return {
    get value() { return value; },
    api: {
      get: async () => structuredClone(value),
      set: async (items: Record<string, unknown>) => { value = structuredClone(items) as typeof value; },
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function nodeFetch(options: {
  balance?: bigint; minimum?: bigint; acceptsSubmit?: boolean;
  failSubmit?: boolean;
  submitRefusal?: string;
  onSubmit?: () => void;
} = {}) {
  const balance = options.balance ?? 100n;
  const minimum = options.minimum ?? 1n;
  return async (raw: string | URL, init?: RequestInit) => {
    const url = new URL(raw);
    if (url.pathname === "/api/chain/info") return json({ chain: ["Nexus"], minRelayFee: minimum.toString(), acceptsSubmit: options.acceptsSubmit ?? true });
    if (url.pathname === `/api/state/account/${alice}`) return json({ owner: alice, balance: balance.toString(), nonce: "3" });
    if (url.pathname === "/api/block/latest") return json({ height: "8", hash: "bafytip", timestamp: "1", transactionCount: 0 });
    if (url.pathname === "/api/block/bafytip/children") return json({ children: [] });
    if (url.pathname === "/transactions" && init?.method === "POST") {
      options.onSubmit?.();
      if (options.failSubmit) throw new TypeError("connection lost");
      if (options.submitRefusal) return json({ error: { message: options.submitRefusal } }, 400);
      return json({ transactionCID: "bafysent", mempoolCount: 1, mempoolBytes: 100 });
    }
    return json({ error: { message: "not found" } }, 404);
  };
}

function walletFor(state: WalletState, overrides: Partial<WalletClient> = {}): WalletClient {
  const base = {
    getState: async () => ({ ok: true as const, state }),
    nodeAuthorization: async () => ({ ok: true as const }),
  };
  return { ...base, ...overrides } as unknown as WalletClient;
}

test("wallet UI e2e: onboarding validation, secret handoff, lock, and keyboard unlock", async () => {
  const dom = installDOM();
  let state: WalletState = { initialized: false, locked: true, accounts: [], active: null };
  let created: { password: string; mnemonic?: string } | undefined;
  const wallet = walletFor(state, {
    getState: async () => ({ ok: true, state }),
    create: async (password, options) => { created = { password, mnemonic: options.mnemonic }; state = openState(); return { ok: true, state }; },
    lock: async () => { state = { ...state, locked: true }; return { ok: true, state }; },
    unlock: async (password) => password === "correct horse"
      ? (state = { ...state, locked: false }, { ok: true, state })
      : { ok: false, error: "Wrong password" },
  });
  const store = memoryStore();
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch(), requestOrigins: async () => true });
  assert.equal(document.querySelector(".wordmark")?.textContent, "SELFHOLD");

  button("Create wallet").click();
  input("password (min 8)").value = "short";
  input("confirm password").value = "short";
  button("Continue").click();
  assert.match(document.body.textContent ?? "", /at least 8 characters/);
  input("password (min 8)").value = "correct horse";
  input("confirm password").value = "not the same";
  button("Continue").click();
  assert.match(document.body.textContent ?? "", /do not match/);
  input("confirm password").value = "correct horse";
  button("Continue").click();
  const phrase = document.querySelector(".mnemonic")?.textContent ?? "";
  assert.equal(phrase.trim().split(/\s+/).length, 12);
  button("I saved it — create").click();
  await settle();
  assert.equal(created?.password, "correct horse");
  assert.equal(created?.mnemonic, phrase);
  assert.doesNotMatch(document.body.textContent ?? "", new RegExp(phrase.split(" ")[0]! + " " + phrase.split(" ")[1]!));

  (document.getElementById("settings-button") as HTMLButtonElement).click();
  button("Lock wallet").click();
  await settle();
  assert.equal(document.querySelector(".wordmark")?.textContent, "WALLET");
  assert.equal(document.querySelector("h1")?.textContent, "Unlock");
  const password = input("password");
  password.value = "wrong";
  password.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  assert.match(document.body.textContent ?? "", /Wrong password/);
  password.value = "correct horse";
  password.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  assert.match(document.body.textContent ?? "", /Balance/);
});

test("wallet UI e2e: fee validation, review, signing, submission, and persistence", async () => {
  installDOM();
  let submitted = 0;
  let signedArgs: Record<string, unknown> | undefined;
  const signedSubmit = { transactionCID: "bafysent", bodyCID: "bafybody", payload: { transaction: { signatures: {}, body: {
    accountActions: [], actions: [], depositActions: [], receiptActions: [], withdrawalActions: [],
    signers: [alice], nonce: "3", chainPath: ["Nexus"],
  } } } };
  const wallet = walletFor(openState(), {
    signTransfer: async (args) => { signedArgs = args; return { ok: true, signedSubmit, summary: { from: args.from, to: args.to, amount: args.amount, fee: args.fee, nonce: args.nonce } }; },
  });
  const store = memoryStore();
  const fetch = nodeFetch({ onSubmit: () => { submitted += 1; } });
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080", fetch, requestOrigins: async () => true });
  button("Send").click();
  await settle();

  assert.match(document.body.textContent ?? "", /depends on miners and current demand/);

  const recipient = input("recipient address (bafy…)");
  const amount = (document.querySelector('input[aria-label="Amount"]') as HTMLInputElement);
  recipient.value = "nope";
  amount.value = "10";
  button("Review").click();
  assert.match(document.body.textContent ?? "", /valid recipient/);
  recipient.value = alice;
  button("Review").click();
  assert.match(document.body.textContent ?? "", /this account/);
  recipient.value = bob;
  amount.value = "0";
  button("Review").click();
  assert.match(document.body.textContent ?? "", /whole, positive amount/);
  amount.value = "100";
  button("Review").click();
  await settle();
  assert.match(document.body.textContent ?? "", /Insufficient balance/);
  amount.value = "10";
  button("Review").click();
  await settle();
  assert.equal(document.querySelector("h1")?.textContent, "Review");
  assert.match(document.body.textContent ?? "", /Network fee1/);
  assert.match(document.body.textContent ?? "", /Total11/);
  assert.match(document.body.textContent ?? "", new RegExp(alice));
  assert.match(document.body.textContent ?? "", new RegExp(bob));
  button("Sign & send").click();
  await settle();
  assert.equal(submitted, 1);
  assert.deepEqual(signedArgs, { from: alice, to: bob, amount: "10", fee: "1", nonce: "3", chainPath: ["Nexus"] });
  assert.equal(store.value.settings.sent.Nexus?.[0]?.cid, "bafysent");
  assert.match(document.body.textContent ?? "", /bafysent/);
});

test("wallet UI e2e: custom-fee warnings, read-only nodes, and receive copy", async () => {
  installDOM();
  let copied = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  const wallet = walletFor(openState());
  const store = memoryStore();
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080",
    fetch: nodeFetch({ minimum: 3n }), requestOrigins: async () => true });
  button("Send").click();
  await settle();
  const custom = document.querySelector('details.advanced input[inputmode="numeric"]') as HTMLInputElement;
  custom.value = "2";
  custom.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal((document.querySelector("details.advanced") as HTMLDetailsElement).open, true);
  assert.match(document.body.textContent ?? "", /at least 3/);

  button("Cancel").click();
  await settle();
  button("Receive").click();
  assert.match(document.body.textContent ?? "", new RegExp(alice));
  button("Copy").click();
  await settle();
  assert.equal(copied, alice);
  assert.match(document.body.textContent ?? "", /copied/);

  installDOM();
  const readOnlyStore = memoryStore({ endpoints: { Nexus: { url: "https://node.test", acceptsSubmit: false, source: "user" as const } } });
  await startWallet({ wallet, store: readOnlyStore.api, fetch: nodeFetch({ acceptsSubmit: false }), requestOrigins: async () => true });
  await settle();
  button("Send").click();
  assert.match(document.body.textContent ?? "", /does not accept submits/);
  assert.equal([...document.querySelectorAll("button")].some((item) => item.textContent === "Review"), false);
});

test("wallet UI e2e: an ambiguous send is saved before submit and cannot be re-signed", async () => {
  installDOM();
  let signCalls = 0;
  const signedSubmit = { transactionCID: "bafyuncertain", bodyCID: "bafybody", payload: { transaction: { signatures: {}, body: {
    accountActions: [], actions: [], depositActions: [], receiptActions: [], withdrawalActions: [],
    signers: [alice], nonce: "3", chainPath: ["Nexus"],
  } } } };
  const wallet = walletFor(openState(), {
    signTransfer: async (args) => { signCalls += 1; return { ok: true, signedSubmit, summary: { from: args.from, to: args.to, amount: args.amount, fee: args.fee, nonce: args.nonce } }; },
  });
  const store = memoryStore();
  const submitState = { failSubmit: true, submitRefusal: undefined as string | undefined };
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch(submitState), requestOrigins: async () => true });
  button("Send").click();
  await settle();
  input("recipient address (bafy…)").value = bob;
  (document.querySelector('input[aria-label="Amount"]') as HTMLInputElement).value = "10";
  button("Review").click();
  await settle();
  button("Sign & send").click();
  await settle();
  assert.equal(signCalls, 1);
  assert.equal(document.querySelector("h1")?.textContent, "Sent");
  assert.match(document.body.textContent ?? "", /unknown to node/i);
  assert.equal(store.value.settings.sent.Nexus?.[0]?.cid, "bafyuncertain");
  assert.equal(store.value.settings.sent.Nexus?.[0]?.signedSubmit, undefined, "display history does not duplicate recovery bytes");
  assert.equal(store.value.settings.pendingSubmissions?.[0]?.cid, "bafyuncertain");
  assert.deepEqual(store.value.settings.pendingSubmissions?.[0]?.signedSubmit, signedSubmit);
  assert.equal([...document.querySelectorAll("button")].some((item) => item.textContent === "Sign & send"), false);
  button("Done").click();
  await settle();
  button("Activity").click();
  button("Transactions").click();
  await settle();
  assert.equal(document.querySelector("h1")?.textContent, "Transactions");
  assert.equal(document.querySelectorAll(".transaction-item").length, 1, "history and recovery are deduplicated");
  const transactionDetails = document.querySelector(".transaction-item") as HTMLDetailsElement;
  assert.equal(transactionDetails.open, false, "technical details are initially collapsed");
  transactionDetails.open = true;
  assert.match(transactionDetails.textContent ?? "", /From.*To.*Chain.*Fee.*Nonce/s);
  assert.match(transactionDetails.textContent ?? "", /Signed recovery is saved/);
  submitState.failSubmit = false;
  submitState.submitRefusal = "conflictingNonce";
  button("Resubmit exact").click();
  await settle();
  assert.equal(store.value.settings.pendingSubmissions?.[0]?.cid, "bafyuncertain", "a retry refusal cannot erase an earlier ambiguous attempt");
  assert.equal(store.value.settings.sent.Nexus?.[0]?.cid, "bafyuncertain");
  assert.match(document.body.textContent ?? "", /saved transaction was kept/i);
});

test("wallet UI e2e: a refusal retains recovery bytes and cannot invite another signature", async () => {
  installDOM();
  const signedSubmit = { transactionCID: "bafyrejected", bodyCID: "bafybody", payload: { transaction: { signatures: {}, body: {
    accountActions: [], actions: [], depositActions: [], receiptActions: [], withdrawalActions: [],
    signers: [alice], nonce: "3", chainPath: ["Nexus"],
  } } } };
  const wallet = walletFor(openState(), {
    signTransfer: async (args) => ({ ok: true, signedSubmit, summary: { from: args.from, to: args.to, amount: args.amount, fee: args.fee, nonce: args.nonce } }),
  });
  const store = memoryStore();
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch({ submitRefusal: "belowMinRelayFee" }), requestOrigins: async () => true });
  button("Send").click();
  await settle();
  input("recipient address (bafy…)").value = bob;
  (document.querySelector('input[aria-label="Amount"]') as HTMLInputElement).value = "10";
  button("Review").click();
  await settle();
  button("Sign & send").click();
  await settle();
  assert.equal(document.querySelector("h1")?.textContent, "Sent");
  assert.match(document.body.textContent ?? "", /Do not create this transaction again/);
  assert.equal(store.value.settings.sent.Nexus?.[0]?.cid, signedSubmit.transactionCID);
  assert.deepEqual(store.value.settings.pendingSubmissions?.[0]?.signedSubmit, signedSubmit);
});

test("wallet UI e2e: a signer that locked itself is unlocked in place and the step continues", async () => {
  const dom = installDOM();
  let locked = true, signs = 0, submitted = 0, unlocks: string[] = [];
  const signedSubmit = { transactionCID: "bafysent", bodyCID: "bafybody", payload: { transaction: { signatures: {}, body: {
    accountActions: [], actions: [], depositActions: [], receiptActions: [], withdrawalActions: [],
    signers: [alice], nonce: "3", chainPath: ["Nexus"],
  } } } };
  const wallet = walletFor(openState(), {
    // The page still believes it is unlocked; the signer knows better.
    signTransfer: async (args) => {
      signs += 1;
      return locked ? { ok: false, error: "Locked" }
        : { ok: true, signedSubmit, summary: { from: args.from, to: args.to, amount: args.amount, fee: args.fee, nonce: args.nonce } };
    },
    unlock: async (password) => {
      unlocks.push(password);
      if (password !== "correct horse") return { ok: false, error: "Wrong password" };
      locked = false;
      return { ok: true, state: openState() };
    },
  });
  const store = memoryStore();
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch({ onSubmit: () => { submitted += 1; } }), requestOrigins: async () => true });
  const review = async () => {
    button("Send").click();
    await settle();
    input("recipient address (bafy…)").value = bob;
    (document.querySelector('input[aria-label="Amount"]') as HTMLInputElement).value = "10";
    button("Review").click();
    await settle();
  };
  const dialog = () => document.querySelector('[role="dialog"][aria-label="Unlock wallet"]');
  const inDialog = (text: string) => [...dialog()!.querySelectorAll("button")].find((item) => item.textContent === text) as HTMLButtonElement;

  // The password is asked for over the review, and there is no way past it.
  await review();
  button("Sign & send").click();
  await settle();
  assert.ok(dialog(), "the password is asked for over the review");
  assert.equal(document.querySelector("h1")?.textContent, "Review", "the review underneath is kept");
  assert.match(dialog()!.textContent ?? "", /Nothing was signed or sent/);
  assert.deepEqual([...dialog()!.querySelectorAll("button")].map((item) => item.textContent), ["Unlock"], "a locked wallet offers only to unlock");
  assert.equal(submitted, 0);

  // Wrong, then right: the same request is sent again and the transfer goes out.
  const password = dialog()!.querySelector("input") as HTMLInputElement;
  password.value = "wrong";
  inDialog("Unlock").click();
  await settle();
  assert.match(dialog()!.textContent ?? "", /That password is not right/);
  assert.equal(submitted, 0);
  password.value = "correct horse";
  password.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  assert.equal(dialog(), null);
  assert.deepEqual(unlocks, ["wrong", "correct horse"]);
  assert.equal(signs, 2, "locked, then signed once unlocked");
  assert.equal(submitted, 1);
  assert.equal(store.value.settings.pendingSubmissions[0]?.cid, "bafysent");
});

test("wallet UI e2e: a signer that locked covers the page until the password is given", async () => {
  const dom = installDOM();
  let state = openState();
  let unlocked = 0;
  let tellLocked = () => {};
  const wallet = walletFor(state, {
    getState: async () => ({ ok: true, state }),
    unlock: async () => { unlocked += 1; state = openState(); return { ok: true, state }; },
  });
  await startWallet({
    wallet, store: memoryStore().api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch(), requestOrigins: async () => true,
    onLocked: (tell) => { tellLocked = tell; },
  });
  await settle();
  const cover = () => document.querySelector('[role="dialog"][aria-label="Unlock wallet"]');
  const unlock = async () => {
    (cover()!.querySelector("input") as HTMLInputElement).value = "correct horse";
    ([...cover()!.querySelectorAll("button")].find((item) => item.textContent === "Unlock") as HTMLButtonElement).click();
    await settle();
  };
  assert.equal(cover(), null);

  // The host says its signer locked: the page is covered at once, not at the next check.
  state = { ...state, locked: true, accounts: [] };
  tellLocked();
  await settle();
  assert.match(cover()?.textContent ?? "", /Wallet locked/);
  assert.ok(cover()!.classList.contains("lock-cover"), "the cover sits over everything");
  // Nothing under the cover can be reached by keyboard or screen reader: all of it is inert, the cover is not.
  const under = [...document.body.children].filter((part) => part !== cover());
  assert.ok(under.length > 0 && under.every((part) => part.hasAttribute("inert")), "everything behind the cover is inert");
  assert.equal(cover()!.hasAttribute("inert"), false);
  assert.equal(document.activeElement, cover()!.querySelector("input"), "the password field has the keyboard");
  assert.match(document.getElementById("view")!.textContent ?? "", /Balance/, "the screen underneath is as it was left");
  tellLocked();
  await settle();
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, "told twice, covered once");
  await unlock();
  assert.equal(unlocked, 1);
  assert.equal(cover(), null);
  assert.equal([...document.body.children].some((part) => part.hasAttribute("inert")), false, "unlocked, the page is reachable again");

  // A signer that stopped without a word is found when the page comes back into view.
  state = { ...state, locked: true, accounts: [] };
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await settle();
  assert.ok(cover(), "covered on return");
  await unlock();
  assert.equal(unlocked, 2);
  assert.equal(cover(), null);
});

test("wallet UI e2e: a host's own screens are offered where it says: home, Settings, or both", async () => {
  installDOM();
  const opened: string[] = [];
  const action = (label: string, on?: "home" | "settings") => ({ label, on, run: () => { opened.push(label); } });
  await startWallet({
    wallet: walletFor(openState(), {}), store: memoryStore().api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch(), requestOrigins: async () => true,
    actions: [action("Mining", "home"), action("Node", "settings"), action("Help")],
  });
  await settle();
  const offered = () => [...document.querySelectorAll("#view button")].map((item) => item.getAttribute("data-row") ?? item.textContent).filter((text) => ["Mining", "Node", "Help"].includes(text ?? ""));
  assert.deepEqual(offered(), ["Mining", "Help"], "beside Send and Receive");
  button("Mining").click();
  document.getElementById("settings-button")!.click();
  await settle();
  assert.deepEqual(offered(), ["Node", "Help"], "in Settings");
  button("Node").click();
  assert.deepEqual(opened, ["Mining", "Node"]);
});

test("wallet UI e2e: a wallet opened locked on a child chain offers the way up once unlocked", async () => {
  installDOM();
  let state: WalletState = { ...openState(), locked: true, accounts: [], active: null };
  const wallet = walletFor(state, {
    getState: async () => ({ ok: true, state }),
    unlock: async () => { state = openState(); return { ok: true, state }; },
  });
  const store = memoryStore({ chain: "Nexus/shop", chains: ["Nexus", "Nexus/shop"] });
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch(), requestOrigins: async () => true });
  await settle();
  const badge = document.getElementById("net-badge") as HTMLButtonElement;
  assert.equal(document.querySelector("h1")?.textContent, "Unlock");
  badge.click();
  await settle();
  assert.equal(document.querySelector(".chain-menu"), null, "nothing to navigate while locked");
  input("password").value = "correct horse";
  button("Unlock").click();
  await settle();
  // Unlocked on Nexus/shop: its parent is the row above it in the menu, one press away.
  badge.click();
  await settle();
  assert.equal(document.querySelector('.chain-menu-item[aria-current="true"]')?.getAttribute("data-chain"), "Nexus/shop");
  (document.querySelector('.chain-menu-item[data-chain="Nexus"]') as HTMLButtonElement).click();
  await settle();
  assert.equal(store.value.settings.chain, "Nexus");
});

test("the home screen says the node is unreachable only when the host has no better account of it", async () => {
  installDOM();
  const fetch = async () => { throw new TypeError("connection refused"); };
  let lines: { text: string }[] = [];
  await startWallet({
    wallet: walletFor(openState()), store: memoryStore().api, ownNode: "http://127.0.0.1:8080", fetch, requestOrigins: async () => true,
    notices: async () => lines,
  });
  await settle();
  const value = document.querySelector(".balance-value .v") as HTMLElement;
  assert.equal(value.textContent, "node unreachable", "the host has nothing to say");
  lines = [{ text: "Your node is starting." }];
  button("Refresh balance").click();
  await settle();
  assert.equal(value.textContent, "—");
  assert.equal(document.querySelector(".notice")?.textContent, "Your node is starting.");
});

test("wallet UI e2e: a locked update re-reads storage and preserves another page's recovery bytes", async () => {
  installDOM();
  let lockRequests = 0;
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request: async (_name: string, _options: LockOptions, task: () => Promise<unknown>) => {
      lockRequests += 1;
      return task();
    },
  } });
  const store = memoryStore();
  await startWallet({ wallet: walletFor(openState()), store: store.api, ownNode: "http://127.0.0.1:8080",
    fetch: nodeFetch(), requestOrigins: async () => true });

  const signedSubmit = { transactionCID: "bafyfromotherpage", bodyCID: "bafybody", payload: { transaction: { signatures: {}, body: {
    accountActions: [], actions: [], depositActions: [], receiptActions: [], withdrawalActions: [],
    signers: [alice], nonce: "9", chainPath: ["Nexus"],
  } } } };
  await store.api.set({ settings: {
    ...store.value.settings,
    pendingSubmissions: [{
      cid: signedSubmit.transactionCID, to: bob, amount: "7", at: Date.now(), from: alice,
      fee: "1", nonce: "9", signedSubmit, chain: "Nexus",
    }],
  } });

  (document.getElementById("settings-button") as HTMLButtonElement).click();
  button("Default fee").click();
  const fee = document.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
  fee.value = "7";
  button("Save").click();
  await settle();

  assert.ok(lockRequests > 0, "the write uses the cross-page lock");
  assert.equal(store.value.settings.fees.Nexus, "7");
  assert.equal(store.value.settings.pendingSubmissions[0]?.cid, signedSubmit.transactionCID);
  assert.deepEqual(store.value.settings.pendingSubmissions[0]?.signedSubmit, signedSubmit,
    "a stale page cannot overwrite signed recovery data saved by another page");
});

test("wallet UI e2e: a background cross-page chain change cannot redirect a reviewed transfer or its cookie", async () => {
  installDOM();
  const own = "https://own.test", other = "https://other.test";
  const signed = (cid: string, path: string[], nonce: string) => ({ transactionCID: cid, bodyCID: "bafybody", payload: { transaction: { signatures: {}, body: {
    accountActions: [], actions: [], depositActions: [], receiptActions: [], withdrawalActions: [],
    signers: [alice], nonce, chainPath: path,
  } } } });
  const old = signed("bafyold", ["Nexus"], "2");
  const store = memoryStore({ nodeMode: "custom", chains: ["Nexus", "Nexus/shop"],
    endpoints: { Nexus: { url: own, acceptsSubmit: true, source: "user" }, "Nexus/shop": { url: other, acceptsSubmit: true, source: "user" } },
    pendingSubmissions: [{ cid: old.transactionCID, to: bob, amount: "1", at: 1, from: alice, fee: "1", nonce: "2", chain: "Nexus", signedSubmit: old }],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let signedPath: readonly string[] | undefined;
  const posts: { origin: string; auth: string | null }[] = [];
  const fetch = async (raw: string | URL, init?: RequestInit) => {
    const url = new URL(raw);
    if (init?.method === "POST") {
      posts.push({ origin: url.origin, auth: new Headers(init.headers).get("Authorization") });
      return json({ transactionCID: "bafysent" });
    }
    if (url.pathname === "/api/transaction/bafyold") {
      await gate;
      return json({ txCID: old.transactionCID, blockHeight: "1", blockHash: "bafyblock", timestamp: "1", nonce: "2", signers: [alice], chainPath: ["Nexus"],
        accountActions: [], depositActions: [], receiptActions: [], withdrawalActions: [], actions: [] });
    }
    if (url.pathname === "/api/chain/info") return json({ chain: (url.searchParams.get("chainPath") ?? "Nexus").split("/"), minRelayFee: "1", acceptsSubmit: true, height: "50", tipCID: "bafytip" });
    if (url.pathname.startsWith("/api/state/account/")) return json({ owner: alice, balance: "100", nonce: "3" });
    return json({ error: { message: "not found" } }, 404);
  };
  const wallet = walletFor(openState(), {
    nodeAuthorization: async (url) => ({ ok: true, ...(url === own ? { authorization: "Basic disposable-own-cookie" } : {}) }),
    signTransfer: async (args) => { signedPath = args.chainPath; return { ok: true, signedSubmit: signed("bafysent", [...args.chainPath], "3"), summary: { from: args.from, to: args.to, amount: args.amount, fee: args.fee, nonce: args.nonce } }; },
  });
  await startWallet({ wallet, store: store.api, fetch, requestOrigins: async () => true });
  await settle();
  button("Send").click(); await settle();
  input("recipient address (bafy…)").value = bob;
  (document.querySelector('input[aria-label="Amount"]') as HTMLInputElement).value = "10";
  button("Review").click(); await settle();
  await store.api.set({ settings: { ...store.value.settings, chain: "Nexus/shop" } });
  release(); await settle();
  assert.equal(store.value.settings.confirmedSubmissions.length, 1, "background archive reloaded the other page's settings");
  assert.match(document.getElementById("net-badge")?.textContent ?? "", /Nexus\/shop/);
  button("Sign & send").click(); await settle();
  assert.deepEqual(signedPath, ["Nexus"]);
  assert.deepEqual(posts, [{ origin: own, auth: "Basic disposable-own-cookie" }]);
  assert.equal(store.value.settings.pendingSubmissions[0]?.chain, "Nexus");
});

test("wallet UI e2e: saved uncertain payments require explicit acknowledgement before signing another", async () => {
  installDOM();
  let signatures = 0;
  const signedSubmit = { transactionCID: "bafynew", bodyCID: "bafybody", payload: { transaction: { signatures: {}, body: {
    accountActions: [], actions: [], depositActions: [], receiptActions: [], withdrawalActions: [], signers: [alice], nonce: "3", chainPath: ["Nexus"],
  } } } };
  const store = memoryStore({ pendingSubmissions: [{ cid: "bafyold", to: bob, amount: "10", at: 1, from: alice, fee: "1", nonce: "2", signedSubmit, chain: "Nexus" }] });
  const wallet = walletFor(openState(), { signTransfer: async (args) => { signatures += 1; return { ok: true, signedSubmit, summary: { from: args.from, to: args.to, amount: args.amount, fee: args.fee, nonce: args.nonce } }; } });
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch(), requestOrigins: async () => true });
  button("Send").click(); await settle();
  input("recipient address (bafy…)").value = bob; (document.querySelector('input[aria-label="Amount"]') as HTMLInputElement).value = "10";
  button("Review").click(); await settle();
  button("Sign & send").click(); await settle();
  assert.equal(signatures, 0);
  assert.match(document.body.textContent ?? "", /may pay twice/);
  button("Send another payment").click(); await settle();
  assert.equal(signatures, 1);
});

test("the home screen says what the host says, in words, with the one thing to do about it", async () => {
  installDOM();
  let down = true;
  let started = 0;
  const fetch = async (raw: string | URL, init?: RequestInit) => {
    if (down) throw new TypeError("connection refused");
    return nodeFetch({ balance: 250n })(raw, init);
  };
  await startWallet({
    wallet: walletFor(openState()), store: memoryStore().api, ownNode: "http://127.0.0.1:8080", fetch, requestOrigins: async () => true,
    actions: [{ label: "Node", run: () => {} }],
    notices: async (chain) => down
      ? [{ text: `Your node is stopped, so ${chain} cannot be read.`, action: { label: "Start node", run: async () => { started += 1; down = false; } } }]
      : [{ text: "Syncing. Balances may be behind." }],
  });
  await settle();
  // A read that failed is a sentence, not a balance: it is not set in the balance's type.
  const value = document.querySelector(".balance-value .v") as HTMLElement;
  assert.equal(value.classList.contains("unread"), true);
  // The host has said why, so the balance does not also guess ("node unreachable").
  assert.equal(value.textContent, "—");
  assert.match(document.querySelector(".balance-label")?.textContent ?? "", /^Balance on Nexus$/);
  assert.match(document.querySelector(".notice")?.textContent ?? "", /Your node is stopped, so Nexus cannot be read\.Start node/);
  button("Start node").click();
  await settle();
  assert.equal(started, 1);
  assert.equal(value.textContent, "250");
  assert.equal(value.classList.contains("unread"), false);
  // A notice with nothing to do about it has no button.
  assert.equal(document.querySelector(".notice")?.textContent, "Syncing. Balances may be behind.");
  assert.equal(document.querySelector(".notice button"), null);

  // The mark says what it does, and Settings carries the host's own screens.
  const mark = document.getElementById("settings-button") as HTMLButtonElement;
  assert.equal(mark.textContent, "Settings");
  mark.click();
  assert.equal(mark.textContent, "Close");
  // The host's screen is a row in the Node group; a wallet on its own node has no connection to choose.
  assert.deepEqual([...document.querySelectorAll(".nav-label")].map((label) => label.textContent), ["Wallet", "This chain · Nexus", "Node"]);
  assert.equal(button("Node").closest(".nav-group")?.querySelector(".nav-label")?.textContent, "Node");
  assert.doesNotMatch(document.body.textContent ?? "", /ConnectionAutomatic|read \+ send/);
  mark.click();
  await settle();

  // Amounts say what they count; the nonce is a detail; the address can be scanned.
  button("Send").click();
  await settle();
  input("recipient address (bafy…)").value = bob;
  (document.querySelector('input[aria-label="Amount"]') as HTMLInputElement).value = "10";
  button("Review").click();
  await settle();
  const review = document.querySelector("#view .kv") as HTMLElement;
  assert.match(review.textContent ?? "", /Amount10 on NexusNetwork fee1 on NexusTotal11 on Nexus/);
  assert.doesNotMatch(review.textContent ?? "", /Nonce/);
  assert.match(document.querySelector("details.advanced")?.textContent ?? "", /Nonce3/);
  // One filled button: the one that sends. The way back is outlined.
  assert.deepEqual([...document.querySelectorAll("#view button")].filter((item) => item.classList.contains("block") && !item.classList.contains("btn")).map((item) => item.textContent), ["Sign & send"]);
  button("Cancel").click();
  await settle();
  button("Receive").click();
  assert.ok(document.querySelector(".qr svg"), "the address is shown as a QR code");
});

test("before there is a wallet, the header offers nothing that would do nothing", async () => {
  installDOM();
  const wallet = walletFor({ initialized: false, locked: true, accounts: [], active: null });
  await startWallet({ wallet, store: memoryStore().api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch(), requestOrigins: async () => true });
  for (const id of ["settings-button", "net-badge"]) assert.equal(document.getElementById(id)!.style.visibility, "hidden", id);
});

test("wallet UI e2e: the account is renamed where its name is shown, and Escape keeps the old name", async () => {
  installDOM();
  let vault: Vault | null = null;
  const signer = createSigner({ load: async () => vault, save: async (v) => { vault = v; }, remove: async () => { vault = null; } });
  const client = walletClient(signer.handle);
  await client.create("pw-pw-pw-pw", { privHex: "a1".repeat(32) });
  await client.importKey("b0".repeat(32), "Cold");
  await client.setActive(alice);
  await startWallet({ wallet: client, store: memoryStore().api, fetch: nodeFetch(), requestOrigins: async () => true });
  await settle();
  const name = () => document.querySelector(".account-name") as HTMLElement;
  const picker = () => document.querySelector(".account-picker") as HTMLSelectElement;
  const field = () => document.querySelector('input[aria-label="Account name"]') as HTMLInputElement | null;
  const key = (k: string) => field()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  assert.equal(name().textContent, "Imported 1");

  button("Rename account").click();
  assert.ok(field(), "the name becomes a field");
  assert.equal(field()!.value, "Imported 1");
  field()!.value = "Throwaway"; key("Escape"); await settle();
  assert.equal(field(), null); assert.equal(name().textContent, "Imported 1", "Escape keeps the old name");

  button("Rename account").click();
  field()!.value = "cold"; key("Enter"); await settle();
  assert.ok(field(), "a refused name stays in the field to be corrected");
  assert.match(document.body.textContent ?? "", /already named “Cold”/);

  field()!.value = "Mining  rewards"; key("Enter"); await settle();
  assert.equal(field(), null);
  assert.equal(name().textContent, "Mining rewards");
  assert.match(picker().selectedOptions[0]!.textContent ?? "", /^Mining rewards · /, "the account menu shows the new name at once");
  const state = await client.getState();
  assert.ok(state.ok && state.state.accounts.find((a) => a.address === alice)!.label === "Mining rewards");

  // Preserve the complete maximum-length label; actual wrapping needs browser QA.
  const longName = "QA " + "L".repeat(61);
  button("Rename account").click();
  field()!.value = longName; key("Enter"); await settle();
  assert.equal(name().textContent, longName);
  assert.equal(button("Rename account").disabled, false);
  assert.equal(button("Copy account address").disabled, false);
  button("Rename account").click();
  assert.equal(field()!.value, longName, "editing retains the full name");
  key("Escape"); await settle();
  assert.equal(name().textContent, longName);
});

test("wallet UI e2e: a new account opens with its name ready to type; Escape keeps the default", async () => {
  installDOM();
  let vault: Vault | null = null;
  const signer = createSigner({ load: async () => vault, save: async (v) => { vault = v; }, remove: async () => { vault = null; } });
  const client = walletClient(signer.handle);
  await client.create("pw-pw-pw-pw", { mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" });
  await startWallet({ wallet: client, store: memoryStore().api, fetch: nodeFetch(), requestOrigins: async () => true });
  await settle();
  const field = () => document.querySelector('input[aria-label="Account name"]') as HTMLInputElement | null;
  const key = (k: string) => field()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const add = () => {
    const picker = document.querySelector(".account-picker") as HTMLSelectElement;
    picker.value = "__add"; picker.dispatchEvent(new Event("change"));
  };
  assert.equal(field(), null, "the home screen opens with no field");

  add(); await settle();
  assert.ok(field(), "the new account's name is a field");
  assert.equal(field()!.value, "Account 2");
  assert.equal(document.activeElement, field(), "ready to type");
  field()!.value = "Savings"; key("Enter"); await settle();
  assert.equal(document.querySelector(".account-name")!.textContent, "Savings");

  add(); await settle();
  assert.equal(field()!.value, "Account 3");
  key("Escape"); await settle();
  assert.equal(document.querySelector(".account-name")!.textContent, "Account 3", "Escape keeps the default");
  const state = await client.getState();
  assert.ok(state.ok);
  assert.deepEqual(state.state.accounts.map((a) => a.label), ["Account 1", "Savings", "Account 3"]);
});
