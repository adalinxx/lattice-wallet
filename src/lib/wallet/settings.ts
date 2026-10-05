// Non-secret settings, kept beside (never inside) the encrypted vault: the
// selected chain, the user's chain list, the endpoint chosen per chain, the
// default fee per chain, and the transactions this wallet sent. No defaults point at any node.

import { ROOT_CHAIN } from "../config.ts";

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

export interface Settings {
  chain: string;
  chains: string[];
  endpoints: Record<string, ChosenEndpoint>;
  sent: Record<string, SentTransaction[]>;
  /** The fee a new send starts with, per chain (decimal string); editable on every send. */
  fees: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = { chain: ROOT_CHAIN, chains: [ROOT_CHAIN], endpoints: {}, sent: {}, fees: {} };

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
