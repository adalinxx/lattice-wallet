// Exact signing preimage, matching Lattice's TransactionSigning.preimage.
// Lines joined by "\n":
//   domain:<utf8len>:lattice-tx-v1
//   chainPath.count:<n>
//   chainPath.component:<utf8len>:<name>   (per component)
//   nonce:<nonce>
//   bodyCID:<utf8len>:<bodyCID>

import { utf8 } from "../crypto/bytes.ts";

export const DOMAIN = "lattice-tx-v1";

export function buildPreimage(bodyCID: string, chainPath: string[], nonce: bigint | number): string {
  const lines: string[] = [
    `domain:${utf8(DOMAIN).length}:${DOMAIN}`,
    `chainPath.count:${chainPath.length}`,
  ];
  for (const component of chainPath) {
    lines.push(`chainPath.component:${utf8(component).length}:${component}`);
  }
  lines.push(`nonce:${nonce}`);
  lines.push(`bodyCID:${utf8(bodyCID).length}:${bodyCID}`);
  return lines.join("\n");
}
