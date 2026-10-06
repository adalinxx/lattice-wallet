// Shared types for the popup <-> background-signer protocol. Note: AccountView
// and every message intentionally carry NO private key material.

import type { TransactionPayload } from "@adalinxx/lattice-core";

/** Persisted, encrypted-at-rest wallet contents (the vault plaintext). */
export interface WalletData {
  mnemonic: string | null; // null = import-only wallet
  hd: { index: number; label: string }[]; // accounts derived from the mnemonic
  imported: { priv: string; label: string }[]; // raw-key accounts (hex)
  active: string | null; // active account address
  /**
   * Paired nodes: node base URL -> the cookie its operator (loopback) port
   * requires (the content of the node's `.cookie` file). Encrypted with the
   * keys; absent in vaults from older versions.
   */
  nodeCookies?: Record<string, string>;
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
  accounts: AccountView[];
  active: string | null;
}

/** A signed transfer: the SDK's POST /transactions payload (plain JSON, exact decimal strings). */
export interface SignedSubmit {
  payload: TransactionPayload;
  bodyCID: string;
  /** Computed locally; a node must report this same CID on submission. */
  transactionCID: string;
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
  | { type: "createWallet"; password: string; mnemonic?: string; privHex?: string }
  | { type: "unlock"; password: string }
  | { type: "lock" }
  | { type: "addAccount"; label?: string }
  | { type: "importKey"; privHex: string; label?: string }
  | { type: "setActive"; address: string }
  | { type: "reset" }
  | { type: "setNodeCookie"; url: string; cookie: string | null }
  | { type: "nodeAuthorization"; url: string }
  // ---- backup & transfer (every export re-checks the password) ----
  | { type: "exportBackup"; password: string; includeNodeCookies?: boolean }
  | { type: "exportSeedQR"; password: string; format: "standard" | "compact" }
  | { type: "importBackup"; backup: string; password: string; mode: "merge" | "replace" }
  | { type: "transferOffer" }
  | { type: "transferSend"; offer: string; password: string }
  | { type: "transferOpen"; envelope: string }
  | {
      type: "signTransfer";
      from: string;
      to: string;
      amount: string; // decimal string (UInt64)
      fee: string;
      nonce: string;
      chainPath: string[];
    }
  | {
      type: "signDeposit";
      from: string;
      amountDeposited: string;
      amountDemanded: string;
      depositNonce: string;
      fee: string;
      nonce: string;
      chainPath: string[];
    }
  | {
      type: "signReceipt" | "signWithdrawal";
      from: string;
      offers: { demander: string; amountDemanded: string; amountDeposited: string; depositNonce: string }[];
      fee: string;
      nonce: string;
      chainPath: string[];
      directory?: string;
    };

export type Ok<T = object> = { ok: true } & T;
export type Err = { ok: false; error: string };
export type Response<T = object> = Ok<T> | Err;
