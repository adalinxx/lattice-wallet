// Background service worker — the extension's SOLE signer. It hosts the shared
// signer (src/lib/wallet/signer.ts) over chrome.storage; the popup talks to it
// by message, and private keys never cross that boundary. Idle auto-lock
// clears the session and wipes mutable secret buffers (JS strings cannot be wiped).

import { createSigner } from "../lib/wallet/signer.ts";
import type { Vault } from "../lib/crypto/keystore.ts";
import type { Request, Response, WalletState } from "../lib/wallet/types.ts";
import { pageOrigin, parseProviderCall, type ProviderCall } from "../lib/wallet/provider.ts";

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

// ---- web pages (`window.lattice`, through the content script) ----
// A page may learn the address it was given and ask to write records. Each
// connection and each write is approved by the person in a window of the
// wallet's own; the page never touches the signer.

interface Pending {
  origin: string;
  call: ProviderCall;
  window?: number;
  settle: (r: Response) => void;
}
const pending = new Map<string, Pending>();
const connections = async (): Promise<Record<string, string>> =>
  ((await store.get("connections")).connections as Record<string, string> | undefined) ?? {};

async function ask(origin: string, call: ProviderCall): Promise<Response> {
  const id = crypto.randomUUID();
  return new Promise((settle) => {
    const request: Pending = { origin, call, settle: (r) => { pending.delete(id); settle(r); } };
    pending.set(id, request);
    chrome.windows.create({ url: chrome.runtime.getURL(`approve/index.html?id=${id}`), type: "popup", width: 380, height: 600 })
      .then((w) => { request.window = w?.id; })
      .catch((e) => request.settle({ ok: false, error: String(e?.message ?? e) }));
  });
}

async function fromPage(origin: string, raw: unknown): Promise<Response> {
  const call = parseProviderCall(raw);
  if ("error" in call) return { ok: false, error: call.error };
  const address = (await connections())[origin] ?? null;
  switch (call.method) {
    case "address":
      return { ok: true, address } as Response;
    case "disconnect": {
      const all = await connections();
      delete all[origin];
      await store.set({ connections: all });
      return { ok: true, address: null } as Response;
    }
    case "connect":
      return address ? { ok: true, address } as Response : ask(origin, call);
    case "writeRecords":
      if (!address) return { ok: false, error: "Not connected: call connect() first" };
      return ask(origin, call);
  }
}

/** The approval window's view of its request, and the person's answer. */
async function fromApproval(msg: { type: string; id?: string; approve?: boolean; address?: string }): Promise<Response> {
  const request = msg.id ? pending.get(msg.id) : undefined;
  if (!request) return { ok: false, error: "This request is gone (answered, or the page went away)." };
  const address = (await connections())[request.origin] ?? null;
  if (msg.type === "pending") return { ok: true, origin: request.origin, call: request.call, address } as Response;
  if (!msg.approve) {
    request.settle({ ok: false, error: "The person declined" });
    return { ok: true };
  }
  if (request.call.method === "connect") {
    const state = await signer.handle({ type: "getState" });
    const chosen = state.ok ? (state as unknown as { state: WalletState }).state.accounts.find((a) => a.address === msg.address) : undefined;
    if (!chosen) return { ok: false, error: "Choose one of this wallet's accounts" };
    await store.set({ connections: { ...(await connections()), [request.origin]: chosen.address } });
    request.settle({ ok: true, address: chosen.address } as Response);
    return { ok: true };
  }
  if (request.call.method !== "writeRecords" || !address) return { ok: false, error: "Not connected" };
  const signed = await signer.handle({ type: "signRecords", from: address, ...request.call.params });
  if (!signed.ok) return signed; // e.g. locked: the window unlocks and tries again
  request.settle(signed);
  return { ok: true };
}

chrome.windows.onRemoved.addListener((closed) => {
  for (const request of pending.values()) {
    if (request.window === closed) request.settle({ ok: false, error: "The person declined" });
  }
});

const APPROVE_PAGE = chrome.runtime.getURL("approve/index.html");

chrome.runtime.onMessage.addListener((message: { type?: unknown }, sender, sendResponse) => {
  const msg = message as Request;
  if (sender.id !== chrome.runtime.id) return false;
  const page = sender.url?.split(/[?#]/, 1)[0];
  if (message?.type === "provider" && page !== APPROVE_PAGE && page !== chrome.runtime.getURL("popup/index.html")) {
    const origin = pageOrigin(sender);
    if (!origin) return false;
    fromPage(origin, (message as { call?: unknown }).call).then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  if (page === APPROVE_PAGE) {
    // The approval window answers its request, and may read state and unlock.
    const kind = message?.type;
    const answer = kind === "pending" || kind === "decide" ? fromApproval(message as never)
      : msg.type === "getState" || msg.type === "unlock" ? signer.handle(msg)
      : Promise.resolve({ ok: false, error: "Not allowed here" } as Response);
    if (kind === "unlock" || kind === "decide") chrome.alarms.create("auto-lock", { delayInMinutes: AUTO_LOCK_MINUTES });
    answer.then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  if (page !== chrome.runtime.getURL("popup/index.html")) return false;
  if (msg.type !== "getState" && msg.type !== "nodeAuthorization") chrome.alarms.create("auto-lock", { delayInMinutes: AUTO_LOCK_MINUTES });
  signer.handle(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "auto-lock") return;
  signer.lock();
  // Tell any open wallet page, so it covers itself now. No page open is not an error.
  chrome.runtime.sendMessage({ type: "locked" }).catch(() => {});
});

export {};
