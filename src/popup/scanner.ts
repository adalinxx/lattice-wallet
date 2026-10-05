// A QR input: live camera (where this page may hold it), an image file, or
// pasted / file-loaded text. Every decoded string goes to `onText`, which
// says whether it is done; the camera stops as soon as it is, or when the
// scanner leaves the page. Byte segments are read as Latin-1 (one char per
// byte) so a CompactSeedQR survives; UR and SeedQR digits are ASCII anyway.

import { QRCanvas, rearCamera, frameLoop, type QRCamera } from "qr/dom.js";
import { decodeQR } from "qr/decode.js";
import { h } from "./app.ts";

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const MAX_FILE = 2_000_000;

export interface ScannerOpts {
  /** May this page open the camera (an extension popup may not)? */
  camera: boolean;
  /** Offered instead of the camera where it cannot run here. */
  openFullPage?: () => void;
  /** Feed one decoded string; return true when nothing more is needed. */
  onText(text: string): boolean;
  /** Placeholder for the paste box. */
  pasteHint: string;
}

export function scanner(opts: ScannerOpts): { node: HTMLElement; status: HTMLElement; stop(): void } {
  const status = h("div", { class: "toast" });
  const video = h("video", { class: "scan-video", playsinline: "true", muted: "true" }) as HTMLVideoElement;
  video.hidden = true;
  let camera: QRCamera | undefined;
  let cancel: (() => void) | undefined;
  let done = false;

  const stop = () => {
    cancel?.(); cancel = undefined;
    camera?.stop(); camera = undefined;
    video.hidden = true;
  };
  const feed = (text: string) => {
    if (done) return;
    if (opts.onText(text)) { done = true; stop(); }
  };

  async function startCamera() {
    status.textContent = "starting camera…";
    try {
      camera = await rearCamera(video);
    } catch (e) {
      status.textContent = "Camera unavailable: " + ((e as Error).message || "permission denied") + ". Load an image or paste instead.";
      return;
    }
    video.hidden = false;
    status.textContent = "Hold the QR code in front of the camera.";
    const canvas = new QRCanvas({}, { textDecoder: latin1 });
    let busy = false;
    cancel = frameLoop(async () => {
      // Leaving the screen releases the camera.
      if (!video.isConnected) return stop();
      if (busy || !camera) return;
      busy = true;
      try {
        const r = await camera.readFrame(canvas);
        if (typeof r === "string") feed(r);
      } catch { /* a frame miss */ } finally { busy = false; }
    });
  }

  async function loadFile(file: File) {
    if (file.size > MAX_FILE) { status.textContent = "That file is too large."; return; }
    if (file.type.startsWith("image/")) {
      try {
        const bmp = await createImageBitmap(file);
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        feed(decodeQR(img, { textDecoder: latin1, effort: Infinity, timeLimit: Infinity }));
      } catch {
        status.textContent = "No QR code found in that image.";
      }
      return;
    }
    for (const line of (await file.text()).split(/\s+/)) if (line) feed(line);
  }

  const file = h("input", { type: "file", accept: "image/*,.txt,text/plain" }) as HTMLInputElement;
  file.addEventListener("change", () => { const f = file.files?.[0]; file.value = ""; if (f) loadFile(f); });
  const paste = h("textarea", { rows: "3", placeholder: opts.pasteHint, spellcheck: "false", autocomplete: "off" }) as HTMLTextAreaElement;

  const cameraControl = opts.camera
    ? h("button", { class: "btn block", onclick: startCamera }, "Scan with camera")
    : opts.openFullPage
      ? h("button", { class: "btn block", onclick: opts.openFullPage }, "Open in a tab to use the camera")
      : null;

  const node = h("div", { class: "stack" },
    cameraControl, video,
    h("label", { class: "k" }, "or load an image or text file"), file,
    paste,
    h("button", { class: "btn block", onclick: () => { for (const t of paste.value.split(/\s+/)) if (t) feed(t); paste.value = ""; } }, "Use pasted text"),
    status,
  );
  return { node, status, stop };
}
