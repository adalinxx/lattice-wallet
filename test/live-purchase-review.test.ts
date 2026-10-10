// Opt-in deployed UI regression. No keys, signatures, or network writes.
// LATTICE_LIVE_PURCHASE=https://rpc.lattice.build node --test test/live-purchase-review.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { activeDeposits, discover, reader, receiptWithdrawer } from "../src/lib/wallet/node.ts";
import { DEFAULT_SETTINGS } from "../src/lib/wallet/settings.ts";
import type { WalletClient } from "../src/lib/wallet/client.ts";

const parentURL = process.env.LATTICE_LIVE_PURCHASE;
test("deployed unpaid offer reaches purchase review without signing or submitting", { skip: !parentURL, timeout: 120_000 }, async (t) => {
  const parentChain = ["Nexus"], childChain = ["Nexus", "testnet"];
  let forbidden = 0;
  const readOnlyFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "GET" || !url.pathname.startsWith("/api/")) {
      forbidden++;
      throw new Error("Live regression forbids network writes");
    }
    return fetch(request);
  };
  const endpoints = await discover(parentURL!, childChain, readOnlyFetch);
  const endpoint = endpoints.find((item) => item.declaresSubmit);
  assert.ok(endpoint, "No discovered submission-capable child endpoint; live gate cannot pass");
  const childURL = endpoint.url;
  const parentInfo = await reader(parentURL!, parentChain, readOnlyFetch).chainInfo();
  assert.equal(parentInfo.acceptsSubmit, true, "Parent must accept submissions for purchase review");
  const childInfo = await reader(childURL, childChain, readOnlyFetch).chainInfo();
  assert.ok(childInfo.minRelayFee !== undefined);
  assert.equal(childInfo.acceptsSubmit, true);
  const deposits = await activeDeposits(childURL, childChain, readOnlyFetch);
  console.log(`[live] verified ${deposits.length} listed deposits; inspecting at most 30 for an unpaid offer`);
  let selected;
  for (const offer of deposits.slice(0, 30)) {
    if (offer.amountDeposited <= childInfo.minRelayFee || offer.amountDemanded <= 0n) continue;
    if (await receiptWithdrawer(parentURL!, parentChain, childChain, offer, readOnlyFetch) === null) { selected = offer; break; }
  }
  assert.ok(selected, "No eligible unpaid offer in the first 30 deposits; supply a live fixture before claiming this gate passed");
  const dom = new JSDOM('<button id="settings-button"></button><button id="parent-chain"></button><button id="net-badge"></button><main id="view"></main>', { url: "https://wallet.test/" });
  t.after(() => dom.window.close());
  for (const name of ["window", "document", "navigator", "Node", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement"] as const) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : dom.window[name] });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  }
  // Public seller address is sufficient for rendering; no private key exists in this test.
  const address = selected.demander;
  const wallet = new Proxy({
    getState: async () => ({ ok: true, state: { initialized: true, locked: false, accounts: [{ address, label: "Read-only fixture", kind: "imported" }], active: address } }),
    nodeAuthorization: async () => ({ ok: true }),
  }, { get(target, property) {
    if (property in target) return Reflect.get(target, property);
    return async () => { forbidden++; throw new Error("Live regression forbids wallet mutations/signing"); };
  } }) as unknown as WalletClient;
  let stored = { settings: { ...structuredClone(DEFAULT_SETTINGS), chain: "Nexus/testnet", chains: ["Nexus", "Nexus/testnet"], endpoints: {
    Nexus: { url: parentURL!, acceptsSubmit: true, source: "user" as const },
    "Nexus/testnet": { url: childURL, acceptsSubmit: true, source: "user" as const },
  } } };
  const { startWallet } = await import("../src/popup/app.ts");
  await startWallet({ wallet, store: { get: async () => stored, set: async (items) => { stored = items as typeof stored; } }, fetch: readOnlyFetch, requestOrigins: async () => true });
  const button = (label: string) => {
    const found = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
    assert.ok(found, `Missing ${label}`); return found;
  };
  (document.getElementById("settings-button") as HTMLButtonElement).click();
  button("Open cross-chain order").click();
  const order = { version: 1, parentChain, childChain, asset: "LAT", expiresAt: new Date(Date.now() + 3600_000).toISOString(), side: "buy_child", orderType: "take", deposits: [{
    demander: selected.demander, amountDemanded: String(selected.amountDemanded), amountDeposited: String(selected.amountDeposited), depositNonce: String(selected.depositNonce),
  }] };
  (document.querySelector("textarea") as HTMLTextAreaElement).value = `lattice://order?v=1&intent=${Buffer.from(JSON.stringify(order)).toString("base64url")}`;
  button("Use pasted text").click();
  const deadline = Date.now() + 60_000;
  while (document.querySelector("h1")?.textContent === "Check sell orders" && Date.now() < deadline) {
    if (document.querySelector(".toast")?.textContent !== "Checking the selected sell orders…") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(document.querySelector("h1")?.textContent, "Review purchase", "Live offer failed review; investigate node/proof compatibility or an offer purchased during the run");
  const rows = [...document.querySelectorAll(".kv .row")].map((item) => item.textContent);
  assert.ok(rows.includes(`You pay${selected.amountDemanded.toLocaleString()} on Nexus`));
  assert.ok(rows.includes(`You receive${selected.amountDeposited.toLocaleString()} on Nexus/testnet`));
  assert.ok(document.getElementById("purchase-node-trust"));
  assert.equal(button("Pay & reserve tokens").disabled, true);
  assert.equal(forbidden, 0);
  console.log("[live] purchase review reached; exact amounts verified; acknowledgement required; zero signing or write attempts");
});
