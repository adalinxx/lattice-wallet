import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { WalletClient } from "../src/lib/wallet/client.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/lib/wallet/settings.ts";
import { cidV1DagCbor, encodeDagCbor, type DagCborValue } from "@adalinxx/lattice-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { ensureOrigins } from "../src/popup/app.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }

test("an already granted node permission is reused without another prompt", async () => {
  let prompts = 0;
  const origins = ["https://rpc.lattice.build/*", "https://*/*"];
  const granted = await ensureOrigins({
    hasOrigins: async (requested) => { assert.deepEqual(requested, origins); return true; },
    requestOrigins: async () => { prompts += 1; return true; },
  }, origins);
  assert.equal(granted, true);
  assert.equal(prompts, 0);
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
function testTrie(values: ReadonlyMap<string, bigint | string>) {
  const entries = new Map<string, Uint8Array>();
  const node = (rows: Array<[string, bigint | string]>, prefix: string): string => {
    let common = rows[0]?.[0] ?? "";
    for (const [key] of rows.slice(1)) while (!key.startsWith(common)) common = common.slice(0, -1);
    const compressed = prefix + common;
    const shortened = rows.map(([key, value]) => [key.slice(common.length), value] as [string, bigint | string]);
    const value = shortened.find(([key]) => key.length === 0)?.[1];
    const groups = new Map<string, Array<[string, bigint | string]>>();
    for (const [key, item] of shortened) if (key.length > 0) groups.set(key[0]!, [...(groups.get(key[0]!) ?? []), [key.slice(1), item]]);
    const children = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rest]) => ({ key, value: { rawCID: node(rest, key) } }));
    const bytes = encodeDagCbor({ prefix: compressed, ...(value === undefined ? {} : { value }), children } as DagCborValue);
    const cid = cidV1DagCbor(bytes); entries.set(cid, bytes); return cid;
  };
  const groups = new Map<string, Array<[string, bigint | string]>>();
  for (const [key, value] of values) groups.set(key[0]!, [...(groups.get(key[0]!) ?? []), [key.slice(1), value]]);
  const children = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rest]) => ({ key, value: { rawCID: node(rest, key) } }));
  const rootBytes = encodeDagCbor({ count: BigInt(values.size), children });
  const rootCID = cidV1DagCbor(rootBytes); entries.set(rootCID, rootBytes);
  return { rootCID, entries: [...entries].map(([cid, bytes]) => ({ cid, bytes: b64(bytes) })) };
}

function testProof(dictionary: "deposits" | "receipts", trie: ReturnType<typeof testTrie>, claims: Array<{ key: string; value: string | null }>) {
  const rootCID = trie.rootCID;
  const stateBytes = encodeDagCbor({ accountState: { rawCID: rootCID }, generalState: { rawCID: rootCID }, depositState: { rawCID: rootCID }, receiptState: { rawCID: rootCID } });
  const postStateCID = cidV1DagCbor(stateBytes);
  const blockBytes = encodeDagCbor({ height: 1n, postState: { rawCID: postStateCID } });
  const blockCID = cidV1DagCbor(blockBytes);
  return { blockHash: blockCID, blockHeight: "1", block: { cid: blockCID, data: b64(blockBytes) }, stateRoot: postStateCID,
    dictionary, dictionaryRoot: rootCID, claims,
    witness: [...trie.entries.map(({ cid, bytes }) => ({ cid, data: bytes })), { cid: postStateCID, data: b64(stateBytes) }] };
}

function testReceiptKey(directory: string, demander: string, amount: string, nonce: string) {
  return Buffer.from(sha256(new TextEncoder().encode(`lattice/receipt-state/v1\0${directory}/${demander}/${amount}/${nonce}`))).toString("hex");
}

function orderURI(expiresAt: string): string {
  const intent = {
    version: 1, parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], asset: "LAT",
    expiresAt, side: "sell_child", orderType: "limit", amountDeposited: "200", amountDemanded: "300",
  };
  return `lattice://order?v=1&intent=${Buffer.from(JSON.stringify(intent)).toString("base64url")}`;
}

function buyOrderURI(expiresAt: string): string {
  const intent = {
    version: 1, parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], asset: "LAT",
    expiresAt, side: "buy_child", orderType: "market", maxAmountDemanded: "150",
  };
  return `lattice://order?v=1&intent=${Buffer.from(JSON.stringify(intent)).toString("base64url")}`;
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  assert.ok(found, `button ${text} exists`);
  return found as HTMLButtonElement;
}

