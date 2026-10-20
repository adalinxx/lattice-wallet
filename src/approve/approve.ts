// The wallet's own window for one request from a web page: connect (give the
// site an address), write records (sign, once the person approves), or sign
// a message. A write is shown as what it does to the person: what they pay,
// to whom, and what their balance becomes; then each record it changes.
// Everything secondary (full addresses, records as sent, the nonce) is
// behind one Details disclosure. What the page sent is only ever shown as
// text, and an address the wallet knows is shown as its name in an inverted
// tag, which no text a page sends can look like.

import { totalDebit, type ProviderCall } from "../lib/wallet/provider.ts";
import { addressGroups, addressNames, nameAddresses, otherHosts, payeeRecords, paymentsToShow, shortAddress } from "../lib/wallet/review.ts";
import type { WalletState } from "../lib/wallet/types.ts";
import { loadSettings } from "../lib/wallet/settings.ts";
import { chosenNodes, discoveryStart, knownPending, livePageWrites, nextNonce, type PageWrite } from "../lib/wallet/nonce.ts";
import { browserFetch, chainNodes, reader, sentStatus } from "../lib/wallet/node.ts";
import { ALL_HTTPS_ORIGINS, LATTICE_EXPLORER_RPC, originPattern } from "../lib/config.ts";

const id = new URLSearchParams(location.search).get("id") ?? "";
const view = document.getElementById("view")!;
type Answer = { ok: boolean; error?: string; [key: string]: unknown };
const send = (msg: object) => chrome.runtime.sendMessage(msg) as Promise<Answer>;

function el(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
// Characters that print as nothing, or reorder what follows, are shown as
// their code points, so a key cannot pass for another.
// A backslash is escaped too, so an escape shown is never text that looks like one.
const visible = (text: string) => text.replace(/\\|[^\S ]|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u115f\u1160\u2800\u3164\uffa0]/gu,
  (ch) => ch === "\\" ? "\\\\" : ch === " " ? ch : `\\u{${ch.codePointAt(0)!.toString(16)}}`);
/** A value as sent: the first 400 characters, the rest a click away. */
function valueNode(label: string, value: string | undefined): HTMLElement {
  if (value === undefined) return el("div", { className: "value", textContent: `${label}: (none)` });
  const text = visible(value);
  if (text.length <= 400) return el("div", { className: "value", textContent: `${label}: ${text}` });
  return el("details", { className: "value" }, el("summary", { textContent: `${label}: ${text.slice(0, 400)}… (${text.length} characters)` }), text);
}
// Exact: amounts are UInt64, never rounded through a double.
const fmt = (n: string | bigint) => BigInt(n).toLocaleString("en-US");
const label = (text: string) => el("p", { className: "section-label", textContent: text });
const row = (key: string, ...value: (Node | string)[]) => el("div", { className: "row" }, el("span", { className: "k", textContent: key }), el("span", { className: "v" }, ...value));

/** A site as people check it: the host, whole and in bold; the scheme only when it is not https. */
function site(origin: string): HTMLElement {
  const url = new URL(origin);
  return el("span", { className: "origin" }, ...(url.protocol === "https:" ? [] : [el("span", { className: "scheme", textContent: `${url.protocol}//` })]), el("strong", { textContent: url.host }));
}
/** A whole address, four characters to a group, to compare a group at a time. Copied, it is unbroken. */
const fullAddress = (address: string) => el("span", { className: "groups" }, ...addressGroups(address).map((g) => el("span", { textContent: g })));

/**
 * Text with every address the wallet knows shown as its name, cut to about
 * `limit` characters (Details shows it all).
 */
function named(text: string, names: ReadonlyMap<string, string>, limit = Infinity): HTMLElement {
  const out = el("span", { className: "named" });
  let room = limit;
  for (const segment of nameAddresses(text, names)) {
    if (room <= 0) break;
    if ("name" in segment) {
      out.append(el("span", { className: "name", title: segment.address, textContent: segment.name }));
      room -= segment.name.length;
    } else {
      const shown = visible(segment.text);
      out.append(shown.length > room ? `${shown.slice(0, room)}…` : shown);
      room -= shown.length;
    }
  }
  return out;
}

function fail(message: string) {
  view.replaceChildren(el("p", { className: "warn", textContent: message }), el("button", { className: "btn block", textContent: "Close", onclick: () => window.close() }));
}

