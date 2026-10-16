// The approval window as a person sees it: a write leads with what the
// person pays, to whom, and what their balance becomes; then each record,
// with the addresses the wallet knows shown as names; everything else is in
// Details. The approving button says what it does and waits until the
// account covers the debit. A message is shown in full.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { deriveAccount } from "../src/lib/crypto/accounts.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const me = deriveAccount(MNEMONIC, 0).address;
const holder = deriveAccount(MNEMONIC, 1).address;
const NODE = "https://node.example";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 40; i += 1) await tick(); }

let loads = 0;
/** Opens the window on `call`, with the node reporting `balance`. Returns what it sent the worker. */
async function open(call: unknown, balance: string, layout?: (dom: JSDOM) => void,
  env: { settings?: unknown; fetch?: (url: URL) => Response | undefined } = {}) {
  const dom = new JSDOM('<main id="view"></main>', { url: "chrome-extension://wallet-id/approve/index.html?id=r1", pretendToBeVisual: true });
  for (const name of ["window", "document", "location", "Node", "HTMLElement", "HTMLButtonElement", "HTMLSelectElement", "Event"]) {
    Object.defineProperty(globalThis, name, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
  }
  dom.window.document.hasFocus = () => true;
  layout?.(dom);
  const sent: Record<string, unknown>[] = [];
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { sendMessage: async (msg: Record<string, unknown>) => {
      sent.push(msg);
      if (msg.type === "pending") return { ok: true, origin: "https://fanfare.example", call, address: me };
      if (msg.type === "getState") return { ok: true, state: { initialized: true, locked: false, active: me, accounts: [{ address: me, label: "Main" }] } };
      if (msg.type === "nodeAuthorization") return { ok: true };
      return { ok: true };
    } },
    storage: { local: { get: async (key: string) => key === "settings"
      ? { settings: env.settings ?? { endpoints: { "Nexus/fanfare/band": { url: NODE, acceptsSubmit: true, source: "user" } }, nodeMode: "custom" } } : {} } },
    permissions: { contains: async () => true },
  } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string | URL) => {
    const url = new URL(String(input));
    if (env.fetch) return env.fetch(url) ?? new Response("{}", { status: 404 });
    if (url.pathname === `/api/state/account/${me}`) return new Response(JSON.stringify({ owner: me, balance, nonce: "7" }), { status: 200 });
    return new Response("{}", { status: 404 });
  } });
  dom.window.close = () => { sent.push({ type: "closed" }); };
  // The window checks in with the worker every 20 s; not needed here, and it would keep the test running.
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  await import(`../src/approve/approve.ts?${++loads}`);
  globalThis.setInterval = realInterval;
  await settle();
  await new Promise((r) => setTimeout(r, 900)); // the Sign button arms after a moment
  return { sent, text: () => dom.window.document.getElementById("view")!.textContent ?? "", dom };
}
/** The one filled button: the approving one. */
const approveButton = (dom: JSDOM) => dom.window.document.querySelector(".decision .btn--primary") as HTMLButtonElement;
const all = (dom: JSDOM, selector: string) => [...dom.window.document.querySelectorAll(selector)].map((n) => n.textContent ?? "");
const one = (dom: JSDOM, selector: string) => dom.window.document.querySelector(selector)?.textContent ?? "";

const buy = {
  method: "writeRecords",
  params: {
    chainPath: ["Nexus", "fanfare", "band"],
    actions: [{ key: "own/a/berlin/A12", oldValue: `${holder}@250`, newValue: me }],
    payments: [{ to: holder, amount: "250" }],
    fee: "1",
  },
};

test("a payment leads with the total, its parts, and the balance after; addresses the wallet knows are names", async () => {
  const { sent, dom } = await open(buy, "1000");
  const summary = one(dom, ".summary");
  for (const part of ["You pay", "251", "on Nexus/fanfare/band · from Main", "Balance: 1,000 → 749", "network fee"]) {
    assert.ok(summary.includes(part), `shows ${part}: ${summary}`);
  }
  assert.deepEqual(all(dom, ".breakdown .amount"), ["250", "1"], "the parts, adding up to the total");
  assert.ok(summary.includes("in record own/a/berlin/A12"), "the payee is the address in the record the write changes");
  assert.equal(dom.window.document.querySelector(".summary .notice"), null, "no warning for a payee a record names");
  assert.equal(one(dom, ".records:not(.raw) li .meta"), "payee@250 → you");
  assert.deepEqual(all(dom, ".records:not(.raw) .name"), ["payee", "you"]);
  const details = one(dom, "details.advanced");
  assert.ok(!(one(dom, ".summary") + all(dom, ".records:not(.raw)").join("")).includes(holder), "outside Details, no address in full");
  assert.ok(details.includes(holder) && details.includes(me) && details.includes("7 · account read from node.example"), "Details has every address whole, and the nonce");
  assert.equal(approveButton(dom).textContent, "Pay 251");
  assert.equal(approveButton(dom).disabled, false);
  approveButton(dom).click();
  await settle();
  const decided = sent.find((m) => m.type === "decide");
  assert.equal(decided?.approve, true);
  assert.equal(decided?.nonce, "7");
});

