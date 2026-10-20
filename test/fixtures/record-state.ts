// Synthetic, content-addressed node data for read-only review tests. No signing.
import { cidV1DagCbor, encodeDagCbor, type DagCborValue } from "@adalinxx/lattice-core";
import { encodeVolumeArchive, VOLUME_ARCHIVE_MEDIA_TYPE } from "@adalinxx/lattice-volumes";

export function recordState(present: boolean) {
  const entries: Array<{ cid: string; bytes: Uint8Array }> = [];
  const add = (value: DagCborValue) => {
    const bytes = encodeDagCbor(value), cid = cidV1DagCbor(bytes);
    entries.push({ cid, bytes }); return { rawCID: cid };
  };
  const leaf = add({ prefix: "optional", value: "existing", children: [] });
  const root = add({ count: present ? 1n : 0n, children: present ? [{ key: "o", value: leaf }] : [] });
  const state = add({ accountState: root, generalState: root, depositState: root, receiptState: root });
  const block = add({ version: 1n, timestamp: 1n, height: 1n, nonce: 0n, target: "ff", nextTarget: "ff",
    transactions: root, spec: root, parentState: state, prevState: state, postState: state, children: root });
  return {
    tip: block.rawCID,
    respond(url: URL): Response | undefined {
      if (url.pathname === "/api/chain/info") return Response.json({ chain: url.searchParams.get("chainPath")!.split("/"), tipCID: block.rawCID });
      const cid = url.pathname.startsWith("/volumes/") ? url.pathname.slice("/volumes/".length) : "";
      if (entries.some((e) => e.cid === cid)) return new Response(new Uint8Array(encodeVolumeArchive({ rootCID: cid, entries })).buffer, { headers: { "content-type": VOLUME_ARCHIVE_MEDIA_TYPE } });
    },
  };
}