// ---- the nonce, read from the person's own node choices ----

/** `stale`: page writes the node's pool no longer holds (never admitted, or dropped). */
type NonceRead = { nonce: bigint; stateNonce: bigint; balance: bigint; node: string; stale: string[] } | { missing: string[]; automatic: boolean } | { error: string };
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
  const pageWrites = ((await chrome.storage.local.get("pageWrites")).pageWrites as PageWrite[] | undefined) ?? [];
  const chain = chainPath.join("/");
  const readAt = async (url: string): Promise<NonceRead | undefined> => {
    try {
      const auth = (await send({ type: "nodeAuthorization", url })).authorization as string | undefined;
      const node = reader(url, chainPath, allowedFetch, auth);
      // Ask the node each write went to whether it knows it, before reading the
      // account (a block landing in between then only makes the write look live).
      const dead = new Set<string>();
      await Promise.all(pageWrites.filter((w) => w.chain === chain && w.from === address && w.cid).map(async (write) => {
        const elsewhere = write.node && write.node !== url;
        const at = elsewhere
          ? reader(write.node!, chainPath, allowedFetch, (await send({ type: "nodeAuthorization", url: write.node })).authorization as string | undefined)
          : node;
        const status = await sentStatus(at, write.cid!, { from: address, nonce: BigInt(write.nonce) }).catch(() => null);
        if (status?.kind === "unknown to node") dead.add(write.cid!);
      }));
      const state = await node.account(address);
      const live = livePageWrites(pageWrites, chain, state.nonce, dead);
      const stale = [...dead];
      return { nonce: nextNonce(state.nonce, chain, address, knownPending(settings, live)), stateNonce: state.nonce, balance: state.balance, node: url, stale };
    } catch { return undefined; /* not this node */ }
  };
  const tried = new Set<string>();
  for (const url of chosenNodes(settings, chainPath)) {
    tried.add(url);
    const read = await readAt(url);
    if (read) return read;
  }
  if (settings.nodeMode === "automatic") {
    // Then the SDK's failover list: the start node if it serves the chain,
    // then the declared hosts, each until one answers.
    const read = await chainNodes(discoveryStart(settings, LATTICE_EXPLORER_RPC), allowedFetch).read(chainPath, async (node) => {
      if (tried.has(node.url)) throw new Error("already tried");
      return (await readAt(node.url)) ?? Promise.reject(new Error("not this node"));
    }).catch(() => undefined); // what it could not reach is in `missing`
    if (read) return read;
  }
  return missing.size ? { missing: [...missing], automatic: settings.nodeMode === "automatic" }
    : { error: `None of your nodes serves ${chainPath.join("/")}. Choose a node for it in the wallet, then try again.` };
}

async function decide(approve: boolean, address?: string, nonce?: { nonce: bigint; stateNonce: bigint; node: string; stale: string[] }) {
  const answer = await send({ type: "decide", id, approve, address, ...(nonce && { nonce: String(nonce.nonce), stateNonce: String(nonce.stateNonce), node: nonce.node, stale: nonce.stale }) });
  if (answer.ok) window.close();
  else if (answer.error === "Locked") render();
  else fail(answer.error ?? "Could not finish");
}

// The approving button wakes up a moment after the window is seen, so a
// click aimed at something else cannot land on it. A bar fills across it
// meanwhile, so a button that waits is not mistaken for a broken one.
const ARM_MS = 800;
/**
 * The decision, kept at the foot of the window so it is never scrolled away
 * from what it decides: a line saying why the approving button waits, when
 * it does, then Decline and the one filled button, named for what it does.
 * The approving button also waits for `ready`; calling `arm` checks again.
 */
function decision(approveLabel: string, onApprove: () => void, ready: () => boolean = () => true) {
  const status = el("div", { className: "status", role: "status", id: "decision-status" });
  const approve = el("button", { className: "btn btn--primary", type: "button", textContent: approveLabel, onclick: onApprove, disabled: true }) as HTMLButtonElement;
  // A button that is off says why to a screen reader too.
  approve.setAttribute("aria-describedby", status.id);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    approve.disabled = true;
    approve.classList.remove("arming");
    clearTimeout(timer);
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    if (ready()) approve.classList.add("arming");
    timer = setTimeout(() => { approve.classList.remove("arming"); approve.disabled = !ready(); }, ARM_MS);
  };
  window.addEventListener("focus", arm);
  window.addEventListener("blur", arm);
  document.addEventListener("visibilitychange", arm);
  arm();
  const bar = el("div", { className: "decision" }, status, el("div", { className: "actions-row" },
    el("button", { className: "btn", type: "button", textContent: "Decline", onclick: () => decide(false) }), approve));
  return Object.assign(bar, { arm, status, approve });
}

