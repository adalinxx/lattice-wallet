// Uniform Resources (Blockchain Commons BCR-2020-005), Bytewords
// (BCR-2020-012) and the multi-part fountain code, for moving binary payloads
// through QR codes. Single-part: `ur:<type>/<bytewords>`. Multi-part:
// `ur:<type>/<seq>-<len>/<bytewords>`, where parts 1..len are the plain
// fragments and later parts XOR a pseudo-random subset of them, so a scanner
// that misses frames still completes. Byte-for-byte compatible with the
// reference implementations (checked against vectors in test/ur.test.ts).

import { sha256 } from "@noble/hashes/sha2.js";

// ---------------- CRC-32 (IEEE) ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32be = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

// ---------------- Bytewords (minimal style) ----------------

const WORDS =
  "ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom";
const MINIMAL: string[] = [];
const FROM_MINIMAL = new Map<string, number>();
for (let i = 0; i < 256; i++) {
  const w = WORDS.slice(i * 4, i * 4 + 4);
  const m = w[0]! + w[3]!;
  MINIMAL.push(m);
  FROM_MINIMAL.set(m, i);
}

/** Bytewords minimal: two letters per byte, with a CRC-32 of the payload appended. */
export function bytewordsEncode(data: Uint8Array): string {
  const all = new Uint8Array(data.length + 4);
  all.set(data);
  all.set(u32be(crc32(data)), data.length);
  let out = "";
  for (const b of all) out += MINIMAL[b];
  return out;
}

export function bytewordsDecode(text: string): Uint8Array {
  const s = text.toLowerCase();
  if (s.length % 2 !== 0 || s.length < 10) throw new Error("bytewords: bad length");
  const all = new Uint8Array(s.length / 2);
  for (let i = 0; i < all.length; i++) {
    const v = FROM_MINIMAL.get(s.slice(i * 2, i * 2 + 2));
    if (v === undefined) throw new Error("bytewords: invalid word");
    all[i] = v;
  }
  const data = all.slice(0, -4);
  const want = u32be(crc32(data));
  for (let i = 0; i < 4; i++) if (all[all.length - 4 + i] !== want[i]) throw new Error("bytewords: checksum mismatch");
  return data;
}

// ---------------- minimal CBOR (unsigned ints, byte strings, arrays, maps) ----------------

export type Cbor = number | Uint8Array | Cbor[] | Map<number, Cbor>;

function head(major: number, n: number): Uint8Array {
  const m = major << 5;
  if (n < 24) return new Uint8Array([m | n]);
  if (n < 0x100) return new Uint8Array([m | 24, n]);
  if (n < 0x10000) return new Uint8Array([m | 25, n >> 8, n & 0xff]);
  if (n <= 0xffffffff) return new Uint8Array([m | 26, ...u32be(n)]);
  throw new Error("cbor: integer too large");
}

export function cborEncode(v: Cbor): Uint8Array {
  const parts: Uint8Array[] = [];
  const walk = (x: Cbor) => {
    if (typeof x === "number") {
      if (!Number.isInteger(x) || x < 0) throw new Error("cbor: only unsigned integers");
      parts.push(head(0, x));
    } else if (x instanceof Uint8Array) {
      parts.push(head(2, x.length), x);
    } else if (Array.isArray(x)) {
      parts.push(head(4, x.length));
      x.forEach(walk);
    } else {
      const keys = [...x.keys()].sort((a, b) => a - b); // canonical: ascending small uint keys
      parts.push(head(5, keys.length));
      for (const k of keys) { walk(k); walk(x.get(k)!); }
    }
  };
  walk(v);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function cborDecode(bytes: Uint8Array): Cbor {
  let o = 0;
  const need = (n: number) => { if (o + n > bytes.length) throw new Error("cbor: truncated"); };
  const arg = (info: number): number => {
    if (info < 24) return info;
    const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
    if (!len) throw new Error("cbor: unsupported length");
    need(len);
    let n = 0;
    for (let i = 0; i < len; i++) n = n * 256 + bytes[o++]!;
    return n;
  };
  const item = (depth: number): Cbor => {
    if (depth > 8) throw new Error("cbor: too deep");
    need(1);
    const b = bytes[o++]!;
    const major = b >> 5;
    const n = arg(b & 31);
    switch (major) {
      case 0: return n;
      case 2: { need(n); const v = bytes.slice(o, o + n); o += n; return v; }
      case 4: { if (n > bytes.length) throw new Error("cbor: bad array"); const a: Cbor[] = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: {
        if (n > bytes.length) throw new Error("cbor: bad map");
        const m = new Map<number, Cbor>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          if (typeof k !== "number" || m.has(k)) throw new Error("cbor: bad map key");
          m.set(k, item(depth + 1));
        }
        return m;
      }
      default: throw new Error("cbor: unsupported type");
    }
  };
  const v = item(0);
  if (o !== bytes.length) throw new Error("cbor: trailing bytes");
  return v;
}

// ---------------- Xoshiro256** seeded by SHA-256, and the fountain's choices ----------------

const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (64n - k))) & M64;

