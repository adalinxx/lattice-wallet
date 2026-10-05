// Background service worker — the extension's SOLE signer. It hosts the shared
// signer (src/lib/wallet/signer.ts) over chrome.storage; the popup talks to it
// by message, and private keys never cross that boundary. Idle auto-lock
// zeroes the session.

import { createSigner } from "../lib/wallet/signer.ts";
import type { Vault } from "../lib/crypto/keystore.ts";
import type { Request } from "../lib/wallet/types.ts";

const AUTO_LOCK_MINUTES = 10;
const store = chrome.storage.local;

const signer = createSigner(
  {
    load: async () => ((await store.get("vault")).vault as Vault | undefined) ?? null,
    save: (vault) => store.set({ vault }),
    remove: () => store.remove(["vault"]),
  },
  () => chrome.alarms.create("auto-lock", { delayInMinutes: AUTO_LOCK_MINUTES }),
);

chrome.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  chrome.alarms.create("auto-lock", { delayInMinutes: AUTO_LOCK_MINUTES });
  signer.handle(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "auto-lock") signer.lock();
});

export {};