async function openOrder(uri: string) {
  (document.getElementById("settings-button") as HTMLButtonElement).click();
  button("Open cross-chain order").click();
  assert.equal(document.querySelector("h1")?.textContent, "Open order", document.body.textContent ?? "");
  const paste = document.querySelector("textarea") as HTMLTextAreaElement;
  assert.ok(paste);
  paste.value = uri;
  button("Use pasted text").click();
  assert.ok(document.querySelector("h1"), document.body.textContent ?? "");
  await settle();
  assert.match(document.body.textContent ?? "", /Review sell order/);
}

test("sell-order UI refuses a stale review and never re-signs after an uncertain submit", async () => {
  const dom = new JSDOM('<button id="settings-button"></button><button id="parent-chain"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
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
    if (url.pathname === "/api/block/bafytip/children") {
      const directory = url.searchParams.get("chainPath") === "Nexus" ? "testnet" : "payments";
      return new Response(JSON.stringify({ children: [{ directory, blockHash: "bafychild" }] }));
    }
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

  for (const label of ["Refresh", "Copy address", "Send", "Receive"]) button(label);
  for (const hidden of ["Scan cross-chain order", "Open cross-chain order", "Transactions", "Settings", "Node", "Fee", "Backup", "Lock"]) {
    assert.equal([...document.querySelectorAll("button")].some((item) => item.textContent === hidden), false, `${hidden} stays off the home screen`);
  }
  assert.match(document.body.textContent ?? "", new RegExp(address), "the home screen displays the full account address");
  button("Copy address").click();
  await settle();
  assert.equal(copied, address, "copies the full address rather than its shortened display");
  assert.match(document.body.textContent ?? "", /Account address copied/);

  const droppedOrder = orderURI(new Date(Date.now() + 600_000).toISOString());
  const dragenter = new dom.window.Event("dragenter", { bubbles: true, cancelable: true });
  Object.defineProperty(dragenter, "dataTransfer", { value: { getData: () => "", files: [], dropEffect: "none" } });
  document.dispatchEvent(dragenter);
  assert.match(document.querySelector(".order-drop")?.textContent ?? "", /Drop a cross-chain order/);
  const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: {
    getData: (type: string) => type === "text/plain" ? droppedOrder : "", files: [], dropEffect: "none",
  } });
  document.dispatchEvent(drop);
  await settle();
  assert.equal(document.querySelector("h1")?.textContent, "Review sell order");
  button("Cancel").click();
  button("Cancel").click();
  await settle();

  (document.getElementById("net-badge") as HTMLButtonElement).click();
  await settle();
  const earlyMenu = document.querySelector(".chain-menu") as HTMLElement;
  assert.match(earlyMenu.textContent ?? "", /payments.*Open/);
  assert.match(earlyMenu.querySelector(".chain-path")?.textContent ?? "", /^Nexus\/testnet$/);
  assert.doesNotMatch(earlyMenu.textContent ?? "", /Parent|Current/);
  (document.getElementById("net-badge") as HTMLButtonElement).click();
  const parentButton = document.getElementById("parent-chain") as HTMLButtonElement;
  assert.equal(parentButton.hidden, false);
  assert.match(parentButton.title, /Nexus$/);
  parentButton.click();
  await settle();
  assert.equal(stored.settings.chain, "Nexus");
  assert.equal(parentButton.hidden, true);
  (document.getElementById("net-badge") as HTMLButtonElement).click();
  await settle();
  const testnet = [...document.querySelectorAll(".chain-menu-item")].find((item) => item.firstChild?.textContent === "testnet") as HTMLButtonElement;
  testnet.click();
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
  (document.getElementById("net-badge") as HTMLButtonElement).click();
  await settle();
  const child = [...document.querySelectorAll(".chain-menu-item")].find((item) => item.textContent?.startsWith("payments")) as HTMLButtonElement;
  assert.ok(child, document.body.textContent ?? "child-chain item missing");
  assert.ok(child);
  child.click();
  await settle();
  assert.equal(stored.settings.chain, "Nexus/testnet/payments");
  const chainBadge = document.getElementById("net-badge");
  assert.equal(chainBadge?.textContent, "Nexus/testnet/payments ▾");
  assert.match(chainBadge?.title ?? "", /Nexus\/testnet\/payments/);
  (document.getElementById("settings-button") as HTMLButtonElement).click();
  assert.equal(document.querySelector("h1")?.textContent, "Settings");
  button("Open cross-chain order");
});

