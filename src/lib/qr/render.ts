// QR rendering (paulmillr's `qr`, bundled): SVG markup for the screen and print.

import encodeQR from "qr";
import { latin1Bytes } from "./seedqr.ts";

/** A UR part as SVG. Uppercase so the QR uses its denser alphanumeric mode (scanners lowercase it). */
export const urSvg = (ur: string): string => encodeQR(ur.toUpperCase(), "svg", { ecc: "low", border: 4 });

/** A Standard SeedQR (digits, numeric mode) or CompactSeedQR (Latin-1 text of the entropy, byte mode). */
export function seedSvg(payload: string, format: "standard" | "compact"): string {
  return format === "standard"
    ? encodeQR(payload, "svg", { ecc: "low", encoding: "numeric", border: 4 })
    : encodeQR(payload, "svg", { ecc: "low", encoding: "byte", textEncoder: latin1Bytes, border: 4 });
}
