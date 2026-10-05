// SeedQR against SeedSigner's published test vectors (docs/seed_qr/README.md):
// digit streams, compact bytes, QR sizes, and decoding a rendered code.

import { test } from "node:test";
import assert from "node:assert/strict";
import encodeQR from "qr";
import { decodeQR } from "qr/decode.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { standardSeedQR, compactSeedQR, seedQRToMnemonic, latin1, latin1Bytes } from "../src/lib/qr/seedqr.ts";

// Compact bytes are SeedSigner's Python byte literals, as hex.
const VECTORS = [
  {
    words: "attack pizza motion avocado network gather crop fresh patrol unusual wild holiday candy pony ranch winter theme error hybrid van cereal salon goddess expire",
    digits: "011513251154012711900771041507421289190620080870026613431420201617920614089619290300152408010643",
    compact: "0e74b64107f94cc0ccfae6a13dcbec3662154fec67e0e00999c07892597d190a",
  },
  {
    words: "atom solve joy ugly ankle message setup typical bean era cactus various odor refuse element afraid meadow quick medal plate wisdom swap noble shallow",
    digits: "011416550964188800731119157218870156061002561932122514430573003611011405110613292018175411971576",
    compact: "0e59dde2760093" + "17f1275f13898880" + "78c99368d1e82489b5f629531fc5b6a56e",
  },
  {
    words: "sound federal bonus bleak light raise false engage round stock update render quote truck quality fringe palace foot recipe labor glow tortoise potato still",
    digits: "166206750203018810361417065805941507171219081456140818651401074412730727143709940798183613501710",
    compact: "cfca8c658bc81962549252bc7ac3ba5b0b01d26bcae89f2b5ecebe263dcb2a36",
  },
  {
    words: "forum undo fragile fade shy sign arrest garment culture tube off merit",
    digits: "073318950739065415961602009907670428187212261116",
    compact: "5bbd9d71a8ec7990831aff359d426545",
  },
];

/** Render a QR matrix to RGBA pixels (4 px per module) for the decoder. */
function pixels(m: boolean[][]) {
  const s = 4, n = m.length * s;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = m[Math.floor(y / s)]![Math.floor(x / s)] ? 0 : 255;
    data.set([v, v, v, 255], (y * n + x) * 4);
  }
  return { width: n, height: n, data };
}

test("SeedSigner vectors: Standard digit stream and CompactSeedQR bytes, both ways", () => {
  for (const v of VECTORS) {
    assert.equal(standardSeedQR(v.words), v.digits);
    assert.equal(bytesToHex(compactSeedQR(v.words)), v.compact);
    assert.equal(seedQRToMnemonic(v.digits), v.words);
    assert.equal(seedQRToMnemonic(latin1(compactSeedQR(v.words))), v.words);
  }
});

test("QR sizes match the spec (ECC L): 12 words 25x25 / 21x21, 24 words 29x29 / 25x25", () => {
  for (const v of VECTORS) {
    const twelve = v.words.split(" ").length === 12;
    const std = encodeQR(v.digits, "raw", { ecc: "low", encoding: "numeric", border: 1 });
    const cmp = encodeQR(latin1(compactSeedQR(v.words)), "raw", { ecc: "low", encoding: "byte", textEncoder: latin1Bytes, border: 1 });
    assert.equal(std.length - 2, twelve ? 25 : 29);
    assert.equal(cmp.length - 2, twelve ? 21 : 25);
  }
});

test("a rendered CompactSeedQR (incl. a 0x00 byte) scans back to the mnemonic", () => {
  for (const v of VECTORS) {
    const m = encodeQR(latin1(compactSeedQR(v.words)), "raw", { ecc: "low", encoding: "byte", textEncoder: latin1Bytes, border: 4 });
    const text = decodeQR(pixels(m), { textDecoder: (b: Uint8Array) => latin1(b) });
    assert.equal(seedQRToMnemonic(text), v.words);
    const s = encodeQR(v.digits, "raw", { ecc: "low", encoding: "numeric", border: 4 });
    assert.equal(seedQRToMnemonic(decodeQR(pixels(s))), v.words);
  }
});

test("only 12/24 valid words export; junk scans are refused", () => {
  assert.throws(() => standardSeedQR("abandon ".repeat(14) + "about"));
  assert.throws(() => compactSeedQR("forum undo fragile fade shy sign arrest garment culture tube off off"));
  assert.equal(seedQRToMnemonic("0733".repeat(11) + "2048"), null, "index out of range");
  assert.equal(seedQRToMnemonic("0".repeat(47)), null);
  assert.equal(seedQRToMnemonic("ur:lattice-vault/abc"), null);
  assert.equal(seedQRToMnemonic("€".repeat(16)), null, "not Latin-1");
  assert.equal(seedQRToMnemonic("0000".repeat(12)), null, "bad checksum");
});