/**
 * Whether the person has had everything that decides the request in front of
 * them: down to `last` (the end of what matters; Details is behind its own
 * toggle) above the decision bar, and each box that scrolls inside, scrolled
 * to its end, at least once. What fits counts as seen. Until then the
 * approving button stays off, as a hardware wallet shows every field before
 * its sign step: what a page puts below the fold is what someone would
 * approve unseen. Meanwhile the bar shows `below()`, a way down.
 * `changed` runs on every change; `watch` starts once all is on the page.
 */
function reviewGate(changed: () => void) {
  const boxes: Element[] = [];
  let last: Element | null = null;
  let bar: Element | null = null;
  let seen = false;
  const atEnd = (box: Element) => box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
  const lastShown = () => !last || !bar || last.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top + 2;
  // Only a change of `seen` matters: re-arming on every scroll would restart
  // the button's wait each time.
  const update = () => {
    if (seen || !lastShown() || !boxes.every(atEnd)) return;
    seen = true;
    changed();
  };
  const down = () => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const behavior = reduced ? "auto" : "smooth";
    const box = boxes.find((b) => !atEnd(b));
    if (lastShown() && box) box.scrollTo({ top: box.scrollHeight, behavior });
    // Down until the end of what matters clears the bar, which covers the window's foot.
    else if (last && bar) window.scrollBy({ top: last.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 8, behavior });
    // Check again once there, not only on scroll events: a smooth scroll ends after they stop.
    update();
    setTimeout(update, 600);
  };
  return {
    seen: () => seen,
    /** The bar's way down while something is unseen, else null. */
    below: (unseen: string): HTMLElement | null =>
      seen ? null : el("button", { className: "text-action", type: "button", textContent: `${unseen} ↓`, onclick: down }),
    watch: (end: Element, decisionBar: Element, ...inside: Element[]) => {
      last = end;
      bar = decisionBar;
      for (const box of inside) { boxes.push(box); box.addEventListener("scroll", update, { passive: true }); }
      window.addEventListener("scroll", update, { passive: true });
      window.addEventListener("resize", update);
      update();
      if (!seen) changed(); // show the way down
    },
  };
}

