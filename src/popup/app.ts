// Nexus Wallet UI, shared by the extension popup and the desktop app. Talks
// only to the signer (key material never enters this module) and to the node
// the user chose for reads/submit. There is no default node. Styled with the
// Lattice design system. The host supplies a Platform: signer, settings
// store, network permission, and optionally its own node.

import type { Fetch } from "@adalinxx/lattice-client";
import { nodeCookieAuthorization } from "@adalinxx/lattice-core";
import type { WalletClient } from "../lib/wallet/client.ts";
import { newMnemonic, isValidMnemonic, keyFilePrivateKey } from "../lib/crypto/accounts.ts";
import { reader, submitter, submitChecked, CIDMismatchError, discover, describe, feeWarning, sentStatus, statusText, OPERATOR_DECLARED } from "../lib/wallet/node.ts";
import { LATTICE_BUILD_RPC, LATTICE_EXPLORER_RPC, ROOT_CHAIN, parseChainPath, normalizeNodeURL, originPattern } from "../lib/config.ts";
import { loadSettings, saveSettings, recordOpenDeposit, recordSent, defaultFee, parseFee, type Settings, type ChosenEndpoint, type KeyValueStore } from "../lib/wallet/settings.ts";
import type { WalletState, AccountView } from "../lib/wallet/types.ts";
import { decodeOrderRequest, type SellOrder } from "../lib/wallet/order.ts";
import { backupMenu, restoreMenu, type BackupHost } from "./backup.ts";
import { scanner } from "./scanner.ts";

export interface Platform {
  /** The signer: the extension's background worker, or the desktop app's in-page signer. */
  wallet: WalletClient;
  /** Where non-secret settings live. */
  store: KeyValueStore;
  /** Ask for network reach to these origin patterns (inside the user's click). */
  requestOrigins(origins: string[]): Promise<boolean>;
  /**
   * The host's own node (its loopback operator URL), when it runs one: every
   * chain then reads and submits through it, and no endpoint is chosen. A
   * stopped node reads as unreachable, like any other.
   */
  ownNode?: string;
  /** The fetch every node call uses (default: the browser's). */
  fetch?: Fetch;
  /** Extra main-screen actions (the desktop's node panel); `back` re-renders the wallet. */
  actions?: { label: string; run(back: () => void): void }[];
  /** Offer a file picker for CLI key files (an extension popup closes on one). */
  keyFilePicker?: boolean;
  /**
   * This UI's browser origin (the extension's `chrome-extension://<id>`), when
   * it can pair with a local node: the node must list it in rpcAllowedOrigins
   * and the user pastes the node's cookie.
   */
  pairOrigin?: string;
  /**
   * The host's chain list, when it has one of its own (the desktop: the
   * chains its node hosts). The wallet then lists exactly these, and adding
   * a chain adds it there (the host may restart its node), instead of
   * keeping a list of its own.
   */
  chains?: { list(): Promise<string[]>; add(chain: string): Promise<void> };
  /** This page may open the camera (an extension popup cannot hold the permission). */
  camera?: boolean;
  /** Reopen a backup flow in a full page (the extension: a tab, for camera, files and print). */
  openFullPage?(view: "backup" | "restore"): void;
  /** Start in this flow (the full page the popup opened). */
  initialView?: "backup" | "restore";
  /** Save a text file (default: a browser download); resolves to where it went. */
  saveFile?(name: string, text: string): Promise<string | void>;
  /** Print the page (default: window.print). */
  print?(): void;
}

