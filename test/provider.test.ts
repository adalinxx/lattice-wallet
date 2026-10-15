// Web pages and the wallet: what `window.lattice` may ask, what it gets
// signed (records, payments, messages), and how the worker decides who is asking.

import { test } from "node:test";
import assert from "node:assert/strict";
import { messageBytes, parseProviderCall, pageOrigin, totalDebit } from "../src/lib/wallet/provider.ts";
import { deriveAccount } from "../src/lib/crypto/accounts.ts";
import { SIGNATURE_DOMAIN } from "@adalinxx/lattice-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
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

test("a write may pay addresses from the connected account; each payment is checked", () => {
  const payee = deriveAccount(MNEMONIC, 1).address;
  const other = deriveAccount(MNEMONIC, 2).address;
  const paying = parseProviderCall(write({ payments: [{ to: payee, amount: "250" }, { to: other, amount: "5", memo: "dropped" }] }));
  assert.ok(!("error" in paying) && paying.method === "writeRecords");
  assert.deepEqual(paying.params.payments, [{ to: payee, amount: "250" }, { to: other, amount: "5" }]);
  assert.equal(totalDebit(paying.params), 256n, "the payments plus the fee");
  const none = parseProviderCall(write({ payments: [] }));
  assert.ok(!("error" in none) && none.method === "writeRecords" && !("payments" in none.params), "no payments is a write as before");
  const max = (1n << 63n) - 1n;
  for (const payments of [
    "x", {}, [null], [{ to: "bafy-nonsense", amount: "1" }], [{ to: payee }], [{ to: payee, amount: "0" }],
    [{ to: payee, amount: "-1" }], [{ to: payee, amount: "01" }], [{ to: payee, amount: 1 }], [{ to: payee, amount: "1.5" }],
    [{ to: payee, amount: "1" }, { to: payee, amount: "2" }], [{ to: payee, amount: String(max) }],
    Array.from({ length: 17 }, (_, i) => ({ to: deriveAccount(MNEMONIC, i + 3).address, amount: "1" })),
  ]) {
    assert.ok("error" in parseProviderCall(write({ payments })), JSON.stringify(payments));
  }
  assert.ok(!("error" in parseProviderCall(write({ payments: [{ to: payee, amount: String(max - 1n) }] }))), "up to the largest debit with the fee");
});

test("a write with payments debits the payments plus the fee, from the signer only", async () => {
  const signer = createSigner(memory());
  const created = await signer.handle({ type: "createWallet", password: "pw", mnemonic: MNEMONIC }) as WalletResponse<{ state: { accounts: { address: string; publicKey: string }[] } }>;
  assert.ok(created.ok);
  const from = created.state.accounts[0].address;
  const holder = deriveAccount(MNEMONIC, 1).address;
  const call = { ...write().params, actions: [{ key: "own/a/berlin/A12", oldValue: `${holder}@250`, newValue: from }], payments: [{ to: holder, amount: "250" }], nonce: "4" };
  const signed = await signer.handle({ type: "signRecords", from, ...call } as Request) as WalletResponse<{ signedSubmit: { payload: { transaction: { signatures: Record<string, string>; body: Record<string, unknown> } } } }>;
  assert.ok(signed.ok, JSON.stringify(signed));
  const { body, signatures } = signed.signedSubmit.payload.transaction;
  assert.deepEqual(body, {
    accountActions: [{ owner: from, delta: "-251" }, { owner: holder, delta: "250" }], actions: call.actions,
    depositActions: [], receiptActions: [], withdrawalActions: [], signers: [from], nonce: "4", chainPath: call.chainPath,
  });
  assert.deepEqual(Object.keys(signatures), [created.state.accounts[0].publicKey]);
  const self = await signer.handle({ type: "signRecords", from, ...call, payments: [{ to: from, amount: "1" }] } as Request);
  assert.deepEqual(self, { ok: false, error: "a write cannot pay the account that signs it" });
});

test("a message is signed under its own prefix and the page's origin, never as a transaction", async () => {
  for (const text of ["", 5, "a".repeat(4097), "é".repeat(2049), "bell\u0007", "a‮b", "zero​width", "\ud800", "tab\there", "line sep", "a\rb"]) {
    assert.ok("error" in parseProviderCall({ method: "signMessage", params: { text } }), JSON.stringify(text));
  }
  const text = "fanfare-door band berlin/A12 7f3c\nscanner 2";
  assert.deepEqual(parseProviderCall({ method: "signMessage", params: { text, extra: 1 } }), { method: "signMessage", params: { text } });
  assert.ok(!("error" in parseProviderCall({ method: "signMessage", params: { text: "a".repeat(4096) } })));

  const signer = createSigner(memory());
  const created = await signer.handle({ type: "createWallet", password: "pw", mnemonic: MNEMONIC }) as WalletResponse<{ state: { accounts: { address: string; publicKey: string }[] } }>;
  assert.ok(created.ok);
  const { address: from, publicKey } = created.state.accounts[0];
  const origin = "https://fanfare.example";
  const signed = await signer.handle({ type: "signMessage", from, origin, text }) as WalletResponse<{ publicKey: string; signature: string }>;
  assert.ok(signed.ok, JSON.stringify(signed));
  assert.equal(signed.publicKey, publicKey);
  const key = hexToBytes(publicKey.slice(4)); // multikey: ed01 + the 32-byte key
  const bytes = messageBytes(origin, text);
  assert.equal(new TextDecoder().decode(bytes), `lattice-message:${origin}\n${text}`);
  assert.ok(ed25519.verify(hexToBytes(signed.signature), bytes, key));
  assert.ok(!ed25519.verify(hexToBytes(signed.signature), messageBytes("https://other.example", text), key), "useless on another site");
  assert.ok(!new TextDecoder().decode(bytes).startsWith(SIGNATURE_DOMAIN), "never a transaction's signed text");
  for (const bad of ["chrome-extension://abc", "https://fanfare.example/path", "nonsense"]) {
    assert.equal((await signer.handle({ type: "signMessage", from, origin: bad, text })).ok, false, bad);
  }
  assert.equal((await signer.handle({ type: "signMessage", from, origin, text: "a‮b" })).ok, false);
  await signer.handle({ type: "lock" });
  assert.deepEqual(await signer.handle({ type: "signMessage", from, origin, text }), { ok: false, error: "Locked" });
});
