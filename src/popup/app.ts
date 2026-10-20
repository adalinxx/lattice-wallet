// Selfhold UI, shared by the extension popup and the desktop app. Talks
// only to the signer (key material never enters this module) and to the node
// the user chose for reads/submit. No node is used until one is chosen. Styled with the
// Lattice design system. The host supplies a Platform: signer, settings
// store, network permission, and optionally its own node.

import type { Fetch } from "@adalinxx/lattice-client";
import { nodeCookieAuthorization } from "@adalinxx/lattice-core";
import type { WalletClient } from "../lib/wallet/client.ts";
import { newMnemonic, isValidMnemonic, keyFilePrivateKey } from "../lib/crypto/accounts.ts";
import { reader, submitter, submitChecked, isDefiniteSubmissionRefusal, shouldOfferFeeReplacement, isTransientSubmissionRefusal, isTooLargeRefusal, declaredHosts, spread, describe, feeWarning, sentStatus, statusText, activeDeposits, depositValues, receiptWithdrawer, type ActiveDeposit, OPERATOR_DECLARED } from "../lib/wallet/node.ts";
import { ALL_HTTPS_ORIGINS, HOSTED_NODE_ORIGINS, LATTICE_BUILD_RPC, LATTICE_EXPLORER_RPC, LATTICE_TESTNET_RPC, ROOT_CHAIN, parseChainPath, normalizeNodeURL, originPattern, isLoopbackNodeURL } from "../lib/config.ts";
import { discoveryStarts } from "../lib/wallet/nonce.ts";
import { loadSettings, saveSettings, recordOpenDeposit, completeOpenDeposit, recordOpenPurchase, archiveOpenPurchase, recordWithdrawalAttempt, purchaseWithdrawalAttempts, recordSent, recordPendingSubmission, archivePendingSubmission, defaultFee, parseFee, type Settings, type ChosenEndpoint, type KeyValueStore, type OpenPurchase, type SentTransaction } from "../lib/wallet/settings.ts";
import type { WalletState, AccountView, SignedSubmit } from "../lib/wallet/types.ts";
import { decodeOrderRequest, type BuyOrder, type SellOrder } from "../lib/wallet/order.ts";
import { decodeWriteRequest } from "../lib/wallet/write-request.ts";
import { backupMenu, restoreMenu, type BackupHost } from "./backup.ts";
import { scanner, scannerFileTexts } from "./scanner.ts";
import { textSvg } from "../lib/qr/render.ts";
import { isAccountAddress, LABEL_MAX } from "../lib/wallet/session.ts";
import { replacementTransfer } from "../lib/wallet/replacement.ts";

export interface Platform {
  /** The signer: the extension's background worker, or the desktop app's in-page signer. */
  wallet: WalletClient;
  /** Where non-secret settings live. */
  store: KeyValueStore;
  /** Ask for network reach to these origin patterns (inside the user's click). */
  requestOrigins(origins: string[]): Promise<boolean>;
  /** Whether these origins were already granted, used to resume after Chrome closes a permission prompt. */
  hasOrigins?(origins: string[]): Promise<boolean>;
  /** Browser-specific guidance for managing site access outside the wallet. */
  siteAccessHelp?: string;
  /**
   * The host's own node (its loopback operator URL), when it runs one: every
   * chain then reads and submits through it, and no endpoint is chosen. A
   * stopped node reads as unreachable, like any other.
   */
  ownNode?: string;
  /** The fetch every node call uses (default: the browser's). */
  fetch?: Fetch;
  /**
   * The host's own screens (the desktop's mining and node pages), each a
   * button on the home screen, in Settings, or on both when `on` is left out.
   * `back` re-renders the wallet.
   */
  actions?: {
    label: string;
    on?: "home" | "settings";
    run(back: () => void): void;
    /** In Settings, what the row says beside its label: what the thing is doing now. */
    summary?(): Promise<string>;
  }[];
  /**
   * What the person should know about the host before trusting what the home
   * screen shows, for the chain in view, each with at most one thing to do
   * about it (the desktop: its node is stopped, starting, or still syncing).
   * Read each time the balance is.
   */
  notices?(chain: string): Promise<{ text: string; action?: { label: string; run(): Promise<void> } }[]>;
  /**
   * Have the host say when its signer locks (its idle timer fired, the
   * computer slept), so the page covers itself at once instead of asking.
   */
  onLocked?(tell: () => void): void;
  /**
   * The signer runs where the browser stops it when idle (the extension's
   * worker) and can lose its keys without a word: check in while in view,
   * which also keeps it running.
   */
  signerCanStop?: boolean;
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
  chains?: {
    list(): Promise<string[]>;
    add(chain: string): Promise<void>;
    /**
     * Every chain the host's node can see, hosted or not. Without it the
     * chain menu learns of unhosted chains only under the current chain.
     */
    seen?(): Promise<string[]>;
    /**
     * Open the host's own page for its chains, or for one of them; `back`
     * returns to the wallet. With it, the chain menu only switches: a chain
     * the node does not host is taken up there, not from the menu.
     */
    manage?(back: () => void, chain?: string): void;
  };
  /** This page may open the camera (an extension popup cannot hold the permission). */
  camera?: boolean;
  /** The host reviews lattice://write requests in an approval window of its own. */
  writeRequests?: boolean;
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
type ActionIcon = "copy" | "refresh" | "edit";
/** Familiar Lucide action geometry, redrawn at Lattice's hairline weight. */
function actionIcon(name: ActionIcon): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    class: "action-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true", focusable: "false",
  })) svg.setAttribute(key, value);
  const shape = (tag: "path" | "rect", attributes: Record<string, string>) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    svg.append(node);
  };
  if (name === "refresh") {
    shape("path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" });
    shape("path", { d: "M21 3v5h-5" });
    shape("path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" });
    shape("path", { d: "M8 16H3v5" });
  } else if (name === "edit") {
    shape("path", { d: "M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" });
    shape("path", { d: "m15 5 4 4" });
  } else {
    shape("rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" });
    shape("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" });
  }
  return svg;
}
const short = (s: string) => (s.length <= 22 ? s : `${s.slice(0, 12)}…${s.slice(-8)}`);
// Exact: amounts are UInt64, never rounded through a double.
const fmt = (n: string | bigint) => BigInt(n).toLocaleString();
/** An amount with what it is an amount of: a chain's coin has no name but the chain's path. */
const amountOn = (n: string | bigint, chain: string) => `${fmt(n)} on ${chain}`;
/** Text as a QR code, drawn by our own encoder and parsed as SVG, never as HTML. */
function qrNode(text: string): El {
  const box = h("div", { class: "qr" });
  box.append(document.importNode(new DOMParser().parseFromString(textSvg(text), "image/svg+xml").documentElement, true));
  return box;
}
const depositKey = (offer: { demander: string; amountDemanded: string | bigint; depositNonce: string | bigint }) =>
  `${offer.demander}/${offer.amountDemanded}/${offer.depositNonce}`;
const view = () => document.getElementById("view")!;
let renderVersion = 0;
export const render = (node: El) => {
  renderVersion += 1;
  closeChainMenu();
  view().replaceChildren(node);
  // The top-left button opens Settings, and on Settings it does what Done does.
  // It says so in words: a mark alone does not read as a button.
  const label = onSettingsScreen() ? "Close settings" : "Open settings";
  const button = document.getElementById("settings-button");
  if (button) {
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    let word = button.querySelector(".brand-label");
    if (!word) { word = h("span", { class: "brand-label" }); button.append(word); }
    word.textContent = onSettingsScreen() ? "Close" : "Settings";
  }
  showHeaderControls();
};
/** The header's controls act only on an open wallet with a node, so they are shown only then. */
function showHeaderControls() {
  const usable = !!st?.initialized && !st.locked && !!settings && !!activeAccount() && !!endpoint();
  for (const id of ["settings-button", "net-badge"]) {
    const control = document.getElementById(id);
    if (control) control.style.visibility = usable ? "" : "hidden";
  }
}
const onSettingsScreen = () => !!document.getElementById("settings-screen");

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
/** The account just added: the home screen opens with its name ready to type. */
let nameOnOpen: string | undefined;
let nodeAuthURL: string | undefined;
const client = () => {
  const chosen = endpoint()!;
  return reader(chosen.url, chainPath(), platform.fetch, nodeAuthURL === chosen.url ? nodeAuth : undefined);
};
async function authorizationFor(url: string): Promise<string | undefined> {
  if (platform.ownNode) return undefined; // the host attaches its own node's cookie
  const r = await wallet.nodeAuthorization(url);
  return r.ok ? r.authorization : undefined;
}
let updateQueue: Promise<unknown> = Promise.resolve();
async function withSettingsLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = navigator.locks;
  return locks ? locks.request("nexus-wallet-settings", { mode: "exclusive" }, task) : task();
}
function update(change: (s: Settings) => Settings): Promise<void> {
  const run = updateQueue.then(() => withSettingsLock(async () => {
    const next = change(await loadSettings(store));
    await saveSettings(store, next);
    settings = next;
    syncBadge();
  }));
  updateQueue = run.catch(() => {});
  return run;
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
  } finally {
    invalidateRecoveryStatus(signed.transactionCID);
  }
}

/** The parent's current tip and the child block that tip commits. */
async function adjacentTips(parentEndpoint: ChosenEndpoint, parentChain: readonly string[], childChain: readonly string[], parentAuth?: string, expectedParentTip?: string) {
  const parent = reader(parentEndpoint.url, [...parentChain], platform.fetch, parentAuth);
  const parentTip = expectedParentTip ?? (await parent.latestBlock()).hash;
  const directory = childChain.at(-1);
  if (!directory || childChain.length !== parentChain.length + 1
    || childChain.slice(0, -1).some((part, index) => part !== parentChain[index])) {
    throw new Error("Cross-chain recovery requires a direct parent and child.");
  }
  const child = (await parent.children(parentTip)).find((entry) => entry.directory === directory);
  if (!child) throw new Error(`The current ${parentChain.join("/")} tip does not commit ${childChain.join("/")}.`);
  return { parent: parentTip, child: child.blockHash };
}

/** The child node's chain must contain the child block the parent tip commits:
 * the block it serves by that hash is the one it has at that height. A positive
 * consistency check between the two nodes, never proof of either.
 *
 * It is not a comparison of tips. A child advances on grinds that meet its own
 * target without meeting its parent's, so between parent blocks the child's tip
 * is ahead of the block its parent last committed, usually by many blocks.
 * Child state is therefore read and proven at the child node's own tip. */
async function requireCommittedChild(
  parentEndpoint: ChosenEndpoint, parentChain: readonly string[], childEndpoint: ChosenEndpoint, childChain: readonly string[],
  parentAuth?: string, childAuth?: string, expectedParentTip?: string,
): Promise<void> {
  const committed = (await adjacentTips(parentEndpoint, parentChain, childChain, parentAuth, expectedParentTip)).child;
  const child = reader(childEndpoint.url, [...childChain], platform.fetch, childAuth);
  const mismatch = () => new Error(`The ${childChain.join("/")} node's chain does not contain the block ${parentChain.join("/")} currently commits for it. The two nodes may be on different branches or still synchronizing; try again shortly.`);
  let height: bigint;
  try { height = (await child.block(committed)).height; } catch (error) {
    if (describe(error).startsWith("not found")) throw mismatch();
    throw error;
  }
  if ((await child.block(height)).hash !== committed) throw mismatch();
}

