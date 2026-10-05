// Nexus Wallet popup. Talks only to the background signer (key material never
// enters this context) and to the node the user chose for reads/submit.
// There is no default node. Styled with the Lattice design system.

import { wallet } from "../lib/wallet/client.ts";
import { newMnemonic, isValidMnemonic } from "../lib/crypto/accounts.ts";
import { reader, submitter, discover, describe, feeWarning, sentStatus, statusText, OPERATOR_DECLARED } from "../lib/wallet/node.ts";
import { ROOT_CHAIN, parseChainPath, normalizeNodeURL, originPattern } from "../lib/config.ts";
import { loadSettings, saveSettings, recordSent, defaultFee, parseFee, type Settings, type ChosenEndpoint } from "../lib/wallet/settings.ts";
import type { WalletState, AccountView } from "../lib/wallet/types.ts";

type El = HTMLElement;
const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null)[]): El => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v as EventListener);
    else n.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid != null) n.append(kid as Node | string);
  return n;
};
const short = (s: string) => (s.length <= 22 ? s : `${s.slice(0, 12)}…${s.slice(-8)}`);
const fmt = (n: string | number) => Number(n).toLocaleString();
const view = () => document.getElementById("view")!;
const render = (node: El) => view().replaceChildren(node);

let st: WalletState = { initialized: false, locked: true, accounts: [], active: null };
let settings: Settings;
const store = chrome.storage.local;
const chainPath = () => parseChainPath(settings.chain) ?? [ROOT_CHAIN];
const endpoint = (): ChosenEndpoint | undefined => settings.endpoints[settings.chain];
const client = () => reader(endpoint()!.url, chainPath());
async function update(change: (s: Settings) => Settings) {
  settings = change(settings);
  await saveSettings(store, settings);
  syncBadge();
}

function syncBadge() {
  const b = document.getElementById("net-badge")!;
  b.textContent = settings.chain;
}

const activeAccount = (): AccountView | undefined => st.accounts.find((a) => a.address === st.active);

async function refresh() {
  const r = await wallet.getState();
  if (r.ok) st = r.state;
  settings = await loadSettings(store);
  syncBadge();
  route();
}

function route() {
  if (!st.initialized) return welcome();
  if (st.locked) return unlockScreen();
  if (!endpoint()) return endpointScreen();
  return mainScreen();
}

// ---------------- onboarding ----------------

function welcome() {
  render(
    h("div", { class: "stack" },
      h("div", { class: "hero" }, h("span", { class: "wordmark" }, "NEXUS"), h("p", { class: "muted" }, "non-custodial. keys never leave this device.")),
      h("button", { class: "block", onclick: createFlow }, "Create wallet"),
      h("button", { class: "btn block", onclick: importFlow }, "Import"),
    ),
  );
}

function passwordFields(): { node: El; get: () => string | null } {
  const p1 = h("input", { type: "password", placeholder: "password (min 8)" }) as HTMLInputElement;
  const p2 = h("input", { type: "password", placeholder: "confirm password" }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  const node = h("div", { class: "stack" }, p1, p2, err);
  return {
    node,
    get() {
      if (p1.value.length < 8) { err.textContent = "Password must be at least 8 characters."; return null; }
      if (p1.value !== p2.value) { err.textContent = "Passwords do not match."; return null; }
      return p1.value;
    },
  };
}

function createFlow() {
  const pw = passwordFields();
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Set a password"),
      h("p", { class: "muted" }, "Encrypts your wallet on this device. There is no recovery if you forget it."),
      pw.node,
      h("button", { class: "block", onclick: () => { const p = pw.get(); if (p) showMnemonic(p); } }, "Continue"),
      h("button", { class: "btn block", onclick: welcome }, "Back"),
    ),
  );
}