class Xoshiro {
  private s: bigint[] = [];
  constructor(seed: Uint8Array) {
    const d = sha256(seed);
    for (let i = 0; i < 4; i++) {
      let v = 0n;
      for (let n = 0; n < 8; n++) v = (v << 8n) | BigInt(d[i * 8 + n]!);
      this.s.push(v);
    }
  }
  private next(): bigint {
    const s = this.s as [bigint, bigint, bigint, bigint];
    const result = (rotl((s[1] * 5n) & M64, 7n) * 9n) & M64;
    const t = (s[1] << 17n) & M64;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
    s[3] = rotl(s[3], 45n);
    return result;
  }
  nextDouble(): number { return Number(this.next()) / 2 ** 64; }
  nextInt(low: number, high: number): number { return Math.floor(this.nextDouble() * (high - low + 1) + low); }
}

/** The reference's alias-method sampler (Vose), drawn with the same RNG calls. */
function chooseDegree(seqLen: number, rng: Xoshiro): number {
  const n = seqLen;
  const p = Array.from({ length: n }, (_, i) => 1 / (i + 1));
  const sum = p.reduce((a, b) => a + b, 0);
  const scaled = p.map((x) => (x * n) / sum);
  const prob = new Array<number>(n);
  const alias = new Array<number>(n);
  const small: number[] = [];
  const large: number[] = [];
  for (let i = n - 1; i >= 0; i--) (scaled[i]! < 1 ? small : large).push(i);
  while (small.length && large.length) {
    const less = small.pop()!;
    const more = large.pop()!;
    prob[less] = scaled[less]!;
    alias[less] = more;
    scaled[more] = scaled[more]! + scaled[less]! - 1;
    (scaled[more]! < 1 ? small : large).push(more);
  }
  while (large.length) prob[large.pop()!] = 1;
  while (small.length) prob[small.pop()!] = 1;
  const c = Math.floor(rng.nextDouble() * n);
  return (rng.nextDouble() < prob[c]! ? c : alias[c]!) + 1;
}

export function chooseFragments(seqNum: number, seqLen: number, checksum: number): number[] {
  if (seqNum <= seqLen) return [seqNum - 1];
  const seed = new Uint8Array(8);
  seed.set(u32be(seqNum)); seed.set(u32be(checksum), 4);
  const rng = new Xoshiro(seed);
  const degree = chooseDegree(seqLen, rng);
  const remaining = Array.from({ length: seqLen }, (_, i) => i);
  const shuffled: number[] = [];
  while (remaining.length) shuffled.push(remaining.splice(rng.nextInt(0, remaining.length - 1), 1)[0]!);
  return shuffled.slice(0, degree);
}

// ---------------- UR encode / decode ----------------

const TYPE_RE = /^[a-z0-9-]+$/;

function fragmentLength(messageLen: number, minLen: number, maxLen: number): number {
  const maxCount = Math.ceil(messageLen / minLen);
  let len = 0;
  for (let count = 1; count <= maxCount; count++) {
    len = Math.ceil(messageLen / count);
    if (len <= maxLen) break;
  }
  return len;
}

const xorInto = (a: Uint8Array, b: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i]! ^= b[i]!; };

/** A single-part UR for a CBOR payload. */
export function encodeUR(type: string, cbor: Uint8Array): string {
  if (!TYPE_RE.test(type)) throw new Error("ur: invalid type");
  return `ur:${type}/${bytewordsEncode(cbor)}`;
}

/**
 * A multi-part encoder: `nextPart()` yields parts 1, 2, 3, … forever (the
 * first `seqLen` are the plain fragments). One fragment encodes single-part.
 */
export function urEncoder(type: string, cbor: Uint8Array, maxFragmentLen = 200, minFragmentLen = 10) {
  if (!TYPE_RE.test(type)) throw new Error("ur: invalid type");
  if (cbor.length === 0) throw new Error("ur: empty message");
  const len = fragmentLength(cbor.length, minFragmentLen, maxFragmentLen);
  const fragments: Uint8Array[] = [];
  for (let o = 0; o < cbor.length; o += len) {
    const f = new Uint8Array(len);
    f.set(cbor.subarray(o, o + len));
    fragments.push(f);
  }
  const checksum = crc32(cbor);
  let seq = 0;
  return {
    seqLen: fragments.length,
    nextPart(): string {
      seq = (seq + 1) >>> 0;
      if (fragments.length === 1) return encodeUR(type, cbor);
      const mixed = new Uint8Array(len);
      for (const i of chooseFragments(seq, fragments.length, checksum)) xorInto(mixed, fragments[i]!);
      const body = cborEncode([seq, fragments.length, cbor.length, checksum, mixed]);
      return `ur:${type}/${seq}-${fragments.length}/${bytewordsEncode(body)}`;
    },
  };
}

