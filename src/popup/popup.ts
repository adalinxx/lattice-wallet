// Nexus Wallet popup. Talks only to the background signer (key material never
// enters this context) and to the node RPC for reads/submit. Styled with the
// Lattice design system.

import { wallet } from "../lib/wallet/client.ts";
import { newMnemonic, isValidMnemonic } from "../lib/crypto/accounts.ts";
import { RpcClient } from "../lib/rpc/client.ts";
import { NETWORKS } from "../lib/config.ts";
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

let st: WalletState = { initialized: false, locked: true, network: "mainnet", accounts: [], active: null };

function syncBadge() {
  const b = document.getElementById("net-badge")!;
  b.textContent = st.network.toUpperCase();
  b.classList.toggle("testnet", st.network === "testnet");
}
const activeAccount = (): AccountView | undefined => st.accounts.find((a) => a.address === st.active);

async function refresh() {
  const r = await wallet.getState();
  if (r.ok) st = r.state;
  syncBadge();
  route();
}

function route() {
  if (!st.initialized) return welcome();
  if (st.locked) return unlockScreen();
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
      h("button", { class: "block", onclick: async () => { const r = await wallet.create(password, { mnemonic: phrase, network: st.network }); if (r.ok) { st = r.state; route(); } } }, "I saved it — create"),
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
        const r = await wallet.create(p, { ...opts, network: st.network });
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

// ---------------- main ----------------

async function mainScreen() {
  const acct = activeAccount();
  if (!acct) return; // shouldn't happen
  const balanceV = h("span", { class: "v" }, "…");
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
      ),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", onclick: sendFlow }, "Send"),
        h("button", { class: "btn", onclick: receiveScreen }, "Receive"),
        h("button", { class: "btn", onclick: () => loadBalance() }, "Refresh"),
      ),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", onclick: historyScreen }, "History"),
        h("button", { class: "btn", onclick: async () => { await wallet.lock(); await refresh(); } }, "Lock"),
      ),
      toast,
    ),
  );

  async function loadBalance() {
    balanceV.textContent = "…";
    try {
      const { balance } = await RpcClient.for(st.network).balance(acct!.address);
      balanceV.textContent = fmt(balance);
    } catch { balanceV.textContent = "unreachable"; }
  }
  loadBalance();
}

function receiveScreen() {
  const acct = activeAccount()!;
  const toast = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Receive"),
      h("p", { class: "muted" }, "Share this address to receive funds on " + NETWORKS[st.network].label + "."),
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
  const err = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Send"),
      h("label", { class: "k" }, "To"), to,
      h("label", { class: "k" }, "Amount"), amount,
      err,
      h("button", { class: "block", onclick: () => prepareReview() }, "Review"),
      h("button", { class: "btn block", onclick: mainScreen }, "Cancel"),
    ),
  );

  async function prepareReview() {
    err.textContent = "";
    const toAddr = to.value.trim();
    if (!/^bafy[a-z2-7]+$/.test(toAddr)) { err.textContent = "Enter a valid recipient address."; return; }
    let amt: bigint;
    try { amt = BigInt(amount.value.trim()); if (amt <= 0n) throw 0; } catch { err.textContent = "Enter a whole, positive amount."; return; }
    err.textContent = "estimating…";
    const rpc = RpcClient.for(st.network);
    let fee = 1n, nonce = 0n, balance = 0n;
    try {
      const [f, n, b] = await Promise.all([rpc.feeEstimate(5).catch(() => ({ fee: 1 })), rpc.nonce(acct.address), rpc.balance(acct.address)]);
      fee = BigInt(Math.max(1, Number(f.fee))); nonce = BigInt(n.nonce); balance = BigInt(b.balance);
    } catch { err.textContent = "Node unreachable — try again."; return; }
    if (amt + fee > balance) { err.textContent = `Insufficient balance (have ${fmt(balance.toString())}, need ${fmt((amt + fee).toString())}).`; return; }
    reviewScreen(toAddr, amt, fee, nonce);
  }
}

function reviewScreen(to: string, amount: bigint, fee: bigint, nonce: bigint) {
  const acct = activeAccount()!;
  const toast = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Review"),
      h("div", { class: "kv" },
        h("div", { class: "row" }, h("span", { class: "k" }, "From"), h("span", { class: "v mono" }, short(acct.address))),
        h("div", { class: "row" }, h("span", { class: "k" }, "To"), h("span", { class: "v mono" }, short(to))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Amount"), h("span", { class: "v" }, fmt(amount.toString()))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Fee"), h("span", { class: "v" }, fmt(fee.toString()))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Total"), h("span", { class: "v" }, fmt((amount + fee).toString()))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Nonce"), h("span", { class: "v" }, String(nonce))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Network"), h("span", { class: "tag" }, st.network)),
      ),
      h("div", { class: "addr mono" }, "To (full): " + to),
      toast,
      h("button", { class: "block", onclick: confirm }, "Sign & send"),
      h("button", { class: "btn block", onclick: mainScreen }, "Cancel"),
    ),
  );

  async function confirm() {
    toast.textContent = "signing…";
    const signed = await wallet.signTransfer({ from: acct.address, to, amount: amount.toString(), fee: fee.toString(), nonce: nonce.toString(), chainPath: [NETWORKS[st.network].chainPath] });
    if (!signed.ok) { toast.textContent = signed.error; return; }
    toast.textContent = "submitting…";
    try {
      const res = await RpcClient.for(st.network).submit(signed.signedSubmit);
      if (res.accepted) sentScreen(res.txCID ?? signed.signedSubmit.bodyCID);
      else toast.textContent = "Rejected: " + (res.error ?? "unknown");
    } catch (e) { toast.textContent = "Submit failed: " + (e as Error).message; }
  }
}

function sentScreen(txCID: string) {
  const toast = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Sent"),
      h("p", { class: "muted" }, "Transaction submitted. It will appear once mined."),
      h("label", { class: "k" }, "Transaction"), h("div", { class: "addr mono" }, txCID),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", onclick: async () => { await navigator.clipboard.writeText(txCID); toast.textContent = "copied"; setTimeout(() => (toast.textContent = ""), 1500); } }, "Copy"),
        h("button", { class: "btn", onclick: mainScreen }, "Done"),
      ),
      toast,
    ),
  );
}

async function historyScreen() {
  const acct = activeAccount()!;
  const list = h("div", { class: "kv" }, h("div", { class: "row" }, h("span", { class: "muted" }, "loading…")));
  render(h("div", { class: "stack" }, h("h1", {}, "History"), list, h("button", { class: "btn block", onclick: mainScreen }, "Back")));
  try {
    const { transactions } = await RpcClient.for(st.network).history(acct.address, 25);
    list.replaceChildren(
      ...(transactions.length
        ? transactions.map((t) => h("div", { class: "row" }, h("span", { class: "v mono" }, short(t.txCID)), h("span", { class: "k" }, "#" + fmt(t.height))))
        : [h("div", { class: "row" }, h("span", { class: "muted" }, "No transactions yet."))]),
    );
  } catch { list.replaceChildren(h("div", { class: "row" }, h("span", { class: "muted" }, "Node unreachable."))); }
}

// ---------------- network switch + boot ----------------

document.getElementById("net-badge")!.addEventListener("click", async () => {
  const next = st.network === "mainnet" ? "testnet" : "mainnet";
  await wallet.setNetwork(next);
  await refresh();
});

refresh();
