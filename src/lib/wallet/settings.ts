// Non-secret settings, kept beside (never inside) the encrypted vault: the
// selected chain, the user's chain list, the endpoint chosen per chain, and
// the transactions this wallet sent. No defaults point at any node.

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
}

export interface Settings {
  chain: string;
  chains: string[];
  endpoints: Record<string, ChosenEndpoint>;
  sent: Record<string, SentTransaction[]>;
}

export const DEFAULT_SETTINGS: Settings = { chain: ROOT_CHAIN, chains: [ROOT_CHAIN], endpoints: {}, sent: {} };

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
