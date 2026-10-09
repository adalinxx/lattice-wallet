// Backup, SeedQR and device-to-device transfer screens. The page holds
// ciphertext (the encrypted backup, the sealed transfer) and public pairing
// data; secrets are produced and consumed in the signer, and each export asks
// for the password again. The one exception is the SeedQR picture, which is
// the phrase by design: it lives in the DOM only while shown or printing.

import { h, render } from "./app.ts";
import { scanner } from "./scanner.ts";
import type { WalletClient } from "../lib/wallet/client.ts";
import type { WalletState } from "../lib/wallet/types.ts";
import { urEncoder, encodeUR, urDecoder } from "../lib/qr/ur.ts";
import { urSvg } from "../lib/qr/render.ts";
import { seedQRToMnemonic } from "../lib/qr/seedqr.ts";
import { VAULT_UR_TYPE } from "../lib/wallet/backup.ts";
import { PAIR_UR_TYPE, TRANSFER_UR_TYPE } from "../lib/wallet/pairing.ts";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

type El = HTMLElement;

export interface BackupHost {
  wallet: WalletClient;
  /** May this page open the camera? */
  camera: boolean;
  /** Where the camera cannot run here: reopen this flow in a full page. */
  openFullPage?: (view: "backup" | "restore") => void;
  /** Save a text file; resolves to where it went, if the host knows. */
  saveFile?: (name: string, text: string) => Promise<string | void>;
  /** Print the page (the print area only). */
  print?: () => void;
  state(): WalletState;
  /** Leave the flow. */
  back(): void;
  /** A wallet was created, restored or changed. */
  done(state: WalletState): void;
}

let host: BackupHost;
const SINGLE_QR_MAX = 500; // UR characters that still scan comfortably as one code
const FRAGMENT = 120; // bytes per animated part
const FRAME_MS = 300;

// ---------------- shared pieces ----------------

function svgNode(svg: string, cls = "qr"): El {
  const box = h("div", { class: cls });
  // The markup is our own encoder's output: parse it as SVG, never as HTML.
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  box.append(document.importNode(doc.documentElement, true));
  return box;
}

/** A static QR for a short UR, or an animated sequence of fountain parts for a long one. */
function urDisplay(type: string, cbor: Uint8Array): { node: El; parts: string[] } {
  const single = encodeUR(type, cbor);
  if (single.length <= SINGLE_QR_MAX) return { node: svgNode(urSvg(single)), parts: [single] };
  const enc = urEncoder(type, cbor, FRAGMENT);
  const pure = Array.from({ length: enc.seqLen }, () => enc.nextPart());
  const box = h("div", { class: "qr" });
  const counter = h("div", { class: "muted center" });
  const node = h("div", {}, box, counter);
  let i = 0;
  const show = () => {
    // Pure fragments first, then fountain parts for frames the scanner missed.
    const part = i < pure.length ? pure[i]! : enc.nextPart();
    box.replaceChildren(svgNode(urSvg(part), "qr-frame"));
    counter.textContent = `animated: part ${(i % 1000) + 1} (${enc.seqLen} needed)`;
    i += 1;
  };
  show();
  const timer = setInterval(() => { if (!node.isConnected) clearInterval(timer); else show(); }, FRAME_MS);
  return { node, parts: pure };
}

function passwordInput(placeholder = "password"): HTMLInputElement {
  return h("input", { type: "password", placeholder, autocomplete: "current-password" }) as HTMLInputElement;
}

async function save(name: string, text: string, status: El) {
  try {
    if (host.saveFile) {
      const where = await host.saveFile(name, text);
      status.textContent = where ? "saved: " + where : "saved";
      return;
    }
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: name }) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status.textContent = "saved to your downloads";
  } catch (e) {
    status.textContent = "Could not save: " + (e as Error).message;
  }
}