test("a payee no record names is shown whole, grouped, with a warning next to it", async () => {
  const stranger = deriveAccount(MNEMONIC, 3).address;
  const { dom } = await open({ ...buy, params: { ...buy.params, payments: [{ to: stranger, amount: "250" }] } }, "1000");
  const row = one(dom, ".breakdown .to");
  assert.ok(row.includes("an address the page chose"));
  assert.ok(row.includes("Check every group of it before you pay."));
  assert.equal(all(dom, ".breakdown .groups").join(""), stranger, "the whole address, in groups of four");
});

test("an account that cannot cover the payments and fee says so beside the button, which stays off", async () => {
  const { dom } = await open(buy, "250");
  assert.ok(one(dom, ".summary").includes("Balance: 250, not enough"));
  assert.equal(one(dom, ".decision .status"), "Needs 1 more.", "only what the button cannot say");
  assert.equal(approveButton(dom).getAttribute("aria-describedby"), "decision-status", "the reason reaches a screen reader");
  assert.equal(approveButton(dom).textContent, "Not enough");
  assert.equal(approveButton(dom).disabled, true);
});

test("a write without payments shows only the fee, and signs as a write", async () => {
  const { dom } = await open({ ...buy, params: { ...buy.params, payments: undefined } }, "10");
  assert.ok(one(dom, ".summary").startsWith("Network fee1"));
  assert.equal(dom.window.document.querySelector(".breakdown"), null);
  assert.equal(approveButton(dom).textContent, "Sign write");
});

test("text a page sends is never shown as a name, even when it reads like one", async () => {
  const { dom } = await open({ ...buy, params: { ...buy.params, payments: undefined, actions: [{ key: "note/you", newValue: "you" }] } }, "10");
  assert.equal(one(dom, ".records:not(.raw) li .meta"), "new · you");
  assert.equal(dom.window.document.querySelector(".records .name"), null);
});

test("a message is shown in full, line by line, with hidden characters made visible", async () => {
  const { sent, dom } = await open({ method: "signMessage", params: { text: "fanfare-door band\nberlin/A12 \\u{202e}" } }, "0");
  const pre = dom.window.document.querySelector("pre.message")!;
  assert.equal(pre.textContent, "fanfare-door band\nberlin/A12 \\\\u{202e}", "a backslash is shown escaped, so it cannot pass for an escape");
  assert.equal(dom.window.document.querySelector(".notice"), null);
  assert.equal(approveButton(dom).textContent, "Sign message");
  approveButton(dom).click();
  await settle();
  assert.deepEqual(sent.find((m) => m.type === "decide"), { type: "decide", id: "r1", approve: true, address: undefined });
});

test("a message naming another site says so", async () => {
  const { dom } = await open({ method: "signMessage", params: { text: "bank.example wants you to sign in with your account:\nURI: https://bank.example/login" } }, "0");
  assert.equal(one(dom, ".notice"), "This message names bank.example, but fanfare.example is asking. Sign only if you expect that.");
});

test("payments no record names come first, numbered as shown", async () => {
  const stranger = deriveAccount(MNEMONIC, 3).address;
  const { dom } = await open({ ...buy, params: { ...buy.params, payments: [{ to: holder, amount: "250" }, { to: stranger, amount: "9" }] } }, "1000");
  assert.deepEqual(all(dom, ".breakdown .amount"), ["9", "250", "1"]);
  assert.deepEqual(all(dom, ".breakdown .to > div:first-child .name"), ["payee 1", "payee 2"]);
  assert.ok(one(dom, ".breakdown .to").includes("an address the page chose"), "the first line is the one to check");
});

test("what does not fit stays off until it has been scrolled to, with a way down", async () => {
  // A window too short for the review: the records end below the decision bar.
  let recordsBottom = 900;
  const { dom } = await open(buy, "1000", (dom) => {
    dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
      const at = this.classList.contains("records") ? recordsBottom : this.classList.contains("decision") ? 500 : 0;
      return { top: at, bottom: at, left: 0, right: 0, width: 0, height: 0, x: 0, y: at, toJSON: () => ({}) } as DOMRect;
    };
    dom.window.scrollBy = (() => { recordsBottom = 480; dom.window.dispatchEvent(new dom.window.Event("scroll")); }) as typeof dom.window.scrollBy;
  });
  assert.equal(approveButton(dom).disabled, true, "covered, but not yet seen");
  const down = dom.window.document.querySelector(".decision .status .text-action") as HTMLButtonElement;
  assert.equal(down.textContent, "See the rest to pay ↓");
  down.click(); // scrolls until the records clear the bar
  await new Promise((r) => setTimeout(r, 900)); // the button's wait
  assert.equal(approveButton(dom).disabled, false);
  assert.equal(one(dom, ".decision .status"), "", "nothing left to say");
});

