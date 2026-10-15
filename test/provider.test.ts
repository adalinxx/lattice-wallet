// Web pages and the wallet: what `window.lattice` may ask, what it gets
// signed, and how the worker decides who is asking.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProviderCall, pageOrigin } from "../src/lib/wallet/provider.ts";
import { createSigner, type VaultStorage } from "../src/lib/wallet/signer.ts";
import type { Request, Response as WalletResponse } from "../src/lib/wallet/types.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const write = (over: Record<string, unknown> = {}) => ({
  method: "writeRecords",
  params: { chainPath: ["Nexus", "stoa", "bitcoin"], actions: [{ key: "post/a/1", newValue: "{\"title\":\"hi\"}" }], fee: "1", ...over },
});

test("a page may connect, read its address, disconnect, and ask to write records; nothing else", () => {
  for (const method of ["connect", "address", "disconnect"]) assert.deepEqual(parseProviderCall({ method }), { method });
  const ok = parseProviderCall(write());
  assert.ok(!("error" in ok) && ok.method === "writeRecords");
  for (const bad of [
    null, "connect", { method: "signTransfer" }, { method: "writeRecords" },
    write({ chainPath: ["Other", "x"] }), write({ chainPath: ["Nexus", "a/b"] }), write({ chainPath: "Nexus" }),
    write({ actions: [] }), write({ actions: [{ key: "" , newValue: "x" }] }), write({ actions: [{ key: "k" }] }),
    write({ actions: [{ key: "k", newValue: 5 }] }), write({ fee: 1 }), write({ fee: "-1" }), write({ fee: "01" }),
    write({ fee: String(1n << 63n) }),
  ]) {
    assert.ok("error" in parseProviderCall(bad), JSON.stringify(bad));
  }
  const extra = parseProviderCall(write({ actions: [{ key: "k", newValue: "v", owner: "someone" }], accountActions: [{ owner: "x", delta: "-5" }], nonce: "7" }));
  assert.ok(!("error" in extra) && extra.method === "writeRecords");
  assert.deepEqual(extra.params, { chainPath: ["Nexus", "stoa", "bitcoin"], actions: [{ key: "k", newValue: "v" }], fee: "1" }, "unknown fields (a page's nonce too) are dropped");
});

test("only a top-level http(s) page is a page origin", () => {
  assert.equal(pageOrigin({ origin: "https://stoa.example", frameId: 0, tab: {} }), "https://stoa.example");
  assert.equal(pageOrigin({ origin: "https://stoa.example", frameId: 3, tab: {} }), null, "not an iframe");
  assert.equal(pageOrigin({ origin: "https://stoa.example", frameId: 0 }), null, "not outside a tab");
  assert.equal(pageOrigin({ origin: "chrome-extension://abc", frameId: 0, tab: {} }), null);
  assert.equal(pageOrigin({ origin: "null", frameId: 0, tab: {} }), null);
});

function memory(): VaultStorage {
  let vault: Awaited<ReturnType<VaultStorage["load"]>> = null;
  return { load: async () => vault, save: async (v) => { vault = v; }, remove: async () => { vault = null; } };
}

test("a records write signs exactly the records and the fee, from the chosen account", async () => {
  const signer = createSigner(memory());
  const created = await signer.handle({ type: "createWallet", password: "pw", mnemonic: MNEMONIC }) as WalletResponse<{ state: { accounts: { address: string }[] } }>;
  assert.ok(created.ok);
  const from = created.state.accounts[0].address;
  const call = { ...write().params, nonce: "4" };
  const signed = await signer.handle({ type: "signRecords", from, ...call } as Request) as WalletResponse<{ signedSubmit: { payload: { transaction: { signatures: Record<string, string>; body: Record<string, unknown> } }; transactionCID: string } }>;
  assert.ok(signed.ok, JSON.stringify(signed));
  const { body, signatures } = signed.signedSubmit.payload.transaction;
  assert.deepEqual(body, {
    accountActions: [{ owner: from, delta: "-1" }], actions: call.actions,
    depositActions: [], receiptActions: [], withdrawalActions: [], signers: [from], nonce: "4", chainPath: call.chainPath,
  });
  assert.equal(Object.keys(signatures).length, 1);
  assert.ok((await signer.handle({ type: "signRecords", from: "bafy-not-mine", ...call } as Request)).ok === false);
  assert.ok((await signer.handle({ type: "signRecords", from, ...call, actions: [] } as Request)).ok === false);
  assert.ok((await signer.handle({ type: "signRecords", from, ...call, nonce: undefined } as unknown as Request)).ok === false, "the signer needs a nonce");
  await signer.handle({ type: "lock" });
  assert.deepEqual(await signer.handle({ type: "signRecords", from, ...call } as Request), { ok: false, error: "Locked" });
});