function showMnemonic(password: string) {
  const phrase = newMnemonic(128);
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Recovery phrase"),
      h("p", { class: "warn" }, "Write these 12 words down, in order, and keep them offline. Anyone with them controls your funds."),
      h("div", { class: "mnemonic" }, phrase),
      h("button", { class: "block", onclick: async () => { const r = await wallet.create(password, { mnemonic: phrase }); if (r.ok) { st = r.state; route(); } } }, "I saved it — create"),
      h("button", { class: "btn block", onclick: createFlow }, "Back"),
    ),
  );
}

function importFlow() {
  const pw = passwordFields();
  const ta = h("textarea", { placeholder: "12/24-word recovery phrase, or a 32-byte (64-hex) private key", spellcheck: "false" }) as HTMLTextAreaElement;
  const err = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Import"),
      pw.node, ta, err,
      h("button", { class: "block", onclick: async () => {
        const p = pw.get(); if (!p) return;
        const raw = ta.value.trim();
        let opts: { mnemonic?: string; privHex?: string };
        if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) opts = { privHex: raw };
        else if (isValidMnemonic(raw)) opts = { mnemonic: raw };
        else { err.textContent = "Not a valid recovery phrase or 32-byte key."; return; }
        const r = await wallet.create(p, opts);
        if (r.ok) { st = r.state; route(); } else err.textContent = r.error;
      } }, "Import"),
      h("button", { class: "btn block", onclick: welcome }, "Back"),
    ),
  );
}

function unlockScreen() {
  const p = h("input", { type: "password", placeholder: "password", autofocus: "true" }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  const submit = async () => { const r = await wallet.unlock(p.value); if (r.ok) { st = r.state; route(); } else err.textContent = r.error; };
  p.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
  render(
    h("div", { class: "stack" },
      h("div", { class: "hero" }, h("span", { class: "wordmark" }, "NEXUS")),
      h("h1", {}, "Unlock"),
      p, err,
      h("button", { class: "block", onclick: submit }, "Unlock"),
    ),
  );
}

// ---------------- node endpoint (no default) ----------------

/** Ask for host permission (must run inside the click), then check the node serves this chain. */
async function chooseEndpoint(url: string, source: ChosenEndpoint["source"], err: El, declaredSubmit = true): Promise<boolean> {
  const granted = await chrome.permissions.request({ origins: [originPattern(url)] }).catch(() => false);
  if (!granted) { err.textContent = "Permission to reach that node was not granted."; return false; }
  err.textContent = "checking…";
  try {
    const info = await reader(url, chainPath()).chainInfo();
    if (info.chain.join("/") !== settings.chain) { err.textContent = `That node answers for ${info.chain.join("/")}, not ${settings.chain}.`; return false; }
    await update((s) => ({ ...s, endpoints: { ...s.endpoints, [s.chain]: { url, acceptsSubmit: declaredSubmit && info.acceptsSubmit === true, source } } }));
    return true;
  } catch (e) {
    err.textContent = "That node does not serve " + settings.chain + ": " + describe(e);
    return false;
  }
}

function endpointScreen() {
  const current = endpoint();
  const url = h("input", { type: "text", placeholder: "your node, e.g. http://127.0.0.1:8080", spellcheck: "false", value: current?.url ?? "" }) as HTMLInputElement;
  const start = h("input", { type: "text", placeholder: "a Nexus node you trust to start from", spellcheck: "false" }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  const found = h("div", { class: "kv" });
  const isChild = chainPath().length > 1;
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Node for " + settings.chain),
      h("p", { class: "muted" }, "The wallet has no default node. Use your own node (its loopback API accepts your submits), or an endpoint whose operator chose to accept public submits."),
      url,
      h("button", { class: "block", onclick: async () => {
        const n = normalizeNodeURL(url.value);
        if (!n) { err.textContent = "Enter an https:// URL (http:// only for 127.0.0.1/localhost)."; return; }
        if (await chooseEndpoint(n, "user", err)) route();
      } }, "Use this node"),
      ...(isChild ? [
        h("p", { class: "muted" }, "Or discover endpoints for " + settings.chain + " through a Nexus node you choose:"),
        start,
        h("button", { class: "btn block", onclick: () => discoverFrom() }, "Discover"),
        found,
      ] : []),
      err,
      ...(current ? [h("button", { class: "btn block", onclick: mainScreen }, "Back")] : []),
      h("button", { class: "btn block", onclick: chainScreen }, "Change chain"),
    ),
  );

  async function discoverFrom() {
    const n = normalizeNodeURL(start.value);
    if (!n) { err.textContent = "Enter the starting node's URL."; return; }
    // Discovery may reach any declared host: ask for broad reach once, in this click.
    const granted = await chrome.permissions.request({ origins: [originPattern(n), "https://*/*"] }).catch(() => false);
    if (!granted) { err.textContent = "Permission not granted."; return; }
    err.textContent = "discovering…";
    found.replaceChildren();
    try {
      const list = await discover(n, chainPath());
      err.textContent = list.length ? "" : "No endpoint served the block its parent commits.";
      for (const e of list) {
        found.append(h("div", { class: "row" },
          h("span", { class: "v mono" }, short(e.url)),
          h("span", { class: "tag" }, e.declaresSubmit ? "declares submit" : "read-only"),
          h("button", { class: "btn", onclick: async () => { if (await chooseEndpoint(e.url, "discovered", err, e.declaresSubmit)) route(); } }, "Use"),
        ));
      }
      if (list.length) found.append(h("p", { class: "muted" }, `Each served the block its parent commits; ${OPERATOR_DECLARED}.`));
    } catch (e) {
      err.textContent = "Discovery failed: " + (e instanceof RangeError ? e.message : describe(e));
    }
  }
}

