// The signer: owns the encrypted vault and, while unlocked, holds the
// decrypted secrets in memory only. Its callers (the extension's background
// worker, the desktop app's page) exchange Request/Response messages with it;
// private keys never leave it. `touchAutoLock` re-arms the host's idle timer
// on every key-touching event; the host calls `lock()` when it fires.

import { encryptVault, decryptVault, deriveForVault, encryptWithVaultKey, type Vault } from "../crypto/keystore.ts";
import { deriveAccounts, toView, nextHdLabel, signDeposit, signReceipt, signTransfer, signWithdrawal, type LiveAccount } from "./session.ts";
import { deriveAccount, importPrivateKey } from "../crypto/accounts.ts";
import { parseChainPath } from "../config.ts";
import { nodeCookieAuthorization } from "@adalinxx/lattice-core";
import { backupContents, encryptBackup, decryptBackup, mergeWalletData } from "./backup.ts";
import { newOffer, encodeOffer, decodeOffer, decodeEnvelope, encodeEnvelope, seal, open, type Offer } from "./pairing.ts";
import { standardSeedQR, compactSeedQR, latin1 } from "../qr/seedqr.ts";
import { seedSvg } from "../qr/render.ts";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
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
    key: CryptoKey;
    header: Vault;
    data: WalletData;
    accounts: LiveAccount[];
  }
  let session: Session | null = null;
  // The receiver's one-time transfer session (its X25519 secret never leaves here).
  let pairing: { offer: Offer; secret: Uint8Array } | null = null;
  let failedReauth = 0;
  let requests: Promise<unknown> = Promise.resolve();
  let generation = 0;
  function lock() {
    generation += 1;
    session?.accounts.forEach((account) => account.privateKey.fill(0));
    pairing?.secret.fill(0);
    pairing = null;
    session = null;
  }

  // ---- persistence ----
  const loadVault = () => vaults.load();
  async function persistData() {
    if (!session) return;
    const current = session;
    const encrypted = await encryptWithVaultKey(current.key, current.header, current.data);
    if (session !== current) throw new Error("Wallet locked during operation");
    try { await vaults.save(encrypted); } catch (error) { lock(); throw error; }
  }
  async function openSession(password: string, data: WalletData, header?: Vault) {
    const before = generation;
    const vault = header ?? await encryptVault(password, data);
    const key = await deriveForVault(password, vault);
    if (before !== generation) throw new Error("Wallet locked during operation");
    const accounts = deriveAccounts(data);
    session?.accounts.forEach((account) => account.privateKey.fill(0));
    session = { key, header: vault, data, accounts };
    failedReauth = 0;
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
  /** Exports re-check the password even while unlocked. */
  async function reauth(password: unknown): Promise<Response | null> {
    if (!session) return { ok: false, error: "Locked" };
    const current = session;
    try {
      const vault = await loadVault();
      if (!vault || typeof password !== "string") throw new Error("Wrong password");
      await decryptVault(password, vault);
      if (session !== current) return { ok: false, error: "Locked" };
      failedReauth = 0;
      return null;
    } catch {
      failedReauth += 1;
      if (failedReauth >= 5) lock();
      return { ok: false, error: failedReauth >= 5 ? "Too many failed attempts. Wallet locked." : "Wrong password" };
    }
  }
  const hex = (s: unknown): Uint8Array => {
    if (typeof s !== "string" || !/^([0-9a-f]{2})+$/.test(s) || s.length > 2_000_000) throw new Error("Malformed data");
    return hexToBytes(s);
  };

  // ---- handlers ----
  async function handle(msg: Request): Promise<Response> {
    if (msg.type === "signTransfer" || msg.type === "signDeposit" || msg.type === "signReceipt" || msg.type === "signWithdrawal") {
      if (!Array.isArray(msg.chainPath) || msg.chainPath.some((part) => typeof part !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(part))) {
        return { ok: false, error: "Invalid chain path" };
      }
      const numeric = msg.type === "signTransfer" ? [msg.amount, msg.fee, msg.nonce]
        : msg.type === "signDeposit" ? [msg.amountDeposited, msg.amountDemanded, msg.depositNonce, msg.fee, msg.nonce]
        : [msg.fee, msg.nonce, ...msg.offers.flatMap((offer) => [offer.amountDemanded, offer.amountDeposited, offer.depositNonce])];
      if (numeric.some((value) => typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))) return { ok: false, error: "Amounts and nonces must be decimal integers" };
    }
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
        await openSession(msg.password, data);
        await persistData();
        touchAutoLock();
        return { ok: true, state: await stateView() } as Response;
      }

      case "unlock": {
        const vault = await loadVault();
        if (!vault) return { ok: false, error: "No wallet to unlock" };
        try {
          const data = await decryptVault<WalletData>(msg.password, vault);
          await openSession(msg.password, data, vault);
          return { ok: true, state: await stateView() } as Response;
        } catch {
          return { ok: false, error: "Wrong password" };
        }
      }

      case "lock":
        lock();
        return { ok: true, state: await stateView() } as Response;

      case "reset":
        lock();
        await vaults.remove();
        return { ok: true, state: await stateView() } as Response;

      case "addAccount": {
        if (!session?.data.mnemonic) return { ok: false, error: "Locked or no recovery phrase" };
        if (session.accounts.length >= 256) return { ok: false, error: "256-account limit reached" };
        const { index, label } = nextHdLabel(session.data);
        session.data.hd.push({ index, label: msg.label?.trim() || label });
        session.accounts = deriveAccounts(session.data);
        session.data.active = deriveAccount(session.data.mnemonic, index).address;
        await persistData();
        return { ok: true, state: await stateView() } as Response;
      }

      case "importKey": {
        if (!session) return { ok: false, error: "Locked" };
        if (session.accounts.length >= 256) return { ok: false, error: "256-account limit reached" };
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

      case "setNodeCookie": {
        if (!session) return { ok: false, error: "Locked" };
        const cookies = { ...(session.data.nodeCookies ?? {}) };
        if (msg.cookie === null) delete cookies[msg.url];
        else {
          const cookie = msg.cookie.trim();
          try {
            nodeCookieAuthorization(cookie);
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
          cookies[msg.url] = cookie;
        }
        session.data.nodeCookies = cookies;
        await persistData();
        return { ok: true } as Response;
      }

      case "nodeAuthorization": {
        if (!session) return { ok: false, error: "Locked" };
        const cookie = session.data.nodeCookies?.[msg.url];
        return { ok: true, ...(cookie === undefined ? {} : { authorization: nodeCookieAuthorization(cookie) }) } as Response;
      }

      case "exportBackup": {
        const denied = await reauth(msg.password);
        if (denied) return denied;
        const backup = await encryptBackup(msg.password, backupContents(session!.data, msg.includeNodeCookies === true));
        return { ok: true, backup: bytesToHex(backup) } as Response;
      }

      case "exportSeedQR": {
        const denied = await reauth(msg.password);
        if (denied) return denied;
        if (!session!.data.mnemonic) return { ok: false, error: "This wallet has no recovery phrase" };
        try {
          const svg = msg.format === "compact"
            ? seedSvg(latin1(compactSeedQR(session!.data.mnemonic)), "compact")
            : seedSvg(standardSeedQR(session!.data.mnemonic), "standard");
          return { ok: true, svg } as Response;
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }

      case "importBackup": {
        const vault = await loadVault();
        if (vault && !session) return { ok: false, error: "Unlock first" };
        if (vault && msg.mode === "replace") {
          const denied = await reauth(msg.currentPassword);
          if (denied) return denied;
        }
        let incoming: WalletData;
        try {
          incoming = await decryptBackup(String(msg.password), hex(msg.backup));
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
        // The KDF took a while: refuse if the wallet locked or appeared meanwhile.
        if ((await loadVault()) ? !session || !vault : vault) return { ok: false, error: "The wallet changed; try again" };
        if (!vault) {
          // A restore: the backup's password becomes this wallet's.
          await openSession(String(msg.password), incoming);
        } else {
          let data: WalletData;
          try {
            data = msg.mode === "replace" ? incoming : mergeWalletData(session!.data, incoming);
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
          session!.accounts.forEach((account) => account.privateKey.fill(0));
          session!.data = data;
          session!.accounts = deriveAccounts(data);
        }
        await persistData();
        return { ok: true, state: await stateView() } as Response;
      }

      case "transferOffer": {
        pairing = newOffer();
        return { ok: true, offer: bytesToHex(encodeOffer(pairing.offer)), expires: pairing.offer.expires } as Response;
      }

      case "transferSend": {
        const denied = await reauth(msg.password);
        if (denied) return denied;
        try {
          const offer = decodeOffer(hex(msg.offer));
          const backup = await encryptBackup(msg.password, backupContents(session!.data, false));
          const { envelope, sas } = await seal(offer, backup);
          return { ok: true, envelope: bytesToHex(encodeEnvelope(envelope)), sas } as Response;
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }

      case "transferOpen": {
        // Single use: the session's secret is gone after one attempt, good or bad.
        const current = pairing;
        pairing = null;
        if (!current) return { ok: false, error: "No transfer session; start a new one" };
        try {
          const { payload, sas } = await open(current.offer, current.secret, decodeEnvelope(hex(msg.envelope)));
          return { ok: true, backup: bytesToHex(payload), sas } as Response;
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        } finally {
          current.secret.fill(0);
        }
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

      case "signDeposit": {
        if (!session) return { ok: false, error: "Locked" };
        const acct = findAccount(msg.from);
        if (!acct) return { ok: false, error: "Unknown sender" };
        const chainPath = parseChainPath(msg.chainPath.join("/"));
        if (!chainPath) return { ok: false, error: "Invalid chain path" };
        try {
          return { ok: true, signedSubmit: signDeposit(acct, {
            amountDeposited: BigInt(msg.amountDeposited), amountDemanded: BigInt(msg.amountDemanded),
            depositNonce: BigInt(msg.depositNonce), fee: BigInt(msg.fee), nonce: BigInt(msg.nonce), chainPath,
          }) } as Response;
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }

      case "signReceipt":
      case "signWithdrawal": {
        if (!session) return { ok: false, error: "Locked" };
        const acct = findAccount(msg.from);
        if (!acct) return { ok: false, error: "Unknown sender" };
        const chainPath = parseChainPath(msg.chainPath.join("/"));
        if (!chainPath) return { ok: false, error: "Invalid chain path" };
        try {
          const offers = msg.offers.map((offer) => ({
            demander: offer.demander,
            amountDemanded: BigInt(offer.amountDemanded),
            amountDeposited: BigInt(offer.amountDeposited),
            depositNonce: BigInt(offer.depositNonce),
          }));
          const common = { offers, fee: BigInt(msg.fee), nonce: BigInt(msg.nonce), chainPath };
          if (msg.type === "signReceipt") {
            if (!msg.directory) return { ok: false, error: "Missing child directory" };
            return { ok: true, signedSubmit: signReceipt(acct, { ...common, directory: msg.directory }) } as Response;
          }
          return { ok: true, signedSubmit: signWithdrawal(acct, common) } as Response;
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }

      default:
        return { ok: false, error: "Unknown request" };
    }
  }

  return {
    handle: (msg: Request): Promise<Response> => {
      const run = requests.then(() => handle(msg));
      requests = run.catch(() => {});
      return run;
    },
    lock,
  };
}

export type Signer = ReturnType<typeof createSigner>;
