import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { WalletClient } from "../src/lib/wallet/client.ts";
import { DEFAULT_SETTINGS } from "../src/lib/wallet/settings.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 5; i++) await tick(); }

function orderURI(expiresAt: string): string {
  const intent = {
    version: 1, parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], asset: "LAT",
    expiresAt, side: "sell_child", orderType: "limit", amountDeposited: "200", amountDemanded: "300",
  };
  return `lattice://order?v=1&intent=${Buffer.from(JSON.stringify(intent)).toString("base64url")}`;
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  assert.ok(found, `button ${text} exists`);
  return found as HTMLButtonElement;
}

async function openOrder(uri: string) {
  button("Scan cross-chain order").click();
  const paste = document.querySelector("textarea") as HTMLTextAreaElement;
  assert.ok(paste);
  paste.value = uri;
  button("Use pasted text").click();
  await settle();
  assert.match(document.body.textContent ?? "", /Review sell order/);
}

test("sell-order UI refuses a stale review and never re-signs after an uncertain submit", async () => {
  const dom = new JSDOM('<button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });

  const address = "bafy" + "a".repeat(48);
  let signCalls = 0;
  const signedSubmit = {
    transactionCID: "bafytx", bodyCID: "bafybody",
    payload: { transaction: { signatures: {}, body: {
      accountActions: [], actions: [], depositActions: [], receiptActions: [], withdrawalActions: [],
      signers: [address], nonce: "7", chainPath: ["Nexus", "testnet"],
    } } },
  };
  const wallet = {
    getState: async () => ({ ok: true, state: {
      initialized: true, locked: false,
      accounts: [{ address, publicKey: "ed01" + "00".repeat(32), label: "Account 1", kind: "hd", index: 0 }],
      active: address,
    } }),
    signDeposit: async () => { signCalls += 1; return { ok: true, signedSubmit }; },
  } as unknown as WalletClient;

  let stored = { settings: { ...DEFAULT_SETTINGS, chain: "Nexus/testnet", chains: ["Nexus", "Nexus/testnet"] } };
  let savedBeforePost: typeof stored.settings | undefined;
  let postCalls = 0;
  const store = {
    get: async () => stored,
    set: async (items: Record<string, unknown>) => { stored = items as typeof stored; },
  };
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/api/chain/info") return new Response(JSON.stringify({ chain: ["Nexus", "testnet"], minRelayFee: "3", acceptsSubmit: true }));
    if (url.pathname === `/api/state/account/${address}`) return new Response(JSON.stringify({ owner: address, balance: "1000", nonce: "7" }));
    if (url.pathname === "/api/block/latest") return new Response(JSON.stringify({ height: "8", hash: "bafytip", timestamp: "1", transactionCount: 0 }));
    if (url.pathname === "/api/block/bafytip/children") return new Response(JSON.stringify({ children: [{ directory: "payments", blockHash: "bafychild" }] }));
    if (url.pathname === "/transactions" && init?.method === "POST") {
      postCalls += 1;
      savedBeforePost = structuredClone(stored.settings);
      throw new TypeError("connection dropped");
    }
    if (url.pathname === "/api/transaction/bafytx") return new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404 });
    return new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404 });
  };

  const { startWallet } = await import("../src/popup/app.ts");
  await startWallet({ wallet, store, ownNode: "http://127.0.0.1:8080", fetch, requestOrigins: async () => true });

  for (const label of ["Refresh", "Copy address", "Send", "Receive", "Scan cross-chain order", "Transactions", "Settings"]) button(label);
  for (const hidden of ["Node", "Fee", "Backup", "Lock"]) {
    assert.equal([...document.querySelectorAll("button")].some((item) => item.textContent === hidden), false, `${hidden} stays off the home screen`);
  }
  assert.match(document.body.textContent ?? "", new RegExp(address), "the home screen displays the full account address");
  button("Copy address").click();
  await settle();
  assert.equal(copied, address, "copies the full address rather than its shortened display");
  assert.match(document.body.textContent ?? "", /Account address copied/);

  const chainPicker = document.querySelector('select[aria-label="Active chain"]') as HTMLSelectElement;
  assert.deepEqual([...chainPicker.options].map((option) => option.textContent), ["Nexus", "Nexus/testnet", "Nexus/testnet/payments", "Manage chains…"]);
  chainPicker.value = "Nexus";
  chainPicker.dispatchEvent(new dom.window.Event("change"));
  await settle();
  assert.equal(stored.settings.chain, "Nexus");
  const switchedPicker = document.querySelector('select[aria-label="Active chain"]') as HTMLSelectElement;
  switchedPicker.value = "Nexus/testnet";
  switchedPicker.dispatchEvent(new dom.window.Event("change"));
  await settle();
  assert.equal(stored.settings.chain, "Nexus/testnet");

  button("Send").click();
  await settle();
  assert.equal((document.querySelector("details.advanced") as HTMLDetailsElement).open, true, "a fee warning reveals its control");
  (document.querySelector('input[placeholder^="recipient"]') as HTMLInputElement).value = "bafybuyer";
  (document.querySelector('input[placeholder^="amount"]') as HTMLInputElement).value = "10";
  button("Review").click();
  await settle();
  assert.match(document.body.textContent ?? "", /From · Account 1/);
  assert.match(document.body.textContent ?? "", new RegExp(address));
  button("Cancel").click();
  await settle();

  const realNow = Date.now;
  const now = realNow();
  await openOrder(orderURI(new Date(now + 120_000).toISOString()));
  Date.now = () => now + 70_000;
  button("Lock funds & create order").click();
  await settle();
  Date.now = realNow;
  assert.equal(signCalls, 0);
  assert.match(document.body.textContent ?? "", /less than one minute left/);

  button("Cancel").click();
  button("Cancel").click();
  await settle();
  await openOrder(orderURI(new Date(realNow() + 600_000).toISOString()));
  const fee = document.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
  fee.value = "3";
  fee.dispatchEvent(new dom.window.Event("input"));
  button("Lock funds & create order").click();
  await settle();

  assert.equal(signCalls, 1);
  assert.equal(postCalls, 1);
  assert.equal(savedBeforePost?.openDeposits[0]?.transactionCID, "bafytx", "claim is durable before submit");
  assert.equal(savedBeforePost?.sent["Nexus/testnet"]?.[0]?.cid, "bafytx", "the exact attempt is status-trackable");
  assert.match(document.body.textContent ?? "", /Do not create this deposit again/i);
  assert.match(document.body.textContent ?? "", /bafytx/);
  assert.equal([...document.querySelectorAll("button")].some((item) => item.textContent === "Lock funds & create order"), false);
  button("Done").click();
  await settle();
  assert.ok([...document.querySelectorAll('select[aria-label="Active chain"] option')].some((option) => option.textContent === "Nexus/testnet/payments"));
  button("payments").click();
  await settle();
  assert.equal(stored.settings.chain, "Nexus/testnet/payments");
  assert.equal((document.querySelector('select[aria-label="Active chain"]') as HTMLSelectElement).value, "Nexus/testnet/payments");
});