/** Print only `content`; it is removed again right after. */
function printOnly(content: El) {
  const area = h("div", { id: "print-area" }, content);
  document.body.append(area);
  document.body.classList.add("printing");
  const cleanup = () => { area.remove(); document.body.classList.remove("printing"); };
  window.addEventListener("afterprint", cleanup, { once: true });
  (host.print ?? (() => window.print()))();
  // window.print blocks until the dialog closes; hosts that do not still fire afterprint or this.
  setTimeout(cleanup, 5_000);
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------------- menus ----------------

/** The unlocked wallet's backup & transfer menu. */
export function backupMenu(b: BackupHost) {
  host = b;
  const hasPhrase = host.state().accounts.some((a) => a.kind === "hd");
  render(h("div", { class: "stack" },
    h("h1", {}, "Backup & transfer"),
    h("button", { class: "btn block", onclick: encryptedBackup }, "Encrypted backup (QR or file)"),
    ...(hasPhrase ? [h("button", { class: "btn block", onclick: seedQRWarning }, "SeedQR paper backup")] : []),
    h("button", { class: "btn block", onclick: sendToDevice }, "Send to another device"),
    h("button", { class: "btn block", onclick: receiveFromDevice }, "Receive from another device"),
    h("button", { class: "btn block", onclick: importBackup }, "Merge or restore a backup"),
    h("button", { class: "btn block", onclick: () => host.back() }, "Back"),
  ));
}

/** First run: restore from any of the three sources. */
export function restoreMenu(b: BackupHost) {
  host = b;
  render(h("div", { class: "stack" },
    h("h1", {}, "Restore"),
    h("button", { class: "btn block", onclick: importBackup }, "Encrypted backup (QR or file)"),
    h("button", { class: "btn block", onclick: importSeedQR }, "SeedQR"),
    h("button", { class: "btn block", onclick: receiveFromDevice }, "From another device"),
    h("button", { class: "btn block", onclick: () => host.back() }, "Back"),
  ));
}

// ---------------- 1. encrypted backup ----------------

function encryptedBackup() {
  const pw = passwordInput("re-enter your password");
  const cookies = h("input", { type: "checkbox" }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  render(h("div", { class: "stack" },
    h("h1", {}, "Encrypted backup"),
    h("p", { class: "muted" }, "Your recovery phrase, imported keys and account labels, encrypted with your wallet password. Restoring it needs that password."),
    pw,
    h("label", { class: "k check" }, cookies, " include paired node cookies (they open your node's operator port)"),
    err,
    h("button", { class: "block", onclick: async () => {
      err.textContent = "encrypting…";
      const r = await host.wallet.exportBackup(pw.value, cookies.checked);
      pw.value = "";
      if (!r.ok) { err.textContent = r.error; return; }
      showBackup(hexToBytes(r.backup));
    } }, "Show backup"),
    h("button", { class: "btn block", onclick: () => backupMenu(host) }, "Back"),
  ));
}

function showBackup(cbor: Uint8Array) {
  const { node, parts } = urDisplay(VAULT_UR_TYPE, cbor);
  const single = encodeUR(VAULT_UR_TYPE, cbor);
  const status = h("div", { class: "toast" });
  render(h("div", { class: "stack" },
    h("h1", {}, "Encrypted backup"),
    h("p", { class: "warn" }, "Encrypted with your password, but anyone who copies it can try to guess that password. Keep it private."),
    node,
    h("div", { class: "row-actions" },
      h("button", { class: "btn", onclick: () => save(`lattice-wallet-backup-${today()}.txt`, `# Lattice wallet backup (encrypted with your wallet password)\n${single}\n`, status) }, "Save file"),
      h("button", { class: "btn", onclick: () => printOnly(h("div", { class: "print-page" },
        h("h1", {}, "Lattice wallet backup"),
        h("p", {}, `Encrypted with the wallet password. ${today()}. ${parts.length > 1 ? `Scan all ${parts.length} codes, in any order.` : ""}`),
        h("div", { class: "print-grid" }, ...parts.map((p) => svgNode(urSvg(p), "qr-print"))),
      )) }, "Print"),
    ),
    status,
    h("button", { class: "btn block", onclick: () => backupMenu(host) }, "Done"),
  ));
}

function importBackup() {
  const decoder = urDecoder([VAULT_UR_TYPE]);
  const progress = h("div", { class: "muted" });
  const s = scanner({
    camera: host.camera,
    openFullPage: host.openFullPage && (() => host.openFullPage!(host.state().initialized ? "backup" : "restore")),
    pasteHint: "paste the ur:lattice-vault/… text",
    onText(text) {
      if (!decoder.receive(text) && !decoder.result) { s.status.textContent = decoder.error ?? "Not a Lattice wallet backup code."; return !!decoder.error; }
      progress.textContent = decoder.result ? "" : `received ${Math.round(decoder.progress() * 100)}%`;
      if (decoder.result) { unlockBackup(decoder.result); return true; }
      return false;
    },
  });
  render(h("div", { class: "stack" },
    h("h1", {}, "Restore a backup"),
    h("p", { class: "muted" }, "Scan the backup QR (keep scanning an animated one until it completes), load its image or file, or paste its text."),
    s.node, progress,
    h("button", { class: "btn block", onclick: () => { s.stop(); host.back(); } }, "Cancel"),
  ));
}

/** The decrypting step, shared by the backup and device-transfer imports. */
function unlockBackup(cbor: Uint8Array, intro?: El) {
  const initialized = host.state().initialized;
  const pw = passwordInput(initialized ? "the backup's password" : "the backup's password (it becomes this wallet's)");
  const err = h("div", { class: "toast" });
  const currentPassword = passwordInput("current wallet password");
  const run = async (mode: "merge" | "replace") => {
    err.textContent = "decrypting…";
    const r = await host.wallet.importBackup(bytesToHex(cbor), pw.value, mode, currentPassword.value);
    if (!r.ok) { err.textContent = r.error; return; }
    pw.value = "";
    host.done(r.state);
  };
  const replace = () => render(h("div", { class: "stack" },
    h("h1", {}, "Replace this wallet?"),
    h("p", { class: "warn" }, "Every account on this device that is not in the backup is removed from it. Make sure you have their recovery phrase or keys."),
    currentPassword,
    err,
    h("button", { class: "block", onclick: () => run("replace") }, "Replace"),
    h("button", { class: "btn block", onclick: () => unlockBackup(cbor, intro) }, "Back"),
  ));
  render(h("div", { class: "stack" },
    h("h1", {}, "Decrypt backup"),
    intro ?? null,
    pw, err,
    ...(initialized
      ? [
          h("button", { class: "block", onclick: () => run("merge") }, "Merge into this wallet"),
          h("button", { class: "btn block", onclick: () => { if (pw.value) replace(); else err.textContent = "Enter the backup's password."; } }, "Replace this wallet…"),
        ]
      : [h("button", { class: "block", onclick: () => run("replace") }, "Restore")]),
    h("button", { class: "btn block", onclick: () => host.back() }, "Cancel"),
  ));
}

// ---------------- 2. SeedQR ----------------

function seedQRWarning() {
  const pw = passwordInput("re-enter your password");
  const format = h("select", { class: "picker" },
    h("option", { value: "compact" }, "CompactSeedQR (smaller)"),
    h("option", { value: "standard" }, "Standard SeedQR (digits, hand-transcribable)"),
  ) as HTMLSelectElement;
  const err = h("div", { class: "toast" });
  render(h("div", { class: "stack" },
    h("h1", {}, "SeedQR"),
    h("p", { class: "warn" }, "This QR code IS your recovery phrase, unencrypted. Anyone who sees or photographs it owns your funds. Only for an offline paper backup: do not screenshot it, photograph it or show it on a shared screen."),
    format, pw, err,
    h("button", { class: "block", onclick: async () => {
      const r = await host.wallet.exportSeedQR(pw.value, format.value as "standard" | "compact");
      pw.value = "";
      if (!r.ok) { err.textContent = r.error; return; }
      showSeedQR(r.svg, format.value);
    } }, "Show SeedQR"),
    h("button", { class: "btn block", onclick: () => backupMenu(host) }, "Back"),
  ));
}

function showSeedQR(svg: string, format: string) {
  const warning = "Anyone who sees this owns your funds. Offline paper backup only. Do not screenshot.";
  const overlay = h("div", { class: "secret-overlay", role: "dialog", "aria-modal": "true" });
  const close = () => {
    overlay.replaceChildren();
    overlay.remove();
    document.removeEventListener("visibilitychange", onHide);
    clearTimeout(timer);
    backupMenu(host);
  };
  const onHide = () => { if (document.hidden) close(); };
  // Cleared when closed, when the page is hidden, and after two minutes.
  document.addEventListener("visibilitychange", onHide);
  const timer = setTimeout(close, 120_000);
  overlay.append(
    h("p", { class: "warn" }, warning),
    svgNode(svg, "qr qr-secret"),
    h("p", { class: "muted center" }, format === "compact" ? "CompactSeedQR" : "Standard SeedQR"),
    h("div", { class: "row-actions" },
      h("button", { class: "btn", onclick: () => printOnly(h("div", { class: "print-page" },
        h("h1", {}, "Recovery phrase (SeedQR)"),
        h("p", {}, warning),
        svgNode(svg, "qr-print qr-secret"),
      )) }, "Print"),
      h("button", { class: "btn", onclick: close }, "Close"),
    ),
  );
  render(h("div", {}));
  document.body.append(overlay);
}

function importSeedQR() {
  const s = scanner({
    camera: host.camera,
    openFullPage: host.openFullPage && (() => host.openFullPage!("restore")),
    pasteHint: "or paste a Standard SeedQR's digits",
    onText(text) {
      const mnemonic = seedQRToMnemonic(text);
      if (!mnemonic) { s.status.textContent = "Not a SeedQR (12 or 24 words)."; return false; }
      seedQRPassword(mnemonic);
      return true;
    },
  });
  render(h("div", { class: "stack" },
    h("h1", {}, "Scan SeedQR"),
    s.node,
    h("button", { class: "btn block", onclick: () => { s.stop(); host.back(); } }, "Cancel"),
  ));
}

function seedQRPassword(mnemonic: string) {
  const p1 = h("input", { type: "password", placeholder: "new password (min 8)", autocomplete: "new-password" }) as HTMLInputElement;
  const p2 = h("input", { type: "password", placeholder: "confirm password", autocomplete: "new-password" }) as HTMLInputElement;
  const err = h("div", { class: "toast" });
  render(h("div", { class: "stack" },
    h("h1", {}, "Set a password"),
    h("p", { class: "muted" }, `Read a ${mnemonic.split(" ").length}-word recovery phrase. Choose a password to encrypt it on this device.`),
    p1, p2, err,
    h("button", { class: "block", onclick: async () => {
      if (p1.value.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
      if (p1.value !== p2.value) { err.textContent = "Passwords do not match."; return; }
      const r = await host.wallet.create(p1.value, { mnemonic });
      if (!r.ok) { err.textContent = r.error; return; }
      host.done(r.state);
    } }, "Restore"),
    h("button", { class: "btn block", onclick: () => host.back() }, "Cancel"),
  ));
}

// ---------------- 3. device-to-device transfer ----------------

const sasText = (sas: string) => `${sas.slice(0, 3)} ${sas.slice(3)}`;

/** Sender: scan the receiver's pairing code, seal the backup to it, show the result and the code. */
function sendToDevice() {
  const decoder = urDecoder([PAIR_UR_TYPE]);
  const s = scanner({
    camera: host.camera,
    openFullPage: host.openFullPage && (() => host.openFullPage!("backup")),
    pasteHint: "paste the ur:lattice-pair/… text",
    onText(text) {
      if (!decoder.receive(text) || !decoder.result) { s.status.textContent = "Not a Lattice pairing code."; return false; }
      confirmSend(decoder.result);
      return true;
    },
  });
  render(h("div", { class: "stack" },
    h("h1", {}, "Send to another device"),
    h("p", { class: "muted" }, "On the other device choose Receive from another device, then scan the code it shows. Nothing goes over the network."),
    s.node,
    h("button", { class: "btn block", onclick: () => { s.stop(); backupMenu(host); } }, "Cancel"),
  ));
}

function confirmSend(offer: Uint8Array) {
  const pw = passwordInput("re-enter your password");
  const err = h("div", { class: "toast" });
  render(h("div", { class: "stack" },
    h("h1", {}, "Send this wallet"),
    h("p", { class: "muted" }, "Sends your recovery phrase, imported keys and labels (not node cookies), encrypted to the other device and to your password. The other device needs this password to import it."),
    pw, err,
    h("button", { class: "block", onclick: async () => {
      err.textContent = "encrypting…";
      const r = await host.wallet.transferSend(bytesToHex(offer), pw.value);
      pw.value = "";
      if (!r.ok) { err.textContent = r.error; return; }
      const { node } = urDisplay(TRANSFER_UR_TYPE, hexToBytes(r.envelope));
      render(h("div", { class: "stack" },
        h("h1", {}, "Scan on the other device"),
        h("div", { class: "sas" }, sasText(r.sas)),
        h("p", { class: "warn" }, "The other device must show this same code. If it shows a different one, stop: do not import there, and do not reuse this password."),
        node,
        h("button", { class: "btn block", onclick: () => backupMenu(host) }, "Done"),
      ));
    } }, "Encrypt and show"),
    h("button", { class: "btn block", onclick: () => backupMenu(host) }, "Cancel"),
  ));
}

/** Receiver: show a one-time pairing code, then scan the sealed transfer and compare codes. */
async function receiveFromDevice() {
  const r = await host.wallet.transferOffer();
  if (!r.ok) return render(h("div", { class: "stack" }, h("p", { class: "toast" }, r.error), h("button", { class: "btn block", onclick: () => host.back() }, "Back")));
  const offer = encodeUR(PAIR_UR_TYPE, hexToBytes(r.offer));
  const left = h("div", { class: "muted center" });
  const view = h("div", { class: "stack" },
    h("h1", {}, "Receive from another device"),
    h("p", { class: "muted" }, "1. On the sending device choose Send to another device and scan this one-time code."),
    svgNode(urSvg(offer)),
    left,
    h("button", { class: "block", onclick: scanTransfer }, "2. Scan the code it shows"),
    h("button", { class: "btn block", onclick: () => host.back() }, "Cancel"),
  );
  let scanning = false;
  render(view);
  // Count down; keep the extension's worker (which holds the session key) awake meanwhile.
  const tick = setInterval(() => {
    if (!document.body.contains(left) && !scanning) return clearInterval(tick);
    const s = r.expires - Math.floor(Date.now() / 1000);
    left.textContent = s > 0 ? `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "expired: start again";
    if (s <= 0) clearInterval(tick);
    host.wallet.getState();
  }, 1000);

  function scanTransfer() {
    scanning = true;
    const decoder = urDecoder([TRANSFER_UR_TYPE]);
    const progress = h("div", { class: "muted" });
    const s = scanner({
      camera: host.camera,
      openFullPage: host.openFullPage && (() => host.openFullPage!(host.state().initialized ? "backup" : "restore")),
      pasteHint: "paste the ur:lattice-transfer/… text",
      onText(text) {
        if (!decoder.receive(text) && !decoder.result) { s.status.textContent = decoder.error ?? "Not a Lattice transfer code."; return !!decoder.error; }
        progress.textContent = decoder.result ? "" : `received ${Math.round(decoder.progress() * 100)}%`;
        if (decoder.result) { scanning = false; openTransfer(decoder.result); return true; }
        return false;
      },
    });
    render(h("div", { class: "stack" },
      h("h1", {}, "Scan the transfer"),
      h("p", { class: "muted" }, "Keep the camera on the other device's code until it completes."),
      s.node, progress, left,
      h("button", { class: "btn block", onclick: () => { scanning = false; s.stop(); host.back(); } }, "Cancel"),
    ));
  }
}

async function openTransfer(envelope: Uint8Array) {
  const r = await host.wallet.transferOpen(bytesToHex(envelope));
  if (!r.ok) {
    return render(h("div", { class: "stack" },
      h("h1", {}, "Transfer failed"),
      h("p", { class: "warn" }, r.error + ". Nothing was imported. Start again on both devices."),
      h("button", { class: "btn block", onclick: () => host.back() }, "Back"),
    ));
  }
  const backup = hexToBytes(r.backup);
  render(h("div", { class: "stack" },
    h("h1", {}, "Compare codes"),
    h("div", { class: "sas" }, sasText(r.sas)),
    h("p", { class: "warn" }, "Does the sending device show exactly this code? If not, someone may be in between: cancel."),
    h("button", { class: "block", onclick: () => unlockBackup(backup, h("p", { class: "muted" }, "Codes match. Enter the sending wallet's password.")) }, "The codes match"),
    h("button", { class: "btn block", onclick: () => host.back() }, "They differ: cancel"),
  ));
}
