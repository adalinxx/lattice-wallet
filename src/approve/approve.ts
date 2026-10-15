// The wallet's own window for one request from a web page: connect (give the
// site an address) or write records (sign, once the person approves). What
// the page sent is only ever shown as text.

import type { ProviderCall } from "../lib/wallet/provider.ts";
import type { WalletState } from "../lib/wallet/types.ts";
import { loadSettings } from "../lib/wallet/settings.ts";
import { chosenNodes, discoveryStart, knownPending, livePageWrites, nextNonce, type PageWrite } from "../lib/wallet/nonce.ts";
import { browserFetch, discover, reader } from "../lib/wallet/node.ts";
import { LATTICE_EXPLORER_RPC, originPattern } from "../lib/config.ts";

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
// Characters that print as nothing, or reorder what follows, are shown as
// their code points, so a key cannot pass for another.
// A backslash is escaped too, so an escape shown is never text that looks like one.
const visible = (text: string) => text.replace(/\\|[^\S ]|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u115f\u1160\u2800\u3164\uffa0]/gu,
  (ch) => ch === "\\" ? "\\\\" : ch === " " ? ch : `\\u{${ch.codePointAt(0)!.toString(16)}}`);
/** A value as text: the first 400 characters, the rest a click away. */
function valueNode(label: string, value: string | undefined): HTMLElement {
  if (value === undefined) return el("div", { className: "value muted", textContent: `${label}: (none)` });
  const text = visible(value);
  if (text.length <= 400) return el("div", { className: "value muted", textContent: `${label}: ${text}` });
  return el("details", { className: "value muted" }, el("summary", { textContent: `${label}: ${text.slice(0, 400)}… (${text.length} characters)` }), text);
}
const grouped = (decimal: string) => BigInt(decimal).toLocaleString("en-US");

function fail(message: string) {
  view.replaceChildren(el("p", { className: "warn", textContent: message }), el("button", { className: "btn block", textContent: "Close", onclick: () => window.close() }));
}

// ---- the nonce, read from the person's own node choices ----

/** `stale`: page writes the node's pool no longer holds (never admitted, or dropped). */
type NonceRead = { nonce: bigint; stateNonce: bigint; node: string; stale: string[] } | { missing: string[] } | { error: string };
const permitted = (origin: string) => chrome.permissions.contains({ origins: [origin] });

/** The next free nonce for `address` on `chainPath`, from a node the person chose or allowed. */
async function readNonce(chainPath: string[], address: string): Promise<NonceRead> {
  const settings = await loadSettings(chrome.storage.local);
  const missing = new Set<string>();
  // Only nodes the person allowed are asked; the others are named to them.
  const allowedFetch: typeof browserFetch = async (input, init) => {
    const origin = originPattern(String(input instanceof Request ? input.url : input));
    if (!(await permitted(origin))) {
      missing.add(origin);
      throw new Error(`no access to ${origin}`);
    }
    return browserFetch(input, init);
  };
  const candidates = chosenNodes(settings, chainPath);
  if (settings.nodeMode === "automatic") {
    try {
      for (const endpoint of await discover(discoveryStart(settings, LATTICE_EXPLORER_RPC), chainPath, allowedFetch)) candidates.push(endpoint.url);
    } catch { /* what it could not reach is in `missing` */ }
  }
  const pageWrites = ((await chrome.storage.local.get("pageWrites")).pageWrites as PageWrite[] | undefined) ?? [];
  const chain = chainPath.join("/");
  for (const url of new Set(candidates)) {
    try {
      const auth = (await send({ type: "nodeAuthorization", url })).authorization as string | undefined;
      const node = reader(url, chainPath, allowedFetch, auth);
      const state = await node.account(address);
      const pool = new Set((await node.mempool()).transactions);
      const live = livePageWrites(pageWrites, chain, state.nonce, pool);
      const stale = pageWrites.filter((p) => p.chain === chain && p.cid && !live.includes(p)).map((p) => p.cid!);
      return { nonce: nextNonce(state.nonce, chain, address, knownPending(settings, live)), stateNonce: state.nonce, node: url, stale };
    } catch { /* not this node */ }
  }
  return missing.size ? { missing: [...missing] }
    : { error: `None of your nodes serves ${chainPath.join("/")}. Choose a node for it in the wallet, then try again.` };
}