function chainScreen() {
  const add = h("input", { type: "text", placeholder: "chain path, e.g. Nexus/testnet", spellcheck: "false" }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  const pick = async (chain: string) => { await update((s) => ({ ...s, chain })); route(); };
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Chain"),
      h("div", { class: "kv" }, ...settings.chains.map((c) => h("div", { class: "row" },
        h("span", { class: "v mono" }, c),
        h("span", { class: "k" }, settings.endpoints[c] ? short(settings.endpoints[c].url) : "no node"),
        h("button", { class: "btn", onclick: () => pick(c) }, c === settings.chain ? "Selected" : "Select"),
      ))),
      add,
      h("button", { class: "btn block", onclick: async () => {
        const path = parseChainPath(add.value);
        if (!path) { err.textContent = "A chain path starts with Nexus, e.g. Nexus/testnet."; return; }
        const key = path.join("/");
        await update((s) => ({ ...s, chains: s.chains.includes(key) ? s.chains : [...s.chains, key] }));
        await pick(key);
      } }, "Add chain"),
      err,
      ...(endpoint() ? [h("button", { class: "btn block", onclick: endpointScreen }, "Change node for " + settings.chain)] : []),
      h("button", { class: "btn block", onclick: route }, "Back"),
    ),
  );
}

// ---------------- main ----------------