async function withStableTip<T>(chosen: ChosenEndpoint, chain: readonly string[], authorization: string | undefined, read: (tip: string) => Promise<T>): Promise<T> {
  const client = reader(chosen.url, [...chain], platform.fetch, authorization);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await client.latestBlock();
    try {
      const result = await read(before.hash);
      const after = await client.latestBlock();
      if (before.hash === after.hash) return result;
    } catch (error) {
      const after = await client.latestBlock();
      if (before.hash === after.hash) throw error;
    }
  }
  throw new Error("The chain kept advancing while verified state was read.");
}

async function stableReceiptOwners(parentEndpoint: ChosenEndpoint, parentChain: readonly string[], childChain: readonly string[], offers: readonly ActiveDeposit[], parentAuth?: string) {
  return withStableTip(parentEndpoint, parentChain, parentAuth, (tip) => Promise.all(offers.map((offer) => receiptWithdrawer(
    parentEndpoint.url, parentChain, childChain, offer, platform.fetch, parentAuth, tip,
  ))));
}

const CONFIRMATION_DEPTH = 6n;
async function inclusionDepth(chosen: ChosenEndpoint, chain: readonly string[], cid: string, from: string, nonce: bigint, authorization?: string, knownMempool?: () => Promise<readonly string[]>) {
  const node = reader(chosen.url, [...chain], platform.fetch, authorization);
  const status = await sentStatus(node, cid, { from, nonce }, knownMempool);
  if (status.kind !== "included") return { status, deep: false };
  const tip = await node.chainInfo();
  return { status, deep: tip.height !== undefined && tip.height >= status.height && tip.height - status.height + 1n >= CONFIRMATION_DEPTH };
}

