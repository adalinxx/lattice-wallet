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
    signTransfer: (args: { from: string; to: string; amount: string; fee: string; nonce: string; chainPath: string[] }) =>
      call<{ signedSubmit: SignedSubmit; summary: TransferSummary }>({ type: "signTransfer", ...args }),
  };
}

export type WalletClient = ReturnType<typeof walletClient>;