test("a market buy discovers deposits, pays the parent receipt, and withdraws on the child", async () => {
  const dom = new JSDOM('<button id="settings-button"></button><button id="parent-chain"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  const address = "bafybuyer";
  const seller = "bafyseller";
  const expensiveSeller = "bafyexpensive";
  const claimedSeller = "bafyclaimed";
  const makeSigned = (cid: string, chainPath: string[]) => ({
    transactionCID: cid, bodyCID: `body-${cid}`,
    payload: { transaction: { signatures: {}, body: {
      accountActions: [], actions: [], depositActions: [], receiptActions: [], withdrawalActions: [],
      signers: [address], nonce: "1", chainPath,
    } } },
  });
  let receiptSigns = 0, withdrawalSigns = 0, posts = 0, receiptMined = false;
  let signedOffers: Array<{ demander: string }> = [];
  const depositRows = [
    { demander: expensiveSeller, amountDemanded: "100", nonce: "43", amountDeposited: "100" },
    { demander: claimedSeller, amountDemanded: "1", nonce: "44", amountDeposited: "1000" },
    { demander: seller, amountDemanded: "50", nonce: "42", amountDeposited: "300" },
  ].map((row) => ({ ...row, key: `${row.demander}/${row.amountDemanded}/${row.nonce}` }));
  const depositTrie = testTrie(new Map(depositRows.map((row) => [row.key, BigInt(row.amountDeposited)])));
  const depositProof = testProof("deposits", depositTrie, depositRows.map((row) => ({ key: row.key, value: row.amountDeposited })));
  const receiptState = () => {
    const rows = depositRows.filter((row) => receiptMined || row.demander === claimedSeller);
    const values = new Map(rows.map((row) => [testReceiptKey("testnet", row.demander, row.amountDemanded, row.nonce), address]));
    const trie = testTrie(values);
    return { trie, proof: testProof("receipts", trie, rows.map((row) => ({
      key: testReceiptKey("testnet", row.demander, row.amountDemanded, row.nonce), value: address,
    }))) };
  };
  const wallet = {
    getState: async () => ({ ok: true, state: {
      initialized: true, locked: false,
      accounts: [{ address, publicKey: "ed01" + "00".repeat(32), label: "Account 1", kind: "hd", index: 0 }], active: address,
    } }),
    nodeAuthorization: async () => ({ ok: true }),
    signReceipt: async (args: { offers: Array<{ demander: string }> }) => {
      receiptSigns += 1; signedOffers = args.offers;
      return { ok: true, signedSubmit: makeSigned("bafyreceipt", ["Nexus"]) };
    },
    signWithdrawal: async () => { withdrawalSigns += 1; return { ok: true, signedSubmit: makeSigned("bafywithdraw", ["Nexus", "testnet"]) }; },
  } as unknown as WalletClient;
  let stored: { settings: Settings } = { settings: {
    ...structuredClone(DEFAULT_SETTINGS), chain: "Nexus/testnet", chains: ["Nexus", "Nexus/testnet"],
    endpoints: {
      Nexus: { url: "https://parent.example", acceptsSubmit: true, source: "user" },
      "Nexus/testnet": { url: "https://child.example", acceptsSubmit: true, source: "user" },
    },
  } };
  const store = { get: async () => stored, set: async (items: Record<string, unknown>) => { stored = items as typeof stored; } };
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/api/deposits") return new Response(JSON.stringify({
      deposits: depositRows, next: null, proof: depositProof,
    }));
    if (url.pathname === "/api/receipt-state") {
      const claimed = url.searchParams.get("demander") === claimedSeller;
      const state = receiptState();
      const key = testReceiptKey("testnet", url.searchParams.get("demander")!, url.searchParams.get("amount")!, url.searchParams.get("nonce")!);
      const exists = receiptMined || claimed;
      const proof = exists ? state.proof : testProof("receipts", state.trie, [...state.proof.claims, { key, value: null }]);
      return new Response(JSON.stringify({ exists, withdrawer: exists ? address : null, key, proof }));
    }
    if (url.pathname === "/api/chain/info") {
      const parent = url.hostname === "parent.example";
      return new Response(JSON.stringify({ chain: url.searchParams.get("chainPath")?.split("/"), minRelayFee: "1", acceptsSubmit: true,
        tipCID: parent ? receiptState().proof.blockHash : depositProof.blockHash, height: "1" }));
    }
    if (url.pathname === "/api/block/latest" && url.hostname === "parent.example") {
      return new Response(JSON.stringify({ height: "1", hash: receiptState().proof.blockHash, timestamp: "1", transactionCount: 0 }));
    }
    if (url.pathname.startsWith("/api/block/") && url.pathname.endsWith("/children") && url.hostname === "parent.example") {
      return new Response(JSON.stringify({ children: [{ directory: "testnet", blockHash: depositProof.blockHash }] }));
    }
    if (url.pathname === `/api/state/account/${address}`) return new Response(JSON.stringify({ owner: address, balance: "1000", nonce: "1" }));
    if (url.pathname === "/transactions" && init?.method === "POST") {
      posts += 1;
      if (posts === 1) { receiptMined = true; return new Response(JSON.stringify({ transactionCID: "bafyreceipt" })); }
      return new Response(JSON.stringify({ transactionCID: "bafywithdraw" }));
    }
    return new Response("not found", { status: 404 });
  };
  const { startWallet } = await import("../src/popup/app.ts");
  await startWallet({ wallet, store, fetch, requestOrigins: async () => true });
  (document.getElementById("settings-button") as HTMLButtonElement).click();
  button("Connection & nodes").click();
  button("Use a custom node").click();
  await settle();
  button("Use Lattice.build testnet");
  button("Find node automatically");
  button("Use this node");
  button("Back").click();
  (document.getElementById("settings-button") as HTMLButtonElement).click();
  button("Open cross-chain order").click();
  assert.equal(document.querySelector("h1")?.textContent, "Open order", document.body.textContent ?? "");
  const paste = document.querySelector("textarea") as HTMLTextAreaElement;
  paste.value = buyOrderURI(new Date(Date.now() + 600_000).toISOString());
  button("Use pasted text").click();
  assert.ok(document.querySelector("h1"), document.body.textContent ?? "");
  await settle();
  assert.equal(document.querySelector("h1")?.textContent, "Review purchase", document.body.textContent ?? "");
  button("Pay & reserve tokens").click();
  await settle();
  assert.equal(receiptSigns, 1);
  assert.deepEqual(signedOffers.map((offer) => offer.demander), [seller, expensiveSeller], "unclaimed offers are signed from best to worst price");
  assert.equal(stored.settings.openPurchases.length, 1);
  assert.equal(document.querySelector("h1")?.textContent, "Complete purchase");
  button("Check & withdraw tokens").click();
  await settle();
  assert.equal(withdrawalSigns, 1);
  assert.equal(stored.settings.openPurchases[0]?.withdrawalCID, "bafywithdraw");
  assert.equal(posts, 2);
});