type RecoveryStatuses = Map<string, Awaited<ReturnType<typeof sentStatus>>>;
let reconciliation: Promise<RecoveryStatuses> | undefined;
let lastReconciliationAt = 0;
let lastRecoveryStatuses: RecoveryStatuses = new Map();
let recoveryStatusEpoch = 0;
function invalidateRecoveryStatus(cid?: string) {
  recoveryStatusEpoch += 1;
  lastReconciliationAt = 0;
  if (cid) lastRecoveryStatuses.delete(cid);
}
function reconcileRecovery(): Promise<RecoveryStatuses> {
  if (reconciliation) return reconciliation;
  if (Date.now() - lastReconciliationAt < 30_000) return Promise.resolve(lastRecoveryStatuses);
  const epoch = recoveryStatusEpoch;
  reconciliation = (async () => {
    const statuses: RecoveryStatuses = new Map();
    const auths = new Map<string, Promise<string | undefined>>();
    const mempools = new Map<string, Promise<readonly string[]>>();
    const auth = (url: string) => {
      let pending = auths.get(url);
      if (!pending) { pending = authorizationFor(url); auths.set(url, pending); }
      return pending;
    };
    const mempool = (chosen: ChosenEndpoint, chain: readonly string[], authorization?: string) => {
      const key = `${chosen.url}\n${chain.join("/")}`;
      let pending = mempools.get(key);
      if (!pending) {
        pending = reader(chosen.url, [...chain], platform.fetch, authorization).mempool().then((value) => value.transactions);
        mempools.set(key, pending);
      }
      return pending;
    };
    const completedTransfers: string[] = [];
    const completedPurchases: string[] = [];
    await Promise.all(settings.pendingSubmissions.map(async (pending) => {
      const chosen = endpointFor(pending.chain);
      if (!chosen) return;
      try {
        const chain = pending.chain.split("/");
        const authorization = await auth(chosen.url);
        const result = await inclusionDepth(chosen, chain, pending.cid, pending.from, BigInt(pending.nonce), authorization,
          () => mempool(chosen, chain, authorization));
        statuses.set(pending.cid, result.status);
        if (result.deep) {
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
        const sharedMempool = () => mempool(child, purchase.childChain, childAuth);
        const attempts = purchaseWithdrawalAttempts(purchase);
        const attemptsStatus = await Promise.all(attempts.map((attempt) => inclusionDepth(
          child, purchase.childChain, attempt.transactionCID, purchase.withdrawer,
          BigInt(attempt.payload.transaction.body.nonce), childAuth, sharedMempool,
        )));
        attemptsStatus.forEach((result, index) => statuses.set(attempts[index]!.transactionCID, result.status));
        if (!attemptsStatus.some((result) => result.deep)) return;
        await requireCommittedChild(parent, purchase.parentChain, child, purchase.childChain, await auth(parent.url), childAuth);
        const keys = purchase.offers.map(depositKey);
        const values = await withStableTip(child, purchase.childChain, childAuth,
          (childTip) => depositValues(child.url, purchase.childChain, keys, platform.fetch, childAuth, childTip));
        if (keys.every((key) => values.has(key) && (values.get(key) === 0n || values.get(key) === null))) {
          completedPurchases.push(purchase.receiptCID);
        }
      } catch { /* Missing targeted proof support is inconclusive, not failure. */ }
    }));
    if (completedTransfers.length || completedPurchases.length) {
      try {
        await update((current) => {
          let next = current;
          for (const cid of completedTransfers) next = archivePendingSubmission(next, cid);
          for (const receiptCID of completedPurchases) next = archiveOpenPurchase(next, receiptCID);
          return next;
        });
      } catch { /* Status reads remain useful even if archive persistence failed. */ }
    }
    // A submit or rebroadcast can invalidate these reads while they are in
    // flight. Never let the older pass reinstate its cache afterward.
    if (epoch === recoveryStatusEpoch) {
      lastRecoveryStatuses = statuses;
      lastReconciliationAt = Date.now();
    }
    return statuses;
  })().finally(() => { reconciliation = undefined; });
  return reconciliation;
}

async function dismissRecovery(label: string, remove: (current: Settings) => Settings): Promise<boolean> {
  if (!window.confirm(`Dismiss ${label}? The wallet will delete its saved recovery data. This does not cancel the signed transaction: it may still confirm. This cannot be undone.`)) return false;
  await update(remove);
  return true;
}
const dismissSubmission = (current: Settings, cid: string): Settings => ({
  ...current,
  pendingSubmissions: current.pendingSubmissions.filter((item) => item.cid !== cid),
  confirmedSubmissions: current.confirmedSubmissions.filter((item) => item.cid !== cid),
});
const dismissPurchase = (current: Settings, receiptCID: string): Settings => ({
  ...current,
  openPurchases: current.openPurchases.filter((item) => item.receiptCID !== receiptCID),
  confirmedPurchases: current.confirmedPurchases.filter((item) => item.receiptCID !== receiptCID),
});

export async function ensureOrigins(host: Pick<Platform, "hasOrigins" | "requestOrigins">, origins: string[]): Promise<boolean> {
  if (host.hasOrigins && await host.hasOrigins(origins).catch(() => false)) return true;
  return host.requestOrigins(origins).catch(() => false);
}

/** Discovery walks to whatever hosts each level's nodes declare, so it may
 * reach any HTTPS node; a starting node on this computer is added by name. */
export function discoveryOrigins(bootstrap: string | readonly string[]): string[] {
  const starts = typeof bootstrap === "string" ? [bootstrap] : bootstrap;
  const local = starts.map(originPattern).filter((origin) => !origin.startsWith("https:"));
  return [ALL_HTTPS_ORIGINS, ...new Set(local)];
}

function syncBadge() {
  const b = document.getElementById("net-badge")!;
  // The whole path, since the chain is part of what is about to be signed.
  // Too long, it loses its start and keeps its end: the chain's own name.
  b.replaceChildren(h("span", { class: "chain-path" }, h("bdi", {}, settings.chain)), h("span", { "aria-hidden": "true" }, "▾"));
  b.title = `${settings.chain} — choose a chain`;
  b.setAttribute("aria-label", `Current chain ${settings.chain}. Choose a chain`);
}

function closeChainMenu() {
  document.querySelector(".chain-menu")?.remove();
  document.getElementById("net-badge")?.setAttribute("aria-expanded", "false");
}

async function switchToChain(chain: string, status: El) {
  if (chain === settings.chain) { document.querySelector(".chain-menu")?.remove(); return; }
  // A host with its own node reads a chain only once that node hosts it.
  if (platform.chains && chain !== ROOT_CHAIN) {
    try {
      if (!(await platform.chains.list()).includes(chain)) {
        status.textContent = `Adding ${chain} to your node…`;
        await platform.chains.add(chain);
      }
    } catch (e) { status.textContent = (e as Error).message; return; }
  }
  if (settings.nodeMode === "automatic" && !platform.ownNode && !settings.endpoints[chain] && chain !== ROOT_CHAIN) {
    status.textContent = `Finding a node for ${chain}…`;
    const bootstrap = discoveryStarts(settings);
    // Persist before Chrome opens its permission prompt: the prompt can close
    // this popup and destroy the remainder of this async handler.
    await update((s) => ({
      ...s, chain, pendingAutomaticChain: chain,
      chains: s.chains.includes(chain) ? s.chains : [...s.chains, chain],
    }));
    const granted = await ensureOrigins(platform, discoveryOrigins(bootstrap));
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
  const bootstrap = discoveryStarts(settings);
  try {
    // Begun at a random host, so wallets spread over the hosts of a chain.
    const candidates = spread((await declaredHosts(bootstrap, parseChainPath(chain)!, platform.fetch)).filter((candidate) => candidate.declaresSubmit));
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
  // The hosted endpoints are granted at install; discovery asks for more only when it runs.
  const origins = pending.chain === ROOT_CHAIN && pending.url === LATTICE_BUILD_RPC
    && pending.nodeMode === "automatic" ? [...HOSTED_NODE_ORIGINS] : [originPattern(pending.url)];
  const granted = await ensureOrigins(platform, origins);
  if (granted) return finishPendingEndpoint(status);
  if (pending.clearCookieOnFailure) await wallet.setNodeCookie(pending.url, null);
  await update((s) => { const { pendingEndpoint: _, ...rest } = s; return rest; });
  status.textContent = "Permission to reach that node was not granted.";
  return false;
}

/**
 * The chain menu is the chains as they are: a tree. Every chain this wallet
 * has, a child under its parent and named by the last part of its path, with
 * the one in use marked. One press on any of them goes there.
 *
 * A wallet on its own node has the chains that node hosts, and lists the
 * ones it sees but does not host as such. Any other wallet has the chains it
 * was given, and learns the children of the chain in use from that chain's
 * node; those of another chain appear once it is the one in use.
 */
async function toggleChainMenu() {
  const existing = document.querySelector(".chain-menu");
  if (existing) { closeChainMenu(); return; }
  document.getElementById("net-badge")?.setAttribute("aria-expanded", "true");
  const status = h("div", { class: "toast" });
  const tree = h("ul", { class: "chain-menu-items" });
  const own = platform.chains;
  const manage = () => { closeChainMenu(); if (own?.manage) own.manage(mainScreen); else void chainScreen(); };
  const menu = h("div", { class: "chain-menu", role: "navigation", "aria-label": "Chains" },
    tree, status,
    h("button", { class: "chain-menu-item chain-menu-manage", onclick: manage },
      h("span", {}, own?.manage ? "Manage chains on your node" : own ? "Add a chain" : "Add a chain or change its node"), h("span", { "aria-hidden": "true" }, "›")),
  );
  const current = settings.chain;
  /** Each chain shown, and what is said beside it: nothing for one this wallet has. */
  const shown = new Map<string, "" | "found" | "unhosted">();
  const have = (chain: string, note: "" | "found" | "unhosted" = "") => {
    // A chain is listed under its parent, so every chain above it is listed too.
    const parts = chain.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const above = parts.slice(0, depth).join("/");
      if (!shown.has(above)) shown.set(above, "");
    }
    if (!shown.has(chain) || note === "") shown.set(chain, note);
  };
  const draw = () => {
    const chains = [...shown.keys()].sort((x, y) => x.localeCompare(y));
    // Drawn again as more is learned: whoever is on a row stays on it.
    const focused = (document.activeElement as HTMLElement | null)?.getAttribute?.("data-chain");
    queueMicrotask(() => {
      if (focused) ([...tree.querySelectorAll("[data-chain]")].find((item) => item.getAttribute("data-chain") === focused) as HTMLElement | undefined)?.focus();
    });
    tree.replaceChildren(...outline(chains, (chain, guide) => {
      const note = shown.get(chain)!;
      const here = chain === current;
      const choose = () => {
        if (here) return closeChainMenu();
        // What the node does not host is taken up on the host's own page, where that is offered.
        if (note === "unhosted" && own?.manage) { closeChainMenu(); return own.manage(mainScreen, chain); }
        void switchToChain(chain, status);
      };
      const said = here ? "you are here" : note === "found" ? "found here" : note === "unhosted" ? (own?.manage ? "not hosted" : "add to node") : "";
      return h("button", {
        class: `chain-menu-item${here ? " current" : ""}${note === "unhosted" ? " unhosted" : ""}`, "data-chain": chain,
        ...(here ? { "aria-current": "true" } : {}),
        ...(note === "unhosted" && !own?.manage ? { title: "Your node does not host this chain yet. Choosing it adds it; a running node restarts." } : {}),
        "aria-label": said ? `${chain}, ${said}` : chain,
        onclick: choose,
      },
        h("span", { class: "chain-name", title: chain }, h("span", { class: "tree-guide", "aria-hidden": "true" }, guide), h("span", {}, chain.split("/").pop()!)),
        ...(said ? [h("span", { class: "chain-note" }, said)] : []),
      );
    }));
  };
  have(ROOT_CHAIN);
  have(current);
  for (const saved of own ? [] : settings.chains) have(saved);
  draw();
  document.body.append(menu);
  status.textContent = "Loading…";
  try {
    const hosted = await own?.list();
    for (const chain of hosted ?? []) have(chain);
    for (const chain of (await own?.seen?.().catch(() => [])) ?? []) if (!hosted!.includes(chain)) have(chain, "unhosted");
    // On a node of its own, a chain is hosted or it is not, however it came
    // to be listed (as the parent of one that is seen, say).
    const settle = () => { if (hosted) for (const chain of shown.keys()) if (chain !== ROOT_CHAIN && !hosted.includes(chain)) shown.set(chain, "unhosted"); };
    settle();
    draw();
    // What the chain in use carries: its children, whoever hosts them.
    const latest = await client().latestBlock();
    for (const child of await client().children(latest.hash)) {
      if (!child.directory || child.directory.includes("/")) continue;
      const chain = `${current}/${child.directory}`;
      if (!shown.has(chain)) have(chain, hosted ? "unhosted" : "found");
    }
    settle();
    draw();
    // Only this function's own word is cleared: a switch may have said something since.
    if (status.textContent === "Loading…") status.textContent = "";
  } catch { if (status.textContent === "Loading…") status.textContent = "Could not load every chain."; }
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
    const origins = discoveryOrigins(discoveryStarts(settings));
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
      h("div", { class: "hero" }, h("span", { class: "wordmark" }, "SELFHOLD"), h("p", { class: "muted" }, "open-source. self-custodial. your keys, your control.")),
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
  const strength = h("p", { class: "muted" }, "Use a long, unique passphrase, such as four randomly chosen words. Anyone with an exported backup can guess its password offline.");
  const node = h("div", { class: "stack" }, p1, p2, strength, err);
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

const hostActions = (place: "home" | "settings") => (platform.actions ?? []).filter((a) => !a.on || a.on === place);

/**
 * A row of a list that leads somewhere: what it is, what it is set to or
 * doing now, and that it opens. `leads` false is a row that acts where it
 * stands (locking the wallet) and so has no mark that it opens.
 */
export function navRow(label: string, onclick: () => void, value: string | El = "", leads = true): El {
  // The mark that a row opens is drawn, not written: the row reads as its label and its value.
  return h("button", { class: leads ? "nav-row leads" : "nav-row", "data-row": label, onclick },
    h("span", { class: "nav-what" }, label),
    h("span", { class: "nav-set" }, value),
  );
}

/**
 * Chains laid out as the tree they are: one item a chain, a child's item
 * nested under its parent's. `row` draws a chain's row, given the guide that
 * marks its place (the lines an outline is drawn with). The wallet's chain
 * menu and a host's own pages draw their chains with this, so a chain sits
 * in the same place wherever it is listed.
 */
export function outline(paths: string[], row: (path: string, guide: string) => El): El[] {
  const listed = new Set(paths);
  const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
  const under = (parent: string | undefined) => paths.filter((p) => (parent === undefined ? !listed.has(parentOf(p)) : parentOf(p) === parent));
  const branch = (path: string, guide: string, inherited: string): El => {
    const kids = under(path);
    return h("li", {}, row(path, guide), ...(kids.length ? [h("ul", {}, ...kids.map((kid, i) => {
      const last = i === kids.length - 1;
      return branch(kid, inherited + (last ? "└ " : "├ "), inherited + (last ? "  " : "│ "));
    }))] : []));
  };
  return under(undefined).map((path) => branch(path, "", ""));
}

/** Rows that belong together, under what they are about. */
export function navGroup(label: string, ...rows: El[]): El {
  return h("div", { class: "nav-group" }, h("h2", { class: "nav-label" }, label), h("div", { class: "nav-list" }, ...rows));
}

/** Purchases paid for and not yet claimed: what the wallet has that waits on its owner. */
const purchasesToClaim = () => settings.openPurchases.filter((purchase) => !purchase.withdrawalCID).length;

/** What the home screen says of Activity: what waits on its owner, or else how much is pending. */
function activityNow(): string {
  const claim = purchasesToClaim();
  if (claim) return `${claim} ${claim === 1 ? "purchase" : "purchases"} to claim`;
  const pending = settings.pendingSubmissions.length + settings.openDeposits.length + settings.openPurchases.length;
  return pending ? `${pending} pending` : "";
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
    h("p", { class: "muted" }, "1. Add this line to lattice.json in the node's root, then restart it (lattice down, lattice up):"),
    h("div", { class: "addr mono" }, line),
    h("p", { class: "muted" }, "2. Paste its cookie, the content of <root>/chains/Nexus/.cookie. The node writes a new cookie each time it starts; paste it again after a restart. It is kept encrypted with your keys."),
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
  start.id = "node-start";
  const err = h("div", { class: "toast node-status", role: "status" });
  const found = h("div", { class: "kv" });
  const isChild = chainPath().length > 1;
  // Three ways to choose, each under its own heading, most common first. The
  // steps for pairing a node on this computer stay folded away unless the
  // address typed is on this computer, since no other node needs them.
  const hosted: El[] = [];
  if (settings.chain === ROOT_CHAIN && !platform.ownNode) {
    hosted.push(
      h("button", { class: "btn btn--primary block", onclick: async () => {
        if (await requestEndpoint({
          chain: settings.chain, url: LATTICE_BUILD_RPC, source: "user",
          declaredSubmit: true, requireSubmit: true, nodeMode: "automatic",
        }, err)) route();
      } }, "Use Lattice.build"),
      h("p", { class: "muted" }, "A public Nexus node run by Lattice. Nothing to set up. The wallet checks that it serves this chain and accepts transactions before saving it."),
    );
  }
  if (isChild) {
    if (settings.chain === "Nexus/testnet") {
      hosted.push(
        h("button", { class: "btn btn--primary block", onclick: async () => {
          if (await requestEndpoint({
            chain: settings.chain, url: LATTICE_TESTNET_RPC, source: "user",
            declaredSubmit: true, requireSubmit: true, nodeMode: "automatic",
          }, err)) route();
        } }, "Use Lattice.build testnet"),
        h("p", { class: "muted" }, "A public testnet node run by Lattice. Nothing to set up."),
      );
    }
    hosted.push(
      h("button", { class: hosted.length ? "btn block" : "btn btn--primary block", onclick: () => discoverFrom(true) }, "Find node automatically"),
      h("p", { class: "muted" }, "Asks the Lattice explorer's Nexus service which nodes serve this chain and picks one that accepts transactions. The first time, Chrome asks to let the wallet reach any HTTPS node, since the nodes a chain names are only known as it looks."),
    );
  }
  const pairing = platform.pairOrigin
    ? h("details", { class: "advanced" },
        h("summary", {}, "Pairing a node on this computer"),
        h("div", { class: "advanced-content stack" }, ...pairingSteps(platform.pairOrigin, cookie)))  as HTMLDetailsElement
    : null;
  const showPairing = () => { if (pairing && isLoopbackNodeURL(normalizeNodeURL(url.value) ?? "")) pairing.open = true; };
  url.addEventListener("input", showPairing);
  showPairing();
  url.id = "node-url";
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Node for " + settings.chain),
      ...(current ? [h("div", { class: "kv" },
        h("div", { class: "row" }, h("span", { class: "k" }, "Current node"), h("span", { class: "v mono" }, current.url)),
        h("div", { class: "row" }, h("span", { class: "k" }, "Access"), h("span", { class: "tag" }, current.acceptsSubmit ? "read + send" : "read only")),
      )] : []),
      h("p", { class: "muted" }, `The node is where the wallet reads ${settings.chain} and sends your transactions. Its operator sees your addresses and can answer wrongly; your keys never leave this wallet.`),
      ...(hosted.length ? [h("h2", { class: "section-label" }, "Hosted"), ...hosted] : []),
      h("h2", { class: "section-label" }, "Your own or another node"),
      h("label", { class: "k", for: "node-url" }, "Node address"), url,
      ...(pairing ? [pairing] : []),
      h("button", { class: "btn block", onclick: async () => {
        const n = normalizeNodeURL(url.value);
        if (!n) { err.textContent = "Enter an https:// address, or http:// for a node on this computer (127.0.0.1 or localhost)."; return; }
        const enteredCookie = cookie.value.trim() || undefined;
        if (await requestEndpoint({
          chain: settings.chain, url: n, source: "user", declaredSubmit: true,
          requireSubmit: false, nodeMode: "custom", clearCookieOnFailure: enteredCookie !== undefined,
        }, err, enteredCookie)) route();
      } }, "Use this node"),
      ...(isChild ? [
        h("h2", { class: "section-label" }, "Discover through a Nexus node"),
        h("p", { class: "muted" }, "Ask a Nexus node you choose which nodes serve " + settings.chain + ", then pick one from the list."),
        h("label", { class: "k", for: "node-start" }, "Nexus node to ask"), start,
        h("button", { class: "btn block", onclick: () => discoverFrom() }, "Discover"),
        found,
      ] : []),
      err,
      h("div", { class: "row-actions" },
        ...(current ? [h("button", { class: "btn", onclick: mainScreen }, "Back")] : []),
        h("button", { class: "btn", onclick: chainScreen }, "Change chain")),
    ),
  );

  async function discoverFrom(autoSelect = false, permissionGranted = false, resumeURL?: string) {
    const n = normalizeNodeURL(resumeURL ?? start.value);
    if (!n) { err.textContent = "Enter the starting node's URL."; return; }
    if (!permissionGranted) {
      // Persist first because Chrome can close the popup on a permission prompt.
      await update((s) => ({ ...s, pendingDiscovery: { chain: s.chain, url: n, autoSelect } }));
      const granted = await ensureOrigins(platform, discoveryOrigins(n));
      if (!granted) {
        await update((s) => { const { pendingDiscovery: _, ...rest } = s; return rest; });
        err.textContent = "Permission not granted.";
        return;
      }
    }
    err.textContent = "discovering…";
    found.replaceChildren();
    try {
      const list = await declaredHosts(n, chainPath(), platform.fetch);
      err.textContent = list.length ? "" : "No declared node serves this chain.";
      if (autoSelect) {
        const candidates = spread(list.filter((endpoint) => endpoint.declaresSubmit));
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
        found.append(h("div", { class: "node-row" },
          h("div", { class: "node-text" },
            h("span", { class: "node-name mono" }, e.url),
            h("span", { class: "node-detail" }, e.declaresSubmit ? "declares it accepts transactions" : "read-only")),
          h("button", { class: "btn", onclick: async () => { if (await chooseEndpoint(e.url, "discovered", err, e.declaresSubmit, undefined, false, true)) route(); } }, "Use"),
        ));
      }
      if (list.length) found.append(h("p", { class: "muted node-note" }, `Each serves this chain on that Nexus node's network; ${OPERATOR_DECLARED}.`));
    } catch (e) {
      err.textContent = "Discovery failed: " + (e instanceof RangeError ? e.message : describe(e));
    } finally {
      if (settings.pendingDiscovery) await update((s) => { const { pendingDiscovery: _, ...rest } = s; return rest; });
    }
  }

  const pendingDiscovery = settings.pendingDiscovery;
  if (pendingDiscovery?.chain === settings.chain && platform.hasOrigins) {
    const origins = discoveryOrigins(pendingDiscovery.url);
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
      // A name or address of any length wraps in its own column; the button
      // beside it keeps its size.
      h("div", { class: "kv" }, ...chains.map((c) => h("div", { class: "node-row" },
        h("div", { class: "node-text" },
          h("span", { class: "node-name mono" }, c),
          h("span", { class: "node-detail" }, platform.ownNode ? "own node" : settings.endpoints[c]?.url ?? "no node chosen")),
        h("button", { class: c === settings.chain ? "btn btn--primary" : "btn", ...(c === settings.chain ? { "aria-current": "true" } : {}), onclick: () => pick(c) },
          c === settings.chain ? "Selected" : "Select"),
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
  const openingVersion = renderVersion;
  void reconcileRecovery();
  const acct = activeAccount();
  if (!acct) return render(h("div", { class: "stack" }, h("p", { class: "muted" }, "No active account."), h("button", { class: "btn block", onclick: () => { wallet.lock().then(refresh); } }, "Lock")));
  const balanceV = h("span", { class: "v" }, "…");
  const notices = h("div", { class: "notices" });
  let recheck: ReturnType<typeof setTimeout> | undefined;
  const nodeV = endpoint()!;
  const homePath = [...chainPath()];
  nodeAuth = await authorizationFor(nodeV.url);
  nodeAuthURL = nodeV.url;
  if (openingVersion !== renderVersion) return; // navigation happened while authentication was read
  const homeReads = reader(nodeV.url, homePath, platform.fetch, nodeAuth);
  const toast = h("div", { class: "toast" });

  const accountPicker = h("select", { class: "picker account-picker", onchange: async (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === "__add") {
      const r = await wallet.addAccount();
      if (r.ok) nameOnOpen = r.state.active ?? undefined;
      await refresh();
      return;
    }
    if (v === "__import") return importKeyFlow();
    await wallet.setActive(v); await refresh();
  } }) as HTMLSelectElement;
  const pickerText = (a: AccountView) => `${a.label} · ${short(a.address)}`;
  for (const a of st.accounts) accountPicker.append(h("option", { value: a.address, ...(a.address === acct.address ? { selected: "true" } : {}) }, pickerText(a)));
  accountPicker.append(h("option", { value: "__add" }, "+ Add account"));
  accountPicker.append(h("option", { value: "__import" }, "+ Import key"));

  // The name is changed where it is read: the pencil turns it into a field
  // holding it, Enter or leaving the field keeps the new one, Escape the old.
  // Emptied, the account takes back its default ("Account 2").
  const nameLine = h("span", { class: "account-name" }, acct.label);
  function renameInPlace() {
    if (nameLine.querySelector("input")) return;
    const field = h("input", {
      class: "account-name-field", type: "text", value: acct!.label, maxlength: String(LABEL_MAX),
      "aria-label": "Account name", placeholder: acct!.kind === "hd" ? `Account ${acct!.index + 1}` : `Imported ${acct!.index + 1}`,
      spellcheck: "false", autocomplete: "off",
    }) as HTMLInputElement;
    let done = false;
    // A refused name (too long, another account's) stays in the field after
    // Enter, to be corrected; on leaving the field the old name comes back.
    const finish = async (keep: boolean, leaving = false) => {
      if (done) return;
      done = true;
      const typed = field.value;
      if (keep && typed.trim() !== acct!.label) {
        const r = await wallet.renameAccount(acct!.address, typed);
        if (!r.ok) {
          toast.textContent = r.error;
          if (!leaving && field.isConnected) { done = false; field.focus(); return; }
          nameLine.replaceChildren(acct!.label);
          return;
        }
        st = r.state;
        const renamed = st.accounts.find((a) => a.address === acct!.address);
        if (renamed) {
          acct!.label = renamed.label;
          const option = [...accountPicker.options].find((o) => o.value === renamed.address);
          if (option) option.textContent = pickerText(renamed);
        }
        toast.textContent = "";
      }
      nameLine.replaceChildren(acct!.label);
    };
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); void finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); void finish(false); }
    });
    field.addEventListener("blur", () => { void finish(true, true); });
    nameLine.replaceChildren(field);
    field.focus();
    field.select();
  }

  render(
    h("div", { class: "stack wallet-home" },
      accountPicker,
      notices,
      h("div", { class: "balance-card" },
        h("div", { class: "balance-heading" },
          h("span", { class: "balance-label" }, `Balance on ${homePath.join("/")}`),
          h("button", {
            class: "btn icon-action", type: "button", title: "Refresh balance", "aria-label": "Refresh balance",
            onclick: () => loadBalance(),
          }, actionIcon("refresh")),
        ),
        h("span", { class: "balance-value" }, balanceV),
        h("div", { class: "account-line" },
          h("div", { class: "account-identity" },
            nameLine,
            h("span", { class: "mono account-address" }, acct.address),
          ),
          h("button", {
            class: "btn icon-action", type: "button", title: "Rename account", "aria-label": "Rename account",
            onclick: () => renameInPlace(),
          }, actionIcon("edit")),
          h("button", {
            class: "btn icon-action", type: "button", title: "Copy account address", "aria-label": "Copy account address",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(acct.address);
                toast.textContent = "Account address copied.";
              } catch {
                toast.textContent = "Could not copy the account address.";
              }
            },
          }, actionIcon("copy")),
        ),
      ),
      h("div", { class: "primary-actions" },
        h("button", { class: "btn btn--primary", onclick: sendFlow }, "Send"),
        h("button", { class: "btn", onclick: receiveScreen }, "Receive"),
      ),
      // What else is done from here: opening an order, and the host's own (the desktop's Mining).
      h("div", { class: "primary-actions" },
        h("button", { class: "btn", onclick: orderFlow }, "Open request"),
        ...hostActions("home").map((a) => h("button", { class: "btn", onclick: () => a.run(route) }, a.label)),
      ),
      // What has happened and what is pending, and first of all what waits on its owner.
      h("div", { class: "nav-list" }, navRow("Activity", activityScreen, activityNow())),
      toast,
    ),
  );

  async function loadBalance() {
    balanceV.textContent = "…";
    try {
      const { balance } = await homeReads.account(acct!.address);
      balanceV.textContent = balance.toLocaleString();
      balanceV.classList.remove("unread");
    } catch (e) {
      // Not a number, so not in a number's type. A host that can say why (its
      // node is starting, stopped, syncing) says it in a notice, and the
      // balance is only marked as not read; "node unreachable" is for when
      // no one has a better account of it.
      unreadBecause = describe(e);
      balanceV.textContent = platform.notices ? "—" : unreadBecause;
      balanceV.classList.add("unread");
    }
    void loadNotices();
  }
  let unreadBecause = "";
  async function loadNotices() {
    if (!platform.notices) return;
    const shown = renderVersion;
    const lines = await platform.notices(homePath.join("/")).catch(() => []);
    if (shown !== renderVersion) return; // another screen was opened meanwhile
    if (balanceV.classList.contains("unread")) balanceV.textContent = lines.length ? "—" : unreadBecause;
    // While the host has something to say, or the balance is unread, things
    // are changing: look again shortly, so the screen catches up by itself
    // (a node that was just started, a sync that finishes) with no Refresh.
    clearTimeout(recheck);
    if (lines.length || balanceV.classList.contains("unread")) {
      recheck = setTimeout(() => { if (shown === renderVersion) void loadBalance(); }, 3000);
      (recheck as unknown as { unref?: () => void }).unref?.(); // never keeps a test or a headless host running
    }
    notices.replaceChildren(...lines.map((line) => h("div", { class: "notice", role: "status" },
      h("span", {}, line.text),
      line.action ? h("button", { class: "btn", onclick: async (event: Event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        try { await line.action!.run(); } catch (e) { toast.textContent = (e as Error).message; }
        void loadBalance();
      } }, line.action.label) : null)));
  }
  // A new account is named as it is made, like a new folder: its default is
  // there, selected; typing replaces it, and Enter or Escape keeps it.
  if (nameOnOpen === acct.address) renameInPlace();
  nameOnOpen = undefined;
  loadBalance();
}

