// Background service worker — the SOLE signer. It owns the encrypted vault, and
// while unlocked holds the decrypted secrets in memory only. The popup talks to
// it by message; private keys never cross that boundary. Idle auto-lock zeroes
// the session.

import { encryptVault, decryptVault, type Vault } from "../lib/crypto/keystore.ts";
import { buildTransferBody, bodyPreimage } from "../lib/tx/build.ts";
import { signPreimage } from "../lib/crypto/ed25519.ts";
import { bytesToHex } from "../lib/crypto/bytes.ts";
import { deriveAccounts, toView, nextHdLabel, type LiveAccount } from "../lib/wallet/session.ts";
import { deriveAccount, importPrivateKey } from "../lib/crypto/accounts.ts";
import { DEFAULT_NETWORK, type NetworkId } from "../lib/config.ts";
import type { Request, Response, WalletData, WalletState } from "../lib/wallet/types.ts";

const AUTO_LOCK_MINUTES = 10;
const store = chrome.storage.local;

// In-memory unlocked session (lost on auto-lock or worker teardown).
interface Session {
  password: string;
  data: WalletData;
  accounts: LiveAccount[];
}
let session: Session | null = null;

// ---- persistence ----
async function loadVault(): Promise<Vault | null> {
  return ((await store.get("vault")).vault as Vault | undefined) ?? null;
}
async function loadNetwork(): Promise<NetworkId> {
  return ((await store.get("network")).network as NetworkId | undefined) ?? DEFAULT_NETWORK;
}
async function persistData() {
  if (!session) return;
  await store.set({ vault: await encryptVault(session.password, session.data) });
}
function touchAutoLock() {
  chrome.alarms.create("auto-lock", { delayInMinutes: AUTO_LOCK_MINUTES });
}
function openSession(password: string, data: WalletData) {
  session = { password, data, accounts: deriveAccounts(data) };
  touchAutoLock();
}

// ---- state view ----
async function stateView(): Promise<WalletState> {
  const initialized = (await loadVault()) != null;
  return {
    initialized,
    locked: session == null,
    network: await loadNetwork(),
    accounts: session ? session.accounts.map(toView) : [],
    active: session?.data.active ?? null,
  };
}
function findAccount(address: string): LiveAccount | undefined {
  return session?.accounts.find((a) => a.address === address);
}

// ---- handlers ----
async function handle(msg: Request): Promise<Response> {
  switch (msg.type) {
    case "getState":
      return { ok: true, state: await stateView() } as Response;

    case "createWallet": {
      if (await loadVault()) return { ok: false, error: "Wallet already exists" };
      let data: WalletData;
      if (msg.mnemonic) {
        const addr0 = deriveAccount(msg.mnemonic, 0).address;
        data = { mnemonic: msg.mnemonic, hd: [{ index: 0, label: "Account 1" }], imported: [], active: addr0 };
      } else if (msg.privHex) {
        let acct;
        try {
          acct = importPrivateKey(msg.privHex.trim());
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
        data = { mnemonic: null, hd: [], imported: [{ priv: msg.privHex.trim().replace(/^0x/, ""), label: "Imported 1" }], active: acct.address };
      } else {
        return { ok: false, error: "Provide a recovery phrase or a private key" };
      }
      if (msg.network) await store.set({ network: msg.network });
      session = { password: msg.password, data, accounts: deriveAccounts(data) };
      await persistData();
      touchAutoLock();
      return { ok: true, state: await stateView() } as Response;
    }

    case "unlock": {
      const vault = await loadVault();
      if (!vault) return { ok: false, error: "No wallet to unlock" };
      try {
        const data = await decryptVault<WalletData>(msg.password, vault);
        openSession(msg.password, data);
        return { ok: true, state: await stateView() } as Response;
      } catch {
        return { ok: false, error: "Wrong password" };
      }
    }

    case "lock":
      session = null;
      return { ok: true, state: await stateView() } as Response;

    case "reset":
      session = null;
      await store.remove(["vault"]);
      return { ok: true, state: await stateView() } as Response;

    case "addAccount": {
      if (!session?.data.mnemonic) return { ok: false, error: "Locked or no recovery phrase" };
      const { index, label } = nextHdLabel(session.data);
      session.data.hd.push({ index, label: msg.label?.trim() || label });
      session.accounts = deriveAccounts(session.data);
      session.data.active = deriveAccount(session.data.mnemonic, index).address;
      await persistData();
      return { ok: true, state: await stateView() } as Response;
    }

    case "importKey": {
      if (!session) return { ok: false, error: "Locked" };
      let acct;
      try {
        acct = importPrivateKey(msg.privHex.trim());
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      if (session.accounts.some((a) => a.address === acct.address)) return { ok: false, error: "Account already exists" };
      session.data.imported.push({ priv: msg.privHex.trim().replace(/^0x/, ""), label: msg.label?.trim() || `Imported ${session.data.imported.length + 1}` });
      session.accounts = deriveAccounts(session.data);
      session.data.active = acct.address;
      await persistData();
      return { ok: true, state: await stateView() } as Response;
    }

    case "setActive": {
      if (!session) return { ok: false, error: "Locked" };
      if (!findAccount(msg.address)) return { ok: false, error: "Unknown account" };
      session.data.active = msg.address;
      await persistData();
      return { ok: true, state: await stateView() } as Response;
    }

    case "setNetwork":
      await store.set({ network: msg.network });
      return { ok: true, state: await stateView() } as Response;

    case "signTransfer": {
      if (!session) return { ok: false, error: "Locked" };
      const acct = findAccount(msg.from);
      if (!acct) return { ok: false, error: "Unknown sender" };
      const amount = BigInt(msg.amount);
      const fee = BigInt(msg.fee);
      const nonce = BigInt(msg.nonce);
      const body = buildTransferBody({ from: acct.address, to: msg.to, amount, fee, nonce, chainPath: msg.chainPath });
      const { bodyCID, bytes, preimage } = bodyPreimage(body);
      const sig = signPreimage(preimage, acct.privateKey);
      return {
        ok: true,
        signedSubmit: { signatures: { [acct.publicKey]: sig }, bodyCID, bodyData: bytesToHex(bytes), chainPath: msg.chainPath },
        summary: { from: acct.address, to: msg.to, amount: msg.amount, fee: msg.fee, nonce: msg.nonce },
      } as Response;
    }

    default:
      return { ok: false, error: "Unknown request" };
  }
}

chrome.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  touchAutoLock();
  handle(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "auto-lock") session = null;
});

export {};