async function mainScreen() {
  const acct = activeAccount();
  if (!acct) return render(h("div", { class: "stack" }, h("p", { class: "muted" }, "No active account."), h("button", { class: "btn block", onclick: () => { wallet.lock().then(refresh); } }, "Lock")));
  const balanceV = h("span", { class: "v" }, "…");
  const nodeV = endpoint()!;
  const toast = h("div", { class: "toast" });

  const accountPicker = h("select", { class: "picker", onchange: async (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === "__add") { await wallet.addAccount(); await refresh(); return; }
    if (v === "__import") return importKeyFlow();
    await wallet.setActive(v); await refresh();
  } }) as HTMLSelectElement;
  for (const a of st.accounts) accountPicker.append(h("option", { value: a.address, ...(a.address === acct.address ? { selected: "true" } : {}) }, `${a.label} · ${short(a.address)}`));
  accountPicker.append(h("option", { value: "__add" }, "+ Add account"));
  accountPicker.append(h("option", { value: "__import" }, "+ Import key"));

  render(
    h("div", { class: "stack" },
      accountPicker,
      h("div", { class: "kv" },
        h("div", { class: "row" }, h("span", { class: "k" }, "Balance"), balanceV),
        h("div", { class: "row" }, h("span", { class: "k" }, acct.kind === "imported" ? "Imported" : "Account"), h("span", { class: "v mono" }, short(acct.address))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Node"), h("span", { class: "v mono" }, short(nodeV.url)),
          h("span", { class: "tag" }, nodeV.acceptsSubmit ? "submit" : "read-only")),
      ),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", onclick: sendFlow }, "Send"),
        h("button", { class: "btn", onclick: receiveScreen }, "Receive"),
        h("button", { class: "btn", onclick: () => loadBalance() }, "Refresh"),
      ),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", onclick: historyScreen }, "Sent"),
        h("button", { class: "btn", onclick: endpointScreen }, "Node"),
        h("button", { class: "btn", onclick: feeScreen }, "Fee"),
        h("button", { class: "btn", onclick: async () => { await wallet.lock(); await refresh(); } }, "Lock"),
      ),
      toast,
    ),
  );

  async function loadBalance() {
    balanceV.textContent = "…";
    try {
      const { balance } = await client().account(acct!.address);
      balanceV.textContent = balance.toLocaleString();
    } catch (e) { balanceV.textContent = describe(e); }
  }
  loadBalance();
}

function receiveScreen() {
  const acct = activeAccount()!;
  const toast = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Receive"),
      h("p", { class: "muted" }, "Share this address to receive funds on " + settings.chain + "."),
      h("div", { class: "addr mono" }, acct.address),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", onclick: async () => { await navigator.clipboard.writeText(acct.address); toast.textContent = "copied"; setTimeout(() => (toast.textContent = ""), 1500); } }, "Copy"),
        h("button", { class: "btn", onclick: mainScreen }, "Back"),
      ),
      toast,
    ),
  );
}

async function importKeyFlow() {
  const inp = h("input", { type: "text", placeholder: "32-byte (64-hex) private key", spellcheck: "false" }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Import key"),
      inp, err,
      h("button", { class: "block", onclick: async () => { const r = await wallet.importKey(inp.value.trim()); if (r.ok) { st = r.state; route(); } else err.textContent = r.error; } }, "Import"),
      h("button", { class: "btn block", onclick: mainScreen }, "Back"),
    ),
  );
}

// ---------------- send ----------------