/**
 * Settings holds what is set, in three groups: the wallet, the chain in use,
 * the node. A row says what it is set to, so checking a thing needs no second
 * screen. What is done (orders) is on the home screen, and what has happened
 * or is pending (purchases, sales, transactions) is in Activity.
 */
function settingsScreen() {
  const node = endpoint()!;
  const hostRows = hostActions("settings").map((a) => {
    const now = h("span", {});
    void a.summary?.().then((text) => { now.textContent = text; }).catch(() => {});
    return navRow(a.label, () => a.run(route), now);
  });
  render(h("div", { class: "stack", id: "settings-screen" },
    h("h1", {}, "Settings"),
    navGroup("Wallet",
      navRow("Backup & recovery", () => openBackup("backup")),
      ...(platform.openFullPage && !platform.camera ? [navRow("Open wallet in a tab", () => platform.openFullPage!("wallet"))] : []),
      navRow("Lock wallet", async () => { await wallet.lock(); await refresh(); }, "", false),
    ),
    navGroup(`This chain · ${settings.chain}`,
      navRow("Default fee", feeScreen, fmt(defaultFee(settings, settings.chain))),
    ),
    // A wallet on its own node with no page for it has nothing to set here.
    ...(hostRows.length || !platform.ownNode ? [navGroup("Node",
      ...hostRows,
      ...(platform.ownNode ? [] : [
        navRow("Connection", connectionScreen, settings.nodeMode === "automatic" ? "Automatic" : "Custom nodes"),
        navRow(`Node for ${settings.chain}`, endpointScreen, `${short(node.url)} · ${node.acceptsSubmit ? "read + send" : "read only"}`),
      ]),
    )] : []),
    h("button", { class: "btn block", onclick: mainScreen }, "Back"),
  ));
}