test("a long message must be read to its end before it can be signed", async () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  let scrolled = 0;
  const { dom } = await open({ method: "signMessage", params: { text } }, "0", (dom) => {
    for (const [name, value] of [["scrollHeight", () => 800], ["clientHeight", () => 260], ["scrollTop", () => scrolled]] as const) {
      Object.defineProperty(dom.window.HTMLPreElement.prototype, name, { configurable: true, get: value });
    }
    dom.window.HTMLPreElement.prototype.scrollTo = function (this: HTMLElement) { scrolled = 540; this.dispatchEvent(new dom.window.Event("scroll")); } as typeof HTMLElement.prototype.scrollTo;
  });
  assert.equal(approveButton(dom).disabled, true);
  (dom.window.document.querySelector(".decision .status .text-action") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(approveButton(dom).disabled, false);
});

test("with no node chosen, the nonce is read from the chain's next node when one fails", async () => {
  const START = "lattice-mainnet-read.fly.dev";
  const { text, dom } = await open({ ...buy, params: { ...buy.params, payments: undefined } }, "10", undefined, {
    settings: { endpoints: {}, nodeMode: "automatic" },
    fetch: (url) => {
      const chain = url.searchParams.get("chainPath");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.pathname === "/api/chain/genesis") return json({ genesisHash: "bafynexusgenesis" });
      if (url.pathname === "/api/chain/info" && (url.host !== START ? chain === "Nexus/fanfare/band" : chain === "Nexus/fanfare")) {
        return json({ chain: chain!.split("/"), height: "3" });
      }
      if (url.host === START && url.pathname === "/api/chain/endpoints" && chain === "Nexus/fanfare/band") {
        return json({ chainPath: ["Nexus", "fanfare", "band"], endpoints: ["https://broken.example", "https://band.example"] });
      }
      if (url.pathname === `/api/state/account/${me}`) {
        return url.host === "band.example" ? json({ owner: me, balance: "10", nonce: "7" }) : json({ error: "unavailable" }, 500);
      }
    },
  });
  assert.ok(!text().includes("None of your nodes"), text());
  assert.equal(approveButton(dom).textContent, "Sign write");
  assert.equal(approveButton(dom).disabled, false, "the nonce was read");
});

test("when the chosen node is down and is also the first host found, the next host is read", async () => {
  const START = "lattice-mainnet-read.fly.dev";
  const { text, dom } = await open({ ...buy, params: { ...buy.params, payments: undefined } }, "10", undefined, {
    settings: { endpoints: { "Nexus/fanfare/band": { url: "https://broken.example", acceptsSubmit: true, source: "discovered" } }, nodeMode: "automatic" },
    fetch: (url) => {
      const chain = url.searchParams.get("chainPath");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.pathname === "/api/chain/genesis") return json({ genesisHash: "bafynexusgenesis" });
      if (url.pathname === "/api/chain/info" && (url.host !== START ? chain === "Nexus/fanfare/band" : chain === "Nexus/fanfare")) {
        return json({ chain: chain!.split("/"), height: "3" });
      }
      if (url.host === START && url.pathname === "/api/chain/endpoints" && chain === "Nexus/fanfare/band") {
        return json({ chainPath: ["Nexus", "fanfare", "band"], endpoints: ["https://broken.example", "https://band.example"] });
      }
      if (url.pathname === `/api/state/account/${me}`) {
        return url.host === "band.example" ? json({ owner: me, balance: "10", nonce: "7" }) : json({ error: "unavailable" }, 500);
      }
    },
  });
  assert.ok(!text().includes("None of your nodes"), text());
  assert.equal(approveButton(dom).textContent, "Sign write");
  assert.equal(approveButton(dom).disabled, false, "the nonce was read");
});

test("when the start node serves the chain but cannot read the account, a declared host is read", async () => {
  const START = "lattice-mainnet-read.fly.dev";
  const { text, dom } = await open({ ...buy, params: { ...buy.params, payments: undefined } }, "10", undefined, {
    settings: { endpoints: {}, nodeMode: "automatic" },
    fetch: (url) => {
      const chain = url.searchParams.get("chainPath");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.pathname === "/api/chain/genesis") return json({ genesisHash: "bafynexusgenesis" });
      if (url.pathname === "/api/chain/info" && chain && (url.host === START || chain === "Nexus/fanfare/band")) {
        return json({ chain: chain.split("/"), height: "3" });
      }
      if (url.host === START && url.pathname === "/api/chain/endpoints" && chain === "Nexus/fanfare/band") {
        return json({ chainPath: ["Nexus", "fanfare", "band"], endpoints: ["https://band.example"] });
      }
      if (url.pathname === `/api/state/account/${me}`) {
        return url.host === "band.example" ? json({ owner: me, balance: "10", nonce: "7" }) : json({ error: "unavailable" }, 500);
      }
    },
  });
  assert.ok(!text().includes("None of your nodes"), text());
  assert.equal(approveButton(dom).disabled, false, "the nonce was read");
});
