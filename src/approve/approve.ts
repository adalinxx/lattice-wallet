// The wallet's own window for one request from a web page: connect (give the
// site an address) or write records (sign, once the person approves). What
// the page sent is only ever shown as text.

import type { ProviderCall } from "../lib/wallet/provider.ts";
import type { WalletState } from "../lib/wallet/types.ts";

const id = new URLSearchParams(location.search).get("id") ?? "";
const view = document.getElementById("view")!;
type Answer = { ok: boolean; error?: string; [key: string]: unknown };
const send = (msg: object) => chrome.runtime.sendMessage(msg) as Promise<Answer>;

function el(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
const field = (label: string, value: string) => el("div", { className: "row" }, el("span", { className: "k", textContent: label }), el("span", { className: "v addr", textContent: value }));
const shown = (value: string | undefined) => value === undefined ? "(none)" : value.length > 400 ? `${value.slice(0, 400)}…` : value;

function fail(message: string) {
  view.replaceChildren(el("p", { className: "warn", textContent: message }), el("button", { className: "btn block", textContent: "Close", onclick: () => window.close() }));
}

async function decide(approve: boolean, address?: string) {
  const answer = await send({ type: "decide", id, approve, address });
  if (answer.ok) window.close();
  else if (answer.error === "Locked") render();
  else fail(answer.error ?? "Could not finish");
}

function buttons(approveLabel: string, onApprove: () => void) {
  return el("div", { className: "actions-row" },
    el("button", { className: "btn", type: "button", textContent: "Decline", onclick: () => decide(false) }),
    el("button", { className: "btn primary", type: "button", textContent: approveLabel, onclick: onApprove }));
}

async function render() {
  const request = await send({ type: "pending", id });
  if (!request.ok) return fail(request.error ?? "This request is gone.");
  const origin = request.origin as string;
  const call = request.call as ProviderCall;
  const stateAnswer = await send({ type: "getState" });
  const state = stateAnswer.state as WalletState;
  if (!state.initialized) return fail("Set up the wallet first: open Lattice Wallet from the toolbar.");
  if (state.locked) {
    const password = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
    const error = el("p", { className: "warn", hidden: true });
    const form = el("form", { className: "stack", onsubmit: async (event: Event) => {
      event.preventDefault();
      const answer = await send({ type: "unlock", password: password.value });
      if (answer.ok) render();
      else { error.textContent = answer.error ?? "Could not unlock"; error.hidden = false; }
    } }, el("p", {}, el("span", { className: "origin", textContent: origin }), " is asking. Unlock to see what."), password, error,
      el("button", { className: "btn block primary", type: "submit", textContent: "Unlock" }));
    view.replaceChildren(form, el("button", { className: "btn block", type: "button", textContent: "Decline", onclick: () => decide(false) }));
    password.focus();
    return;
  }
  if (call.method === "connect") {
    const picker = el("select", { className: "picker" }, ...state.accounts.map((a) => el("option", { value: a.address, textContent: `${a.label} · ${a.address.slice(0, 10)}…${a.address.slice(-4)}`, selected: a.address === state.active }))) as HTMLSelectElement;
    view.replaceChildren(
      el("h1", { textContent: "Connect" }),
      el("p", {}, el("span", { className: "origin", textContent: origin }), " wants to know your address. It can then ask you to sign writes; you approve each one here."),
      el("label", { className: "k", textContent: "Account" }), picker,
      buttons("Connect", () => decide(true, picker.value)));
    return;
  }
  if (call.method !== "writeRecords") return fail("Unknown request");
  const { chainPath, actions, fee, nonce } = call.params;
  const account = state.accounts.find((a) => a.address === request.address);
  view.replaceChildren(
    el("h1", { textContent: "Sign a write" }),
    el("p", {}, el("span", { className: "origin", textContent: origin }), ` asks to write ${actions.length} ${actions.length === 1 ? "record" : "records"}. No coins move except the fee.`),
    el("div", { className: "kv" },
      field("Account", account ? `${account.label} · ${account.address}` : String(request.address)),
      field("Chain", chainPath.join("/")), field("Fee", fee), field("Nonce", nonce)),
    el("ul", { className: "records" }, ...actions.map((a) => el("li", {},
      el("div", { className: "key", textContent: a.key }),
      el("div", { className: "value muted", textContent: a.newValue === undefined ? `delete (was ${shown(a.oldValue)})` : `${a.oldValue === undefined ? "new" : "replaces"}: ${shown(a.newValue)}` })))),
    buttons("Sign", () => decide(true)));
}

// The worker keeps this request only while it runs; checking in keeps it awake.
setInterval(() => { send({ type: "pending", id }).catch(() => {}); }, 20_000);
render().catch((e) => fail(String(e?.message ?? e)));