/**
 * What has happened and what is pending, in one place: purchases (each one
 * still to claim by itself, since it waits on its owner), sales, and
 * transactions. Every row opens the screen that deals with it.
 */
function activityScreen() {
  void reconcileRecovery();
  const records = settings.openPurchases.length + settings.confirmedPurchases.length;
  const pending = settings.pendingSubmissions.length;
  render(h("div", { class: "stack" },
    h("h1", {}, "Activity"),
    ...(records ? [navGroup("Purchases",
      ...settings.openPurchases.map((purchase) => navRow(
        `${fmt(purchase.offers.reduce((sum, offer) => sum + BigInt(offer.amountDeposited), 0n))} on ${purchase.childChain.join("/")}`,
        () => purchaseScreen(purchase),
        purchase.withdrawalCID ? "withdrawal submitted" : "paid · claim it",
      )),
      navRow("Purchase records", purchasesScreen, settings.confirmedPurchases.length
        ? `${settings.openPurchases.length} pending, ${settings.confirmedPurchases.length} confirmed`
        : `${settings.openPurchases.length} pending`),
    )] : []),
    ...(settings.openDeposits.length ? [navGroup("Sales",
      navRow("Pending sales", depositsScreen, String(settings.openDeposits.length)),
    )] : []),
    navGroup("Transactions",
      navRow("Transactions", pendingSubmissionsScreen, pending ? `${pending} pending` : ""),
    ),
    h("button", { class: "btn block", onclick: mainScreen }, "Back"),
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
          check.disabled = false;
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
    h("button", { class: "btn block", onclick: activityScreen }, "Back")));
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
        if (await dismissRecovery("this pending purchase", (s) => dismissPurchase(s, purchase.receiptCID))) purchasesScreen();
      } }, "Dismiss")));
  }
  for (const purchase of settings.confirmedPurchases) {
    const receive = purchase.offers.reduce((sum, offer) => sum + BigInt(offer.amountDeposited), 0n);
    list.append(h("div", { class: "stack compact" },
      h("div", { class: "row" }, h("span", {}, `${fmt(receive)} on ${purchase.childChain.join("/")}`), h("span", { class: "tag" }, "confirmed archive")),
      h("button", { class: "text-action", onclick: async () => {
        if (await dismissRecovery("this confirmed purchase archive", (s) => dismissPurchase(s, purchase.receiptCID))) purchasesScreen();
      } }, "Dismiss")));
  }
  render(h("div", { class: "stack" }, h("h1", {}, "Pending purchases"), list,
    h("button", { class: "btn block", onclick: activityScreen }, "Back")));
}

function purchaseScreen(purchase: OpenPurchase, openingMessage?: string) {
  const reconciliationResult = reconcileRecovery();
  const childName = purchase.childChain.join("/");
  const parentName = purchase.parentChain.join("/");
  const childEndpoint = endpointFor(childName);
  const parentEndpoint = endpointFor(parentName);
  const totalReceive = purchase.offers.reduce((sum, offer) => sum + BigInt(offer.amountDeposited), 0n);
  const totalPaid = purchase.offers.reduce((sum, offer) => sum + BigInt(offer.amountDemanded), 0n);
  const feeInput = h("input", { type: "text", inputmode: "numeric", value: defaultFee(settings, childName) }) as HTMLInputElement;
  const toast = h("div", { class: "toast" }, openingMessage
    ?? (purchase.withdrawalCID ? "Checking withdrawal…" : "Check the parent receipt before withdrawing."));
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
      if (await dismissRecovery("this pending purchase", (s) => dismissPurchase(s, purchase.receiptCID))) purchasesScreen();
    } }, "Dismiss saved recovery"),
    h("button", { class: "btn block", onclick: activityScreen }, "Back"),
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
            toast.textContent = `Replacement rejected: ${describe(submitted.error)} Both signed attempts remain saved; either may still confirm.`;
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
          } else if (submitted.kind === "refused" && isTransientSubmissionRefusal(submitted.error)) {
            toast.textContent = `${describe(submitted.error)} Fix the connection or try the exact transaction again; no higher fee is needed.`;
            retry.disabled = false;
          } else {
            toast.textContent = describe(submitted.error);
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
          const cached = (await reconciliationResult).get(attempt.transactionCID);
          if (cached) return { attempt, result: cached };
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
            await requireCommittedChild(parentEndpoint, purchase.parentChain, childEndpoint, purchase.childChain, await authorizationFor(parentEndpoint.url), auth);
            const keys = purchase.offers.map(depositKey);
            const values = await withStableTip(childEndpoint, purchase.childChain, auth,
              (childTip) => depositValues(childEndpoint.url, purchase.childChain, keys, platform.fetch, auth, childTip));
            if (keys.every((key) => typeof values.get(key) === "bigint" && values.get(key)! > 0n)) {
              const restart = h("button", { class: "btn block", onclick: async () => {
                restart.disabled = true;
                await update((s) => ({ ...s, openPurchases: s.openPurchases.map((item) => item.receiptCID === purchase.receiptCID
                  ? { ...item, withdrawalCID: undefined } : item) }));
                const current = settings.openPurchases.find((item) => item.receiptCID === purchase.receiptCID);
                if (current) purchaseScreen(current);
              } }, "Try withdrawal with current nonce") as HTMLButtonElement;
              toast.after(restart);
            } else if (keys.every((key) => values.has(key) && (values.get(key) === 0n || values.get(key) === null))) {
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
      await update((s) => {
        return recordWithdrawalAttempt(recordSent(s, childName, {
            cid: withdrawalCID, to: purchase.withdrawer, amount: totalReceive.toString(), at: Date.now(),
            from: purchase.withdrawer, fee: fee.toString(), nonce: account.nonce.toString(),
          }), purchase.receiptCID, signed.signedSubmit);
      });
      invalidateRecoveryStatus(withdrawalCID);
      toast.textContent = "submitting child withdrawal…";
      try {
        await submitChecked(submitter(childEndpoint.url, platform.fetch, childAuth), signed.signedSubmit);
      } catch (e) {
        toast.textContent = `Withdrawal confirmation unknown: ${describe(e)} The signed attempt remains saved. Check this purchase before taking another action.`;
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
    h("p", { class: "muted" }, "Automatic uses the explorer directory to find a node serving each chain. These are operator declarations, not independently verified consensus. Choose custom when you operate or trust a specific node."),
    h("div", { class: "kv" },
      h("div", { class: "row" }, h("span", { class: "k" }, "Now using"), h("span", { class: "v" }, settings.nodeMode === "automatic" ? "Automatic" : "Custom nodes"))),
    h("button", { class: settings.nodeMode === "automatic" ? "btn btn--primary block" : "btn block", "aria-pressed": String(settings.nodeMode === "automatic"), onclick: async () => {
      await update((s) => ({ ...s, nodeMode: "automatic" }));
      route();
    } }, "Automatic (recommended)"),
    h("button", { class: settings.nodeMode === "custom" ? "btn btn--primary block" : "btn block", "aria-pressed": String(settings.nodeMode === "custom"), onclick: async () => {
      await update((s) => ({ ...s, nodeMode: "custom" }));
      endpointScreen();
    } }, "Use a custom node"),
    ...(platform.siteAccessHelp ? [h("p", { class: "muted", "aria-label": "Site access" }, platform.siteAccessHelp)] : []),
    h("button", { class: "btn block", onclick: settingsScreen }, "Back"),
  ));
}

// ---------------- requests: cross-chain orders and record writes ----------------

function orderFlow() {
  const scan = scanner({
    camera: platform.camera === true,
    openFullPage: platform.openFullPage && (() => platform.openFullPage!("wallet")),
    pasteHint: "paste the lattice://order or lattice://write request",
    onText: (text) => openOrderText(text, scan.status),
  });
  render(h("div", { class: "stack" },
    h("h1", {}, "Open request"),
    h("p", { class: "muted" }, "Scan the QR, load its image, or paste its text. The wallet validates the request and shows the transaction before signing."),
    scan.node,
    h("button", { class: "btn block", onclick: () => { scan.stop(); mainScreen(); } }, "Cancel"),
  ));
}

