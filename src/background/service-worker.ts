// Background service worker — the extension's SOLE signer. It hosts the shared
// signer (src/lib/wallet/signer.ts) over chrome.storage; the popup talks to it
// by message, and private keys never cross that boundary. Idle auto-lock
// clears the session and wipes mutable secret buffers (JS strings cannot be wiped).

import { createSigner } from "../lib/wallet/signer.ts";
import type { Vault } from "../lib/crypto/keystore.ts";
import type { Request, Response, SignedSubmit, WalletState } from "../lib/wallet/types.ts";
import { browserFetch, describe, isDefiniteSubmissionRefusal, submitChecked, submitter } from "../lib/wallet/node.ts";
import { isNonce, pageOrigin, parseProviderCall, type ProviderCall } from "../lib/wallet/provider.ts";
import type { PageWrite } from "../lib/wallet/nonce.ts";

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
  /** For a write: the account shown to the person, the only one that may sign it. */
  address: string | null;
  /** Approved and being signed or sent: closing the window no longer declines it. */
  approved?: boolean;
  window?: number;
  settle: (r: Response) => void;
}
const pending = new Map<string, Pending>();
// A site whose request was just declined waits before asking again, so a
// page cannot reopen the window the moment it is closed.
const DECLINE_PAUSE_MS = 5000;
const declinedAt = new Map<string, number>();
function declined(request: Pending) {
  declinedAt.set(request.origin, Date.now());
  request.settle({ ok: false, error: "The person declined" });
}
const connections = async (): Promise<Record<string, string>> =>
  ((await store.get("connections")).connections as Record<string, string> | undefined) ?? {};