test("the optional Lattice.build endpoint is offered but a failed submit probe is not saved", async () => {
  const dom = new JSDOM('<button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });

  const address = "bafyaccount";
  const wallet = {
    getState: async () => ({ ok: true, state: {
      initialized: true, locked: false,
      accounts: [{ address, publicKey: "ed01" + "00".repeat(32), label: "Account 1", kind: "hd", index: 0 }],
      active: address,
    } }),
    nodeAuthorization: async () => ({ ok: true }),
  } as unknown as WalletClient;
  let stored = { settings: structuredClone(DEFAULT_SETTINGS) };
  const store = {
    get: async () => stored,
    set: async (items: Record<string, unknown>) => { stored = items as typeof stored; },
  };
  const requested: string[][] = [];
  const fetch = async (input: string | URL) => {
    assert.equal(new URL(input).origin, "https://rpc.lattice.build");
    return new Response(JSON.stringify({ chain: ["Nexus"], minRelayFee: "1", acceptsSubmit: false }));
  };

  const { startWallet } = await import("../src/popup/app.ts");
  await startWallet({
    wallet, store, fetch,
    requestOrigins: async (origins) => { requested.push(origins); return true; },
  });

  button("Use Lattice.build").click();
  await settle();
  assert.deepEqual(requested, [["https://rpc.lattice.build/*"]]);
  assert.deepEqual(stored.settings.endpoints, {});
  assert.match(document.body.textContent ?? "", /not accepting transactions/i);
});

test("a child chain automatically discovers and selects a verified submit node through the explorer bootstrap", async () => {
  const dom = new JSDOM('<button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });

  const address = "bafyaccount";
  const wallet = {
    getState: async () => ({ ok: true, state: {
      initialized: true, locked: false,
      accounts: [{ address, publicKey: "ed01" + "00".repeat(32), label: "Account 1", kind: "hd", index: 0 }],
      active: address,
    } }),
    nodeAuthorization: async () => ({ ok: true }),
  } as unknown as WalletClient;
  let stored = { settings: { ...structuredClone(DEFAULT_SETTINGS), chain: "Nexus/testnet", chains: ["Nexus", "Nexus/testnet"] } };
  const store = {
    get: async () => stored,
    set: async (items: Record<string, unknown>) => { stored = items as typeof stored; },
  };
  const requested: string[][] = [];
  const block = {
    height: "3", hash: "bafycommitted", timestamp: "1", transactionCount: 0, childBlockCount: 0,
    nonce: "0", version: 1, target: "0x1", nextTarget: "0x1", transactionsCID: "bafyt",
    postStateCID: "bafys", chain: ["Nexus", "testnet"],
  };
  const fetch = async (input: string | URL) => {
    const url = new URL(input);
    if (url.host === "lattice-mainnet-read.fly.dev" && url.pathname === "/api/chain/endpoints") {
      return new Response(JSON.stringify({
        chainPath: ["Nexus", "testnet"], committedBlock: "bafycommitted",
        endpoints: ["https://testnet-node.example"], submitEndpoints: ["https://testnet-node.example"],
      }));
    }
    if (url.host === "testnet-node.example" && url.pathname === "/api/block/bafycommitted") return new Response(JSON.stringify(block));
    if (url.host === "testnet-node.example" && url.pathname === "/api/chain/info") {
      return new Response(JSON.stringify({ chain: ["Nexus", "testnet"], minRelayFee: "1", acceptsSubmit: true }));
    }
    return new Response("not found", { status: 404 });
  };

  const { startWallet } = await import("../src/popup/app.ts");
  await startWallet({
    wallet, store, fetch,
    requestOrigins: async (origins) => { requested.push(origins); return true; },
  });

  button("Find node automatically").click();
  await settle();
  assert.equal(stored.settings.endpoints["Nexus/testnet"]?.url, "https://testnet-node.example");
  assert.equal(stored.settings.endpoints["Nexus/testnet"]?.acceptsSubmit, true);
  assert.deepEqual(requested[0], ["https://lattice-mainnet-read.fly.dev/*", "https://*/*"]);
  assert.ok(requested.some((origins) => origins.includes("https://testnet-node.example/*")));
});
