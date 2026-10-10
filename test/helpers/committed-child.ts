import assert from "node:assert/strict";
import type { NodeClient } from "@adalinxx/lattice-client";

// The child can advance beyond the parent's last commitment. Verify that the
// committed block remains on the child node's current chain, as the wallet does.
export async function assertCommittedChild(
  parent: Pick<NodeClient, "children">,
  child: Pick<NodeClient, "block">,
  parentTip: string,
  directory: string,
): Promise<void> {
  const commitment = (await parent.children(parentTip)).find((entry) => entry.directory === directory);
  assert.ok(commitment?.blockHash, "parent must commit a block for the selected child");
  const committed = await child.block(commitment.blockHash);
  assert.equal(committed.hash, commitment.blockHash, "child must return the requested committed block");
  assert.equal((await child.block(committed.height)).hash, commitment.blockHash,
    "parent-committed block must remain on the child node's current chain");
}