async function render() {
  const request = await send({ type: "pending", id });
  if (!request.ok) return fail(request.error ?? "This request is gone.");
  const origin = request.origin as string;
  const host = new URL(origin).host;
  const call = request.call as ProviderCall;
  const stateAnswer = await send({ type: "getState" });
  const state = stateAnswer.state as WalletState;
  if (!state.initialized) return fail("Set up the wallet first: open Selfhold from the toolbar.");
  if (state.locked) {
    const password = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
    const error = el("p", { className: "warn", hidden: true });
    const form = el("form", { className: "stack", onsubmit: async (event: Event) => {
      event.preventDefault();
      const answer = await send({ type: "unlock", password: password.value });
      if (answer.ok) render();
      else { error.textContent = answer.error ?? "Could not unlock"; error.hidden = false; }
    } }, el("p", {}, site(origin), " is asking. Unlock to see what."), password, error,
      el("button", { className: "btn block btn--primary", type: "submit", textContent: "Unlock" }));
    view.replaceChildren(form, el("button", { className: "btn block", type: "button", textContent: "Decline", onclick: () => decide(false) }));
    password.focus();
    return;
  }
  if (call.method === "connect") {
    const picker = el("select", { className: "picker" }, ...state.accounts.map((a) => el("option", { value: a.address, textContent: `${a.label} · ${shortAddress(a.address)}`, selected: a.address === state.active }))) as HTMLSelectElement;
    view.replaceChildren(
      el("h1", { textContent: "Connect" }),
      el("p", {}, site(origin), " wants to know your address. It can then ask you to sign writes and messages; you approve each one here."),
      el("label", { className: "k", textContent: "Account" }), picker,
      decision("Connect", () => decide(true, picker.value)));
    return;
  }
  const address = String(request.address);
  const account = state.accounts.find((a) => a.address === address);
  const who = account?.label ?? shortAddress(address);
  const accountDetail = row("Account", ...(account ? [`${account.label} `] : []), fullAddress(address));
  if (call.method === "signMessage") {
    const { text } = call.params;
    const elsewhere = otherHosts(text, origin);
    const message = el("pre", { className: "message", textContent: text.split("\n").map(visible).join("\n") });
    const explanation = el("p", { className: "meta", textContent: `Signing proves to ${host} that you hold this account. It cannot move coins or approve a transaction.` });
    const gate = reviewGate(() => {
      const below = gate.below("Read the whole message to sign it");
      bar.status.replaceChildren(...(below ? [below] : []));
      bar.arm();
    });
    const bar = decision("Sign message", () => decide(true), () => gate.seen());
    view.replaceChildren(
      el("h1", { textContent: "Review message" }),
      el("p", { className: "from" }, "from ", site(origin), ` · signing as ${who}`),
      label("Message"),
      message,
      ...(elsewhere.length ? [el("p", { className: "notice", textContent: `This message names ${elsewhere.join(", ")}, but ${host} is asking. Sign only if you expect that.` })] : []),
      explanation,
      el("details", { className: "advanced" }, el("summary", { textContent: "Details" }), el("div", { className: "advanced-content kv" },
        accountDetail,
        row("Signed", `lattice-message:${origin}, a line break, then the message`))),
      bar);
    gate.watch(explanation, bar, message);
    return;
  }
  if (call.method !== "writeRecords") return fail("Unknown request");

  const { chainPath, actions, payments = [], fee } = call.params;
  const chain = chainPath.join("/");
  const debit = totalDebit(call.params);
  // Payments no record names first: those are the ones to check.
  const shown = paymentsToShow(actions, payments);
  const names = addressNames(address, shown, state.accounts);
  const namedBy = payeeRecords(actions, shown);
  const approveLabel = payments.length ? `Pay ${fmt(debit)}` : "Sign write";

  // ---- the account, read from the person's node: balance and nonce ----
  const balanceAfter = el("p", { className: "meta", textContent: "Balance: checking…" });
  const nonceShown = el("span", { textContent: "checking…" });
  let nonceRead: NonceRead = { missing: [], automatic: false };
  const covered = (read: NonceRead) => "nonce" in read && read.balance >= debit;
  const sign = async () => {
    // Read again at the moment of signing: the account may have moved.
    const now = await readNonce(chainPath, address);
    if (!covered(now)) { nonceRead = now; showRead(); return; }
    decide(true, undefined, now as Extract<NonceRead, { nonce: bigint }>);
  };
  const gate = reviewGate(() => explain());
  const bar = decision(approveLabel, () => { sign().catch((e) => fail(String(e?.message ?? e))); }, () => covered(nonceRead) && gate.seen());
  /** The one line the bar shows: why the account stops it (showRead), else what is left to see. */
  function explain() {
    if ("nonce" in nonceRead && nonceRead.balance >= debit) {
      const below = gate.below(`See the rest to ${payments.length ? "pay" : "sign"}`);
      bar.status.replaceChildren(...(below ? [below] : []));
    }
    bar.arm();
  }
  bar.status.textContent = `Checking your account on ${chain}…`;
  function showRead() {
    bar.approve.textContent = approveLabel;
    if ("nonce" in nonceRead) {
      const { balance } = nonceRead;
      nonceShown.textContent = `${nonceRead.nonce} · account read from ${new URL(nonceRead.node).host}`;
      if (balance >= debit) {
        balanceAfter.textContent = `Balance: ${fmt(balance)} → ${fmt(balance - debit)}`;
      } else {
        balanceAfter.textContent = `Balance: ${fmt(balance)}, not enough`;
        bar.status.textContent = `Needs ${fmt(debit - balance)} more.`;
        bar.approve.textContent = "Not enough";
      }
      return explain();
    } else if ("missing" in nonceRead && nonceRead.missing.length) {
      const hosts = nonceRead.missing;
      // Automatic discovery may walk on to hosts not yet named, so it asks once for every HTTPS node.
      const asked = nonceRead.automatic ? [ALL_HTTPS_ORIGINS] : hosts;
      nonceShown.textContent = "needs your permission";
      bar.status.replaceChildren(
        el("p", { textContent: `To check your account on ${chain}, the wallet needs to reach ${hosts.map((o) => o.replace(/\/\*$/, "")).join(", ")}${nonceRead.automatic ? ", and any other node it finds for this chain" : ""}.` }),
        el("button", { className: "btn block", type: "button", textContent: "Allow", onclick: async () => {
          if (await chrome.permissions.request({ origins: asked }).catch(() => false)) check();
        } }));
    } else if ("error" in nonceRead) {
      nonceShown.textContent = "unknown";
      bar.status.textContent = nonceRead.error;
    }
    bar.arm();
  }
  const check = () => readNonce(chainPath, address).then((r) => { nonceRead = r; showRead(); }, (e) => { nonceRead = { error: String(e?.message ?? e) }; showRead(); });

  // ---- what the person pays: each payment, then the fee, adding up to the total ----
  const line = (amount: string, ...to: (Node | string)[]) => el("li", {}, el("span", { className: "amount", textContent: fmt(amount) }), el("div", { className: "to" }, ...to));
  // Without payments the fee is all there is to pay: one figure, nothing to break down.
  const breakdown = [
    ...shown.map((p, i) => {
      const record = namedBy[i];
      const payee = el("span", { className: "name", title: p.to, textContent: names.get(p.to)! });
      return record
        ? line(p.amount, el("div", {}, "to ", payee), el("div", { className: "meta" }, "in record ", named(record, names, 60)), el("div", { className: "meta", textContent: shortAddress(p.to) }))
        : line(p.amount, el("div", {}, "to ", payee, ", an address the page chose"), el("div", { className: "meta" }, fullAddress(p.to)),
          el("p", { className: "notice", textContent: "No record in this write names this address. Check every group of it before you pay." }));
    }),
    ...(payments.length && BigInt(fee) > 0n ? [line(fee, "network fee")] : []),
  ];
  const summary = el("section", { className: "balance-card summary" },
    label(payments.length ? "You pay" : debit > 0n ? "Network fee" : "No coins move"),
    ...(debit > 0n ? [el("span", { className: "balance-value", textContent: fmt(debit) })] : []),
    el("p", { className: "meta", textContent: `on ${chain} · from ${who}` }),
    balanceAfter,
    ...(breakdown.length ? [el("ul", { className: "breakdown" }, ...breakdown)] : []));

  // ---- what the write changes: each record, was → now ----
  const change = (a: (typeof actions)[number]) =>
    a.newValue === undefined ? el("div", { className: "meta" }, "deleted · was ", named(a.oldValue ?? "", names, 80))
    : a.oldValue === undefined ? el("div", { className: "meta" }, "new · ", named(a.newValue, names, 80))
    : el("div", { className: "meta" }, named(a.oldValue, names, 40), " → ", named(a.newValue, names, 40));

  const recordList = el("ul", { className: "records" }, ...actions.map((a) => el("li", {}, el("div", { className: "key" }, named(a.key, names, 80)), change(a))));
  view.replaceChildren(
    el("h1", { textContent: payments.length ? "Review payment" : "Review write" }),
    el("p", { className: "from" }, "from ", site(origin)),
    summary,
    label(`Records · ${actions.length}`),
    recordList,
    el("details", { className: "advanced" },
      el("summary", { textContent: "Details" }),
      el("div", { className: "advanced-content" },
        el("div", { className: "kv" },
          accountDetail,
          row("Chain", chain),
          ...shown.map((p) => row(names.get(p.to)!, fullAddress(p.to))),
          row("Nonce", nonceShown)),
        label("Records as sent"),
        el("ul", { className: "records raw" }, ...actions.map((a) => el("li", {},
          el("div", { className: "key", textContent: visible(a.key) }),
          ...(a.newValue === undefined ? [valueNode("delete, was", a.oldValue)]
            : a.oldValue === undefined ? [valueNode("new", a.newValue)]
            : [valueNode("was", a.oldValue), valueNode("now", a.newValue)])))))),
    bar);
  gate.watch(recordList, bar);
  check();
}

// The worker keeps this request only while it runs; checking in keeps it awake.
setInterval(() => { send({ type: "pending", id }).catch(() => {}); }, 20_000);
render().catch((e) => fail(String(e?.message ?? e)));