type El = HTMLElement;
export const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null)[]): El => {
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
// Exact: amounts are UInt64, never rounded through a double.
const fmt = (n: string | bigint) => BigInt(n).toLocaleString();
const view = () => document.getElementById("view")!;
export const render = (node: El) => view().replaceChildren(node);

let st: WalletState = { initialized: false, locked: true, accounts: [], active: null };
let settings: Settings;
let platform: Platform;
let wallet: WalletClient;
let store: KeyValueStore;
const chainPath = () => parseChainPath(settings.chain) ?? [ROOT_CHAIN];
// The operator route of the host's own node accepts its owner's submits.
const endpoint = (): ChosenEndpoint | undefined =>
  platform.ownNode ? { url: platform.ownNode, acceptsSubmit: true, source: "user" } : settings.endpoints[settings.chain];
// The chosen node's cookie header when the user paired it (its operator port requires one).
let nodeAuth: string | undefined;
const client = () => reader(endpoint()!.url, chainPath(), platform.fetch, nodeAuth);
async function authorizationFor(url: string): Promise<string | undefined> {
  if (platform.ownNode) return undefined; // the host attaches its own node's cookie
  const r = await wallet.nodeAuthorization(url);
  return r.ok ? r.authorization : undefined;
}
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

export async function refresh() {
  const r = await wallet.getState();
  if (r.ok) st = r.state;
  settings = await loadSettings(store);
  syncBadge();
  route();
}

function backupHost(): BackupHost {
  return {
    wallet, camera: platform.camera === true, openFullPage: platform.openFullPage,
    saveFile: platform.saveFile, print: platform.print,
    state: () => st,
    back: route,
    done: (state) => { st = state; route(); },
  };
}

/** Backup flows open in a full page where the host has one (the popup cannot hold the camera). */
function openBackup(view: "backup" | "restore") {
  if (platform.openFullPage && !platform.camera) return platform.openFullPage(view);
  return view === "backup" ? backupMenu(backupHost()) : restoreMenu(backupHost());
}

let initialView: Platform["initialView"];
function route() {
  const start = initialView;
  initialView = undefined;
  if (start === "restore" && !st.initialized) return restoreMenu(backupHost());
  if (start === "backup" && st.initialized && !st.locked) return backupMenu(backupHost());
  if (start === "backup" && st.locked) initialView = start; // after unlock
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
      h("button", { class: "btn block", onclick: restoreChoice }, "Restore or import"),
    ),
  );
}

