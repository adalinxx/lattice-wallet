// Nexus Wallet popup (v0 vertical slice). Demonstrates the Lattice design system
// and exercises the proven crypto core + RPC. NOTE: v0 keeps the account in
// memory only — encrypted persistence and the background signer land next
// (tasks: keystore, service worker). No keys are written anywhere yet.

import { newMnemonic, deriveAccount, importPrivateKey, isValidMnemonic, type Account } from "../lib/crypto/accounts.ts";
import { RpcClient } from "../lib/rpc/client.ts";
import { type NetworkId, NETWORKS } from "../lib/config.ts";

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
const short = (s: string) => (s.length <= 20 ? s : `${s.slice(0, 10)}…${s.slice(-8)}`);

const state: { network: NetworkId; account: Account | null } = { network: "mainnet", account: null };

const view = () => document.getElementById("view")!;
function render(node: El) {
  view().replaceChildren(node);
}
function syncBadge() {
  const badge = document.getElementById("net-badge")!;
  badge.textContent = state.network.toUpperCase();
  badge.classList.toggle("testnet", state.network === "testnet");
}

// ---- views ----

function welcome() {
  render(
    h("div", { class: "stack" },
      h("div", { class: "hero" },
        h("span", { class: "wordmark" }, "NEXUS"),
        h("p", { class: "muted" }, "non-custodial. keys never leave this device."),
      ),
      h("button", { class: "block", onclick: createFlow }, "Create wallet"),
      h("button", { class: "btn block", onclick: importFlow }, "Import"),
      h("p", { class: "muted center" }, "v0 — keys held in memory only (persistence next)"),
    ),
  );
}

function createFlow() {
  const phrase = newMnemonic(128);
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Recovery phrase"),
      h("p", { class: "warn" }, "Write these 12 words down and keep them offline. Anyone with them controls your funds."),
      h("div", { class: "mnemonic" }, phrase),
      h("button", { class: "block", onclick: () => openAccount(deriveAccount(phrase, 0)) }, "I saved it — continue"),
      h("button", { class: "btn block", onclick: welcome }, "Back"),
    ),
  );
}

function importFlow() {
  const ta = h("textarea", { placeholder: "12/24-word recovery phrase, or a 32-byte (64-hex) private key", spellcheck: "false" }) as HTMLTextAreaElement;
  const err = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Import"),
      ta,
      err,
      h("button", {
        class: "block",
        onclick: () => {
          const raw = ta.value.trim();
          try {
            if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) openAccount(importPrivateKey(raw));
            else if (isValidMnemonic(raw)) openAccount(deriveAccount(raw, 0));
            else err.textContent = "Not a valid recovery phrase or 32-byte key.";
          } catch (e) {
            err.textContent = (e as Error).message;
          }
        },
      }, "Import"),
      h("button", { class: "btn block", onclick: welcome }, "Back"),
    ),
  );
}

function openAccount(account: Account) {
  state.account = account;
  main();
}

async function main() {
  const acct = state.account!;
  const toast = h("div", { class: "toast" });
  const balanceV = h("span", { class: "v" }, "…");
  const root = h("div", { class: "stack" },
    h("div", { class: "kv" },
      h("div", { class: "row" }, h("span", { class: "k" }, "Account"), h("span", { class: "v mono" }, short(acct.address), acct.index < 0 ? " " : "")),
      h("div", { class: "row" }, h("span", { class: "k" }, "Balance"), balanceV),
    ),
    h("div", {},
      h("p", { class: "k", style: "margin-bottom:var(--s-1)" }, acct.index < 0 ? "Imported address" : "Receive address"),
      h("div", { class: "addr mono" }, acct.address),
    ),
    h("div", { class: "row-actions" },
      h("button", { class: "btn", onclick: async () => { await navigator.clipboard.writeText(acct.address); toast.textContent = "address copied"; setTimeout(() => (toast.textContent = ""), 1500); } }, "Copy"),
      h("button", { class: "btn", onclick: () => loadBalance() }, "Refresh"),
      h("button", { class: "btn", onclick: () => { state.account = null; welcome(); } }, "Lock"),
    ),
    toast,
    h("p", { class: "muted" }, "Send + history land with the background signer. v0 is receive + balance."),
  );
  render(root);

  async function loadBalance() {
    balanceV.textContent = "…";
    try {
      const rpc = RpcClient.for(state.network);
      const { balance } = await rpc.balance(acct.address);
      balanceV.textContent = Number(balance).toLocaleString();
    } catch {
      balanceV.textContent = "unreachable";
    }
  }
  loadBalance();
}

// ---- network switch ----

document.getElementById("net-badge")!.addEventListener("click", () => {
  state.network = state.network === "mainnet" ? "testnet" : "mainnet";
  syncBadge();
  if (state.account) main();
});

// ---- boot ----
syncBadge();
welcome();

// expose for sanity in devtools (no secrets)
void NETWORKS;