async function ask(origin: string, call: ProviderCall, address: string | null): Promise<Response> {
  // One waiting request per site: a page cannot stack windows, or slip a
  // second request under a click meant for the first.
  if ([...pending.values()].some((request) => request.origin === origin)) {
    return { ok: false, error: "A request from this site is already waiting in the wallet" };
  }
  if (Date.now() - (declinedAt.get(origin) ?? -Infinity) < DECLINE_PAUSE_MS) {
    return { ok: false, error: "The person just declined; ask again in a moment" };
  }
  const id = crypto.randomUUID();
  return new Promise((settle) => {
    const request: Pending = { origin, call, address, settle: (r) => { pending.delete(id); settle(r); } };
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
      return address ? { ok: true, address } as Response : ask(origin, call, null);
    case "writeRecords":
      if (!address) return { ok: false, error: "Not connected: call connect() first" };
      return ask(origin, call, address);
  }
}

/** The approval window's view of its request, and the person's answer. */
/** Page writes this wallet signed, until the chain's nonce passes them (nonce.ts). */
const pageWrites = async (): Promise<PageWrite[]> =>
  ((await store.get("pageWrites")).pageWrites as PageWrite[] | undefined) ?? [];

// Decisions run one at a time: two windows signing for one account must not
// both take a nonce, or both rewrite pageWrites.
let deciding: Promise<unknown> = Promise.resolve();
function serialized(msg: Parameters<typeof decideNow>[0]): Promise<Response> {
  const next = deciding.then(() => decideNow(msg));
  deciding = next.catch(() => {});
  return next;
}

async function fromApproval(msg: Parameters<typeof decideNow>[0]): Promise<Response> {
  if (msg.type === "decide") return serialized(msg);
  return decideNow(msg);
}

async function decideNow(msg: { type: string; id?: string; approve?: boolean; address?: string; nonce?: unknown; stateNonce?: unknown; node?: unknown; stale?: unknown }): Promise<Response> {
  const request = msg.id ? pending.get(msg.id) : undefined;
  if (!request) return { ok: false, error: "This request is gone (answered, or the page went away)." };
  if (msg.type === "pending") return { ok: true, origin: request.origin, call: request.call, address: request.address } as Response;
  if (!msg.approve) {
    declined(request);
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
  if (request.call.method !== "writeRecords" || !request.address) return { ok: false, error: "Not connected" };
  // Sign only as the account the person was shown, and only while the site
  // is still connected to it.
  if ((await connections())[request.origin] !== request.address) {
    request.settle({ ok: false, error: "The site's connection changed; ask again" });
    return { ok: false, error: "This site's connection changed since this request was made. Nothing was signed." };
  }
  // The nonce the window read from the person's node (nonce.ts); never the page's.
  if (!isNonce(msg.nonce) || !isNonce(msg.stateNonce) || typeof msg.node !== "string") {
    return { ok: false, error: "The wallet has not read this account's nonce" };
  }
  const chain = request.call.params.chainPath.join("/");
  const from = request.address;
  const nonce = msg.nonce;
  // Writes the window found the node's pool no longer holds stop keeping their nonce.
  const stale = Array.isArray(msg.stale) ? msg.stale.filter((cid): cid is string => typeof cid === "string") : [];
  if (stale.length) await store.set({ pageWrites: (await pageWrites()).filter((p) => !(p.chain === chain && p.cid && stale.includes(p.cid))) });
  if ((await pageWrites()).some((p) => p.chain === chain && p.from === from && p.nonce === nonce)) {
    return { ok: false, error: "That nonce was just taken; check again" };
  }
  request.approved = true;
  try {
    return await signAndSend(request, from, chain, nonce, msg.node, BigInt(msg.stateNonce));
  } catch (e) {
    // Never leave an approved request unanswered: the site could ask nothing again.
    const reason = String((e as Error)?.message ?? e);
    request.settle({ ok: false, error: `The wallet could not finish: ${reason}` });
    return { ok: false, error: reason };
  }
}

async function signAndSend(request: Pending, from: string, chain: string, nonce: string, nodeURL: string, passed: bigint): Promise<Response> {
  if (request.call.method !== "writeRecords") return { ok: false, error: "Not a write" };
  const signed = await signer.handle({ type: "signRecords", from, ...request.call.params, nonce });
  if (!signed.ok) { request.approved = false; return signed; } // e.g. locked: the window unlocks and tries again
  const signedSubmit = (signed as unknown as { signedSubmit: SignedSubmit }).signedSubmit;
  // The wallet submits, to the node it read the nonce from: a page never
  // holds a signed write it could send later, against the person's next
  // transaction at that nonce.
  const auth = await signer.handle({ type: "nodeAuthorization", url: nodeURL });
  let delivered: "yes" | "uncertain" = "yes";
  let failure = "";
  try {
    await submitChecked(submitter(nodeURL, browserFetch, auth.ok ? (auth as unknown as { authorization?: string }).authorization : undefined), signedSubmit);
  } catch (e) {
    if (isDefiniteSubmissionRefusal(e)) {
      request.settle({ ok: false, error: `The node refused it: ${describe(e)}` });
      return { ok: false, error: `The node refused it: ${describe(e)}. Nothing was sent.` };
    }
    delivered = "uncertain";
    failure = describe(e);
  }
  // Pending until the chain's nonce passes it, even if delivery is uncertain:
  // it may have been admitted.
  await store.set({ pageWrites: [
    ...(await pageWrites()).filter((p) => !(p.chain === chain && p.from === from && BigInt(p.nonce) < passed)),
    { chain, from, nonce, cid: signedSubmit.transactionCID, node: nodeURL },
  ] });
  request.settle(delivered === "yes"
    ? { ok: true, transactionCID: signedSubmit.transactionCID } as Response // the CID only: never bytes a page could send later
    : { ok: false, error: `Sent, but the node did not confirm it (${failure}); it may still land`, transactionCID: signedSubmit.transactionCID } as Response);
  return { ok: true };
}

chrome.windows.onRemoved.addListener((closed) => {
  for (const request of pending.values()) {
    if (request.window === closed && !request.approved) declined(request);
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
      : msg.type === "getState" || msg.type === "unlock" || msg.type === "nodeAuthorization" ? signer.handle(msg)
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
