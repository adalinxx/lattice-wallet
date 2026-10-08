// Nexus Wallet UI, shared by the extension popup and the desktop app. Talks
// only to the signer (key material never enters this module) and to the node
// the user chose for reads/submit. There is no default node. Styled with the
// Lattice design system. The host supplies a Platform: signer, settings
// store, network permission, and optionally its own node.

import type { Fetch } from "@adalinxx/lattice-client";
import { nodeCookieAuthorization } from "@adalinxx/lattice-core";
import type { WalletClient } from "../lib/wallet/client.ts";
import { newMnemonic, isValidMnemonic, keyFilePrivateKey } from "../lib/crypto/accounts.ts";
import { reader, submitter, submitChecked, isDefiniteSubmissionRefusal, shouldOfferFeeReplacement, discover, describe, feeWarning, sentStatus, statusText, activeDeposits, depositValues, receiptWithdrawer, type ActiveDeposit, OPERATOR_DECLARED } from "../lib/wallet/node.ts";
import { LATTICE_BUILD_RPC, LATTICE_EXPLORER_RPC, LATTICE_TESTNET_RPC, ROOT_CHAIN, parseChainPath, normalizeNodeURL, originPattern } from "../lib/config.ts";
import { loadSettings, saveSettings, recordOpenDeposit, completeOpenDeposit, recordOpenPurchase, completeOpenPurchase, recordWithdrawalAttempt, forgetWithdrawalAttempt, purchaseWithdrawalAttempts, recordSent, forgetSent, recordPendingSubmission, completePendingSubmission, defaultFee, parseFee, type Settings, type ChosenEndpoint, type KeyValueStore, type OpenPurchase } from "../lib/wallet/settings.ts";
import type { WalletState, AccountView, SignedSubmit } from "../lib/wallet/types.ts";
import { decodeOrderRequest, type BuyOrder, type SellOrder } from "../lib/wallet/order.ts";
import { backupMenu, restoreMenu, type BackupHost } from "./backup.ts";
import { scanner, scannerFileTexts } from "./scanner.ts";
import { isAccountAddress } from "../lib/wallet/session.ts";

