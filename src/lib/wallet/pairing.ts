// Device-to-device transfer over QR codes, with no server and no network.
//
//   receiver: one-time X25519 key r, session id, expiry -> shows ur:lattice-pair
//   sender:   scans it, one-time key s, ECDH(s, R) -> HKDF -> AES-256-GCM over
//             the password-encrypted backup -> shows ur:lattice-transfer
//             (animated if large) and a 6-digit code
//   receiver: scans it, ECDH(r, S) -> same key and code; the user compares the
//             codes before anything is imported, then enters the wallet's password
//
// Every value is bound into the transcript (version, session id, both public
// keys) which salts the HKDF and is the AEAD's associated data: a changed byte
// fails decryption. The code is a 20-bit short authentication string over the
// same transcript. The inner layer is the ordinary password-encrypted backup,
// so a sender tricked into encrypting to someone else's key still only hands
// over what an encrypted backup QR would. Format in docs/qr-formats.md.

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { cborEncode, cborDecode, type Cbor } from "../qr/ur.ts";

export const PAIR_UR_TYPE = "lattice-pair";
export const TRANSFER_UR_TYPE = "lattice-transfer";
export const OFFER_TTL_SECONDS = 300;
const VERSION = 1;
const LABEL = new TextEncoder().encode("lattice-transfer-v1");
const enc = new TextEncoder();
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export interface Offer { sid: Uint8Array; publicKey: Uint8Array; expires: number }
export interface Envelope { sid: Uint8Array; publicKey: Uint8Array; iv: Uint8Array; ct: Uint8Array }

const now = () => Math.floor(Date.now() / 1000);

/** A receiver's one-time session: its secret stays with the caller (the signer). */
export function newOffer(nowSeconds = now()): { offer: Offer; secret: Uint8Array } {
  const secret = x25519.utils.randomSecretKey();
  return {
    secret,
    offer: { sid: crypto.getRandomValues(new Uint8Array(8)), publicKey: x25519.getPublicKey(secret), expires: nowSeconds + OFFER_TTL_SECONDS },
  };
}

export const encodeOffer = (o: Offer) => cborEncode(new Map<number, Cbor>([[1, VERSION], [2, o.sid], [3, o.publicKey], [4, o.expires]]));
export const encodeEnvelope = (e: Envelope) => cborEncode(new Map<number, Cbor>([[1, VERSION], [2, e.sid], [3, e.publicKey], [4, e.iv], [5, e.ct]]));

function fields(bytes: Uint8Array, what: string): Map<number, Cbor> {
  let m: Cbor;
  try { m = cborDecode(bytes); } catch { throw new Error(`Not a ${what}`); }
  if (!(m instanceof Map) || m.get(1) !== VERSION) throw new Error(`Not a ${what}`);
  return m;
}
const bytesOf = (m: Map<number, Cbor>, k: number, len: number | null, what: string): Uint8Array => {
  const v = m.get(k);
  if (!(v instanceof Uint8Array) || (len !== null && v.length !== len)) throw new Error(`Not a ${what}`);
  return v;
};

export function decodeOffer(bytes: Uint8Array): Offer {
  const m = fields(bytes, "pairing code");
  const expires = m.get(4);
  if (typeof expires !== "number") throw new Error("Not a pairing code");
  return { sid: bytesOf(m, 2, 8, "pairing code"), publicKey: bytesOf(m, 3, 32, "pairing code"), expires };
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const m = fields(bytes, "transfer");
  const ct = bytesOf(m, 5, null, "transfer");
  if (ct.length < 17) throw new Error("Not a transfer");
  return { sid: bytesOf(m, 2, 8, "transfer"), publicKey: bytesOf(m, 3, 32, "transfer"), iv: bytesOf(m, 4, 12, "transfer"), ct };
}

/** The AEAD key and the 6-digit code for one session. Order: receiver key, then sender key. */
async function session(secret: Uint8Array, peer: Uint8Array, sid: Uint8Array, receiverKey: Uint8Array, senderKey: Uint8Array) {
  const shared = x25519.getSharedSecret(secret, peer);
  if (shared.every((b) => b === 0)) throw new Error("Invalid transfer key");
  const transcript = new Uint8Array([...LABEL, VERSION, ...sid, ...receiverKey, ...senderKey]);
  const salt = sha256(transcript);
  const keyBytes = hkdf(sha256, shared, salt, enc.encode("lattice-transfer-v1 key"), 32);
  const sasBytes = hkdf(sha256, shared, salt, enc.encode("lattice-transfer-v1 sas"), 4);
  shared.fill(0);
  const key = await crypto.subtle.importKey("raw", bs(keyBytes), "AES-GCM", false, ["encrypt", "decrypt"]);
  keyBytes.fill(0);
  const n = ((sasBytes[0]! << 24) | (sasBytes[1]! << 16) | (sasBytes[2]! << 8) | sasBytes[3]!) >>> 0;
  return { key, transcript, sas: String(n % 1_000_000).padStart(6, "0") };
}

/** Sender: encrypt `payload` to a scanned offer. Refuses an expired offer. */
export async function seal(offer: Offer, payload: Uint8Array, nowSeconds = now()): Promise<{ envelope: Envelope; sas: string }> {
  if (nowSeconds > offer.expires) throw new Error("That pairing code has expired; show a new one on the receiving device");
  const secret = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secret);
  const { key, transcript, sas } = await session(secret, offer.publicKey, offer.sid, offer.publicKey, publicKey);
  secret.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(transcript) }, key, bs(payload)));
  return { envelope: { sid: offer.sid, publicKey, iv, ct }, sas };
}

/** Receiver: open an envelope with the session's secret. Throws on any mismatch or tampering. */
export async function open(offer: Offer, secret: Uint8Array, envelope: Envelope, nowSeconds = now()): Promise<{ payload: Uint8Array; sas: string }> {
  if (nowSeconds > offer.expires) throw new Error("This transfer session expired; start a new one");
  if (envelope.sid.length !== offer.sid.length || envelope.sid.some((b, i) => b !== offer.sid[i])) {
    throw new Error("That transfer is for a different session");
  }
  const { key, transcript, sas } = await session(secret, envelope.publicKey, offer.sid, offer.publicKey, envelope.publicKey);
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(envelope.iv), additionalData: bs(transcript) }, key, bs(envelope.ct));
  } catch {
    throw new Error("The transfer did not decrypt (altered, or not for this session)");
  }
  return { payload: new Uint8Array(pt), sas };
}