function openOrderText(text: string, status: El): boolean {
  if (/^lattice:\/\/write\b/i.test(text.trim())) {
    if (!platform.writeRequests) { status.textContent = "This wallet can't open write requests yet."; return false; }
    try { decodeWriteRequest(text); } catch (e) { status.textContent = (e as Error).message; return false; }
    // Reviewed and signed in the approval window, as a page's request is.
    status.textContent = "Opening…";
    wallet.openWriteRequest(text.trim()).then((r) => {
      status.textContent = r.ok ? "Review it in the window that opened." : r.error;
    }, (e) => { status.textContent = String(e?.message ?? e); });
    return true;
  }
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

async function reviewBuyOrder(order: BuyOrder) {
  const acct = activeAccount()!;
  const parentName = order.parentChain.join("/");
  const childName = order.childChain.join("/");
  const childEndpoint = endpointFor(childName);
  const parentEndpoint = endpointFor(parentName);
  const toast = h("div", { class: "toast" }, "Checking the selected sell orders…");
  render(h("div", { class: "stack" }, h("h1", {}, "Check sell orders"), toast,
    h("button", { class: "btn block", onclick: orderFlow }, "Cancel")));
  if (!childEndpoint || !parentEndpoint) { toast.textContent = `Connect both ${parentName} and ${childName} before buying.`; return; }
  if (!parentEndpoint.acceptsSubmit || !childEndpoint.acceptsSubmit) {
    toast.textContent = "Both the parent and child nodes must accept transactions before buying.";
    return;
  }
  let childAuth: string | undefined, parentAuth: string | undefined;
  try { [childAuth, parentAuth] = await Promise.all([authorizationFor(childEndpoint.url), authorizationFor(parentEndpoint.url)]); }
  catch (e) { toast.textContent = describe(e); return; }
  // Any node that is not on this computer is its operator's word about the
  // chain, whether or not a cookie is stored for it.
  const publicNodePurchase = !platform.ownNode && (!isLoopbackNodeURL(parentEndpoint.url) || !isLoopbackNodeURL(childEndpoint.url));
  // The request names the deposits; nothing about them is taken from it on
  // trust. Each must be proven in the child node's current state with exactly
  // the stated amount, on a chain that contains the block the parent commits,
  // and have no receipt on the parent.
  const offers: ActiveDeposit[] = order.deposits.map((deposit) => ({
    demander: deposit.demander, amountDemanded: BigInt(deposit.amountDemanded),
    amountDeposited: BigInt(deposit.amountDeposited), depositNonce: BigInt(deposit.depositNonce),
  }));
  let minRelayFee: bigint | undefined, childMinRelayFee: bigint | undefined;
  const verifySelected = () => withStableTip(parentEndpoint, order.parentChain, parentAuth, async (parentTip) => {
    await requireCommittedChild(parentEndpoint, order.parentChain, childEndpoint, order.childChain, parentAuth, childAuth, parentTip);
    const listed = await withStableTip(childEndpoint, order.childChain, childAuth,
      (childTip) => activeDeposits(childEndpoint.url, order.childChain, platform.fetch, childAuth, childTip));
    const locked = new Map(listed.map((deposit) => [depositKey(deposit), deposit.amountDeposited]));
    const owners = await Promise.all(offers.map((offer) => receiptWithdrawer(
      parentEndpoint.url, order.parentChain, order.childChain, offer, platform.fetch, parentAuth, parentTip,
    )));
    return offers.map((offer, index) => locked.get(depositKey(offer)) !== offer.amountDeposited ? "is no longer locked with these terms"
      : owners[index] !== null ? "was already bought" : null);
  });
  const unavailable = (problems: readonly (string | null)[]): string | null => {
    const failed = problems.flatMap((problem, index) => problem === null ? [] : [`${fmt(offers[index]!.amountDeposited)} from ${short(offers[index]!.demander)} ${problem}`]);
    return failed.length ? `${failed.length} of ${offers.length} selected sell orders cannot be bought: ${failed.join("; ")}. Nothing was paid. Select again on the Buy page.` : null;
  };
  try {
    const refusal = unavailable(await verifySelected());
    if (refusal) { toast.textContent = refusal; return; }
    [minRelayFee, childMinRelayFee] = await Promise.all([
      reader(parentEndpoint.url, [...order.parentChain], platform.fetch, parentAuth).chainInfo().then((info) => info.minRelayFee),
      reader(childEndpoint.url, [...order.childChain], platform.fetch, childAuth).chainInfo().then((info) => info.minRelayFee),
    ]);
  } catch (e) { toast.textContent = "Could not check the selected sell orders: " + (e instanceof Error && !(e instanceof TypeError) ? e.message : describe(e)); return; }
  const totalPay = offers.reduce((sum, offer) => sum + offer.amountDemanded, 0n);
  const totalReceive = offers.reduce((sum, offer) => sum + offer.amountDeposited, 0n);
  if (childMinRelayFee === undefined || totalReceive <= childMinRelayFee) {
    toast.textContent = "These sell orders cannot cover the fee of the child-chain withdrawal transaction.";
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
  let purchaseSubmitting = false;
  toast.textContent = ""; // the check is done; the review that follows is its result
  const trustAcknowledgement = h("input", { type: "checkbox", id: "purchase-node-trust" }) as HTMLInputElement;
  buyButton.disabled = publicNodePurchase;
  trustAcknowledgement.addEventListener("change", () => { buyButton.disabled = purchaseSubmitting || !trustAcknowledgement.checked; });
  render(h("div", { class: "stack" },
    h("h1", {}, "Review purchase"),
    h("p", { class: "warn" }, "Payment on the parent chain is irreversible. After it confirms, complete the child-chain withdrawal from Settings."),
    ...(publicNodePurchase ? [
      h("div", { class: "warn" },
        h("p", {}, "Public-node purchase: proofs check the supplied state, not whether it is the current canonical chain. A dishonest or stale operator can cause loss of your payment."),
        h("p", { class: "mono" }, `Parent node: ${parentEndpoint.url}`),
        h("p", { class: "mono" }, `Child node: ${childEndpoint.url}`),
        h("label", {}, trustAcknowledgement, " I trust these node operators for this purchase."),
      ),
    ] : []),
    h("p", { class: "muted" }, "These are the sell orders named in the request, each bought whole. The wallet proved each one in the child state its node serves and found no payment for it; it checks again before signing."),
    h("div", { class: "kv" },
      h("div", { class: "row" }, h("span", { class: "k" }, "You pay"), h("span", { class: "v" }, `${fmt(totalPay)} on ${parentName}`)),
      h("div", { class: "row" }, h("span", { class: "k" }, "You receive"), h("span", { class: "v" }, `${fmt(totalReceive)} on ${childName}`)),
      h("div", { class: "row" }, h("span", { class: "k" }, "Sell orders"), h("span", { class: "v" }, offers.length.toString())),
      ...offers.map((offer) => h("div", { class: "row" }, h("span", { class: "k" }, short(offer.demander)), h("span", { class: "v" }, `${fmt(offer.amountDemanded)} parent / ${fmt(offer.amountDeposited)} child`))),
      h("div", { class: "row" }, h("span", { class: "k" }, "Child node minimum fee"), h("span", { class: "v" }, `${fmt(childMinRelayFee)}, paid from what you receive`)),
      h("div", { class: "row" }, h("span", { class: "k" }, "Account"), h("span", { class: "v mono" }, short(acct.address))),
    ),
    h("label", { class: "k" }, "Parent-chain fee"), feeInput, feeNote, toast, buyButton,
    h("button", { class: "btn block", onclick: orderFlow }, "Cancel"),
  ));
  buyButton.addEventListener("click", async () => {
    if (purchaseSubmitting) return;
    if (publicNodePurchase && !trustAcknowledgement.checked) {
      toast.textContent = "Acknowledge trust in the selected public nodes before paying.";
      return;
    }
    if (Date.parse(order.expiresAt) <= Date.now() + 60_000) { toast.textContent = "This request is expired or has less than one minute left."; return; }
    const fee = parseFee(feeInput.value);
    if (fee === null) { toast.textContent = "Enter a whole fee of 0 or more."; return; }
    purchaseSubmitting = true;
    buyButton.disabled = true; feeInput.disabled = true; trustAcknowledgement.disabled = true; toast.textContent = "Rechecking the selected sell orders…";
    try {
      const refusal = unavailable(await verifySelected());
      if (refusal) throw new Error(refusal);
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
      await update((s) => {
        return recordSent(recordOpenPurchase(s, purchase), parentName, {
          cid: purchase.receiptCID, to: `buy on ${childName}`, amount: totalPay.toString(), at: Date.now(),
          from: acct.address, fee: fee.toString(), nonce: account.nonce.toString(),
        });
      });
      invalidateRecoveryStatus(purchase.receiptCID);
      const storedPurchase = settings.openPurchases.find((item) => item.receiptCID === purchase.receiptCID) ?? purchase;
      toast.textContent = "submitting parent receipt…";
      try {
        await submitChecked(submitter(parentEndpoint.url, platform.fetch, parentAuth), signed.signedSubmit);
      } catch (e) {
        purchaseScreen(storedPurchase, isTooLargeRefusal(e)
          ? `Too many sell orders for one transaction: ${describe(e)} Nothing was paid through this node. Select fewer on the Buy page. The signed request is kept here; dismiss it once you have bought again.`
          : `Receipt confirmation unknown: ${describe(e)} The payment may still confirm; keep this record and check its status before creating another purchase.`);
        return;
      }
      purchaseScreen(storedPurchase);
    } catch (e) {
      toast.textContent = e instanceof Error && !(e instanceof TypeError) ? e.message : describe(e);
      purchaseSubmitting = false;
      buyButton.disabled = publicNodePurchase && !trustAcknowledgement.checked;
      feeInput.disabled = false; trustAcknowledgement.disabled = false;
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
  const chain = order.childChain.join("/");
  const chosen = { ...endpointFor(chain)! };
  const authorization = await authorizationFor(chosen.url);
  const reads = reader(chosen.url, [...order.childChain], platform.fetch, authorization);
  const deposited = BigInt(order.amountDeposited);
  const demanded = BigInt(order.amountDemanded);
  const feeInput = h("input", { type: "text", inputmode: "numeric", value: defaultFee(settings, settings.chain) }) as HTMLInputElement;
  const toast = h("div", { class: "toast" }, "reading account…");
  render(h("div", { class: "stack" }, h("h1", {}, "Review sell order"), toast,
    h("button", { class: "btn block", onclick: orderFlow }, "Cancel"),
  ));
  let minRelayFee: bigint | undefined;
  try {
    const info = await reads.chainInfo();
    minRelayFee = info.minRelayFee;
  } catch (e) { toast.textContent = describe(e); return; }
  toast.textContent = ""; // the read is done; the same element reports signing below
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
      const account = await reads.account(acct.address);
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
    try {
      // Persist the exact signed attempt before touching the network. A timeout
      // can mean the node accepted it even though no response arrived.
      await update((s) => {
        return recordSent(recordOpenDeposit(s, {
          transactionCID: cid, demander: acct.address,
          depositNonce: depositNonce.toString(), amountDeposited: order.amountDeposited,
          amountDemanded: order.amountDemanded, fee: fee.toString(), transactionNonce: nonce.toString(),
          childChain: [...order.childChain], parentChain: [...order.parentChain],
          createdAt: Date.now(), expiresAt: order.expiresAt, signedSubmit: signed.signedSubmit,
        }), chain, {
          cid, to: `sell for ${order.parentChain.join("/")}`,
          amount: order.amountDeposited, at: Date.now(), from: acct.address, fee: fee.toString(), nonce: nonce.toString(),
        });
      });
      invalidateRecoveryStatus(cid);
    } catch {
      toast.textContent = "Could not save the deposit record; nothing was submitted.";
      lockButton.disabled = false; feeInput.disabled = false; return;
    }
    toast.textContent = "submitting…";
    try {
      await submitChecked(submitter(chosen.url, platform.fetch, authorization), signed.signedSubmit);
      sentScreen(cid);
    } catch (e) {
      // Never return to a control that re-signs with a newly read account
      // nonce. Track this exact CID; resubmission must reuse its signed bytes.
      sentScreen(cid, { uncertain: true, from: acct.address, nonce, kind: "deposit" }, reads);
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
      qrNode(acct.address),
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
  const name = h("input", {
    type: "text", maxlength: String(LABEL_MAX), "aria-label": "Account name (optional)",
    placeholder: `Name (optional) · Imported ${st.accounts.filter((a) => a.kind === "imported").length + 1}`,
    spellcheck: "false", autocomplete: "off",
  }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  render(
    h("div", { class: "stack" },
      h("h1", {}, "Import key"),
      inp, ...keyFilePicker(inp), name, err,
      h("button", { class: "block", onclick: async () => {
        let priv: string;
        try { priv = privateKeyText(inp.value); } catch (e) { err.textContent = (e as Error).message; return; }
        const r = await wallet.importKey(priv, name.value); if (r.ok) { st = r.state; route(); } else err.textContent = r.error;
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
  const sendContext = { chain: settings.chain, path: [...chainPath()], chosen: { ...endpoint()! }, acct };
  const to = h("input", { type: "text", placeholder: "recipient address (bafy…)", spellcheck: "false" }) as HTMLInputElement;
  const amount = h("input", { type: "text", inputmode: "numeric", placeholder: `amount on ${sendContext.chain}`, "aria-label": "Amount" }) as HTMLInputElement;
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
  void authorizationFor(sendContext.chosen.url).then((auth) => reader(sendContext.chosen.url, sendContext.path, platform.fetch, auth).chainInfo()).then((info) => {
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
    try { if (!/^[1-9][0-9]*$/.test(amount.value.trim())) throw 0; amt = BigInt(amount.value.trim()); } catch { err.textContent = "Enter a whole, positive amount."; return; }
    const parsedFee = parseFee(fee.value);
    if (parsedFee === null) { err.textContent = "Enter a whole fee of 0 or more."; return; }
    f = parsedFee;
    err.textContent = "reading account…";
    let nonce: bigint, balance: bigint;
    try {
      const reads = reader(sendContext.chosen.url, sendContext.path, platform.fetch, await authorizationFor(sendContext.chosen.url));
      const [a, info] = await Promise.all([reads.account(acct.address), reads.chainInfo()]);
      nonce = a.nonce; balance = a.balance; minRelayFee = info.minRelayFee;
    } catch (e) { err.textContent = describe(e); return; }
    if (amt + f > balance) { err.textContent = `Insufficient balance (have ${fmt(balance.toString())}, need ${fmt((amt + f).toString())}).`; return; }
    reviewScreen(toAddr, amt, f, nonce, minRelayFee, sendContext);
  }
}

function reviewScreen(to: string, amount: bigint, fee: bigint, nonce: bigint, minRelayFee: bigint | undefined,
  context: { chain: string; path: string[]; chosen: ChosenEndpoint; acct: NonNullable<ReturnType<typeof activeAccount>> }) {
  const { acct, chain, path, chosen } = context;
  let acknowledgedPending: string | undefined;
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
        h("div", { class: "row" }, h("span", { class: "k" }, "Amount"), h("span", { class: "v" }, amountOn(amount, chain))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Network fee"), h("span", { class: "v" }, amountOn(fee, chain))),
        h("div", { class: "row" }, h("span", { class: "k" }, "Total"), h("span", { class: "v" }, amountOn(amount + fee, chain))),
      ),
      h("details", { class: "advanced" },
        h("summary", {}, "Transaction details"),
        h("div", { class: "kv advanced-content" },
          h("div", { class: "row" }, h("span", { class: "k" }, "Nonce"), h("span", { class: "v" }, String(nonce))),
          ...(minRelayFee === undefined ? [] : [h("div", { class: "row" }, h("span", { class: "k" }, "Node minimum"), h("span", { class: "v" }, fmt(minRelayFee.toString())))]),
          h("div", { class: "row" }, h("span", { class: "k" }, "Node"), h("span", { class: "v mono" }, short(chosen.url))),
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
    let authorization: string | undefined;
    try {
      const latest = await loadSettings(store);
      const unresolved = latest.pendingSubmissions.filter((item) => item.chain === chain && item.from === acct.address);
      const fingerprint = unresolved.map((item) => item.cid).sort().join(",");
      if (unresolved.length && acknowledgedPending !== fingerprint) {
        acknowledgedPending = fingerprint;
        toast.textContent = "This account has saved transactions that may still confirm. Check Pending transactions before paying again. Sending another payment may pay twice or compete for the same nonce.";
        sendButton.textContent = "Send another payment";
        sendButton.disabled = false;
        return;
      }
      authorization = await authorizationFor(chosen.url);
      signed = await wallet.signTransfer({ from: acct.address, to, amount: amount.toString(), fee: fee.toString(), nonce: nonce.toString(), chainPath: path });
    } catch (e) {
      toast.textContent = describe(e); sendButton.disabled = false; return;
    }
    if (!signed.ok) { toast.textContent = signed.error; sendButton.disabled = false; return; }
    toast.textContent = "submitting…";
    const cid = signed.signedSubmit.transactionCID;
    try {
      const pending = {
        cid, to, amount: amount.toString(), at: Date.now(),
        from: acct.address, fee: fee.toString(), nonce: nonce.toString(), signedSubmit: signed.signedSubmit,
        chain,
      };
      await update((s) => {
        return recordPendingSubmission(recordSent(s, chain, {
          cid, to, amount: amount.toString(), at: pending.at,
          from: acct.address, fee: fee.toString(), nonce: nonce.toString(),
        }), pending);
      });
      invalidateRecoveryStatus(cid);
    } catch {
      toast.textContent = "Could not save the signed transaction; nothing was submitted.";
      sendButton.disabled = false;
      return;
    }
    try {
      await submitChecked(submitter(chosen.url, platform.fetch, authorization), signed.signedSubmit);
      sentScreen(cid);
    } catch (e) {
      sentScreen(cid, { uncertain: true, from: acct.address, nonce }, reader(chosen.url, path, platform.fetch, authorization));
    }
  }
}

function pendingSubmissionsScreen() {
  const reconciliationResult = reconcileRecovery();
  const tipReads = new Map<string, ReturnType<ReturnType<typeof reader>["latestBlock"]>>();
  const pendingList = h("div", { class: "transaction-list" });
  const recentList = h("div", { class: "transaction-list" });
  const seen = new Set<string>();
  const add = (transaction: SentTransaction, chain: string, recovery?: SignedSubmit, archived = false, pending = false) => {
    const identity = `${chain}:${transaction.cid}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const replacesCID = [...settings.pendingSubmissions, ...settings.confirmedSubmissions]
      .find((item) => item.chain === chain && item.cid === transaction.cid)?.replacesCID;
    const state = h("span", { class: "transaction-status", role: "status" }, "Checking…");
    const message = h("div", { class: "toast", role: "status" });
    const field = (label: string, value: string) => h("div", { class: "transaction-field" }, h("span", { class: "muted" }, label), h("span", { class: "mono" }, value));
    const date = new Date(transaction.at);
    const confirmations = h("span", {}, "Checking…");
    const details = h("div", { class: "transaction-details stack" },
      field("Transaction", transaction.cid),
      ...(replacesCID ? [field("Replaces", replacesCID)] : []),
      ...(transaction.from ? [field("From", transaction.from)] : []),
      field("To", transaction.to), field("Chain", chain),
      ...(transaction.fee !== undefined ? [field("Fee", fmt(transaction.fee))] : []),
      ...(transaction.nonce !== undefined ? [field("Nonce", transaction.nonce)] : []),
      field("Created", Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown"),
      h("div", { class: "transaction-field" }, h("span", { class: "muted" }, "Confirmations (node-reported)"), confirmations),
      ...(recovery ? [h("p", { class: "muted" }, archived
        ? "Archived locally. Signed recovery is still saved; node status may change."
        : "Signed recovery is saved. Retry sends the same transaction, not another payment.")] : []),
      message,
    );
    if (recovery) details.append(h("details", { class: "advanced" },
      h("summary", {}, "Signed transaction"),
      h("pre", { class: "transaction-payload" }, JSON.stringify(recovery.payload, null, 2))));
    const actions = h("div", { class: "row-actions" }, h("button", {
      class: "btn icon-action", "aria-label": "Copy transaction ID", title: "Copy transaction ID", onclick: async () => {
        try { await navigator.clipboard.writeText(transaction.cid); message.textContent = "Transaction ID copied."; }
        catch { message.textContent = "Could not copy. Select the transaction ID above."; }
      },
    }, actionIcon("copy")));
    const row = h("details", { class: "transaction-item" }, h("summary", {},
      h("div", { class: "transaction-summary" },
        h("div", { class: "transaction-line" }, h("span", { class: "transaction-title" }, replacesCID ? "Fee replacement" : transaction.to.startsWith("buy on ") ? "Purchase payment" : transaction.to.startsWith("sell on ") ? "Sell order" : "Sent"), h("span", { class: "transaction-amount" }, fmt(transaction.amount))),
        h("div", { class: "transaction-line muted" }, h("span", { class: "transaction-context", title: chain }, chain), state),
      ),
    ), details);
    (pending ? pendingList : recentList).append(row);
    const chosen = endpointFor(chain);
    let increaseFee: El | undefined;
    if (recovery) {
      if (chosen?.acceptsSubmit) {
        const retry = h("button", { class: "btn", onclick: async () => {
          if (retry.disabled) return;
          retry.disabled = true; message.textContent = "Resubmitting the exact saved transaction…";
          try {
            const submitted = await resubmitExact(chosen.url, await authorizationFor(chosen.url), recovery);
            message.textContent = submitted.kind === "submitted" ? "Exact transaction resubmitted. Check status for confirmation."
              : `${submitted.kind === "refused" ? "Retry rejected" : "Retry outcome unknown"}: ${describe(submitted.error)} The saved transaction was kept.`;
          } catch (error) { message.textContent = describe(error); }
          finally { retry.disabled = false; }
        } }, "Resubmit exact") as HTMLButtonElement;
        actions.append(retry);
        const saved = settings.pendingSubmissions.find((item) => item.chain === chain && item.cid === transaction.cid);
        if (pending && saved && replacementTransfer(saved)) {
          increaseFee = h("button", { class: "btn", onclick: () => replacementScreen(saved, chosen) }, "Increase fee");
          actions.append(increaseFee);
        }
      }
      actions.append(h("button", { class: "text-action", onclick: async () => {
        if (await dismissRecovery("this transaction's recovery data", (s) => dismissSubmission(s, transaction.cid))) pendingSubmissionsScreen();
      } }, "Dismiss"));
    }
    details.append(actions);
    if (!chosen) { state.textContent = "Not connected"; confirmations.textContent = "Unavailable"; message.textContent = `Connect ${chain} to check or resubmit.`; return; }
    const recorded = transaction.from && transaction.nonce !== undefined ? { from: transaction.from, nonce: BigInt(transaction.nonce) } : undefined;
    void (async () => {
      try {
        const auth = await authorizationFor(chosen.url);
        const result = (await reconciliationResult).get(transaction.cid) ?? await sentStatus(
          reader(chosen.url, chain.split("/"), platform.fetch, auth), transaction.cid, recorded);
        state.textContent = statusText(result);
        if (result.kind === "included" || result.kind === "replaced" || result.kind === "nonce advanced") increaseFee?.remove();
        if (result.kind === "included") {
          try {
            const key = `${chosen.url}\n${chain}`;
            let tip = tipReads.get(key);
            const node = reader(chosen.url, chain.split("/"), platform.fetch, auth);
            if (!tip) { tip = node.latestBlock(); tipReads.set(key, tip); }
            const [latest, included] = await Promise.all([tip, node.block(result.height)]);
            if (included.hash !== result.hash || latest.height < result.height) {
              confirmations.textContent = "Unavailable — inclusion changed";
            } else {
              const depth = latest.height - result.height + 1n;
              confirmations.textContent = depth.toString();
              state.textContent = `${depth} confirmation${depth === 1n ? "" : "s"}`;
            }
          } catch { confirmations.textContent = "Unavailable"; }
        } else { confirmations.textContent = result.kind === "pending" ? "0" : "Unknown"; }
      } catch (e) { state.textContent = "Status unavailable"; confirmations.textContent = "Unavailable"; message.textContent = describe(e); }
    })();
  };
  for (const transaction of [...settings.pendingSubmissions].sort((a, b) => b.at - a.at)) add(transaction, transaction.chain, transaction.signedSubmit, false, true);
  const recent = [
    ...settings.confirmedSubmissions.map((transaction) => ({ transaction, chain: transaction.chain, recovery: transaction.signedSubmit, archived: true })),
    ...(settings.sent[settings.chain] ?? []).map((transaction) => ({ transaction, chain: settings.chain, recovery: transaction.signedSubmit, archived: false })),
  ].sort((a, b) => b.transaction.at - a.transaction.at || Number(b.archived) - Number(a.archived));
  for (const entry of recent) add(entry.transaction, entry.chain, entry.recovery, entry.archived);
  const refreshNotice = h("div", { class: "toast", role: "status" });
  const refreshButton = h("button", {
    class: "btn icon-action", title: "Refresh transactions", "aria-label": "Refresh transactions", onclick: async () => {
      if (refreshButton.disabled) return;
      refreshButton.disabled = true;
      try {
        const current = await loadSettings(store);
        invalidateRecoveryStatus();
        settings = current;
        pendingSubmissionsScreen();
      } catch { refreshNotice.textContent = "Could not refresh saved transactions. Try again."; }
      finally { refreshButton.disabled = false; }
    },
  }, actionIcon("refresh")) as HTMLButtonElement;
  render(h("div", { class: "stack" },
    h("div", { class: "transaction-heading" }, h("h1", {}, "Transactions"), refreshButton),
    h("p", { class: "muted" }, `Local sent history for ${settings.chain}, plus saved recovery across chains. Not a complete on-chain history.`),
    refreshNotice,
    ...(pendingList.childElementCount ? [h("h2", { class: "section-label" }, `Pending recovery · ${pendingList.childElementCount}`), pendingList] : []),
    ...(recentList.childElementCount ? [h("h2", { class: "section-label" }, "Recent & archived"), recentList] : []),
    ...(!seen.size ? [h("p", { class: "transaction-empty muted" }, "No transactions yet. Transactions sent from this wallet will appear here.")] : []),
    h("button", { class: "btn block", onclick: activityScreen }, "Back")));
}

function replacementScreen(original: Parameters<typeof replacementTransfer>[0], chosen: ChosenEndpoint) {
  const terms = replacementTransfer(original);
  if (!terms) return pendingSubmissionsScreen();
  const fee = h("input", { type: "text", inputmode: "numeric", value: (terms.fee + 1n).toString(), "aria-label": "Replacement fee" }) as HTMLInputElement;
  const message = h("div", { class: "toast", role: "status" });
  const confirm = h("button", { class: "block", onclick: async () => {
    if (confirm.disabled) return;
    const nextFee = parseFee(fee.value);
    if (nextFee === null || nextFee <= terms.fee) { message.textContent = `Enter a fee higher than ${terms.fee}.`; return; }
    confirm.disabled = true; fee.disabled = true;
    try {
      const auth = await authorizationFor(chosen.url);
      const node = reader(chosen.url, terms.chainPath, platform.fetch, auth);
      const [account, status, info] = await Promise.all([node.account(terms.from), sentStatus(node, original.cid, { from: terms.from, nonce: terms.nonce }), node.chainInfo()]);
      if (status.kind === "included" || account.nonce > terms.nonce) throw new Error("This nonce has already been used. Refresh transactions; do not replace it.");
      if (terms.amount + nextFee > account.balance) throw new Error("Insufficient balance for this replacement fee.");
      if (info.minRelayFee !== undefined && nextFee < info.minRelayFee) throw new Error(`This node requires a fee of at least ${info.minRelayFee}.`);
      const signed = await wallet.signTransfer({ from: terms.from, to: terms.to, amount: terms.amount.toString(), fee: nextFee.toString(), nonce: terms.nonce.toString(), chainPath: terms.chainPath });
      if (!signed.ok) throw new Error(signed.error);
      const replacement = { ...original, cid: signed.signedSubmit.transactionCID, signedSubmit: signed.signedSubmit, fee: nextFee.toString(), at: Date.now(), replacesCID: original.cid };
      // Check all same-nonce attempts inside the cross-page settings lock. A
      // racing replacement may have raised the fee while this screen was open.
      await update((s) => {
        const attempts = [...s.pendingSubmissions, ...s.confirmedSubmissions].filter((item) => item.chain === original.chain && item.from === original.from && item.nonce === original.nonce);
        if (!s.pendingSubmissions.some((item) => item.cid === original.cid && item.chain === original.chain)) throw new Error("The saved transaction changed. Refresh before replacing it.");
        if (attempts.some((item) => BigInt(item.fee) >= nextFee)) throw new Error("A newer fee attempt is already saved. Refresh before replacing it.");
        return recordPendingSubmission(recordSent(s, original.chain, {
          cid: replacement.cid, from: terms.from, to: terms.to, amount: terms.amount.toString(), fee: nextFee.toString(), nonce: terms.nonce.toString(), at: replacement.at,
        }), replacement);
      });
      const submitted = await resubmitExact(chosen.url, auth, signed.signedSubmit);
      message.textContent = submitted.kind === "submitted"
        ? "Replacement submitted. Both attempts remain saved; only one can use this nonce."
        : `${submitted.kind === "refused" ? "Replacement refused" : "Replacement outcome unknown"}: ${describe(submitted.error)} Both attempts remain saved; either may still confirm.`;
      confirm.remove(); fee.disabled = true;
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : describe(error);
      confirm.disabled = false; fee.disabled = false;
    }
  } }, "Sign replacement") as HTMLButtonElement;
  render(h("div", { class: "stack" }, h("h1", {}, "Increase fee"),
    h("p", { class: "warn" }, "Same payment and nonce, higher fee. This is not a second payment or a cancellation. Replacement is not guaranteed; the original may confirm first."),
    h("div", { class: "transaction-details stack" },
      h("p", { class: "mono" }, `From: ${terms.from}`), h("p", { class: "mono" }, `To: ${terms.to}`),
      h("p", {}, `Amount: ${fmt(terms.amount)} · Chain: ${original.chain}`),
      h("p", {}, `Nonce: ${terms.nonce} · Previous fee: ${terms.fee}`)),
    h("label", { class: "k", for: "replacement-fee" }, "New fee"), fee, message, confirm,
    h("button", { class: "btn block", onclick: pendingSubmissionsScreen }, "Back")));
  fee.id = "replacement-fee";
}

function sentScreen(txCID: string, outcome?: { uncertain: true; from: string; nonce: bigint; kind?: "deposit" }, reads = client()) {
  const toast = h("div", { class: "toast" });
  const subject = outcome?.kind === "deposit" ? "deposit" : "transaction";
  const status = h("p", { class: outcome ? "warn" : "muted" }, outcome
    ? `Submission outcome unknown. Do not create this ${subject} again; checking this exact transaction…`
    : "Admitted to the node's pool (pending). Check Pending transactions or Pending sales in Settings for confirmation.");
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
    sentStatus(reads, txCID, { from: outcome.from, nonce: outcome.nonce })
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
      const retained = settings.pendingSubmissions.find((pending) => pending.cid === t.cid)
        ?? settings.confirmedSubmissions.find((confirmed) => confirmed.cid === t.cid);
      if (result.kind === "included") { if (retained) s.textContent += " (recovery retained)"; return; }
      const recovery = retained?.signedSubmit ?? t.signedSubmit;
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

// The signer locks behind the page: its idle timer fires, the computer
// sleeps, the browser stops its worker, or the extension is reloaded. A locked
// wallet shows nothing: the page is covered by the password prompt, and what
// was on it (a half-entered send, the node's screens) is underneath, as it was
// left, once the password is given. The page finds out in three ways:
//  - the host says so the moment its signer locks (`onLocked`);
//  - where the signer can stop without a word, the page checks in while it is
//    in view (`signerCanStop`), and whenever it comes back into view;
//  - a request that needs keys and is answered "Locked" asks for the password
//    and is sent again.
// Passive reads never raise the prompt themselves.
const NEEDS_KEYS = ["signTransfer", "signDeposit", "signReceipt", "signWithdrawal", "exportBackup", "exportSeedQR",
  "transferSend", "addAccount", "importKey", "setActive", "renameAccount", "setNodeCookie"] as const;
type KeyCall = (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>;
let signer: WalletClient; // the platform's own client, without the unlock wrapper

function unlockingWallet(client: WalletClient): WalletClient {
  const wrapped = { ...client } as unknown as Record<string, KeyCall | undefined>;
  for (const name of NEEDS_KEYS) {
    const call = wrapped[name];
    if (!call) continue;
    wrapped[name] = async (...args) => {
      const answer = await call(...args);
      if (answer.ok || answer.error !== "Locked") return answer;
      await promptUnlock();
      return call(...args);
    };
  }
  return wrapped as unknown as WalletClient;
}

let unlocking: Promise<void> | undefined;
/** Cover the page and ask for the password. Resolves once unlocked; there is no way past it. */
function promptUnlock(): Promise<void> {
  unlocking ??= new Promise<void>((resolve) => {
    closeChainMenu();
    const password = h("input", { type: "password", placeholder: "password", autocomplete: "current-password" }) as HTMLInputElement;
    const error = h("div", { class: "toast", role: "alert" });
    const submit = async () => {
      error.textContent = "unlocking…";
      const answer = await signer.unlock(password.value);
      if (!answer.ok) { error.textContent = answer.error === "Wrong password" ? "That password is not right. Try again." : answer.error; password.select(); return; }
      st = answer.state;
      overlay.remove();
      for (const part of behind) part.removeAttribute("inert");
      unlocking = undefined;
      resolve();
    };
    password.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Enter") void submit(); });
    const overlay = h("div", { class: "secret-overlay lock-cover", role: "dialog", "aria-modal": "true", "aria-label": "Unlock wallet" },
      h("h1", {}, "Wallet locked"),
      h("p", { class: "muted" }, "The wallet locks itself after ten minutes without use, and when the computer sleeps or the browser stops it in the background. Nothing was signed or sent. Enter your password to pick up where you left off; what you entered is still there."),
      password, error,
      h("button", { class: "block", onclick: () => { void submit(); } }, "Unlock"),
    );
    // What the cover covers cannot be reached while it is up: not by pointer,
    // not by Tab, not by a screen reader. The cover is all there is.
    const behind = [...document.body.children].filter((part) => !part.hasAttribute("inert"));
    for (const part of behind) part.setAttribute("inert", "");
    document.body.append(overlay);
    password.focus();
  });
  return unlocking;
}

/** Learn whether the signer locked behind an unlocked-looking page, and cover
 * the page if it did. A status read never postpones the signer's idle lock. */
async function checkSigner() {
  if (!st.initialized || st.locked || document.visibilityState === "hidden") return;
  const answer = await signer.getState().catch(() => undefined);
  if (answer?.ok && answer.state.locked) void promptUnlock();
}

export function startWallet(host: Platform) {
  invalidateRecoveryStatus();
  lastRecoveryStatuses = new Map();
  nodeAuth = undefined;
  nodeAuthURL = undefined;
  platform = host;
  signer = host.wallet;
  wallet = unlockingWallet(host.wallet);
  store = host.store;
  host.onLocked?.(() => { void checkSigner(); });
  if (host.signerCanStop) {
    const checkIn = setInterval(() => { void checkSigner(); }, 20_000) as unknown as { unref?: () => void };
    checkIn.unref?.(); // never keeps a test or a headless host running
  }
  document.addEventListener("visibilitychange", () => { void checkSigner(); });
  initialView = host.initialView;
  enableOrderDrop();
  const badge = document.getElementById("net-badge")!;
  badge.setAttribute("aria-haspopup", "true");
  badge.setAttribute("aria-expanded", "false");
  badge.addEventListener("click", () => {
    if (st.initialized && !st.locked && endpoint()) toggleChainMenu();
  });
  document.getElementById("settings-button")?.addEventListener("click", () => {
    if (!(st.initialized && !st.locked && activeAccount() && endpoint())) return;
    if (onSettingsScreen()) mainScreen(); else settingsScreen();
  });
  return refresh();
}