async function decide(approve: boolean, address?: string, nonce?: { nonce: bigint; stateNonce: bigint; node: string; stale: string[] }) {
  const answer = await send({ type: "decide", id, approve, address, ...(nonce && { nonce: String(nonce.nonce), stateNonce: String(nonce.stateNonce), node: nonce.node, stale: nonce.stale }) });
  if (answer.ok) window.close();
  else if (answer.error === "Locked") render();
  else fail(answer.error ?? "Could not finish");
}

// The approving button wakes up a moment after the window is seen, so a
// click aimed at something else cannot land on it.
const ARM_MS = 800;
/** Decline and approve; approve also waits for `ready` (re-checked by calling the returned arm). */
function buttons(approveLabel: string, onApprove: () => void, ready: () => boolean = () => true) {
  const approve = el("button", { className: "btn primary", type: "button", textContent: approveLabel, onclick: onApprove, disabled: true }) as HTMLButtonElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    approve.disabled = true;
    clearTimeout(timer);
    if (document.visibilityState === "visible" && document.hasFocus()) timer = setTimeout(() => { approve.disabled = !ready(); }, ARM_MS);
  };
  window.addEventListener("focus", arm);
  window.addEventListener("blur", arm);
  document.addEventListener("visibilitychange", arm);
  arm();
  const row = el("div", { className: "actions-row" },
    el("button", { className: "btn", type: "button", textContent: "Decline", onclick: () => decide(false) }), approve);
  return Object.assign(row, { arm });
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
  const { chainPath, actions, fee } = call.params;
  const address = String(request.address);
  const account = state.accounts.find((a) => a.address === address);
  const nonceShown = el("span", { className: "v addr", textContent: "checking…" });
  const nonceHelp = el("div", { className: "stack" });
  let nonceRead: NonceRead = { missing: [] };
  const ready = () => "nonce" in nonceRead;
  const sign = async () => {
    // Read again at the moment of signing: the account may have moved.
    const now = await readNonce(chainPath, address);
    if (!("nonce" in now)) { nonceRead = now; showNonce(); return; }
    decide(true, undefined, now);
  };
  const row = buttons("Sign", () => { sign().catch((e) => fail(String(e?.message ?? e))); }, ready);
  function showNonce() {
    if ("nonce" in nonceRead) {
      nonceShown.textContent = `${nonceRead.nonce} (from ${new URL(nonceRead.node).host})`;
      nonceHelp.replaceChildren();
    } else if ("missing" in nonceRead && nonceRead.missing.length) {
      const hosts = nonceRead.missing;
      nonceShown.textContent = "needs your permission";
      nonceHelp.replaceChildren(
        el("p", { className: "muted", textContent: `To check your account on this chain, the wallet needs to reach ${hosts.map((o) => o.replace(/\/\*$/, "")).join(", ")}.` }),
        el("button", { className: "btn block", type: "button", textContent: "Allow", onclick: async () => {
          if (await chrome.permissions.request({ origins: hosts }).catch(() => false)) check();
        } }));
    } else if ("error" in nonceRead) {
      nonceShown.textContent = "unknown";
      nonceHelp.replaceChildren(el("p", { className: "warn", textContent: nonceRead.error }));
    }
    row.arm();
  }
  const check = () => readNonce(chainPath, address).then((r) => { nonceRead = r; showNonce(); }, (e) => { nonceRead = { error: String(e?.message ?? e) }; showNonce(); });
  view.replaceChildren(
    el("h1", { textContent: "Sign a write" }),
    el("p", {}, el("span", { className: "origin", textContent: origin }), ` asks to write ${actions.length} ${actions.length === 1 ? "record" : "records"}. No coins move except the fee.`),
    el("div", { className: "kv" },
      field("Account", account ? `${account.label} · ${account.address}` : address),
      field("Chain", chainPath.join("/")), field("Fee", grouped(fee)),
      el("div", { className: "row" }, el("span", { className: "k", textContent: "Nonce" }), nonceShown)),
    nonceHelp,
    el("ul", { className: "records" }, ...actions.map((a) => el("li", {},
      el("div", { className: "key", textContent: visible(a.key) }),
      ...(a.newValue === undefined ? [valueNode("delete, was", a.oldValue)]
        : a.oldValue === undefined ? [valueNode("new", a.newValue)]
        : [valueNode("was", a.oldValue), valueNode("now", a.newValue)])))),
    row);
  check();
}

// The worker keeps this request only while it runs; checking in keeps it awake.
setInterval(() => { send({ type: "pending", id }).catch(() => {}); }, 20_000);
render().catch((e) => fail(String(e?.message ?? e)));
