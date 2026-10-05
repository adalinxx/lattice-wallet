// The signer: owns the encrypted vault and, while unlocked, holds the
// decrypted secrets in memory only. Its callers (the extension's background
// worker, the desktop app's page) exchange Request/Response messages with it;
// private keys never leave it. `touchAutoLock` re-arms the host's idle timer
// on every key-touching event; the host calls `lock()` when it fires.

import { encryptVault, decryptVault, type Vault } from "../crypto/keystore.ts";
import { deriveAccounts, toView, nextHdLabel, signTransfer, type LiveAccount } from "./session.ts";
import { deriveAccount, importPrivateKey } from "../crypto/accounts.ts";
import { parseChainPath } from "../config.ts";
import type { Request, Response, WalletData, WalletState } from "./types.ts";

/** Where the one encrypted vault is kept (the format is the same on every host). */
export interface VaultStorage {
  load(): Promise<Vault | null>;
  save(vault: Vault): Promise<void>;
  remove(): Promise<void>;
}

export function createSigner(vaults: VaultStorage, touchAutoLock: () => void = () => {}) {
  // In-memory unlocked session (lost on auto-lock or worker teardown).
  interface Session {
    password: string;
    data: WalletData;
    accounts: LiveAccount[];
  }
  let session: Session | null = null;

  // ---- persistence ----
  const loadVault = () => vaults.load();
  async function persistData() {
    if (!session) return;
    await vaults.save(await encryptVault(session.password, session.data));
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
        await vaults.remove();
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

      case "signTransfer": {
        if (!session) return { ok: false, error: "Locked" };
        const acct = findAccount(msg.from);
        if (!acct) return { ok: false, error: "Unknown sender" };
        const chainPath = parseChainPath(msg.chainPath.join("/"));
        if (!chainPath) return { ok: false, error: "Invalid chain path" };
        let signedSubmit;
        try {
          signedSubmit = signTransfer(acct, {
            to: msg.to, amount: BigInt(msg.amount), fee: BigInt(msg.fee), nonce: BigInt(msg.nonce), chainPath,
          });
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
        return {
          ok: true,
          signedSubmit,
          summary: { from: acct.address, to: msg.to, amount: msg.amount, fee: msg.fee, nonce: msg.nonce },
        } as Response;
      }

      default:
        return { ok: false, error: "Unknown request" };
    }
  }

  return { handle, lock: () => { session = null; } };
}

export type Signer = ReturnType<typeof createSigner>;
