// Shared types for the popup <-> background-signer protocol. Note: AccountView
// and every message intentionally carry NO private key material.

import type { NetworkId } from "../config.ts";

/** Persisted, encrypted-at-rest wallet contents (the vault plaintext). */
export interface WalletData {
  mnemonic: string | null; // null = import-only wallet
  hd: { index: number; label: string }[]; // accounts derived from the mnemonic
  imported: { priv: string; label: string }[]; // raw-key accounts (hex)
  active: string | null; // active account address
}

export interface AccountView {
  address: string;
  publicKey: string; // multikey hex
  label: string;
  kind: "hd" | "imported";
  index: number; // hd account index, or position in imported[]
}

export interface WalletState {
  initialized: boolean; // a vault exists on disk
  locked: boolean; // no in-memory session
  network: NetworkId;
  accounts: AccountView[];
  active: string | null;
}

export interface SignedSubmit {
  signatures: Record<string, string>;
  bodyCID: string;
  bodyData: string; // hex
  chainPath: string[];
}

export interface TransferSummary {
  from: string;
  to: string;
  amount: string;
  fee: string;
  nonce: string;
}

// ---- request/response messages ----
export type Request =
  | { type: "getState" }
  | { type: "createWallet"; password: string; mnemonic?: string; privHex?: string; network?: NetworkId }
  | { type: "unlock"; password: string }
  | { type: "lock" }
  | { type: "addAccount"; label?: string }
  | { type: "importKey"; privHex: string; label?: string }
  | { type: "setActive"; address: string }
  | { type: "setNetwork"; network: NetworkId }
  | { type: "reset" }
  | {
      type: "signTransfer";
      from: string;
      to: string;
      amount: string; // decimal string (UInt64)
      fee: string;
      nonce: string;
      chainPath: string[];
    };

export type Ok<T = object> = { ok: true } & T;
export type Err = { ok: false; error: string };
export type Response<T = object> = Ok<T> | Err;
