// Popup-side messaging client. Thin typed wrapper over runtime messaging; the
// popup never imports key material — it only exchanges these messages.

import type { Request, Response, WalletState, SignedSubmit, TransferSummary } from "./types.ts";

async function send<T = object>(msg: Request): Promise<Response<T>> {
  return (await chrome.runtime.sendMessage(msg)) as Response<T>;
}

type WithState = { state: WalletState };

export const wallet = {
  getState: () => send<WithState>({ type: "getState" }),
  create: (password: string, opts: { mnemonic?: string; privHex?: string; network?: WalletState["network"] }) =>
    send<WithState>({ type: "createWallet", password, ...opts }),
  unlock: (password: string) => send<WithState>({ type: "unlock", password }),
  lock: () => send<WithState>({ type: "lock" }),
  reset: () => send<WithState>({ type: "reset" }),
  addAccount: (label?: string) => send<WithState>({ type: "addAccount", label }),
  importKey: (privHex: string, label?: string) => send<WithState>({ type: "importKey", privHex, label }),
  setActive: (address: string) => send<WithState>({ type: "setActive", address }),
  setNetwork: (network: WalletState["network"]) => send<WithState>({ type: "setNetwork", network }),
  signTransfer: (args: { from: string; to: string; amount: string; fee: string; nonce: string; chainPath: string[] }) =>
    send<{ signedSubmit: SignedSubmit; summary: TransferSummary }>({ type: "signTransfer", ...args }),
};
