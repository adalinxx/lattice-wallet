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
  /** Legacy recovery bytes. New versions keep these in pendingSubmissions. */
  signedSubmit?: SignedSubmit;
}

/** An ordinary transfer whose final chain outcome is not known yet. This is
 * recovery state, not display history, so it must never be trimmed. */
export interface PendingSubmission extends SentTransaction {
  from: string;
  fee: string;
  nonce: string;
  signedSubmit: SignedSubmit;
  chain: string;
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
  /** Exact bytes used for safe resubmission after an ambiguous network error. */
  signedSubmit?: SignedSubmit;
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
  /** Every withdrawal attempt, oldest first. Never discard an
   * earlier CID merely because a fee replacement was created. */
  withdrawalAttempts?: SignedSubmit[];
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
  /** Never trim these. Remove only after chain status proves a final outcome. */
  pendingSubmissions: PendingSubmission[];
  /** Deeply confirmed transfers, capped but still manually recoverable. */
  confirmedSubmissions: PendingSubmission[];
  /** Never trim these. Remove one only after a verified parent receipt confirms the sale. */
  openDeposits: OpenDeposit[];
  /** Never trim these. Remove only after verified state identifies this buyer's withdrawal, not merely a spent deposit. */
  openPurchases: OpenPurchase[];
  /** Protocol-confirmed purchases, capped but retaining their signed bytes. */
  confirmedPurchases: OpenPurchase[];
  /** The fee a new send starts with, per chain (decimal string); editable on every send. */
  fees: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = { chain: ROOT_CHAIN, chains: [ROOT_CHAIN], nodeMode: "automatic", endpoints: {}, sent: {}, pendingSubmissions: [], confirmedSubmissions: [], openDeposits: [], openPurchases: [], confirmedPurchases: [], fees: {} };

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
  const loaded = { ...DEFAULT_SETTINGS, ...(raw ?? {}),
    confirmedSubmissions: raw?.confirmedSubmissions ?? [], confirmedPurchases: raw?.confirmedPurchases ?? [] };
  return {
    ...loaded,
    openPurchases: loaded.openPurchases.map((purchase) => {
      const legacy = purchase as OpenPurchase & { withdrawalSubmit?: SignedSubmit };
      const { withdrawalSubmit, ...current } = legacy;
      return withdrawalSubmit && !current.withdrawalAttempts?.length
        ? { ...current, withdrawalAttempts: [withdrawalSubmit] }
        : current;
    }),
  };
}

export async function saveSettings(store: KeyValueStore, settings: Settings): Promise<void> {
  await store.set({ settings });
}

/** Remember a sent transaction, newest first, at most 50 per chain. */
export function recordSent(settings: Settings, chain: string, tx: SentTransaction): Settings {
  const list = [tx, ...(settings.sent[chain] ?? []).filter((t) => t.cid !== tx.cid)].slice(0, 50);
  return { ...settings, sent: { ...settings.sent, [chain]: list } };
}

export function forgetSent(settings: Settings, chain: string, cid: string): Settings {
  return { ...settings, sent: { ...settings.sent, [chain]: (settings.sent[chain] ?? []).filter((tx) => tx.cid !== cid) } };
}

export function recordPendingSubmission(settings: Settings, submission: PendingSubmission): Settings {
  return {
    ...settings,
    pendingSubmissions: [submission, ...settings.pendingSubmissions.filter((item) => item.cid !== submission.cid)],
  };
}

export function completePendingSubmission(settings: Settings, cid: string): Settings {
  return { ...settings, pendingSubmissions: settings.pendingSubmissions.filter((item) => item.cid !== cid) };
}

export function archivePendingSubmission(settings: Settings, cid: string): Settings {
  const item = settings.pendingSubmissions.find((candidate) => candidate.cid === cid);
  if (!item) return settings;
  return {
    ...settings,
    pendingSubmissions: settings.pendingSubmissions.filter((candidate) => candidate.cid !== cid),
    confirmedSubmissions: [item, ...settings.confirmedSubmissions.filter((candidate) => candidate.cid !== cid)].slice(0, 50),
  };
}

/** Save before submission: an ambiguous network failure may still mean the
 * node accepted the deposit. Deduplicate retries by the wallet-computed CID. */
export function recordOpenDeposit(settings: Settings, deposit: OpenDeposit): Settings {
  const existing = settings.openDeposits.find((item) => item.transactionCID === deposit.transactionCID);
  return {
    ...settings,
    openDeposits: [existing ?? deposit, ...settings.openDeposits.filter((item) => item.transactionCID !== deposit.transactionCID)],
  };
}

export function completeOpenDeposit(settings: Settings, transactionCID: string): Settings {
  return { ...settings, openDeposits: settings.openDeposits.filter((item) => item.transactionCID !== transactionCID) };
}

export function recordOpenPurchase(settings: Settings, purchase: OpenPurchase): Settings {
  const existing = settings.openPurchases.find((item) => item.receiptCID === purchase.receiptCID);
  return {
    ...settings,
    openPurchases: [existing ?? purchase, ...settings.openPurchases.filter((item) => item.receiptCID !== purchase.receiptCID)],
  };
}

export function completeOpenPurchase(settings: Settings, receiptCID: string): Settings {
  return { ...settings, openPurchases: settings.openPurchases.filter((item) => item.receiptCID !== receiptCID) };
}

export function archiveOpenPurchase(settings: Settings, receiptCID: string): Settings {
  const item = settings.openPurchases.find((candidate) => candidate.receiptCID === receiptCID);
  if (!item) return settings;
  return {
    ...settings,
    openPurchases: settings.openPurchases.filter((candidate) => candidate.receiptCID !== receiptCID),
    confirmedPurchases: [item, ...settings.confirmedPurchases.filter((candidate) => candidate.receiptCID !== receiptCID)].slice(0, 50),
  };
}

export function purchaseWithdrawalAttempts(purchase: OpenPurchase): SignedSubmit[] {
  return purchase.withdrawalAttempts ?? [];
}

/** Append a same-nonce withdrawal attempt without losing any earlier CID. */
export function recordWithdrawalAttempt(settings: Settings, receiptCID: string, signed: SignedSubmit): Settings {
  return {
    ...settings,
    openPurchases: settings.openPurchases.map((item) => {
      if (item.receiptCID !== receiptCID) return item;
      const attempts = purchaseWithdrawalAttempts(item);
      return {
        ...item,
        withdrawalCID: signed.transactionCID,
        withdrawalAttempts: [...attempts.filter((attempt) => attempt.transactionCID !== signed.transactionCID), signed],
      };
    }),
  };
}

/** Remove one definitely refused replacement and restore the preceding
 * attempt as current without discarding its CID or signed bytes. */
export function forgetWithdrawalAttempt(settings: Settings, receiptCID: string, transactionCID: string): Settings {
  return {
    ...settings,
    openPurchases: settings.openPurchases.map((item) => {
      if (item.receiptCID !== receiptCID) return item;
      const all = purchaseWithdrawalAttempts(item);
      const removedNonce = all.find((attempt) => attempt.transactionCID === transactionCID)?.payload.transaction.body.nonce;
      const attempts = all.filter((attempt) => attempt.transactionCID !== transactionCID);
      const latest = [...attempts].reverse().find((attempt) => attempt.payload.transaction.body.nonce === removedNonce);
      return { ...item, withdrawalCID: latest?.transactionCID, withdrawalAttempts: attempts.length ? attempts : undefined };
    }),
  };
}
