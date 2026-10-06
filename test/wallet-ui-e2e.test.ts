import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { WalletClient } from "../src/lib/wallet/client.ts";
import { DEFAULT_SETTINGS } from "../src/lib/wallet/settings.ts";
import type { WalletState } from "../src/lib/wallet/types.ts";
import { startWallet } from "../src/popup/app.ts";

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
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  assert.ok(found, `button ${text} exists; page was: ${document.body.textContent}`);
  return found as HTMLButtonElement;
}

function buttonStarting(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.startsWith(text));
  assert.ok(found, `button starting ${text} exists; page was: ${document.body.textContent}`);
  return found as HTMLButtonElement;
}

function input(placeholder: string): HTMLInputElement {
  const found = document.querySelector(`input[placeholder="${placeholder}"]`);
  assert.ok(found, `input ${placeholder} exists`);
  return found as HTMLInputElement;
}

const alice = "bafy" + "a".repeat(48);
const bob = "bafy" + "b".repeat(48);
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
const projection = (cid: string, fee: bigint) => ({
  txCID: cid, nonce: "0", signers: [alice], chainPath: ["Nexus"],
  accountActions: [{ owner: alice, delta: `-${fee + 10n}` }, { owner: bob, delta: "10" }],
  depositActions: [], receiptActions: [], withdrawalActions: [],
});

function nodeFetch(options: {
  balance?: bigint; minimum?: bigint; pool?: Array<[string, bigint]>; poolCount?: number;
  acceptsSubmit?: boolean; failSpec?: boolean; failTransactions?: Set<string>;
  onSubmit?: () => void;
} = {}) {
  const balance = options.balance ?? 100n;
  const minimum = options.minimum ?? 1n;
  const pool = options.pool ?? [];
  return async (raw: string | URL, init?: RequestInit) => {
    const url = new URL(raw);
    if (url.pathname === "/api/chain/info") return json({ chain: ["Nexus"], minRelayFee: minimum.toString(), acceptsSubmit: options.acceptsSubmit ?? true });
    if (url.pathname === "/api/chain/spec") return options.failSpec
      ? json({ error: { message: "not found" } }, 404)
      : json({ targetBlockTime: "60000", maxNumberOfTransactionsPerBlock: "2" });
    if (url.pathname === "/api/mempool") return json({ count: options.poolCount ?? pool.length, transactions: pool.map(([cid]) => cid) });
    if (url.pathname.startsWith("/api/transaction/")) {
      const cid = url.pathname.split("/").at(-1)!;
      if (options.failTransactions?.has(cid)) return json({ error: { message: "not found" } }, 404);
      const row = pool.find(([candidate]) => candidate === cid);
      return row ? json(projection(row[0], row[1])) : json({ error: { message: "not found" } }, 404);
    }
    if (url.pathname === `/api/state/account/${alice}`) return json({ owner: alice, balance: balance.toString(), nonce: "3" });
    if (url.pathname === "/api/block/latest") return json({ height: "8", hash: "bafytip", timestamp: "1", transactionCount: 0 });
    if (url.pathname === "/api/block/bafytip/children") return json({ children: [] });
    if (url.pathname === "/transactions" && init?.method === "POST") {
      options.onSubmit?.();
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

test("wallet UI e2e: fee choices, validation, review, signing, submission, and persistence", async () => {
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
  const fetch = nodeFetch({ pool: [["a", 9n], ["b", 5n], ["c", 2n]], onSubmit: () => { submitted += 1; } });
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080", fetch, requestOrigins: async () => true });
  button("Send").click();
  await settle();

  assert.equal(buttonStarting("Recommended").dataset.fee, "1");
  assert.equal(buttonStarting("Priority").dataset.fee, "6");
  assert.match(document.querySelector(".fee-eta")?.textContent ?? "", /Estimated 2 blocks · ~2 min/);
  buttonStarting("Priority").click();
  assert.equal(buttonStarting("Priority").getAttribute("aria-pressed"), "true");
  assert.match(document.querySelector(".fee-eta")?.textContent ?? "", /Estimated 1 block · ~1 min/);

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
  assert.match(document.body.textContent ?? "", /Network fee6/);
  assert.match(document.body.textContent ?? "", /Total16/);
  assert.match(document.body.textContent ?? "", new RegExp(alice));
  assert.match(document.body.textContent ?? "", new RegExp(bob));
  button("Sign & send").click();
  await settle();
  assert.equal(submitted, 1);
  assert.deepEqual(signedArgs, { from: alice, to: bob, amount: "10", fee: "6", nonce: "3", chainPath: ["Nexus"] });
  assert.equal(store.value.settings.sent.Nexus?.[0]?.cid, "bafysent");
  assert.match(document.body.textContent ?? "", /bafysent/);
});

test("wallet UI e2e: partial estimates, custom-fee warnings, unavailable estimates, read-only nodes, and receive copy", async () => {
  installDOM();
  let copied = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  const wallet = walletFor(openState());
  const store = memoryStore();
  await startWallet({ wallet, store: store.api, ownNode: "http://127.0.0.1:8080",
    fetch: nodeFetch({ minimum: 3n, pool: [["good", 7n], ["gone", 5n]], poolCount: 202, failTransactions: new Set(["gone"]) }), requestOrigins: async () => true });
  button("Send").click();
  await settle();
  assert.match(document.querySelector(".fee-eta")?.textContent ?? "", /partial mempool/);
  const custom = document.querySelector('details.advanced input[inputmode="numeric"]') as HTMLInputElement;
  custom.value = "2";
  custom.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal((document.querySelector("details.advanced") as HTMLDetailsElement).open, true);
  assert.match(document.body.textContent ?? "", /at least 3/);
  assert.match(document.querySelector(".fee-eta")?.textContent ?? "", /Below this node's minimum/);

  button("Cancel").click();
  await settle();
  button("Receive").click();
  assert.match(document.body.textContent ?? "", new RegExp(alice));
  button("Copy").click();
  await settle();
  assert.equal(copied, alice);
  assert.match(document.body.textContent ?? "", /copied/);

  installDOM();
  const unavailableStore = memoryStore();
  await startWallet({ wallet, store: unavailableStore.api, ownNode: "http://127.0.0.1:8080", fetch: nodeFetch({ failSpec: true }), requestOrigins: async () => true });
  button("Send").click();
  await settle();
  assert.match(document.body.textContent ?? "", /Fee estimate unavailable/);

  installDOM();
  const readOnlyStore = memoryStore({ endpoints: { Nexus: { url: "https://node.test", acceptsSubmit: false, source: "user" as const } } });
  await startWallet({ wallet, store: readOnlyStore.api, fetch: nodeFetch({ acceptsSubmit: false }), requestOrigins: async () => true });
  await settle();
  button("Send").click();
  assert.match(document.body.textContent ?? "", /does not accept submits/);
  assert.equal([...document.querySelectorAll("button")].some((item) => item.textContent === "Review"), false);
});
