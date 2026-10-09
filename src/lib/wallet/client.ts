// UI-side signer client. Thin typed wrapper over a message channel to the
// signer; the UI never imports key material — it only exchanges these
// messages (the extension's channel is runtime messaging to its worker).

import type { Request, Response, WalletState, SignedSubmit, TransferSummary } from "./types.ts";

type WithState = { state: WalletState };
type Send = (msg: Request) => Promise<Response<object>>;

export function walletClient(send: Send) {
  const call = <T = object>(msg: Request) => send(msg) as Promise<Response<T>>;
  return {
    getState: () => call<WithState>({ type: "getState" }),
    create: (password: string, opts: { mnemonic?: string; privHex?: string }) =>
      call<WithState>({ type: "createWallet", password, ...opts }),
    unlock: (password: string) => call<WithState>({ type: "unlock", password }),
    lock: () => call<WithState>({ type: "lock" }),
    reset: () => call<WithState>({ type: "reset" }),
    addAccount: (label?: string) => call<WithState>({ type: "addAccount", label }),
    importKey: (privHex: string, label?: string) => call<WithState>({ type: "importKey", privHex, label }),
    setActive: (address: string) => call<WithState>({ type: "setActive", address }),
    /** Pair (or, with null, unpair) a node: keep its operator cookie in the vault. */
    setNodeCookie: (url: string, cookie: string | null) => call({ type: "setNodeCookie", url, cookie }),
    /** The Authorization header for a paired node; absent when unpaired. */
    nodeAuthorization: (url: string) => call<{ authorization?: string }>({ type: "nodeAuthorization", url }),
    /** The vault re-encrypted with the (re-entered) password: CBOR hex for `ur:lattice-vault`. */
    exportBackup: (password: string, includeNodeCookies = false) =>
      call<{ backup: string }>({ type: "exportBackup", password, includeNodeCookies }),
    /**
     * The recovery phrase as a SeedQR, rendered to SVG inside the signer. The
     * picture is the phrase: the one secret the page receives, only to display it.
     */
    exportSeedQR: (password: string, format: "standard" | "compact") =>
      call<{ svg: string }>({ type: "exportSeedQR", password, format }),
    /** Restore (no wallet yet), or merge into / replace the open wallet. */
    importBackup: (backup: string, password: string, mode: "merge" | "replace", currentPassword?: string) =>
      call<WithState>({ type: "importBackup", backup, password, mode, currentPassword }),
    /** Receiver: a one-time pairing offer (CBOR hex for `ur:lattice-pair`). */
    transferOffer: () => call<{ offer: string; expires: number }>({ type: "transferOffer" }),
    /** Sender: the backup sealed to a scanned offer (CBOR hex for `ur:lattice-transfer`) and the code to compare. */
    transferSend: (offer: string, password: string) => call<{ envelope: string; sas: string }>({ type: "transferSend", offer, password }),
    /** Receiver: open a scanned transfer (single use); yields the encrypted backup and the code to compare. */
    transferOpen: (envelope: string) => call<{ backup: string; sas: string }>({ type: "transferOpen", envelope }),
    signTransfer: (args: { from: string; to: string; amount: string; fee: string; nonce: string; chainPath: string[] }) =>
      call<{ signedSubmit: SignedSubmit; summary: TransferSummary }>({ type: "signTransfer", ...args }),
    signDeposit: (args: { from: string; amountDeposited: string; amountDemanded: string; depositNonce: string; fee: string; nonce: string; chainPath: string[] }) =>
      call<{ signedSubmit: SignedSubmit }>({ type: "signDeposit", ...args }),
    signReceipt: (args: { from: string; offers: { demander: string; amountDemanded: string; amountDeposited: string; depositNonce: string }[]; directory: string; fee: string; nonce: string; chainPath: string[] }) =>
      call<{ signedSubmit: SignedSubmit }>({ type: "signReceipt", ...args }),
    signWithdrawal: (args: { from: string; offers: { demander: string; amountDemanded: string; amountDeposited: string; depositNonce: string }[]; fee: string; nonce: string; chainPath: string[] }) =>
      call<{ signedSubmit: SignedSubmit }>({ type: "signWithdrawal", ...args }),
  };
}

export type WalletClient = ReturnType<typeof walletClient>;
