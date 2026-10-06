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
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });

  const address = "bafyseller";
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

  for (const label of ["Refresh", "Send", "Receive", "Scan cross-chain order", "Transactions", "Settings"]) button(label);
  for (const hidden of ["Node", "Fee", "Backup", "Lock"]) {
    assert.equal([...document.querySelectorAll("button")].some((item) => item.textContent === hidden), false, `${hidden} stays off the home screen`);
  }

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
});