test("the optional Lattice.build endpoint is offered but a failed submit probe is not saved", async () => {
  const dom = new JSDOM('<button id="parent-chain"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
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
  assert.deepEqual(requested, [["https://*/*"]]);
  assert.deepEqual(stored.settings.endpoints, {});
  assert.match(document.body.textContent ?? "", /not accepting transactions/i);
});

test("Lattice.build selection resumes after Chrome closes the popup for host permission", async () => {
  const dom = new JSDOM('<button id="parent-chain"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
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
  const fetch = async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname === "/api/chain/info") return new Response(JSON.stringify({ chain: ["Nexus"], minRelayFee: "1", acceptsSubmit: true }));
    if (url.pathname === `/api/state/account/${address}`) return new Response(JSON.stringify({ owner: address, balance: "1000", nonce: "0" }));
    return new Response("not found", { status: 404 });
  };

  const { startWallet } = await import("../src/popup/app.ts");
  await startWallet({ wallet, store, fetch, requestOrigins: async () => new Promise<boolean>(() => {}) });
  button("Use Lattice.build").click();
  await settle();
  assert.equal(stored.settings.pendingEndpoint?.url, "https://rpc.lattice.build");

  await startWallet({
    wallet, store, fetch,
    requestOrigins: async () => true,
    hasOrigins: async (origins) => origins.includes("https://rpc.lattice.build/*"),
  });
  await settle();
  assert.equal(stored.settings.pendingEndpoint, undefined);
  assert.equal(stored.settings.endpoints.Nexus?.url, "https://rpc.lattice.build");
  assert.match(document.body.textContent ?? "", /Send/);
});

