// Non-secret settings, kept beside (never inside) the encrypted vault: the
// selected chain, the user's chain list, the endpoint chosen per chain, the
// default fee per chain, connection preference, and the transactions this wallet sent.

import { ROOT_CHAIN } from "../config.ts";
import type { SignedSubmit } from "./types.ts";

export interface ChosenEndpoint {
  url: string;
  /** Confirmed from the endpoint's own /api/chain/info when it was chosen. */
  acceptsSubmit: boolean;
  /** "user": typed in; "discovered": operator-declared, served the committed block, not independently verified. */
  source: "user" | "discovered";
}

export interface SentTransaction {
  cid: string;
  to: string;
  amount: string;
  at: number;
  /** Absent on records from older versions. */
  from?: string;
  fee?: string;
  nonce?: string;
}

/** Claim-critical metadata for a deposit that has not yet been withdrawn.
 * This is deliberately separate from trimmed display history. */
export interface OpenDeposit {
  transactionCID: string;
  demander: string;
  depositNonce: string;
  amountDeposited: string;
  amountDemanded: string;
  fee: string;
  transactionNonce: string;
  childChain: string[];
  parentChain: string[];
  createdAt: number;
  expiresAt: string;
}

export interface PurchaseOffer {
  demander: string;
  depositNonce: string;
  amountDeposited: string;
  amountDemanded: string;
}

/** A paid receipt whose child-chain withdrawal still needs confirmation. */
export interface OpenPurchase {
  receiptCID: string;
  receiptSubmit: SignedSubmit;
  withdrawalCID?: string;
  withdrawalSubmit?: SignedSubmit;
  withdrawer: string;
  offers: PurchaseOffer[];
  parentChain: string[];
  childChain: string[];
  createdAt: number;
}

export interface Settings {
  chain: string;
  chains: string[];
  /** Automatic discovers verified submit nodes; custom requires an explicit endpoint per chain. */
  nodeMode: "automatic" | "custom";
  /** Survives Chrome closing the popup while it displays a host-permission prompt. */
  pendingAutomaticChain?: string;
  /** Resumes selecting any node after Chrome's host-permission prompt closes the popup. */
  pendingEndpoint?: {
    chain: string;
    url: string;
    source: ChosenEndpoint["source"];
    declaredSubmit: boolean;
    requireSubmit: boolean;
    nodeMode?: "automatic" | "custom";
    /** A newly entered cookie should be removed if permission or probing fails. */
    clearCookieOnFailure?: boolean;
  };
  /** Resumes node discovery after Chrome's host-permission prompt closes the popup. */
  pendingDiscovery?: { chain: string; url: string; autoSelect: boolean };
  endpoints: Record<string, ChosenEndpoint>;
  sent: Record<string, SentTransaction[]>;
  /** Never trim these. Remove one only after its withdrawal is confirmed. */
  openDeposits: OpenDeposit[];
  /** Never trim these. Remove one only after its child withdrawal confirms. */
  openPurchases: OpenPurchase[];
  /** The fee a new send starts with, per chain (decimal string); editable on every send. */
  fees: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = { chain: ROOT_CHAIN, chains: [ROOT_CHAIN], nodeMode: "automatic", endpoints: {}, sent: {}, openDeposits: [], openPurchases: [], fees: {} };

/** With no per-chain choice, a send starts at 1 unit: the smallest positive fee, not an estimate. */
export const FALLBACK_FEE = "1";

export function defaultFee(settings: Settings, chain: string): string {
  return settings.fees[chain] ?? FALLBACK_FEE;
}

/** A fee as the user typed it: a whole number of units, 0 or more. */
export function parseFee(text: string): bigint | null {
  const t = text.trim();
  return /^(0|[1-9][0-9]{0,18})$/.test(t) ? BigInt(t) : null;
}

export interface KeyValueStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadSettings(store: KeyValueStore): Promise<Settings> {
  const raw = (await store.get("settings")).settings as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
}

export async function saveSettings(store: KeyValueStore, settings: Settings): Promise<void> {
  await store.set({ settings });
}

/** Remember a sent transaction, newest first, at most 50 per chain. */
export function recordSent(settings: Settings, chain: string, tx: SentTransaction): Settings {
  const list = [tx, ...(settings.sent[chain] ?? []).filter((t) => t.cid !== tx.cid)].slice(0, 50);
  return { ...settings, sent: { ...settings.sent, [chain]: list } };
}

/** Save before submission: an ambiguous network failure may still mean the
 * node accepted the deposit. Deduplicate retries by the wallet-computed CID. */
export function recordOpenDeposit(settings: Settings, deposit: OpenDeposit): Settings {
  return {
    ...settings,
    openDeposits: [deposit, ...settings.openDeposits.filter((item) => item.transactionCID !== deposit.transactionCID)],
  };
}

export function recordOpenPurchase(settings: Settings, purchase: OpenPurchase): Settings {
  return {
    ...settings,
    openPurchases: [purchase, ...settings.openPurchases.filter((item) => item.receiptCID !== purchase.receiptCID)],
  };
}