function restoreChoice() {
  render(h("div", { class: "stack" },
    h("h1", {}, "Restore wallet"),
    h("p", { class: "muted" }, "Choose the recovery method you already have."),
    h("button", { class: "block", onclick: importFlow }, "Recovery phrase or private key"),
    h("button", { class: "btn block", onclick: () => openBackup("restore") }, "Backup, SeedQR or another device"),
    h("button", { class: "btn block", onclick: welcome }, "Back"),
  ));
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
  const ta = h("textarea", { placeholder: "12/24-word recovery phrase, a 32-byte (64-hex) private key, or a key file", spellcheck: "false" }) as HTMLTextAreaElement;
  const err = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Import"),
      pw.node, ta, ...keyFilePicker(ta), err,
      h("button", { class: "block", onclick: async () => {
        const p = pw.get(); if (!p) return;
        const raw = ta.value.trim();
        let opts: { mnemonic?: string; privHex?: string };
        if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) opts = { privHex: raw };
        else if (isValidMnemonic(raw)) opts = { mnemonic: raw };
        else if (raw.startsWith("{")) {
          try { opts = { privHex: keyFilePrivateKey(raw) }; } catch (e) { err.textContent = (e as Error).message; return; }
        } else { err.textContent = "Not a valid recovery phrase, 32-byte key, or key file."; return; }
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

function actionButtons(): El[] {
  return (platform.actions ?? []).map((a) => h("button", { class: "btn block", onclick: () => a.run(route) }, a.label));
}

/** Ask for host permission (must run inside the click), then check the node serves this chain. */
async function chooseEndpoint(url: string, source: ChosenEndpoint["source"], err: El, declaredSubmit = true, cookie?: string, requireSubmit = false): Promise<boolean> {
  const granted = await platform.requestOrigins([originPattern(url)]).catch(() => false);
  if (!granted) { err.textContent = "Permission to reach that node was not granted."; return false; }
  let authorization: string | undefined;
  try {
    authorization = cookie ? nodeCookieAuthorization(cookie) : await authorizationFor(url);
  } catch (e) { err.textContent = "Cookie: " + (e as Error).message; return false; }
  err.textContent = "checking…";
  try {
    const info = await reader(url, chainPath(), platform.fetch, authorization).chainInfo();
    if (info.chain.join("/") !== settings.chain) { err.textContent = `That node answers for ${info.chain.join("/")}, not ${settings.chain}.`; return false; }
    if (requireSubmit && info.acceptsSubmit !== true) { err.textContent = "Lattice.build is not accepting transactions right now."; return false; }
    // Kept only once it opened this node.
    if (cookie) {
      const paired = await wallet.setNodeCookie(url, cookie);
      if (!paired.ok) { err.textContent = "Cookie: " + paired.error; return false; }
    }
    await update((s) => ({ ...s, endpoints: { ...s.endpoints, [s.chain]: { url, acceptsSubmit: declaredSubmit && info.acceptsSubmit === true, source } } }));
    return true;
  } catch (e) {
    err.textContent = "That node does not serve " + settings.chain + ": " + describe(e);
    return false;
  }
}

/**
 * Pairing with the user's own node: its loopback operator port refuses browser
 * origins it does not list and every request without its cookie
 * (bitcoind-style, rewritten at every node start).
 */
function pairingSteps(origin: string, cookie: HTMLTextAreaElement): El[] {
  const line = `"rpcAllowedOrigins": [${JSON.stringify(origin)}]`;
  return [
    h("p", { class: "muted" }, "Your own node on this computer: add this line to lattice.json in the node's root, then restart it (lattice down, lattice up):"),
    h("div", { class: "addr mono" }, line),
    h("p", { class: "muted" }, "Then paste its cookie, the content of <root>/chains/Nexus/.cookie. The node writes a new cookie each time it starts; paste it again after a restart. It is kept encrypted with your keys."),
    cookie,
  ];
}

function endpointScreen() {
  const current = endpoint();
  const url = h("input", { type: "text", placeholder: "your node, e.g. http://127.0.0.1:8080", spellcheck: "false", value: current?.url ?? "" }) as HTMLInputElement;
  const cookie = h("textarea", { rows: "2", placeholder: "your node's cookie (__cookie__:…), for a node on this computer", spellcheck: "false", autocomplete: "off" }) as HTMLTextAreaElement;
  const start = h("input", {
    type: "text", placeholder: "a Nexus node you trust to start from", spellcheck: "false",
    value: settings.endpoints[ROOT_CHAIN]?.url ?? LATTICE_EXPLORER_RPC,
  }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  const found = h("div", { class: "kv" });
  const isChild = chainPath().length > 1;
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Node for " + settings.chain),
      h("p", { class: "muted" }, "The wallet has no default node. Use your own node (its loopback API accepts your submits), or an endpoint whose operator chose to accept public submits."),
      ...(settings.chain === ROOT_CHAIN && !platform.ownNode ? [
        h("button", { class: "block", onclick: async () => {
          if (await chooseEndpoint(LATTICE_BUILD_RPC, "user", err, true, undefined, true)) route();
        } }, "Use Lattice.build"),
        h("p", { class: "muted" }, "Optional public Nexus service. The wallet verifies the chain and submission support before saving it."),
      ] : []),
      ...(isChild ? [
        h("button", { class: "block", onclick: () => discoverFrom(true) }, "Find node automatically"),
        h("p", { class: "muted" }, "Uses the explorer's configured Nexus service to find and verify a node that accepts transactions for this chain."),
      ] : []),
      url,
      ...(platform.pairOrigin ? pairingSteps(platform.pairOrigin, cookie) : []),
      h("button", { class: "block", onclick: async () => {
        const n = normalizeNodeURL(url.value);
        if (!n) { err.textContent = "Enter an https:// URL (http:// only for 127.0.0.1/localhost)."; return; }
        if (await chooseEndpoint(n, "user", err, true, cookie.value.trim() || undefined)) route();
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

  async function discoverFrom(autoSelect = false) {
    const n = normalizeNodeURL(start.value);
    if (!n) { err.textContent = "Enter the starting node's URL."; return; }
    // Discovery may reach any declared host: ask for broad reach once, in this click.
    const granted = await platform.requestOrigins([originPattern(n), "https://*/*"]).catch(() => false);
    if (!granted) { err.textContent = "Permission not granted."; return; }
    err.textContent = "discovering…";
    found.replaceChildren();
    try {
      const list = await discover(n, chainPath(), platform.fetch);
      err.textContent = list.length ? "" : "No endpoint served the block its parent commits.";
      if (autoSelect) {
        const candidates = list.filter((endpoint) => endpoint.declaresSubmit);
        if (!candidates.length) {
          err.textContent = "No verified node declares transaction submission for this chain.";
          return;
        }
        for (const candidate of candidates) {
          if (await chooseEndpoint(candidate.url, "discovered", err, true, undefined, true)) {
            route();
            return;
          }
        }
        err.textContent = "No verified node is currently accepting transactions for this chain.";
        return;
      }
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

async function chainScreen() {
  const add = h("input", { type: "text", placeholder: "chain path, e.g. Nexus/testnet", spellcheck: "false" }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  const pick = async (chain: string) => { await update((s) => ({ ...s, chain })); route(); };
  let chains = settings.chains;
  if (platform.chains) {
    try { chains = await platform.chains.list(); } catch (e) { err.textContent = (e as Error).message; }
  }
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Chain"),
      h("div", { class: "kv" }, ...chains.map((c) => h("div", { class: "row" },
        h("span", { class: "v mono" }, c),
        h("span", { class: "k" }, platform.ownNode ? "own node" : settings.endpoints[c] ? short(settings.endpoints[c].url) : "no node"),
        h("button", { class: "btn", onclick: () => pick(c) }, c === settings.chain ? "Selected" : "Select"),
      ))),
      add,
      h("button", { class: "btn block", onclick: async () => {
        const path = parseChainPath(add.value);
        if (!path) { err.textContent = "A chain path starts with Nexus, e.g. Nexus/testnet."; return; }
        const key = path.join("/");
        if (platform.chains) {
          err.textContent = "adding " + key + " to your node…";
          try { await platform.chains.add(key); } catch (e) { err.textContent = (e as Error).message; return; }
        } else {
          await update((s) => ({ ...s, chains: s.chains.includes(key) ? s.chains : [...s.chains, key] }));
        }
        await pick(key);
      } }, "Add chain"),
      err,
      ...(endpoint() && !platform.ownNode ? [h("button", { class: "btn block", onclick: endpointScreen }, "Change node for " + settings.chain)] : []),
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
  nodeAuth = await authorizationFor(nodeV.url);
  const toast = h("div", { class: "toast" });

  const accountPicker = h("select", { class: "picker account-picker", onchange: async (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === "__add") { await wallet.addAccount(); await refresh(); return; }
    if (v === "__import") return importKeyFlow();
    await wallet.setActive(v); await refresh();
  } }) as HTMLSelectElement;
  for (const a of st.accounts) accountPicker.append(h("option", { value: a.address, ...(a.address === acct.address ? { selected: "true" } : {}) }, `${a.label} · ${short(a.address)}`));
  accountPicker.append(h("option", { value: "__add" }, "+ Add account"));
  accountPicker.append(h("option", { value: "__import" }, "+ Import key"));

  let availableChains = settings.chains;
  if (platform.chains) {
    try { availableChains = await platform.chains.list(); } catch { /* keep the saved list */ }
  }
  const parentChain = chainPath().slice(0, -1).join("/");
  availableChains = [...new Set([...(parentChain ? [parentChain] : []), settings.chain, ...availableChains])];
  const switchChain = async (chain: string) => {
    await update((s) => ({
      ...s, chain,
      chains: s.chains.includes(chain) ? s.chains : [...s.chains, chain],
    }));
    route();
  };
  const chainPicker = h("select", { class: "chain-quick-picker", "aria-label": "Active chain", onchange: async (e: Event) => {
    const chain = (e.target as HTMLSelectElement).value;
    if (chain === "__manage") { chainScreen(); return; }
    if (chain === settings.chain) return;
    await switchChain(chain);
  } }) as HTMLSelectElement;
  for (const chain of availableChains) chainPicker.append(h("option", { value: chain, ...(chain === settings.chain ? { selected: "true" } : {}) }, chain));
  const manageOption = h("option", { value: "__manage" }, "Manage chains…");
  chainPicker.append(manageOption);
  const childChainButtons = h("div", { class: "child-chain-buttons" });
  const childChainsSection = h("div", { class: "child-chains" },
    h("p", { class: "section-label" }, "Direct child chains"),
    childChainButtons,
  );
  childChainsSection.hidden = true;

  render(
    h("div", { class: "stack wallet-home" },
      accountPicker,
      h("div", { class: "balance-card" },
        h("div", { class: "balance-heading" },
          h("span", { class: "balance-label" }, "Balance"),
          h("div", { class: "balance-tools" },
            chainPicker,
            h("button", { class: "text-action", onclick: () => loadBalance() }, "Refresh"),
          ),
        ),
        h("span", { class: "balance-value" }, balanceV),
        h("div", { class: "account-line" },
          h("div", { class: "account-identity" },
            h("span", {}, acct.label),
            h("span", { class: "mono account-address" }, acct.address),
          ),
          h("button", { class: "text-action", onclick: async () => {
            try {
              await navigator.clipboard.writeText(acct.address);
              toast.textContent = "Account address copied.";
            } catch {
              toast.textContent = "Could not copy the account address.";
            }
          } }, "Copy address"),
        ),
      ),
      childChainsSection,
      h("div", { class: "primary-actions" },
        h("button", { class: "btn btn--primary", onclick: sendFlow }, "Send"),
        h("button", { class: "btn", onclick: receiveScreen }, "Receive"),
      ),
      h("button", { class: "btn block", onclick: orderFlow }, "Scan cross-chain order"),
      h("div", { class: "secondary-actions" },
        h("button", { class: "btn", onclick: historyScreen }, "Transactions"),
        h("button", { class: "btn", onclick: settingsScreen }, "Settings"),
      ),
      ...actionButtons(),
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
  async function loadChildChains() {
    try {
      const latest = await client().latestBlock();
      const children = await client().children(latest.hash);
      const paths = [...new Set(children
        .filter((child) => child.directory.length > 0 && !child.directory.includes("/"))
        .map((child) => `${settings.chain}/${child.directory}`))];
      if (!paths.length) return;
      for (const path of paths) {
        if (![...chainPicker.options].some((option) => option.value === path)) {
          chainPicker.insertBefore(h("option", { value: path }, path), manageOption);
        }
        const label = path.slice(path.lastIndexOf("/") + 1);
        childChainButtons.append(h("button", { class: "btn", onclick: () => switchChain(path) }, label));
      }
      childChainsSection.hidden = false;
    } catch { /* The wallet still works when this endpoint cannot list children. */ }
  }
  loadBalance();
  loadChildChains();
}

function settingsScreen() {
  const acct = activeAccount()!;
  const node = endpoint()!;
  render(h("div", { class: "stack" },
    h("h1", {}, "Settings"),
    h("div", { class: "kv" },
      h("div", { class: "row" }, h("span", { class: "k" }, "Account"), h("span", { class: "v mono" }, short(acct.address))),
      h("div", { class: "row" }, h("span", { class: "k" }, "Node"), h("span", { class: "v mono" }, short(node.url))),
      h("div", { class: "row" }, h("span", { class: "k" }, "Access"), h("span", { class: "tag" }, node.acceptsSubmit ? "read + send" : "read only")),
    ),
    h("button", { class: "btn block", onclick: chainScreen }, "Change chain"),
    ...(platform.ownNode ? [] : [h("button", { class: "btn block", onclick: endpointScreen }, "Change node")]),
    h("button", { class: "btn block", onclick: feeScreen }, "Default fee"),
    h("button", { class: "btn block", onclick: () => openBackup("backup") }, "Backup & recovery"),
    h("button", { class: "btn block", onclick: async () => { await wallet.lock(); await refresh(); } }, "Lock wallet"),
    h("button", { class: "btn block", onclick: mainScreen }, "Done"),
  ));
}

// ---------------- cross-chain order handoff ----------------

function orderFlow() {
  const scan = scanner({
    camera: platform.camera === true,
    pasteHint: "paste the lattice://order request",
    onText(text) {
      try {
        const order = decodeOrderRequest(text);
        if (order.side === "buy_child") {
          scan.status.textContent = "Buy requests need verified active-deposit discovery, which this node does not provide yet.";
          return false;
        }
        if (order.childChain.join("/") !== settings.chain) {
          scan.status.textContent = `Select ${order.childChain.join("/")} in the wallet before opening this request.`;
          return false;
        }
        reviewSellOrder(order);
        return true;
      } catch (e) { scan.status.textContent = (e as Error).message; return false; }
    },
  });
  render(h("div", { class: "stack" },
    h("h1", {}, "Open order"),
    h("p", { class: "muted" }, "Scan the QR, load its image, or paste its text. The wallet validates the request and shows the transaction before signing."),
    scan.node,
    h("button", { class: "btn block", onclick: () => { scan.stop(); mainScreen(); } }, "Cancel"),
  ));
}

function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

async function reviewSellOrder(order: SellOrder) {
  const acct = activeAccount()!;
  const deposited = BigInt(order.amountDeposited);
  const demanded = BigInt(order.amountDemanded);
  const feeInput = h("input", { type: "text", inputmode: "numeric", value: defaultFee(settings, settings.chain) }) as HTMLInputElement;
  const toast = h("div", { class: "toast" }, "reading account…");
  render(h("div", { class: "stack" }, h("h1", {}, "Review sell order"), toast,
    h("button", { class: "btn block", onclick: orderFlow }, "Cancel"),
  ));
  let minRelayFee: bigint | undefined;
  try {
    const info = await client().chainInfo();
    minRelayFee = info.minRelayFee;
  } catch (e) { toast.textContent = describe(e); return; }
  const depositNonce = randomNonce();
  const feeNote = h("div", { class: "warn" });
  const checkFee = () => {
    const fee = parseFee(feeInput.value);
    feeNote.textContent = fee === null ? "Enter a whole fee of 0 or more." : feeWarning(fee, minRelayFee) ?? "";
  };
  feeInput.addEventListener("input", checkFee);
  checkFee();
  const lockButton = h("button", { class: "block" }, "Lock funds & create order") as HTMLButtonElement;
  render(h("div", { class: "stack" },
    h("h1", {}, "Review sell order"),
    h("p", { class: "warn" }, "This locks child-chain funds. There is currently no timeout or cancel transaction."),
    h("div", { class: "kv" },
      h("div", { class: "row" }, h("span", { class: "k" }, "You lock"), h("span", { class: "v" }, fmt(deposited))),
      h("div", { class: "row" }, h("span", { class: "k" }, "You ask"), h("span", { class: "v" }, `${fmt(demanded)} on ${order.parentChain.join("/")}`)),
      h("div", { class: "row" }, h("span", { class: "k" }, "Chain"), h("span", { class: "tag" }, order.childChain.join("/"))),
      h("div", { class: "row" }, h("span", { class: "k" }, "Account"), h("span", { class: "v mono" }, short(acct.address))),
    ),
    h("label", { class: "k" }, "Fee (paid to the miner)"), feeInput, feeNote, toast,
    lockButton,
    h("button", { class: "btn block", onclick: orderFlow }, "Cancel"),
  ));
  lockButton.addEventListener("click", async () => {
    // Leave enough time for account lookup, signing, submission and relay.
    if (Date.parse(order.expiresAt) <= Date.now() + 60_000) {
      toast.textContent = "This order is expired or has less than one minute left. Create a fresh request.";
      return;
    }
    const fee = parseFee(feeInput.value);
    if (fee === null) { toast.textContent = "Enter a whole fee of 0 or more."; return; }
    lockButton.disabled = true;
    feeInput.disabled = true;
    let nonce: bigint, balance: bigint;
    try {
      const account = await client().account(acct.address);
      nonce = account.nonce; balance = account.balance;
    } catch (e) {
      toast.textContent = describe(e); lockButton.disabled = false; feeInput.disabled = false; return;
    }
    if (deposited + fee > balance) {
      toast.textContent = `Insufficient balance (have ${fmt(balance)}, need ${fmt(deposited + fee)}).`;
      lockButton.disabled = false; feeInput.disabled = false; return;
    }
    toast.textContent = "signing…";
    const signed = await wallet.signDeposit({
      from: acct.address, amountDeposited: order.amountDeposited, amountDemanded: order.amountDemanded,
      depositNonce: depositNonce.toString(), fee: fee.toString(), nonce: nonce.toString(), chainPath: [...order.childChain],
    });
    if (!signed.ok) { toast.textContent = signed.error; lockButton.disabled = false; feeInput.disabled = false; return; }
    const cid = signed.signedSubmit.transactionCID;
    const chain = settings.chain;
    try {
      // Persist the exact signed attempt before touching the network. A timeout
      // can mean the node accepted it even though no response arrived.
      await update((s) => recordSent(recordOpenDeposit(s, {
        transactionCID: cid, demander: acct.address,
        depositNonce: depositNonce.toString(), amountDeposited: order.amountDeposited,
        amountDemanded: order.amountDemanded, fee: fee.toString(), transactionNonce: nonce.toString(),
        childChain: [...order.childChain], parentChain: [...order.parentChain],
        createdAt: Date.now(), expiresAt: order.expiresAt,
      }), chain, {
        cid, to: `sell for ${order.parentChain.join("/")}`,
        amount: order.amountDeposited, at: Date.now(), from: acct.address, fee: fee.toString(), nonce: nonce.toString(),
      }));
    } catch {
      toast.textContent = "Could not save the deposit record; nothing was submitted.";
      lockButton.disabled = false; feeInput.disabled = false; return;
    }
    toast.textContent = "submitting…";
    try {
      await submitChecked(submitter(endpoint()!.url, platform.fetch, nodeAuth), signed.signedSubmit);
      sentScreen(cid);
    } catch {
      // Never return to a control that re-signs with a newly read account
      // nonce. Track this exact CID; resubmission must reuse its signed bytes.
      sentScreen(cid, { uncertain: true, from: acct.address, nonce });
    }
  });
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
  const inp = h("textarea", { placeholder: "32-byte (64-hex) private key, or a `lattice key generate` key file", spellcheck: "false" }) as HTMLTextAreaElement;
  const err = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Import key"),
      inp, ...keyFilePicker(inp), err,
      h("button", { class: "block", onclick: async () => {
        let priv: string;
        try { priv = privateKeyText(inp.value); } catch (e) { err.textContent = (e as Error).message; return; }
        const r = await wallet.importKey(priv); if (r.ok) { st = r.state; route(); } else err.textContent = r.error;
      } }, "Import"),
      h("button", { class: "btn block", onclick: mainScreen }, "Back"),
    ),
  );
}

/** A typed 64-hex key, or a pasted `lattice key generate` key file. */
function privateKeyText(text: string): string {
  const raw = text.trim();
  return raw.startsWith("{") ? keyFilePrivateKey(raw) : raw;
}

/** On hosts that allow it, a picker that loads a key file's text into `target`. */
function keyFilePicker(target: HTMLTextAreaElement): El[] {
  if (!platform.keyFilePicker) return [];
  const picker = h("input", { type: "file", accept: ".json,application/json" }) as HTMLInputElement;
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      if (file.size > 4096) throw new Error("too large");
      target.value = await file.text();
    } catch {
      target.value = "";
      target.placeholder = "That file is not a key file (unreadable or over 4 KB).";
    }
  });
  return [h("label", { class: "k" }, "or load a key file"), picker];
}

// ---------------- send ----------------

async function sendFlow() {
  const acct = activeAccount()!;
  const to = h("input", { type: "text", placeholder: "recipient address (bafy…)", spellcheck: "false" }) as HTMLInputElement;
  const amount = h("input", { type: "text", inputmode: "numeric", placeholder: "amount (units)" }) as HTMLInputElement;
  // No estimate service: the fee is the user's, starting at this chain's default.
  const fee = h("input", { type: "text", inputmode: "numeric", value: defaultFee(settings, settings.chain) }) as HTMLInputElement;
  const feeNote = h("div", { class: "warn" });
  const feeAdvanced = h("details", { class: "advanced" },
    h("summary", {}, "Advanced"),
    h("div", { class: "advanced-content" },
      h("label", { class: "k" }, "Network fee"), fee, feeNote,
    ),
  ) as HTMLDetailsElement;
  const err = h("div", { class: "toast" });
  const submitOK = endpoint()!.acceptsSubmit;
  // The chosen endpoint's relay floor (its policy): read once, warned against, never applied.
  let minRelayFee: bigint | undefined;
  const checkFee = () => {
    const f = parseFee(fee.value);
    const warning = f === null ? "" : feeWarning(f, minRelayFee) ?? "";
    feeNote.textContent = warning;
    if (warning) feeAdvanced.open = true;
  };
  fee.addEventListener("input", checkFee);
  client().chainInfo().then((info) => { minRelayFee = info.minRelayFee; checkFee(); }).catch(() => {});
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Send on " + settings.chain),
      ...(submitOK ? [] : [h("p", { class: "warn" }, "This node does not accept submits. Use your own node, or an endpoint whose operator accepts public submits.")]),
      h("label", { class: "k" }, "To"), to,
      h("label", { class: "k" }, "Amount"), amount,
      feeAdvanced,
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
      h("p", { class: "section-label" }, `From · ${acct.label}`),
      h("div", { class: "addr mono" }, acct.address),
      h("p", { class: "section-label" }, "Recipient"),
      h("div", { class: "addr mono" }, to),
      h("div", { class: "kv" },
        h("div", { class: "row" }, h("span", { class: "k" }, "Amount"), h("span", { class: "v" }, fmt(amount.toString()))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Network fee"), h("span", { class: "v" }, fmt(fee.toString()))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Total"), h("span", { class: "v" }, fmt((amount + fee).toString()))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Chain"), h("span", { class: "tag" }, settings.chain)),
      ),
      h("details", { class: "advanced" },
        h("summary", {}, "Transaction details"),
        h("div", { class: "kv advanced-content" },
          h("div", { class: "row" }, h("span", { class: "k" }, "Nonce"), h("span", { class: "v" }, String(nonce))),
          ...(minRelayFee === undefined ? [] : [h("div", { class: "row" }, h("span", { class: "k" }, "Node minimum"), h("span", { class: "v" }, fmt(minRelayFee.toString())))]),
          h("div", { class: "row" }, h("span", { class: "k" }, "Node"), h("span", { class: "v mono" }, short(endpoint()!.url))),
        ),
      ),
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
      const cid = signed.signedSubmit.transactionCID;
      const chain = settings.chain;
      const record = () => update((s) => recordSent(s, chain, {
        cid, to, amount: amount.toString(), at: Date.now(),
        from: acct.address, fee: fee.toString(), nonce: nonce.toString(),
      }));
      try {
        await submitChecked(submitter(endpoint()!.url, platform.fetch, nodeAuth), signed.signedSubmit);
      } catch (e) {
        // The node may hold it under the CID it reported: keep ours on record.
        if (e instanceof CIDMismatchError) await record();
        throw e;
      }
      await record();
      sentScreen(cid);
    } catch (e) {
      toast.textContent = describe(e) + (e instanceof CIDMismatchError ? " It may have been admitted: check Sent before resending." : "");
    }
  }
}

function sentScreen(txCID: string, outcome?: { uncertain: true; from: string; nonce: bigint }) {
  const toast = h("div", { class: "toast" });
  const status = h("p", { class: outcome ? "warn" : "muted" }, outcome
    ? "Submission outcome unknown. Do not create this deposit again; checking this exact transaction…"
    : "Admitted to the node's pool (pending). See Sent for its block once mined.");
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Sent"),
      status,
      h("label", { class: "k" }, outcome ? "Transaction computed and saved by this wallet" : "Transaction (computed by this wallet; the node reported the same CID)"), h("div", { class: "addr mono" }, txCID),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", onclick: async () => { await navigator.clipboard.writeText(txCID); toast.textContent = "copied"; setTimeout(() => (toast.textContent = ""), 1500); } }, "Copy"),
        h("button", { class: "btn", onclick: mainScreen }, "Done"),
      ),
      toast,
    ),
  );
  if (outcome) {
    sentStatus(client(), txCID, { from: outcome.from, nonce: outcome.nonce })
      .then((result) => { status.textContent = `Submission outcome: ${statusText(result)}. Do not create this deposit again.`; })
      .catch((e) => { status.textContent = `${describe(e)} The signed deposit remains saved; do not create it again.`; });
  }
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

export function startWallet(host: Platform) {
  platform = host;
  wallet = host.wallet;
  store = host.store;
  initialView = host.initialView;
  document.getElementById("net-badge")!.addEventListener("click", () => {
    if (st.initialized && !st.locked) chainScreen();
  });
  return refresh();
}
