// Deterministic DAG-CBOR encoder — a faithful port of cashew's
// `DagCBOR.serializeValue` (cashew/Sources/cashew/Core/DagCBOR.swift).
//
// Scope: exactly what Lattice's TransactionBody / PublicKey need — null, bool,
// integers, text strings, arrays, and string-keyed maps. Maps sort keys by
// (utf8 byte length, then lexicographic), which is what makes the CID
// deterministic. There are NO byte or link (CID-tag) fields in the bodies we
// encode, so tag 42 / bytes are intentionally unsupported.

import { utf8, concatBytes } from "./bytes.ts";

export type CborValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | CborValue[]
  | { [key: string]: CborValue };

function writeUnsigned(value: bigint, major: number): Uint8Array {
  const m = major << 5;
  if (value < 24n) return Uint8Array.of(m | Number(value));
  if (value <= 0xffn) return Uint8Array.of(m | 24, Number(value));
  if (value <= 0xffffn) {
    const v = Number(value);
    return Uint8Array.of(m | 25, (v >>> 8) & 0xff, v & 0xff);
  }
  if (value <= 0xffffffffn) {
    const v = Number(value);
    return Uint8Array.of(m | 26, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  // 64-bit big-endian
  const out = new Uint8Array(9);
  out[0] = m | 27;
  let v = value;
  for (let i = 8; i >= 1; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function encodeInteger(n: bigint): Uint8Array {
  // major 0 for >= 0, major 1 (encoding -1 - n) for negatives
  return n >= 0n ? writeUnsigned(n, 0) : writeUnsigned(-1n - n, 1);
}

export function encode(value: CborValue): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === "boolean") return Uint8Array.of(value ? 0xf5 : 0xf4);
  if (typeof value === "bigint") return encodeInteger(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("dag-cbor: non-integer number");
    return encodeInteger(BigInt(value));
  }
  if (typeof value === "string") {
    const b = utf8(value);
    return concatBytes(writeUnsigned(BigInt(b.length), 3), b);
  }
  if (Array.isArray(value)) {
    const parts = [writeUnsigned(BigInt(value.length), 4)];
    for (const el of value) parts.push(encode(el));
    return concatBytes(...parts);
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => {
      const al = utf8(a).length;
      const bl = utf8(b).length;
      if (al !== bl) return al - bl;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const parts = [writeUnsigned(BigInt(keys.length), 5)];
    for (const k of keys) {
      const kb = utf8(k);
      parts.push(writeUnsigned(BigInt(kb.length), 3), kb);
      parts.push(encode(value[k]));
    }
    return concatBytes(...parts);
  }
  throw new Error("dag-cbor: unsupported type");
}