export interface Platform {
  /** The signer: the extension's background worker, or the desktop app's in-page signer. */
  wallet: WalletClient;
  /** Where non-secret settings live. */
  store: KeyValueStore;
  /** Ask for network reach to these origin patterns (inside the user's click). */
  requestOrigins(origins: string[]): Promise<boolean>;
  /** Whether these origins were already granted, used to resume after Chrome closes a permission prompt. */
  hasOrigins?(origins: string[]): Promise<boolean>;
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
  openFullPage?(view: "backup" | "restore" | "wallet"): void;
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
export const render = (node: El) => {
  closeChainMenu();
  view().replaceChildren(node);
};

let st: WalletState = { initialized: false, locked: true, accounts: [], active: null };
let settings: Settings;
let platform: Platform;
let wallet: WalletClient;
let store: KeyValueStore;
const dropReady = new WeakSet<Document>();
const chainPath = () => parseChainPath(settings.chain) ?? [ROOT_CHAIN];
// The operator route of the host's own node accepts its owner's submits.
const endpoint = (): ChosenEndpoint | undefined =>
  platform.ownNode ? { url: platform.ownNode, acceptsSubmit: true, source: "user" } : settings.endpoints[settings.chain];
const endpointFor = (chain: string): ChosenEndpoint | undefined =>
  platform.ownNode ? { url: platform.ownNode, acceptsSubmit: true, source: "user" } : settings.endpoints[chain];
// The chosen node's cookie header when the user paired it (its operator port requires one).
let nodeAuth: string | undefined;
const client = () => reader(endpoint()!.url, chainPath(), platform.fetch, nodeAuth);
async function authorizationFor(url: string): Promise<string | undefined> {
  if (platform.ownNode) return undefined; // the host attaches its own node's cookie
  const r = await wallet.nodeAuthorization(url);
  return r.ok ? r.authorization : undefined;
}
async function update(change: (s: Settings) => Settings) {
  const next = change(settings);
  await saveSettings(store, next);
  settings = next;
  syncBadge();
}

type ResubmitResult = { kind: "submitted" } | { kind: "refused" | "uncertain"; error: unknown };
/** Exact-byte rebroadcast never changes recovery records. A refusal describes
 * this attempt only; it cannot prove an earlier ambiguous submission absent. */
async function resubmitExact(url: string, authorization: string | undefined, signed: SignedSubmit): Promise<ResubmitResult> {
  try {
    await submitChecked(submitter(url, platform.fetch, authorization), signed);
    return { kind: "submitted" };
  } catch (error) {
    return { kind: isDefiniteSubmissionRefusal(error) ? "refused" : "uncertain", error };
  }
}

/** Resolve the current child block through its parent commitment. Child state
 * is only final enough to delete recovery data when it matches this anchor. */
async function adjacentTips(parentEndpoint: ChosenEndpoint, parentChain: readonly string[], childChain: readonly string[], parentAuth?: string) {
  const parent = reader(parentEndpoint.url, [...parentChain], platform.fetch, parentAuth);
  const latest = await parent.latestBlock();
  const directory = childChain.at(-1);
  if (!directory || childChain.length !== parentChain.length + 1
    || childChain.slice(0, -1).some((part, index) => part !== parentChain[index])) {
    throw new Error("Cross-chain recovery requires a direct parent and child.");
  }
  const child = (await parent.children(latest.hash)).find((entry) => entry.directory === directory);
  if (!child) throw new Error(`The current ${parentChain.join("/")} tip does not commit ${childChain.join("/")}.`);
  return { parent: latest.hash, child: child.blockHash };
}

async function withStableTip<T>(chosen: ChosenEndpoint, chain: readonly string[], authorization: string | undefined, read: (tip: string) => Promise<T>): Promise<T> {
  const client = reader(chosen.url, [...chain], platform.fetch, authorization);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const before = await client.latestBlock();
      const result = await read(before.hash);
      const after = await client.latestBlock();
      if (before.hash === after.hash) return result;
      lastError = new Error("The chain advanced while verified state was read.");
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error("Could not read a stable chain tip.");
}

async function stableReceiptOwners(parentEndpoint: ChosenEndpoint, parentChain: readonly string[], childChain: readonly string[], offers: readonly ActiveDeposit[], parentAuth?: string) {
  return withStableTip(parentEndpoint, parentChain, parentAuth, (tip) => Promise.all(offers.map((offer) => receiptWithdrawer(
    parentEndpoint.url, parentChain, childChain, offer, platform.fetch, parentAuth, tip,
  ))));
}

const CONFIRMATION_DEPTH = 6n;
async function deeplyIncluded(chosen: ChosenEndpoint, chain: readonly string[], cid: string, from: string, nonce: bigint, authorization?: string): Promise<boolean> {
  const node = reader(chosen.url, [...chain], platform.fetch, authorization);
  const status = await sentStatus(node, cid, { from, nonce });
  if (status.kind !== "included") return false;
  const tip = await node.chainInfo();
  if (tip.height === undefined) return false;
  return tip.height >= status.height && tip.height - status.height + 1n >= CONFIRMATION_DEPTH;
}

let reconciliation: Promise<void> | undefined;
function reconcileRecovery(): Promise<void> {
  if (reconciliation) return reconciliation;
  reconciliation = (async () => {
    const auths = new Map<string, Promise<string | undefined>>();
    const auth = (url: string) => {
      let pending = auths.get(url);
      if (!pending) { pending = authorizationFor(url); auths.set(url, pending); }
      return pending;
    };
    const completedTransfers: string[] = [];
    const completedPurchases: string[] = [];
    await Promise.all(settings.pendingSubmissions.map(async (pending) => {
      const chosen = endpointFor(pending.chain);
      if (!chosen) return;
      try {
        if (await deeplyIncluded(chosen, pending.chain.split("/"), pending.cid, pending.from, BigInt(pending.nonce), await auth(chosen.url))) {
          completedTransfers.push(pending.cid);
        }
      } catch { /* Keep recovery on every inconclusive read. */ }
    }));
    await Promise.all(settings.openPurchases.map(async (purchase) => {
      const child = endpointFor(purchase.childChain.join("/"));
      const parent = endpointFor(purchase.parentChain.join("/"));
      if (!child || !parent) return;
      try {
        const childAuth = await auth(child.url);
        const attempts = purchaseWithdrawalAttempts(purchase);
        const included = (await Promise.all(attempts.map((attempt) => deeplyIncluded(
          child, purchase.childChain, attempt.transactionCID, purchase.withdrawer,
          BigInt(attempt.payload.transaction.body.nonce), childAuth,
        )))).some(Boolean);
        if (!included) return;
        const tips = await adjacentTips(parent, purchase.parentChain, purchase.childChain, await auth(parent.url));
        const keys = purchase.offers.map((offer) => `${offer.demander}/${offer.amountDemanded}/${offer.depositNonce}`);
        const values = await depositValues(child.url, purchase.childChain, keys, platform.fetch, childAuth, tips.child);
        if (keys.every((key) => values.get(key) === 0n)) completedPurchases.push(purchase.receiptCID);
      } catch { /* Missing targeted proof support is inconclusive, not failure. */ }
    }));
    if (completedTransfers.length || completedPurchases.length) {
      await update((current) => ({
        ...current,
        pendingSubmissions: current.pendingSubmissions.filter((item) => !completedTransfers.includes(item.cid)),
        openPurchases: current.openPurchases.filter((item) => !completedPurchases.includes(item.receiptCID)),
      }));
    }
  })().finally(() => { reconciliation = undefined; });
  return reconciliation;
}

async function dismissRecovery(label: string, remove: (current: Settings) => Settings): Promise<boolean> {
  if (!window.confirm(`Dismiss ${label}? The wallet will delete its saved recovery data. This cannot be undone.`)) return false;
  await update(remove);
  return true;
}

export async function ensureOrigins(host: Pick<Platform, "hasOrigins" | "requestOrigins">, origins: string[]): Promise<boolean> {
  if (host.hasOrigins && await host.hasOrigins(origins).catch(() => false)) return true;
  return host.requestOrigins(origins).catch(() => false);
}

function syncBadge() {
  const b = document.getElementById("net-badge")!;
  b.textContent = `${settings.chain} ▾`;
  b.title = `${settings.chain} — show child chains`;
  b.setAttribute("aria-label", `Current chain ${settings.chain}. Show child chains`);
  const parentButton = document.getElementById("parent-chain") as HTMLButtonElement | null;
  if (parentButton) {
    const parent = chainPath().slice(0, -1).join("/");
    parentButton.hidden = !parent;
    parentButton.textContent = "↑";
    parentButton.title = parent ? `Go to ${parent}` : "";
    parentButton.setAttribute("aria-label", parent ? `Go to parent chain ${parent}` : "No parent chain");
  }
}

function closeChainMenu() {
  document.querySelector(".chain-menu")?.remove();
  document.getElementById("net-badge")?.setAttribute("aria-expanded", "false");
}

async function switchToChain(chain: string, status: El) {
  if (chain === settings.chain) { document.querySelector(".chain-menu")?.remove(); return; }
  if (settings.nodeMode === "automatic" && !platform.ownNode && !settings.endpoints[chain] && chain !== ROOT_CHAIN) {
    status.textContent = `Finding a node for ${chain}…`;
    const bootstrap = settings.endpoints[ROOT_CHAIN]?.url ?? LATTICE_EXPLORER_RPC;
    // Persist before Chrome opens its permission prompt: the prompt can close
    // this popup and destroy the remainder of this async handler.
    await update((s) => ({
      ...s, chain, pendingAutomaticChain: chain,
      chains: s.chains.includes(chain) ? s.chains : [...s.chains, chain],
    }));
    const granted = await ensureOrigins(platform, [originPattern(bootstrap), "https://*/*"]);
    if (granted) {
      if (await finishAutomaticChain(chain, status)) { route(); return; }
    }
    await update((s) => { const { pendingAutomaticChain: _, ...rest } = s; return rest; });
    endpointScreen();
    return;
  }
  await update((s) => ({ ...s, chain, chains: s.chains.includes(chain) ? s.chains : [...s.chains, chain] }));
  route();
}

async function finishAutomaticChain(chain: string, status: El): Promise<boolean> {
  const bootstrap = settings.endpoints[ROOT_CHAIN]?.url ?? LATTICE_EXPLORER_RPC;
  try {
    const candidates = (await discover(bootstrap, parseChainPath(chain)!, platform.fetch)).filter((candidate) => candidate.declaresSubmit);
    for (const candidate of candidates) {
      if (await chooseEndpoint(candidate.url, "discovered", status, true, undefined, true, true)) {
        await update((s) => { const { pendingAutomaticChain: _, ...rest } = s; return rest; });
        return true;
      }
    }
  } catch { /* The connection screen provides the manual fallback. */ }
  return false;
}

async function finishPendingEndpoint(status: El): Promise<boolean> {
  const pending = settings.pendingEndpoint;
  if (!pending || pending.chain !== settings.chain) return false;
  if (!await chooseEndpoint(pending.url, pending.source, status, pending.declaredSubmit, undefined, pending.requireSubmit, true)) {
    if (pending.clearCookieOnFailure) await wallet.setNodeCookie(pending.url, null);
    await update((s) => { const { pendingEndpoint: _, ...rest } = s; return rest; });
    return false;
  }
  await update((s) => {
    const { pendingEndpoint: _, ...rest } = s;
    return pending.nodeMode ? { ...rest, nodeMode: pending.nodeMode } : rest;
  });
  return true;
}

async function requestEndpoint(
  pending: NonNullable<Settings["pendingEndpoint"]>, status: El, cookie?: string,
): Promise<boolean> {
  if (cookie) {
    const paired = await wallet.setNodeCookie(pending.url, cookie);
    if (!paired.ok) { status.textContent = "Cookie: " + paired.error; return false; }
  }
  await update((s) => ({ ...s, pendingEndpoint: pending }));
  // Choosing the hosted Nexus bootstrap opts into automatic HTTPS discovery.
  // Ask for that reach once here, so its hosted child chains do not trigger a
  // second Chrome permission prompt on first use.
  const origins = pending.chain === ROOT_CHAIN && pending.url === LATTICE_BUILD_RPC
    && pending.nodeMode === "automatic" ? ["https://*/*"] : [originPattern(pending.url)];
  const granted = await ensureOrigins(platform, origins);
  if (granted) return finishPendingEndpoint(status);
  if (pending.clearCookieOnFailure) await wallet.setNodeCookie(pending.url, null);
  await update((s) => { const { pendingEndpoint: _, ...rest } = s; return rest; });
  status.textContent = "Permission to reach that node was not granted.";
  return false;
}

async function toggleChainMenu() {
  const existing = document.querySelector(".chain-menu");
  if (existing) { closeChainMenu(); return; }
  document.getElementById("net-badge")?.setAttribute("aria-expanded", "true");
  const status = h("div", { class: "toast" });
  const items = h("div", { class: "chain-menu-items" });
  const menu = h("div", { class: "chain-menu", role: "navigation", "aria-label": "Child chains" },
    h("div", { class: "chain-path", title: settings.chain }, settings.chain),
    items, status,
  );
  const shown = new Set<string>();
  const add = (chain: string, label: string) => {
    if (!chain || shown.has(chain)) return;
    shown.add(chain);
    items.append(h("button", {
      class: chain === settings.chain ? "chain-menu-item current" : "chain-menu-item",
      ...(chain === settings.chain ? { "aria-current": "page", disabled: "true" } : {}),
      onclick: () => switchToChain(chain, status),
    }, h("span", { class: "chain-name", title: chain }, label), h("span", { "aria-hidden": "true" }, "›")));
  };
  const current = settings.chain;
  for (const saved of settings.chains) {
    if (saved.split("/").slice(0, -1).join("/") === current) add(saved, saved.slice(current.length + 1));
  }
  document.body.append(menu);
  status.textContent = "Loading…";
  try {
    const latest = await client().latestBlock();
    for (const child of await client().children(latest.hash)) {
      if (child.directory && !child.directory.includes("/")) add(`${current}/${child.directory}`, child.directory);
    }
    status.textContent = shown.size ? "" : "No child chains.";
  } catch { status.textContent = shown.size ? "" : "Could not load child chains."; }
}

const activeAccount = (): AccountView | undefined => st.accounts.find((a) => a.address === st.active);

export async function refresh() {
  const r = await wallet.getState();
  if (r.ok) st = r.state;
  settings = await loadSettings(store);
  syncBadge();
  if (settings.pendingEndpoint?.chain === settings.chain && !endpoint() && platform.hasOrigins) {
    const origins = [originPattern(settings.pendingEndpoint.url)];
    if (await platform.hasOrigins(origins).catch(() => false)) {
      const status = h("div");
      if (await finishPendingEndpoint(status)) { route(); return; }
    }
    if (settings.pendingEndpoint) {
      if (settings.pendingEndpoint.clearCookieOnFailure) await wallet.setNodeCookie(settings.pendingEndpoint.url, null);
      await update((s) => { const { pendingEndpoint: _, ...rest } = s; return rest; });
    }
  }
  if (settings.pendingAutomaticChain === settings.chain && !endpoint() && platform.hasOrigins) {
    const bootstrap = settings.endpoints[ROOT_CHAIN]?.url ?? LATTICE_EXPLORER_RPC;
    const origins = [originPattern(bootstrap), "https://*/*"];
    if (await platform.hasOrigins(origins).catch(() => false)) {
      const status = h("div");
      if (await finishAutomaticChain(settings.chain, status)) { route(); return; }
    }
    await update((s) => { const { pendingAutomaticChain: _, ...rest } = s; return rest; });
  }
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
      h("div", { class: "hero" }, h("span", { class: "wordmark" }, "WALLET")),
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
async function chooseEndpoint(url: string, source: ChosenEndpoint["source"], err: El, declaredSubmit = true, cookie?: string, requireSubmit = false, permissionGranted = false): Promise<boolean> {
  if (!permissionGranted) {
    const granted = await ensureOrigins(platform, [originPattern(url)]);
    if (!granted) { err.textContent = "Permission to reach that node was not granted."; return false; }
  }
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
          if (await requestEndpoint({
            chain: settings.chain, url: LATTICE_BUILD_RPC, source: "user",
            declaredSubmit: true, requireSubmit: true, nodeMode: "automatic",
          }, err)) route();
        } }, "Use Lattice.build"),
        h("p", { class: "muted" }, "Optional public Nexus service. The wallet verifies the chain and submission support before saving it."),
      ] : []),
      ...(isChild ? [
        ...(settings.chain === "Nexus/testnet" ? [
          h("button", { class: "block", onclick: async () => {
            if (await requestEndpoint({
              chain: settings.chain, url: LATTICE_TESTNET_RPC, source: "user",
              declaredSubmit: true, requireSubmit: true, nodeMode: "automatic",
            }, err)) route();
          } }, "Use Lattice.build testnet"),
          h("p", { class: "muted" }, "Optional hosted testnet node. You can replace it with automatic discovery or any custom node."),
        ] : []),
        h("button", { class: "block", onclick: () => discoverFrom(true) }, "Find node automatically"),
        h("p", { class: "muted" }, "Uses the explorer's configured Nexus service to find and verify a node that accepts transactions for this chain."),
      ] : []),
      url,
      ...(platform.pairOrigin ? pairingSteps(platform.pairOrigin, cookie) : []),
      h("button", { class: "block", onclick: async () => {
        const n = normalizeNodeURL(url.value);
        if (!n) { err.textContent = "Enter an https:// URL (http:// only for 127.0.0.1/localhost)."; return; }
        const enteredCookie = cookie.value.trim() || undefined;
        if (await requestEndpoint({
          chain: settings.chain, url: n, source: "user", declaredSubmit: true,
          requireSubmit: false, nodeMode: "custom", clearCookieOnFailure: enteredCookie !== undefined,
        }, err, enteredCookie)) route();
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

  async function discoverFrom(autoSelect = false, permissionGranted = false, resumeURL?: string) {
    const n = normalizeNodeURL(resumeURL ?? start.value);
    if (!n) { err.textContent = "Enter the starting node's URL."; return; }
    if (!permissionGranted) {
      // Discovery may reach any declared host. Persist first because Chrome can
      // close the popup while it asks for this broad reach.
      await update((s) => ({ ...s, pendingDiscovery: { chain: s.chain, url: n, autoSelect } }));
      const granted = await ensureOrigins(platform, [originPattern(n), "https://*/*"]);
      if (!granted) {
        await update((s) => { const { pendingDiscovery: _, ...rest } = s; return rest; });
        err.textContent = "Permission not granted.";
        return;
      }
    }
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
          if (await chooseEndpoint(candidate.url, "discovered", err, true, undefined, true, true)) {
            await update((s) => {
              const { pendingDiscovery: _, ...rest } = s;
              return { ...rest, nodeMode: "automatic" };
            });
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
          h("button", { class: "btn", onclick: async () => { if (await chooseEndpoint(e.url, "discovered", err, e.declaresSubmit, undefined, false, true)) route(); } }, "Use"),
        ));
      }
      if (list.length) found.append(h("p", { class: "muted" }, `Each served the block its parent commits; ${OPERATOR_DECLARED}.`));
    } catch (e) {
      err.textContent = "Discovery failed: " + (e instanceof RangeError ? e.message : describe(e));
    } finally {
      if (settings.pendingDiscovery) await update((s) => { const { pendingDiscovery: _, ...rest } = s; return rest; });
    }
  }

  const pendingDiscovery = settings.pendingDiscovery;
  if (pendingDiscovery?.chain === settings.chain && platform.hasOrigins) {
    const origins = [originPattern(pendingDiscovery.url), "https://*/*"];
    void platform.hasOrigins(origins).then(async (granted) => {
      if (granted) await discoverFrom(pendingDiscovery.autoSelect, true, pendingDiscovery.url);
      else await update((s) => { const { pendingDiscovery: _, ...rest } = s; return rest; });
    }).catch(async () => update((s) => { const { pendingDiscovery: _, ...rest } = s; return rest; }));
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
  void reconcileRecovery();
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

  render(
    h("div", { class: "stack wallet-home" },
      accountPicker,
      h("div", { class: "balance-card" },
        h("div", { class: "balance-heading" },
          h("span", { class: "balance-label" }, "Balance"),
          h("button", { class: "text-action", onclick: () => loadBalance() }, "Refresh"),
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
      h("div", { class: "primary-actions" },
        h("button", { class: "btn btn--primary", onclick: sendFlow }, "Send"),
        h("button", { class: "btn", onclick: receiveScreen }, "Receive"),
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
  loadBalance();
}

function settingsScreen() {
  void reconcileRecovery();
  const acct = activeAccount()!;
  const node = endpoint()!;
  render(h("div", { class: "stack" },
    h("h1", {}, "Settings"),
    h("div", { class: "kv" },
      h("div", { class: "row" }, h("span", { class: "k" }, "Account"), h("span", { class: "v mono" }, short(acct.address))),
      h("div", { class: "row" }, h("span", { class: "k" }, "Node"), h("span", { class: "v mono" }, short(node.url))),
      h("div", { class: "row" }, h("span", { class: "k" }, "Access"), h("span", { class: "tag" }, node.acceptsSubmit ? "read + send" : "read only")),
      h("div", { class: "row" }, h("span", { class: "k" }, "Connection"), h("span", { class: "v" }, settings.nodeMode === "automatic" ? "Automatic" : "Custom nodes")),
    ),
    h("button", { class: "btn block", onclick: chainScreen }, "Change chain"),
    ...(platform.ownNode ? [] : [h("button", { class: "btn block", onclick: connectionScreen }, "Connection & nodes")]),
    ...(platform.openFullPage && !platform.camera
      ? [h("button", { class: "btn block", onclick: () => platform.openFullPage!("wallet") }, "Open wallet in tab")]
      : []),
    h("button", { class: "btn block", onclick: orderFlow }, "Open cross-chain order"),
    ...(settings.openPurchases.length
      ? [h("button", { class: "btn block", onclick: purchasesScreen }, `Pending purchases (${settings.openPurchases.length})`)]
      : []),
    ...(settings.openDeposits.length
      ? [h("button", { class: "btn block", onclick: depositsScreen }, `Pending sales (${settings.openDeposits.length})`)]
      : []),
    ...(settings.pendingSubmissions.length
      ? [h("button", { class: "btn block", onclick: pendingSubmissionsScreen }, `Pending transactions (${settings.pendingSubmissions.length})`)]
      : []),
    h("button", { class: "btn block", onclick: feeScreen }, "Default fee"),
    h("button", { class: "btn block", onclick: () => openBackup("backup") }, "Backup & recovery"),
    h("button", { class: "btn block", onclick: async () => { await wallet.lock(); await refresh(); } }, "Lock wallet"),
    h("button", { class: "btn block", onclick: mainScreen }, "Done"),
  ));
}

function depositsScreen() {
  void reconcileRecovery();
  const list = h("div", { class: "kv" });
  for (const deposit of settings.openDeposits) {
    const toast = h("span", { class: "muted" }, "Not checked");
    let retryButton: HTMLButtonElement | undefined;
    const check = h("button", { class: "btn", onclick: async () => {
      const parentName = deposit.parentChain.join("/");
      const childName = deposit.childChain.join("/");
      const parentEndpoint = endpointFor(parentName);
      const childEndpoint = endpointFor(childName);
      if (!childEndpoint) { toast.textContent = `Connect ${childName} to recover this deposit.`; return; }
      check.disabled = true;
      toast.textContent = "Checking the saved deposit…";
      try {
        const childAuth = await authorizationFor(childEndpoint.url);
        let withdrawer: string | null | undefined;
        let receiptMessage: string;
        if (parentEndpoint) {
          try {
            const authorization = await authorizationFor(parentEndpoint.url);
            [withdrawer] = await stableReceiptOwners(parentEndpoint, deposit.parentChain, deposit.childChain, [{
              demander: deposit.demander,
              depositNonce: BigInt(deposit.depositNonce),
              amountDeposited: BigInt(deposit.amountDeposited),
              amountDemanded: BigInt(deposit.amountDemanded),
            }], authorization);
            receiptMessage = withdrawer === null ? "no verified payment receipt yet" : `paid by ${short(withdrawer)}`;
          } catch (error) { receiptMessage = `could not check receipt: ${describe(error)}`; }
        } else receiptMessage = `connect ${parentName} to verify payment`;
        if (typeof withdrawer === "string") {
          toast.textContent = `Paid by ${short(withdrawer)}. Keep this recovery record until the receipt is final, then dismiss it.`;
          return;
        }
        let statusMessage: string;
        let result: Awaited<ReturnType<typeof sentStatus>>;
        try {
          result = await sentStatus(reader(childEndpoint.url, deposit.childChain, platform.fetch, childAuth), deposit.transactionCID,
            { from: deposit.demander, nonce: BigInt(deposit.transactionNonce) });
          statusMessage = `Deposit: ${statusText(result)}`;
        } catch (e) {
          result = { kind: "unknown to node" } as const;
          statusMessage = `Deposit status unavailable: ${describe(e)}`;
        }
        toast.textContent = `${statusMessage}; ${receiptMessage}.`;
        if (result.kind === "unknown to node" || result.kind === "pending or dropped") {
          retryButton?.remove();
          const retry = h("button", { class: "btn", onclick: async () => {
              retry.disabled = true; toast.textContent = "Resubmitting the exact saved deposit…";
              try {
                let exact = deposit.signedSubmit;
                if (!exact) {
                  const rebuilt = await wallet.signDeposit({
                    from: deposit.demander, amountDeposited: deposit.amountDeposited,
                    amountDemanded: deposit.amountDemanded, depositNonce: deposit.depositNonce,
                    fee: deposit.fee, nonce: deposit.transactionNonce, chainPath: [...deposit.childChain],
                  });
                  if (!rebuilt.ok) throw new Error(rebuilt.error);
                  if (rebuilt.signedSubmit.transactionCID !== deposit.transactionCID) {
                    throw new Error("The reconstructed deposit does not match the saved transaction; nothing was submitted.");
                  }
                  exact = rebuilt.signedSubmit;
                  await update((s) => ({ ...s, openDeposits: s.openDeposits.map((item) => item.transactionCID === deposit.transactionCID
                    ? { ...item, signedSubmit: exact } : item) }));
                }
                const submitted = await resubmitExact(childEndpoint.url, childAuth, exact);
                toast.textContent = submitted.kind === "submitted" ? "Exact deposit resubmitted."
                  : `${submitted.kind === "refused" ? "Retry rejected" : "Retry outcome unknown"}: ${describe(submitted.error)} The saved deposit was kept.`;
                retry.disabled = false;
              } catch (e) {
                toast.textContent = describe(e); retry.disabled = false;
              }
          } }, "Resubmit exact deposit") as HTMLButtonElement;
          retryButton = retry;
          check.after(retry);
        }
        check.disabled = false;
      } catch (e) {
        toast.textContent = describe(e);
        check.disabled = false;
      }
    } }, "Check payment") as HTMLButtonElement;
    const dismiss = h("button", { class: "btn", onclick: async () => {
      if (await dismissRecovery("this pending sale", (s) => completeOpenDeposit(s, deposit.transactionCID))) depositsScreen();
    } }, "Dismiss");
    list.append(h("div", { class: "stack compact" },
      h("div", { class: "row" },
        h("span", { class: "v" }, `${fmt(deposit.amountDeposited)} on ${deposit.childChain.join("/")}`),
        h("span", { class: "muted" }, `for ${fmt(deposit.amountDemanded)} on ${deposit.parentChain.join("/")}`)),
      h("div", { class: "row-actions" }, check, dismiss, toast)));
  }
  render(h("div", { class: "stack" }, h("h1", {}, "Pending sales"), list,
    h("button", { class: "btn block", onclick: settingsScreen }, "Back")));
}

function purchasesScreen() {
  void reconcileRecovery();
  const list = h("div", { class: "kv" });
  for (const purchase of settings.openPurchases) {
    const receive = purchase.offers.reduce((sum, offer) => sum + BigInt(offer.amountDeposited), 0n);
    list.append(h("div", { class: "stack compact" },
      h("button", { class: "chain-menu-item", onclick: () => purchaseScreen(purchase) },
        h("span", {}, `${fmt(receive)} on ${purchase.childChain.join("/")}`),
        h("span", { class: "muted" }, purchase.withdrawalCID ? "Withdrawal submitted" : "Complete")),
      h("button", { class: "text-action", onclick: async () => {
        if (await dismissRecovery("this pending purchase", (s) => completeOpenPurchase(s, purchase.receiptCID))) purchasesScreen();
      } }, "Dismiss")));
  }
  render(h("div", { class: "stack" }, h("h1", {}, "Pending purchases"), list,
    h("button", { class: "btn block", onclick: settingsScreen }, "Back")));
}

function purchaseScreen(purchase: OpenPurchase) {
  void reconcileRecovery();
  const childName = purchase.childChain.join("/");
  const parentName = purchase.parentChain.join("/");
  const childEndpoint = endpointFor(childName);
  const parentEndpoint = endpointFor(parentName);
  const totalReceive = purchase.offers.reduce((sum, offer) => sum + BigInt(offer.amountDeposited), 0n);
  const totalPaid = purchase.offers.reduce((sum, offer) => sum + BigInt(offer.amountDemanded), 0n);
  const feeInput = h("input", { type: "text", inputmode: "numeric", value: defaultFee(settings, childName) }) as HTMLInputElement;
  const toast = h("div", { class: "toast" }, purchase.withdrawalCID ? "Checking withdrawal…" : "Check the parent receipt before withdrawing.");
  const withdraw = h("button", { class: "block" }, "Check & withdraw tokens") as HTMLButtonElement;
  render(h("div", { class: "stack" }, h("h1", {}, "Complete purchase"),
    h("div", { class: "kv" },
      h("div", { class: "row" }, h("span", { class: "k" }, "Paid"), h("span", { class: "v" }, `${fmt(totalPaid)} on ${parentName}`)),
      h("div", { class: "row" }, h("span", { class: "k" }, "Claim"), h("span", { class: "v" }, `${fmt(totalReceive)} on ${childName}`)),
      h("div", { class: "row" }, h("span", { class: "k" }, "Receipt"), h("span", { class: "v mono" }, short(purchase.receiptCID))),
    ),
    ...(purchase.withdrawalCID ? [] : [h("label", { class: "k" }, "Child-chain fee"), feeInput, withdraw]),
    toast,
    h("button", { class: "btn block", onclick: async () => {
      if (await dismissRecovery("this pending purchase", (s) => completeOpenPurchase(s, purchase.receiptCID))) purchasesScreen();
    } }, "Dismiss saved recovery"),
    h("button", { class: "btn block", onclick: purchasesScreen }, "Back"),
  ));
  if (!childEndpoint) {
    toast.textContent = `Connect ${childName} to recover this withdrawal.`;
    withdraw.disabled = true;
    return;
  }
  if (purchase.withdrawalCID) {
    const attempts = purchaseWithdrawalAttempts(purchase);
    const latestAttempt = attempts.find((attempt) => attempt.transactionCID === purchase.withdrawalCID) ?? attempts.at(-1);
    const offerFeeReplacement = (message: string, auth: string | undefined) => {
      const body = latestAttempt?.payload.transaction.body;
      if (!body) { toast.textContent = `${message} This older record cannot be replaced automatically.`; return; }
      const oldCredit = body.accountActions.find((action) => action.owner === purchase.withdrawer)?.delta;
      const oldFee = oldCredit === undefined ? 0n : totalReceive - BigInt(oldCredit);
      const replacementFee = h("input", {
        type: "text", inputmode: "numeric",
        value: (oldFee + 1n > BigInt(defaultFee(settings, childName)) ? oldFee + 1n : BigInt(defaultFee(settings, childName))).toString(),
      }) as HTMLInputElement;
      const replace = h("button", { class: "btn block", onclick: async () => {
        const fee = parseFee(replacementFee.value);
        if (fee === null || fee <= oldFee) { toast.textContent = `Enter a fee above the previous ${oldFee}.`; return; }
        if (fee >= totalReceive) { toast.textContent = "The child amount must exceed the replacement fee."; return; }
        replace.disabled = true; replacementFee.disabled = true; toast.textContent = "Signing a same-nonce fee replacement…";
        try {
          const signed = await wallet.signWithdrawal({
            from: purchase.withdrawer, offers: purchase.offers, fee: fee.toString(),
            nonce: body.nonce.toString(), chainPath: purchase.childChain,
          });
          if (!signed.ok) throw new Error(signed.error);
          const replacementCID = signed.signedSubmit.transactionCID;
          try {
            await update((s) => recordWithdrawalAttempt(recordSent(s, childName, {
                cid: replacementCID, to: purchase.withdrawer, amount: totalReceive.toString(), at: Date.now(),
                from: purchase.withdrawer, fee: fee.toString(), nonce: body.nonce.toString(),
              }), purchase.receiptCID, signed.signedSubmit));
          } catch {
            toast.textContent = "Could not save the replacement; nothing was submitted.";
            replace.disabled = false; replacementFee.disabled = false;
            return;
          }
          const submitted = await resubmitExact(childEndpoint.url, auth, signed.signedSubmit);
          if (submitted.kind === "submitted") {
            toast.textContent = "Fee replacement submitted. Reopen this purchase to check confirmation.";
            replacementFee.remove(); replace.remove();
          } else if (submitted.kind === "refused") {
            await update((s) => forgetWithdrawalAttempt(forgetSent(s, childName, replacementCID), purchase.receiptCID, replacementCID));
            toast.textContent = `Replacement rejected: ${describe(submitted.error)} The preceding attempt remains current.`;
            replacementFee.remove(); replace.remove();
            const reviewPrevious = h("button", { class: "btn block", onclick: () => {
              const current = settings.openPurchases.find((item) => item.receiptCID === purchase.receiptCID);
              if (current) purchaseScreen(current);
            } }, "Review preceding attempt");
            toast.after(reviewPrevious);
          } else {
            toast.textContent = "Replacement outcome unknown. The latest signed attempt remains saved; do not replace it again yet.";
            replacementFee.remove(); replace.remove();
          }
        } catch (e) {
          toast.textContent = e instanceof Error ? e.message : describe(e);
          replace.disabled = false; replacementFee.disabled = false;
        }
      } }, "Replace with higher fee") as HTMLButtonElement;
      toast.textContent = message;
      toast.after(replacementFee, replace);
    };
    if (latestAttempt) {
      const retry = h("button", { class: "btn block", onclick: async () => {
        retry.disabled = true; toast.textContent = "Resubmitting the exact saved withdrawal…";
        try {
          const auth = await authorizationFor(childEndpoint.url);
          const submitted = await resubmitExact(childEndpoint.url, auth, latestAttempt);
          if (submitted.kind === "submitted") toast.textContent = "Exact withdrawal resubmitted.";
          else if (submitted.kind === "refused" && shouldOfferFeeReplacement(submitted.error)) {
            retry.remove();
            offerFeeReplacement(`Exact retry rejected: ${describe(submitted.error)}`, auth);
          } else {
            toast.textContent = `${describe(submitted.error)} Fix the connection or try the exact transaction again; no higher fee is needed.`;
            retry.disabled = false;
          }
        } catch (error) { toast.textContent = describe(error); retry.disabled = false; }
      } }, "Resubmit exact withdrawal") as HTMLButtonElement;
      toast.after(retry);
    }
    void (async () => {
      try {
        const auth = await authorizationFor(childEndpoint.url);
        if (!attempts.length) {
          let legacy;
          try { legacy = await sentStatus(reader(childEndpoint.url, purchase.childChain, platform.fetch, auth), purchase.withdrawalCID!); }
          catch (error) { toast.textContent = `${describe(error)} This older record has no signed bytes for exact recovery.`; return; }
          toast.textContent = `Withdrawal: ${statusText(legacy)}. This older record has no signed bytes for exact recovery.`;
          return;
        }
        const statuses = await Promise.all(attempts.map(async (attempt) => {
          try {
            return { attempt, result: await sentStatus(reader(childEndpoint.url, purchase.childChain, platform.fetch, auth), attempt.transactionCID,
              { from: purchase.withdrawer, nonce: BigInt(attempt.payload.transaction.body.nonce) }) };
          } catch { return { attempt, result: { kind: "unknown to node" } as const }; }
        }));
        const included = statuses.find(({ result }) => result.kind === "included");
        const rank = (kind: typeof statuses[number]["result"]["kind"]) =>
          kind === "included" ? 4 : kind === "pending" ? 3 : kind === "pending or dropped" || kind === "unknown to node" ? 2 : 1;
        const latest = statuses.reduce((best, item) => !best || rank(item.result.kind) > rank(best.kind) ? item.result : best, undefined as typeof statuses[number]["result"] | undefined);
        if (included) {
          // The transaction endpoint is useful status, not a locally verified
          // state proof. Keep recovery metadata until an exact current-state
          // proof can establish that every claimed deposit was spent.
          toast.textContent = `Node reports withdrawal ${short(included.attempt.transactionCID)} included. Recovery record kept pending verified child state.`;
        } else if (latest) {
          toast.textContent = `Withdrawal: ${statusText(latest)}.`;
        }
        if (!included && latest && (latest.kind === "replaced" || latest.kind === "nonce advanced") && parentEndpoint) {
          try {
            const tips = await adjacentTips(parentEndpoint, purchase.parentChain, purchase.childChain, await authorizationFor(parentEndpoint.url));
            const keys = purchase.offers.map((offer) => `${offer.demander}/${offer.amountDemanded}/${offer.depositNonce}`);
            const values = await depositValues(childEndpoint.url, purchase.childChain, keys, platform.fetch, auth, tips.child);
            if (keys.every((key) => (values.get(key) ?? 0n) > 0n)) {
              const restart = h("button", { class: "btn block", onclick: async () => {
                restart.disabled = true;
                await update((s) => ({ ...s, openPurchases: s.openPurchases.map((item) => item.receiptCID === purchase.receiptCID
                  ? { ...item, withdrawalCID: undefined, withdrawalSubmit: undefined } : item) }));
                const current = settings.openPurchases.find((item) => item.receiptCID === purchase.receiptCID);
                if (current) purchaseScreen(current);
              } }, "Try withdrawal with current nonce") as HTMLButtonElement;
              toast.after(restart);
            } else if (keys.every((key) => values.get(key) === 0n)) {
              toast.textContent = "The saved nonce advanced and the deposits are already spent. Recovery is retained until ownership is proven.";
            }
          } catch { /* Without anchored state, never invite a second claim. */ }
        }
      } catch (e) { toast.textContent = describe(e); }
    })();
    return;
  }
  if (!parentEndpoint) {
    toast.textContent = `Connect ${parentName} to verify the purchase receipt before withdrawing.`;
    withdraw.disabled = true;
    return;
  }
  withdraw.addEventListener("click", async () => {
    const fee = parseFee(feeInput.value);
    if (fee === null) { toast.textContent = "Enter a whole fee of 0 or more."; return; }
    if (totalReceive <= fee) { toast.textContent = "The child amount must exceed the withdrawal fee."; return; }
    withdraw.disabled = true; feeInput.disabled = true; toast.textContent = "Checking parent receipt…";
    try {
      const [parentAuth, childAuth] = await Promise.all([authorizationFor(parentEndpoint.url), authorizationFor(childEndpoint.url)]);
      const offers: ActiveDeposit[] = purchase.offers.map((offer) => ({
        demander: offer.demander, depositNonce: BigInt(offer.depositNonce),
        amountDemanded: BigInt(offer.amountDemanded), amountDeposited: BigInt(offer.amountDeposited),
      }));
      const owners = await stableReceiptOwners(parentEndpoint, purchase.parentChain, purchase.childChain, offers, parentAuth);
      for (const [index, offer] of offers.entries()) {
        const recorded = owners[index];
        if (recorded !== null && recorded !== purchase.withdrawer) throw new Error("Another account purchased one of these sell orders.");
        if (recorded === null) {
          await submitChecked(submitter(parentEndpoint.url, platform.fetch, parentAuth), purchase.receiptSubmit);
          throw new Error("The parent receipt is not confirmed yet. Its exact saved transaction was resubmitted; check again after it mines.");
        }
      }
      const child = reader(childEndpoint.url, purchase.childChain, platform.fetch, childAuth);
      const account = await child.account(purchase.withdrawer);
      toast.textContent = "signing child withdrawal…";
      const signed = await wallet.signWithdrawal({
        from: purchase.withdrawer, offers: purchase.offers, fee: fee.toString(),
        nonce: account.nonce.toString(), chainPath: purchase.childChain,
      });
      if (!signed.ok) throw new Error(signed.error);
      const withdrawalCID = signed.signedSubmit.transactionCID;
      await update((s) => recordWithdrawalAttempt(recordSent(s, childName, {
          cid: withdrawalCID, to: purchase.withdrawer, amount: totalReceive.toString(), at: Date.now(),
          from: purchase.withdrawer, fee: fee.toString(), nonce: account.nonce.toString(),
        }), purchase.receiptCID, signed.signedSubmit));
      toast.textContent = "submitting child withdrawal…";
      try {
        await submitChecked(submitter(childEndpoint.url, platform.fetch, childAuth), signed.signedSubmit);
      } catch (e) {
        if (isDefiniteSubmissionRefusal(e)) {
          try {
            await update((s) => forgetWithdrawalAttempt(forgetSent(s, childName, withdrawalCID), purchase.receiptCID, withdrawalCID));
          } catch { /* Refusal remains definite. */ }
          toast.textContent = describe(e);
          withdraw.disabled = false; feeInput.disabled = false;
          return;
        }
        toast.textContent = "Withdrawal outcome unknown. Check this saved purchase before taking another action.";
        return;
      }
      toast.textContent = "Withdrawal submitted. Reopen this purchase to check confirmation.";
    } catch (e) {
      toast.textContent = e instanceof Error && !(e instanceof TypeError) ? e.message : describe(e);
      withdraw.disabled = false; feeInput.disabled = false;
    }
  });
}

function connectionScreen() {
  render(h("div", { class: "stack" },
    h("h1", {}, "Connection"),
    h("p", { class: "muted" }, "Automatic uses the explorer directory to find a verified node for each chain. Choose custom only when you operate or trust a specific node."),
    h("button", { class: settings.nodeMode === "automatic" ? "block" : "btn block", onclick: async () => {
      await update((s) => ({ ...s, nodeMode: "automatic" }));
      route();
    } }, "Automatic (recommended)"),
    h("button", { class: settings.nodeMode === "custom" ? "block" : "btn block", onclick: async () => {
      await update((s) => ({ ...s, nodeMode: "custom" }));
      endpointScreen();
    } }, "Use a custom node"),
    h("button", { class: "btn block", onclick: settingsScreen }, "Back"),
  ));
}

// ---------------- cross-chain order handoff ----------------

function orderFlow() {
  const scan = scanner({
    camera: platform.camera === true,
    openFullPage: platform.openFullPage && (() => platform.openFullPage!("wallet")),
    pasteHint: "paste the lattice://order request",
    onText: (text) => openOrderText(text, scan.status),
  });
  render(h("div", { class: "stack" },
    h("h1", {}, "Open order"),
    h("p", { class: "muted" }, "Scan the QR, load its image, or paste its text. The wallet validates the request and shows the transaction before signing."),
    scan.node,
    h("button", { class: "btn block", onclick: () => { scan.stop(); mainScreen(); } }, "Cancel"),
  ));
}

function openOrderText(text: string, status: El): boolean {
  try {
    const order = decodeOrderRequest(text);
    if (order.side === "buy_child") {
      void reviewBuyOrder(order);
      return true;
    }
    if (order.childChain.join("/") !== settings.chain) {
      status.textContent = `Select ${order.childChain.join("/")} in the wallet before opening this request.`;
      return false;
    }
    reviewSellOrder(order);
    return true;
  } catch (e) { status.textContent = (e as Error).message; return false; }
}

const wireOffer = (offer: ActiveDeposit) => ({
  demander: offer.demander,
  amountDemanded: offer.amountDemanded.toString(),
  amountDeposited: offer.amountDeposited.toString(),
  depositNonce: offer.depositNonce.toString(),
});

function chooseBuyOffers(order: BuyOrder, offers: ActiveDeposit[]): ActiveDeposit[] {
  const sorted = [...offers].sort((a, b) => {
    const left = a.amountDemanded * b.amountDeposited;
    const right = b.amountDemanded * a.amountDeposited;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const chosen: ActiveDeposit[] = [];
  if (order.maxAmountDemanded) {
    let remaining = BigInt(order.maxAmountDemanded);
    for (const offer of sorted) {
      if (offer.amountDemanded <= remaining) { chosen.push(offer); remaining -= offer.amountDemanded; }
    }
  } else {
    const desired = BigInt(order.desiredAmountDeposited!);
    let received = 0n;
    for (const offer of sorted) {
      chosen.push(offer); received += offer.amountDeposited;
      if (received >= desired) break;
    }
    if (received < desired) return [];
  }
  return chosen;
}

async function reviewBuyOrder(order: BuyOrder) {
  const acct = activeAccount()!;
  const parentName = order.parentChain.join("/");
  const childName = order.childChain.join("/");
  const childEndpoint = endpointFor(childName);
  const parentEndpoint = endpointFor(parentName);
  const toast = h("div", { class: "toast" }, "Finding available sell orders…");
  render(h("div", { class: "stack" }, h("h1", {}, "Find sell orders"), toast,
    h("button", { class: "btn block", onclick: orderFlow }, "Cancel")));
  if (!childEndpoint || !parentEndpoint) { toast.textContent = `Connect both ${parentName} and ${childName} before buying.`; return; }
  if (!parentEndpoint.acceptsSubmit || !childEndpoint.acceptsSubmit) {
    toast.textContent = "Both the parent and child nodes must accept transactions before buying.";
    return;
  }
  let childAuth: string | undefined, parentAuth: string | undefined;
  try { [childAuth, parentAuth] = await Promise.all([authorizationFor(childEndpoint.url), authorizationFor(parentEndpoint.url)]); }
  catch (e) { toast.textContent = describe(e); return; }
  let offers: ActiveDeposit[], minRelayFee: bigint | undefined, childMinRelayFee: bigint | undefined;
  const stableDeposits = () => withStableTip(parentEndpoint, order.parentChain, parentAuth, async (parentTip) => {
    const directory = order.childChain.at(-1)!;
    const parent = reader(parentEndpoint.url, [...order.parentChain], platform.fetch, parentAuth);
    const child = (await parent.children(parentTip)).find((entry) => entry.directory === directory);
    if (!child) throw new Error(`The current ${parentName} tip does not commit ${childName}.`);
    const listed = await activeDeposits(childEndpoint.url, order.childChain, platform.fetch, childAuth, child.blockHash);
    return { tips: { parent: parentTip, child: child.blockHash }, listed };
  });
  const unclaimedOffers = async (listed: ActiveDeposit[], parentTip: string) => {
    let eligible = [...listed];
    const verified = new Set<string>();
    const identity = (offer: ActiveDeposit) => `${offer.demander}/${offer.amountDemanded}/${offer.depositNonce}`;
    while (true) {
      const selected = chooseBuyOffers(order, eligible);
      if (!selected.length) return selected;
      const unchecked = selected.find((offer) => !verified.has(identity(offer)));
      if (!unchecked) return selected;
      if (await receiptWithdrawer(parentEndpoint.url, order.parentChain, order.childChain, unchecked, platform.fetch, parentAuth, parentTip) === null) {
        verified.add(identity(unchecked));
      } else {
        const claimed = identity(unchecked);
        eligible = eligible.filter((offer) => identity(offer) !== claimed);
      }
    }
  };
  try {
    const { tips, listed } = await stableDeposits();
    offers = await unclaimedOffers(listed, tips.parent);
    [minRelayFee, childMinRelayFee] = await Promise.all([
      reader(parentEndpoint.url, [...order.parentChain], platform.fetch, parentAuth).chainInfo().then((info) => info.minRelayFee),
      reader(childEndpoint.url, [...order.childChain], platform.fetch, childAuth).chainInfo().then((info) => info.minRelayFee),
    ]);
  } catch (e) { toast.textContent = "Could not read active sell orders: " + describe(e); return; }
  if (!offers.length) { toast.textContent = "No active sell orders satisfy this purchase amount."; return; }
  const totalPay = offers.reduce((sum, offer) => sum + offer.amountDemanded, 0n);
  const totalReceive = offers.reduce((sum, offer) => sum + offer.amountDeposited, 0n);
  if (childMinRelayFee === undefined || totalReceive <= childMinRelayFee) {
    toast.textContent = "These sell orders cannot safely cover the child-chain withdrawal fee.";
    return;
  }
  const feeInput = h("input", { type: "text", inputmode: "numeric", value: defaultFee(settings, parentName) }) as HTMLInputElement;
  const feeNote = h("div", { class: "warn" });
  const checkFee = () => {
    const fee = parseFee(feeInput.value);
    feeNote.textContent = fee === null ? "Enter a whole fee of 0 or more." : feeWarning(fee, minRelayFee) ?? "";
  };
  feeInput.addEventListener("input", checkFee); checkFee();
  const buyButton = h("button", { class: "block" }, "Pay & reserve tokens") as HTMLButtonElement;
  render(h("div", { class: "stack" },
    h("h1", {}, "Review purchase"),
    h("p", { class: "warn" }, "Payment on the parent chain is irreversible. After it confirms, complete the child-chain withdrawal from Settings."),
    h("div", { class: "kv" },
      h("div", { class: "row" }, h("span", { class: "k" }, "You pay"), h("span", { class: "v" }, `${fmt(totalPay)} on ${parentName}`)),
      h("div", { class: "row" }, h("span", { class: "k" }, "You receive"), h("span", { class: "v" }, `${fmt(totalReceive)} on ${childName}`)),
      h("div", { class: "row" }, h("span", { class: "k" }, "Sell orders"), h("span", { class: "v" }, offers.length.toString())),
      h("div", { class: "row" }, h("span", { class: "k" }, "Child withdrawal fee"), h("span", { class: "v" }, `at least ${fmt(childMinRelayFee)}`)),
      h("div", { class: "row" }, h("span", { class: "k" }, "Account"), h("span", { class: "v mono" }, short(acct.address))),
    ),
    h("label", { class: "k" }, "Parent-chain fee"), feeInput, feeNote, toast, buyButton,
    h("button", { class: "btn block", onclick: orderFlow }, "Cancel"),
  ));
  buyButton.addEventListener("click", async () => {
    if (Date.parse(order.expiresAt) <= Date.now() + 60_000) { toast.textContent = "This request is expired or has less than one minute left."; return; }
    const fee = parseFee(feeInput.value);
    if (fee === null) { toast.textContent = "Enter a whole fee of 0 or more."; return; }
    buyButton.disabled = true; feeInput.disabled = true; toast.textContent = "Rechecking sell orders…";
    try {
      const { tips, listed: currentDeposits } = await stableDeposits();
      for (const offer of offers) {
        const stillLocked = currentDeposits.some((current) => current.demander === offer.demander
          && current.depositNonce === offer.depositNonce && current.amountDemanded === offer.amountDemanded
          && current.amountDeposited === offer.amountDeposited);
        if (!stillLocked) throw new Error("A selected sell order is no longer locked. Create a fresh request.");
        if (await receiptWithdrawer(parentEndpoint.url, order.parentChain, order.childChain, offer, platform.fetch, parentAuth, tips.parent) !== null) {
          throw new Error("A selected sell order was already purchased. Create a fresh request.");
        }
      }
      const parent = reader(parentEndpoint.url, [...order.parentChain], platform.fetch, parentAuth);
      const account = await parent.account(acct.address);
      if (totalPay + fee > account.balance) throw new Error(`Insufficient parent balance (have ${fmt(account.balance)}, need ${fmt(totalPay + fee)}).`);
      toast.textContent = "signing parent receipt…";
      const signed = await wallet.signReceipt({
        from: acct.address, offers: offers.map(wireOffer), directory: order.childChain.at(-1)!,
        fee: fee.toString(), nonce: account.nonce.toString(), chainPath: [...order.parentChain],
      });
      if (!signed.ok) throw new Error(signed.error);
      const purchase: OpenPurchase = {
        receiptCID: signed.signedSubmit.transactionCID, receiptSubmit: signed.signedSubmit, withdrawer: acct.address,
        offers: offers.map(wireOffer), parentChain: [...order.parentChain], childChain: [...order.childChain], createdAt: Date.now(),
      };
      const purchaseAlreadySaved = settings.openPurchases.some((item) => item.receiptCID === purchase.receiptCID);
      await update((s) => recordSent(recordOpenPurchase(s, purchase), parentName, {
        cid: purchase.receiptCID, to: `buy on ${childName}`, amount: totalPay.toString(), at: Date.now(),
        from: acct.address, fee: fee.toString(), nonce: account.nonce.toString(),
      }));
      toast.textContent = "submitting parent receipt…";
      try {
        await submitChecked(submitter(parentEndpoint.url, platform.fetch, parentAuth), signed.signedSubmit);
      } catch (e) {
        if (isDefiniteSubmissionRefusal(e)) {
          if (!purchaseAlreadySaved) {
            try {
              await update((s) => ({
                ...forgetSent(s, parentName, purchase.receiptCID),
                openPurchases: s.openPurchases.filter((item) => item.receiptCID !== purchase.receiptCID),
              }));
            } catch { /* Refusal remains definite. */ }
            toast.textContent = describe(e);
            buyButton.disabled = false; feeInput.disabled = false;
          } else {
            toast.textContent = `Retry rejected: ${describe(e)} The earlier ambiguous purchase remains saved.`;
          }
          return;
        }
        purchaseScreen(purchase);
        return;
      }
      purchaseScreen(purchase);
    } catch (e) {
      toast.textContent = e instanceof Error && !(e instanceof TypeError) ? e.message : describe(e);
      buyButton.disabled = false; feeInput.disabled = false;
    }
  });
}

function enableOrderDrop() {
  if (dropReady.has(document)) return;
  dropReady.add(document);
  let depth = 0;
  let notice: El | undefined;
  const available = () => st.initialized && !st.locked && !!activeAccount() && !!endpoint();
  const show = (text = "Drop a cross-chain order") => {
    notice ??= h("div", { class: "order-drop", role: "status" });
    notice.className = "order-drop";
    notice.textContent = text;
    if (!notice.isConnected) document.body.append(notice);
  };
  const hide = () => { notice?.remove(); notice = undefined; };

  document.addEventListener("dragenter", (event) => {
    if (!available()) return;
    event.preventDefault();
    depth += 1;
    show();
  });
  document.addEventListener("dragover", (event) => {
    if (!available()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", () => {
    if (depth > 0) depth -= 1;
    if (depth === 0) hide();
  });
  document.addEventListener("drop", async (event) => {
    if (!available()) return;
    event.preventDefault();
    depth = 0;
    show("Opening cross-chain order…");
    const transfer = event.dataTransfer;
    const texts: string[] = [];
    try {
      if (transfer) {
        const lattice = transfer.getData("application/x-lattice-order").trim();
        const plain = transfer.getData("text/plain").trim();
        const uri = transfer.getData("text/uri-list").trim();
        if (lattice) texts.push(lattice);
        if (plain) texts.push(plain, ...plain.split(/\s+/));
        if (uri) texts.push(uri, ...uri.split(/\s+/));
        for (const file of Array.from(transfer.files)) texts.push(...await scannerFileTexts(file));
      }
      for (const text of new Set(texts)) {
        if (openOrderText(text, notice!)) { hide(); return; }
      }
      notice!.className = "order-drop error";
      if (!texts.length) notice!.textContent = "Drop order text, a text file, or a QR image.";
    } catch (e) {
      notice!.className = "order-drop error";
      notice!.textContent = (e as Error).message;
    }
    setTimeout(hide, 2500);
  });
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
    const depositAlreadySaved = settings.openDeposits.some((item) => item.transactionCID === cid);
    try {
      // Persist the exact signed attempt before touching the network. A timeout
      // can mean the node accepted it even though no response arrived.
      await update((s) => recordSent(recordOpenDeposit(s, {
        transactionCID: cid, demander: acct.address,
        depositNonce: depositNonce.toString(), amountDeposited: order.amountDeposited,
        amountDemanded: order.amountDemanded, fee: fee.toString(), transactionNonce: nonce.toString(),
        childChain: [...order.childChain], parentChain: [...order.parentChain],
        createdAt: Date.now(), expiresAt: order.expiresAt, signedSubmit: signed.signedSubmit,
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
    } catch (e) {
      if (isDefiniteSubmissionRefusal(e)) {
        if (!depositAlreadySaved) {
          try { await update((s) => forgetSent(completeOpenDeposit(s, cid), chain, cid)); } catch { /* Refusal remains definite. */ }
          toast.textContent = describe(e);
          lockButton.disabled = false; feeInput.disabled = false;
        } else {
          toast.textContent = `Retry rejected: ${describe(e)} The earlier ambiguous deposit remains saved.`;
        }
        return;
      }
      // Never return to a control that re-signs with a newly read account
      // nonce. Track this exact CID; resubmission must reuse its signed bytes.
      sentScreen(cid, { uncertain: true, from: acct.address, nonce, kind: "deposit" });
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
  const fee = h("input", { type: "text", inputmode: "numeric", value: defaultFee(settings, settings.chain) }) as HTMLInputElement;
  const feeNote = h("div", { class: "warn" });
  const feeHelp = h("p", { class: "muted" }, "The wallet never changes your fee. A node minimum is only a warning; confirmation depends on miners and current demand.");
  const feeAdvanced = h("details", { class: "advanced" },
    h("summary", {}, "Custom fee"),
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
  client().chainInfo().then((info) => {
    minRelayFee = info.minRelayFee;
    checkFee();
  }).catch(() => {});
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Send on " + settings.chain),
      ...(submitOK ? [] : [h("p", { class: "warn" }, "This node does not accept submits. Use your own node, or an endpoint whose operator accepts public submits.")]),
      h("label", { class: "k" }, "To"), to,
      h("label", { class: "k" }, "Amount"), amount,
      feeHelp,
      feeAdvanced,
      err,
      ...(submitOK ? [h("button", { class: "block", onclick: () => prepareReview() }, "Review")] : []),
      h("button", { class: "btn block", onclick: mainScreen }, "Cancel"),
    ),
  );
  async function prepareReview() {
    err.textContent = "";
    const toAddr = to.value.trim();
    if (!isAccountAddress(toAddr)) { err.textContent = "Enter a valid recipient address."; return; }
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
  const sendButton = h("button", { class: "block", onclick: confirm }, "Sign & send") as HTMLButtonElement;
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
      sendButton,
      h("button", { class: "btn block", onclick: mainScreen }, "Cancel"),
    ),
  );

  async function confirm() {
    if (sendButton.disabled) return;
    sendButton.disabled = true;
    toast.textContent = "signing…";
    let signed;
    try {
      signed = await wallet.signTransfer({ from: acct.address, to, amount: amount.toString(), fee: fee.toString(), nonce: nonce.toString(), chainPath: chainPath() });
    } catch (e) {
      toast.textContent = describe(e); sendButton.disabled = false; return;
    }
    if (!signed.ok) { toast.textContent = signed.error; sendButton.disabled = false; return; }
    toast.textContent = "submitting…";
    const cid = signed.signedSubmit.transactionCID;
    const chain = settings.chain;
    const transferAlreadySaved = settings.pendingSubmissions.some((item) => item.cid === cid);
    try {
      const pending = {
        cid, to, amount: amount.toString(), at: Date.now(),
        from: acct.address, fee: fee.toString(), nonce: nonce.toString(), signedSubmit: signed.signedSubmit,
        chain,
      };
      await update((s) => recordPendingSubmission(recordSent(s, chain, {
        cid, to, amount: amount.toString(), at: pending.at,
        from: acct.address, fee: fee.toString(), nonce: nonce.toString(),
      }), pending));
    } catch {
      toast.textContent = "Could not save the signed transaction; nothing was submitted.";
      sendButton.disabled = false;
      return;
    }
    try {
      await submitChecked(submitter(endpoint()!.url, platform.fetch, nodeAuth), signed.signedSubmit);
      sentScreen(cid);
    } catch (e) {
      if (isDefiniteSubmissionRefusal(e)) {
        if (!transferAlreadySaved) {
          try { await update((s) => completePendingSubmission(forgetSent(s, chain, cid), cid)); } catch { /* The refusal remains definite. */ }
          toast.textContent = describe(e);
          sendButton.disabled = false;
        } else {
          toast.textContent = `Retry rejected: ${describe(e)} The earlier ambiguous transaction remains saved.`;
        }
        return;
      }
      sentScreen(cid, { uncertain: true, from: acct.address, nonce });
    }
  }
}

function pendingSubmissionsScreen() {
  void reconcileRecovery();
  const list = h("div", { class: "kv" });
  for (const pending of settings.pendingSubmissions) {
    const state = h("span", { class: "muted" }, "Checking…");
    const row = h("div", { class: "stack compact" },
      h("div", { class: "row" }, h("span", { class: "v mono" }, short(pending.cid)), h("span", { class: "v" }, pending.chain)),
      h("div", { class: "row-actions" }, state,
        h("button", { class: "text-action", onclick: async () => {
          if (await dismissRecovery("this pending transaction", (s) => completePendingSubmission(s, pending.cid))) pendingSubmissionsScreen();
        } }, "Dismiss")));
    list.append(row);
    const chosen = endpointFor(pending.chain);
    if (!chosen) { state.textContent = `Connect ${pending.chain} to check or resubmit.`; continue; }
    const retry = h("button", { class: "btn", onclick: async () => {
      retry.disabled = true; state.textContent = "Resubmitting the exact saved transaction…";
      try {
        const submitted = await resubmitExact(chosen.url, await authorizationFor(chosen.url), pending.signedSubmit);
        state.textContent = submitted.kind === "submitted" ? "Exact transaction resubmitted."
          : `${submitted.kind === "refused" ? "Retry rejected" : "Retry outcome unknown"}: ${describe(submitted.error)} The saved transaction was kept.`;
      } catch (error) { state.textContent = describe(error); }
      retry.disabled = false;
    } }, "Resubmit exact") as HTMLButtonElement;
    row.append(retry);
    void (async () => {
      try {
        const auth = await authorizationFor(chosen.url);
        const result = await sentStatus(reader(chosen.url, pending.chain.split("/"), platform.fetch, auth), pending.cid,
          { from: pending.from, nonce: BigInt(pending.nonce) });
        state.textContent = statusText(result);
        if (result.kind === "included") state.textContent += " — signed recovery retained against reorgs.";
      } catch (e) { state.textContent = describe(e); }
    })();
  }
  render(h("div", { class: "stack" }, h("h1", {}, "Pending transactions"), list,
    h("p", { class: "muted" }, "The wallet keeps exact signed transactions here until the chain reports a final outcome."),
    h("button", { class: "btn block", onclick: settingsScreen }, "Back")));
}

function sentScreen(txCID: string, outcome?: { uncertain: true; from: string; nonce: bigint; kind?: "deposit" }) {
  const toast = h("div", { class: "toast" });
  const subject = outcome?.kind === "deposit" ? "deposit" : "transaction";
  const status = h("p", { class: outcome ? "warn" : "muted" }, outcome
    ? `Submission outcome unknown. Do not create this ${subject} again; checking this exact transaction…`
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
      .then(async (result) => {
        status.textContent = `Submission outcome: ${statusText(result)}. Do not create this ${subject} again.`;
        if (subject === "transaction" && result.kind === "included") status.textContent += " Signed recovery retained against reorgs.";
      })
      .catch((e) => { status.textContent = `${describe(e)} The signed ${subject} remains saved; do not create it again.`; });
  }
}

/** What this wallet sent on this chain, with each transaction's status from the node. */
async function historyScreen() {
  void reconcileRecovery();
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
  const checks: Promise<void>[] = [];
  for (const t of sent) {
    const s = h("span", { class: "k" }, "…");
    const row = h("div", { class: "row" }, h("span", { class: "v mono" }, short(t.cid)), h("span", { class: "v" }, fmt(t.amount)), s);
    list.append(row);
    const recorded = t.from && t.nonce !== undefined ? { from: t.from, nonce: BigInt(t.nonce) } : undefined;
    checks.push(sentStatus(client(), t.cid, recorded).then((result) => {
      s.textContent = statusText(result);
      if (result.kind === "included") { s.textContent += " (recovery retained)"; return; }
      const recovery = settings.pendingSubmissions.find((pending) => pending.cid === t.cid)?.signedSubmit ?? t.signedSubmit;
      if (!recovery) return undefined;
      const retry = h("button", { class: "btn", onclick: async () => {
        retry.disabled = true;
        const submitted = await resubmitExact(endpoint()!.url, nodeAuth, recovery);
        s.textContent = submitted.kind === "submitted" ? "Exact transaction resubmitted"
          : `${submitted.kind === "refused" ? "Retry rejected" : "Retry outcome unknown"}: ${describe(submitted.error)}; saved transaction kept`;
        retry.disabled = false;
      } }, "Resubmit exact") as HTMLButtonElement;
      row.append(retry);
    }).catch((e) => { s.textContent = describe(e); }));
  }
  await Promise.all(checks);

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
  enableOrderDrop();
  const badge = document.getElementById("net-badge")!;
  badge.setAttribute("aria-haspopup", "true");
  badge.setAttribute("aria-expanded", "false");
  badge.addEventListener("click", () => {
    if (st.initialized && !st.locked && endpoint()) toggleChainMenu();
  });
  document.getElementById("parent-chain")?.addEventListener("click", () => {
    if (!st.initialized || st.locked || !endpoint()) return;
    const parent = chainPath().slice(0, -1).join("/");
    if (parent) switchToChain(parent, h("div"));
  });
  document.getElementById("settings-button")?.addEventListener("click", () => {
    if (st.initialized && !st.locked && activeAccount() && endpoint()) settingsScreen();
  });
  return refresh();
}