async function sendFlow() {
  const acct = activeAccount()!;
  const to = h("input", { type: "text", placeholder: "recipient address (bafy…)", spellcheck: "false" }) as HTMLInputElement;
  const amount = h("input", { type: "text", inputmode: "numeric", placeholder: "amount (units)" }) as HTMLInputElement;
  // No estimate service: the fee is the user's, starting at this chain's default.
  const fee = h("input", { type: "text", inputmode: "numeric", value: defaultFee(settings, settings.chain) }) as HTMLInputElement;
  const feeNote = h("div", { class: "warn" });
  const err = h("div", { class: "toast" });
  const submitOK = endpoint()!.acceptsSubmit;
  // The chosen endpoint's relay floor (its policy): read once, warned against, never applied.
  let minRelayFee: bigint | undefined;
  const checkFee = () => {
    const f = parseFee(fee.value);
    feeNote.textContent = f === null ? "" : feeWarning(f, minRelayFee) ?? "";
  };
  fee.addEventListener("input", checkFee);
  client().chainInfo().then((info) => { minRelayFee = info.minRelayFee; checkFee(); }).catch(() => {});
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Send on " + settings.chain),
      ...(submitOK ? [] : [h("p", { class: "warn" }, "This node does not accept submits. Use your own node, or an endpoint whose operator accepts public submits.")]),
      h("label", { class: "k" }, "To"), to,
      h("label", { class: "k" }, "Amount"), amount,
      h("label", { class: "k" }, "Fee (paid to the miner)"), fee, feeNote,
      err,
      ...(submitOK ? [h("button", { class: "block", onclick: () => prepareReview() }, "Review")] : []),
      h("button", { class: "btn block", onclick: mainScreen }, "Cancel"),
    ),
  );

  async function prepareReview() {
    err.textContent = "";
    const toAddr = to.value.trim();
    if (!/^bafy[a-z2-7]+$/.test(toAddr)) { err.textContent = "Enter a valid recipient address."; return; }
    if (toAddr === acct.address) { err.textContent = "That is this account."; return; }
    let amt: bigint, f: bigint;
    try { amt = BigInt(amount.value.trim()); if (amt <= 0n) throw 0; } catch { err.textContent = "Enter a whole, positive amount."; return; }
    const parsedFee = parseFee(fee.value);
    if (parsedFee === null) { err.textContent = "Enter a whole fee of 0 or more."; return; }
    f = parsedFee;
    err.textContent = "reading account…";
    let nonce: bigint, balance: bigint;
    try {
      const [a, info] = await Promise.all([client().account(acct.address), client().chainInfo()]);
      nonce = a.nonce; balance = a.balance; minRelayFee = info.minRelayFee;
    } catch (e) { err.textContent = describe(e); return; }
    if (amt + f > balance) { err.textContent = `Insufficient balance (have ${fmt(balance.toString())}, need ${fmt((amt + f).toString())}).`; return; }
    reviewScreen(toAddr, amt, f, nonce, minRelayFee);
  }
}

function reviewScreen(to: string, amount: bigint, fee: bigint, nonce: bigint, minRelayFee: bigint | undefined) {
  const acct = activeAccount()!;
  const toast = h("div", { class: "toast" });
  const warning = feeWarning(fee, minRelayFee);
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Review"),
      h("div", { class: "kv" },
        h("div", { class: "row" }, h("span", { class: "k" }, "From"), h("span", { class: "v mono" }, short(acct.address))),
        h("div", { class: "row" }, h("span", { class: "k" }, "To"), h("span", { class: "v mono" }, short(to))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Amount"), h("span", { class: "v" }, fmt(amount.toString()))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Fee"), h("span", { class: "v" }, fmt(fee.toString()))),
        ...(minRelayFee === undefined ? [] : [h("div", { class: "row" }, h("span", { class: "k" }, "Node minimum"), h("span", { class: "v" }, fmt(minRelayFee.toString())))]),
        h("div", { class: "row" }, h("span", { class: "k" }, "Total"), h("span", { class: "v" }, fmt((amount + fee).toString()))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Nonce"), h("span", { class: "v" }, String(nonce))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Chain"), h("span", { class: "tag" }, settings.chain)),
        h("div", { class: "row" }, h("span", { class: "k" }, "Node"), h("span", { class: "v mono" }, short(endpoint()!.url))),
      ),
      h("div", { class: "addr mono" }, "To (full): " + to),
      ...(warning ? [h("p", { class: "warn" }, warning)] : []),
      toast,
      h("button", { class: "block", onclick: confirm }, "Sign & send"),
      h("button", { class: "btn block", onclick: mainScreen }, "Cancel"),
    ),
  );

  async function confirm() {
    toast.textContent = "signing…";
    const signed = await wallet.signTransfer({ from: acct.address, to, amount: amount.toString(), fee: fee.toString(), nonce: nonce.toString(), chainPath: chainPath() });
    if (!signed.ok) { toast.textContent = signed.error; return; }
    toast.textContent = "submitting…";
    try {
      const answer = await submitter(endpoint()!.url).submit(signed.signedSubmit.payload);
      const chain = settings.chain;
      await update((s) => recordSent(s, chain, {
        cid: answer.transactionCID, to, amount: amount.toString(), at: Date.now(),
        from: acct.address, fee: fee.toString(), nonce: nonce.toString(),
      }));
      sentScreen(answer.transactionCID);
    } catch (e) { toast.textContent = describe(e); }
  }
}