test("a custom node selection resumes after Chrome closes the popup for host permission", async () => {
  const dom = new JSDOM('<button id="parent-chain"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });

  const address = "bafyaccount";
  const wallet = {
    getState: async () => ({ ok: true, state: {
      initialized: true, locked: false,
      accounts: [{ address, publicKey: "ed01" + "00".repeat(32), label: "Account 1", kind: "hd", index: 0 }], active: address,
    } }),
    nodeAuthorization: async () => ({ ok: true }),
    setNodeCookie: async () => ({ ok: true }),
  } as unknown as WalletClient;
  let stored = { settings: structuredClone(DEFAULT_SETTINGS) };
  const store = {
    get: async () => stored,
    set: async (items: Record<string, unknown>) => { stored = items as typeof stored; },
  };
  const fetch = async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname === "/api/chain/info") return new Response(JSON.stringify({ chain: ["Nexus"], minRelayFee: "1", acceptsSubmit: true }));
    if (url.pathname === `/api/state/account/${address}`) return new Response(JSON.stringify({ owner: address, balance: "1000", nonce: "0" }));
    return new Response("not found", { status: 404 });
  };

  const { startWallet } = await import("../src/popup/app.ts");
  await startWallet({ wallet, store, fetch, requestOrigins: async () => new Promise<boolean>(() => {}) });
  const nodeInput = [...document.querySelectorAll("input")].find((input) => input.placeholder?.startsWith("your node")) as HTMLInputElement;
  nodeInput.value = "https://node.example";
  button("Use this node").click();
  await settle();
  assert.equal(stored.settings.pendingEndpoint?.url, "https://node.example");

  await startWallet({
    wallet, store, fetch,
    requestOrigins: async () => true,
    hasOrigins: async (origins) => origins.includes("https://node.example/*"),
  });
  await settle();
  assert.equal(stored.settings.pendingEndpoint, undefined);
  assert.equal(stored.settings.endpoints.Nexus?.url, "https://node.example");
  assert.equal(stored.settings.nodeMode, "custom");
});

test("a child chain automatically discovers and selects a verified submit node through the explorer bootstrap", async () => {
  const dom = new JSDOM('<button id="parent-chain"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
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
    requestOrigins: async () => new Promise<boolean>(() => {}),
  });

  button("Find node automatically").click();
  await settle();
  assert.equal(stored.settings.pendingDiscovery?.chain, "Nexus/testnet");

  await startWallet({
    wallet, store, fetch,
    requestOrigins: async () => true,
    hasOrigins: async (origins) => origins.includes("https://*/*"),
  });
  await settle();
  assert.equal(stored.settings.endpoints["Nexus/testnet"]?.url, "https://testnet-node.example");
  assert.equal(stored.settings.endpoints["Nexus/testnet"]?.acceptsSubmit, true);
  assert.equal(stored.settings.pendingDiscovery, undefined);
});

test("a chain switch is saved before Chrome's permission prompt can close the popup", async () => {
  const dom = new JSDOM('<button id="parent-chain"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });

  const address = "bafyaccount";
  const wallet = {
    getState: async () => ({ ok: true, state: {
      initialized: true, locked: false,
      accounts: [{ address, publicKey: "ed01" + "00".repeat(32), label: "Account 1", kind: "hd", index: 0 }], active: address,
    } }),
    nodeAuthorization: async () => ({ ok: true }),
  } as unknown as WalletClient;
  let stored: { settings: Settings } = { settings: {
    ...structuredClone(DEFAULT_SETTINGS), chain: "Nexus/testnet",
    chains: ["Nexus", "Nexus/testnet", "Nexus/testnet/payments"],
    endpoints: { "Nexus/testnet": { url: "https://current.example", acceptsSubmit: true, source: "discovered" as const } },
  } };
  const store = {
    get: async () => stored,
    set: async (items: Record<string, unknown>) => { stored = items as typeof stored; },
  };
  let answerPermission!: (granted: boolean) => void;
  const permission = new Promise<boolean>((resolve) => { answerPermission = resolve; });
  const fetch = async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname === `/api/state/account/${address}`) return new Response(JSON.stringify({ owner: address, balance: "1000", nonce: "0" }));
    return new Response("not found", { status: 404 });
  };

  const { startWallet } = await import("../src/popup/app.ts");
  await startWallet({ wallet, store, fetch, requestOrigins: async () => permission });
  await settle();
  (document.getElementById("net-badge") as HTMLButtonElement).click();
  await settle();
  const pendingChild = [...document.querySelectorAll(".chain-menu-item")].find((item) => item.textContent?.startsWith("payments")) as HTMLButtonElement;
  assert.ok(pendingChild, document.body.textContent ?? "child-chain item missing");
  pendingChild.click();
  await settle();
  assert.equal(stored.settings.chain, "Nexus/testnet/payments");
  assert.equal(stored.settings.pendingAutomaticChain, "Nexus/testnet/payments");
  answerPermission(false);
  await settle();
});