interface Part { indexes: number[]; data: Uint8Array }

/**
 * Collects scanned parts (any order, duplicates and other noise ignored) until
 * the message is complete. `receive` returns false for a part it rejected.
 */
export function urDecoder(expectedTypes?: string[]) {
  let type: string | undefined;
  let result: Uint8Array | undefined;
  let error: string | undefined;
  let meta: { seqLen: number; messageLen: number; checksum: number; fragLen: number } | undefined;
  const simple = new Map<number, Uint8Array>();
  let mixed: Part[] = [];
  const seenMixed = new Set<string>();
  const queue: Part[] = [];

  const reduce = (a: Part, b: Part): Part => {
    if (!b.indexes.every((i) => a.indexes.includes(i))) return a;
    const data = a.data.slice();
    xorInto(data, b.data);
    return { indexes: a.indexes.filter((i) => !b.indexes.includes(i)), data };
  };

  const finish = () => {
    const m = meta!;
    const all = new Uint8Array(m.seqLen * m.fragLen);
    for (let i = 0; i < m.seqLen; i++) all.set(simple.get(i)!, i * m.fragLen);
    const msg = all.slice(0, m.messageLen);
    if (crc32(msg) !== m.checksum) error = "The scanned parts do not reassemble (checksum mismatch).";
    else result = msg;
  };

  const process = (p: Part) => {
    if (p.indexes.length === 1) {
      const i = p.indexes[0]!;
      if (simple.has(i)) return;
      simple.set(i, p.data);
      if (simple.size === meta!.seqLen) return finish();
      const next: Part[] = [];
      for (const m of mixed) {
        const r = reduce(m, p);
        if (r.indexes.length === 1) queue.push(r); else next.push(r);
      }
      mixed = next;
    } else {
      let r = p;
      for (const [i, data] of simple) r = reduce(r, { indexes: [i], data });
      for (const m of mixed) r = reduce(r, m);
      if (r.indexes.length === 0) return;
      if (r.indexes.length === 1) { queue.push(r); return; }
      const next: Part[] = [];
      for (const m of mixed) {
        const x = reduce(m, r);
        if (x.indexes.length === 1) queue.push(x); else next.push(x);
      }
      mixed = [...next, r];
    }
  };

  return {
    get type() { return type; },
    get result() { return result; },
    /** Set when every fragment arrived but they do not reassemble: start over. */
    get error() { return error; },
    /** Fraction of fragments recovered (0..1). */
    progress(): number { return result ? 1 : meta ? simple.size / meta.seqLen : 0; },
    receive(text: string): boolean {
      if (result || error) return false;
      const s = text.trim().toLowerCase();
      if (!s.startsWith("ur:")) return false;
      const comps = s.slice(3).split("/");
      const t = comps[0]!;
      if (!TYPE_RE.test(t) || (expectedTypes && !expectedTypes.includes(t))) return false;
      if (type && t !== type) return false;
      try {
        if (comps.length === 2) {
          const cbor = bytewordsDecode(comps[1]!);
          type = t;
          result = cbor;
          return true;
        }
        if (comps.length !== 3) return false;
        const seqm = /^(\d+)-(\d+)$/.exec(comps[1]!);
        if (!seqm) return false;
        const body = cborDecode(bytewordsDecode(comps[2]!));
        if (!Array.isArray(body) || body.length !== 5) return false;
        const [seq, seqLen, messageLen, checksum, data] = body;
        if (typeof seq !== "number" || typeof seqLen !== "number" || typeof messageLen !== "number" || typeof checksum !== "number" || !(data instanceof Uint8Array)) return false;
        if (seq !== Number(seqm[1]) || seqLen !== Number(seqm[2]) || seq < 1 || seqLen < 1 || data.length === 0) return false;
        // Bounds before any allocation: a hostile part cannot make us allocate more than it implies.
        if (seqLen > 10_000 || messageLen > seqLen * data.length || messageLen <= (seqLen - 1) * data.length) return false;
        if (!meta) meta = { seqLen, messageLen, checksum, fragLen: data.length };
        else if (meta.seqLen !== seqLen || meta.messageLen !== messageLen || meta.checksum !== checksum || meta.fragLen !== data.length) return false;
        type = t;
        const indexes = chooseFragments(seq, seqLen, checksum);
        const key = indexes.slice().sort((a, b) => a - b).join(",");
        if (indexes.length > 1) { if (seenMixed.has(key)) return true; seenMixed.add(key); }
        queue.push({ indexes, data });
        while (!result && !error && queue.length) process(queue.shift()!);
        return true;
      } catch {
        return false;
      }
    },
  };
}