function sentScreen(txCID: string) {
  const toast = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Sent"),
      h("p", { class: "muted" }, "Admitted to the node's pool (pending). See Sent for its block once mined."),
      h("label", { class: "k" }, "Transaction"), h("div", { class: "addr mono" }, txCID),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", onclick: async () => { await navigator.clipboard.writeText(txCID); toast.textContent = "copied"; setTimeout(() => (toast.textContent = ""), 1500); } }, "Copy"),
        h("button", { class: "btn", onclick: mainScreen }, "Done"),
      ),
      toast,
    ),
  );
}

/** What this wallet sent on this chain, with each transaction's status from the node. */
async function historyScreen() {
  const sent = settings.sent[settings.chain] ?? [];
  const list = h("div", { class: "kv" });
  const lookup = h("input", { type: "text", placeholder: "look up a transaction CID", spellcheck: "false" }) as HTMLInputElement;
  const found = h("div", { class: "toast" });
  render(h("div", { class: "stack" },
    h("h1", {}, "Sent on " + settings.chain), list,
    lookup,
    h("button", { class: "btn block", onclick: async () => { found.textContent = await status(lookup.value.trim()); } }, "Look up"),
    found,
    h("button", { class: "btn block", onclick: mainScreen }, "Back"),
  ));
  if (!sent.length) list.append(h("div", { class: "row" }, h("span", { class: "muted" }, "Nothing sent from this wallet yet.")));
  for (const t of sent) {
    const s = h("span", { class: "k" }, "…");
    list.append(h("div", { class: "row" }, h("span", { class: "v mono" }, short(t.cid)), h("span", { class: "v" }, fmt(t.amount)), s));
    const recorded = t.from && t.nonce ? { from: t.from, nonce: BigInt(t.nonce) } : undefined;
    status(t.cid, recorded).then((text) => (s.textContent = text));
  }

  async function status(cid: string, recorded?: { from: string; nonce: bigint }): Promise<string> {
    try {
      return statusText(await sentStatus(client(), cid, recorded));
    } catch (e) {
      return describe(e);
    }
  }
}

// ---------------- fee default ----------------

/** The fee a new send on this chain starts with. Every send can still change it. */
function feeScreen() {
  const input = h("input", { type: "text", inputmode: "numeric", value: defaultFee(settings, settings.chain) }) as HTMLInputElement;
  const note = h("div", { class: "warn" });
  const err = h("div", { class: "toast" });
  let minRelayFee: bigint | undefined;
  const check = () => { const f = parseFee(input.value); note.textContent = f === null ? "" : feeWarning(f, minRelayFee) ?? ""; };
  input.addEventListener("input", check);
  client().chainInfo().then((info) => { minRelayFee = info.minRelayFee; check(); }).catch(() => {});
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Default fee on " + settings.chain),
      h("p", { class: "muted" }, "Paid to the miner as the debit over the credit. There is no estimate: you choose it, and you can change it on each send."),
      input, note, err,
      h("button", { class: "block", onclick: async () => {
        const f = parseFee(input.value);
        if (f === null) { err.textContent = "Enter a whole fee of 0 or more."; return; }
        const chain = settings.chain;
        await update((s) => ({ ...s, fees: { ...s.fees, [chain]: f.toString() } }));
        mainScreen();
      } }, "Save"),
      h("button", { class: "btn block", onclick: mainScreen }, "Back"),
    ),
  );
}

// ---------------- chain switch + boot ----------------

document.getElementById("net-badge")!.addEventListener("click", () => {
  if (st.initialized && !st.locked) chainScreen();
});

refresh();
