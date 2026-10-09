import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { WalletClient } from "../src/lib/wallet/client.ts";
import { DEFAULT_SETTINGS } from "../src/lib/wallet/settings.ts";
import type { WalletState } from "../src/lib/wallet/types.ts";
import { startWallet } from "../src/popup/app.ts";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 24; i += 1) await tick(); }

function installDOM() {
  const dom = new JSDOM('<button id="settings-button"></button><button id="parent-chain"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
  for (const name of ["window", "document", "navigator", "Node", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "KeyboardEvent", "Event"]) {
    Object.defineProperty(globalThis, name, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
  }
  return dom;
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent === text || item.getAttribute("aria-label") === text);
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
  const amount = input("amount (units)");
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
  input("amount (units)").value = "10";
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
  (document.getElementById("settings-button") as HTMLButtonElement).click();
  button("Pending transactions (1)").click();
  await settle();
  submitState.failSubmit = false;
  submitState.submitRefusal = "conflictingNonce";
  button("Resubmit exact").click();
  await settle();
  assert.equal(store.value.settings.pendingSubmissions?.[0]?.cid, "bafyuncertain", "a retry refusal cannot erase an earlier ambiguous attempt");
  assert.equal(store.value.settings.sent.Nexus?.[0]?.cid, "bafyuncertain");
  assert.match(document.body.textContent ?? "", /saved transaction was kept/i);
});

test("wallet UI e2e: a definite refusal is removed from recovery history and can be corrected", async () => {
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
  input("amount (units)").value = "10";
  button("Review").click();
  await settle();
  button("Sign & send").click();
  await settle();
  assert.equal(document.querySelector("h1")?.textContent, "Review");
  assert.match(document.body.textContent ?? "", /belowMinRelayFee/);
  assert.equal(button("Sign & send").disabled, false);
  assert.deepEqual(store.value.settings.sent.Nexus ?? [], []);
  assert.deepEqual(store.value.settings.pendingSubmissions ?? [], []);
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
