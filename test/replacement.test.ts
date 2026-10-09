import { test } from "node:test";
import assert from "node:assert/strict";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";
import { signTransfer, signDeposit } from "../src/lib/wallet/session.ts";
import { replacementTransfer } from "../src/lib/wallet/replacement.ts";
import { DEFAULT_SETTINGS, recordPendingSubmission } from "../src/lib/wallet/settings.ts";

const sender = importPrivateKey("a1".repeat(32));
const to = importPrivateKey("b0".repeat(32)).address;
const args = { to, amount: 10n, fee: 1n, nonce: 3n, chainPath: ["Nexus"] };
const signed = signTransfer(sender, args);
const record = { cid: signed.transactionCID, from: sender.address, to, amount: "10", fee: "1", nonce: "3", chain: "Nexus", at: 1, signedSubmit: signed };

test("RBF recovers exact transfer terms and fails closed on metadata or body changes", () => {
  assert.deepEqual(replacementTransfer(record), { from: sender.address, ...args });
  for (const changed of [{ amount: "11" }, { fee: "2" }, { nonce: "4" }, { chain: "Nexus/testnet" }, { to: sender.address }, { cid: "wrong" }]) {
    assert.equal(replacementTransfer({ ...record, ...changed }), null);
  }
  const deposit = signDeposit(sender, { amountDeposited: 10n, amountDemanded: 2n, depositNonce: 42n, fee: 1n, nonce: 3n, chainPath: ["Nexus", "testnet"] });
  assert.equal(replacementTransfer({ ...record, chain: "Nexus/testnet", cid: deposit.transactionCID, signedSubmit: deposit }), null);
});

test("same-nonce replacement changes the CID but retains both signed attempts", () => {
  const replacement = signTransfer(sender, { ...args, fee: 2n });
  assert.notEqual(replacement.transactionCID, signed.transactionCID);
  assert.equal(replacement.payload.transaction.body.nonce, signed.payload.transaction.body.nonce);
  const settings = recordPendingSubmission(recordPendingSubmission(DEFAULT_SETTINGS, record), { ...record, cid: replacement.transactionCID, signedSubmit: replacement, fee: "2", replacesCID: record.cid });
  assert.equal(settings.pendingSubmissions.length, 2);
  assert.deepEqual(settings.pendingSubmissions.find((item) => item.cid === record.cid)?.signedSubmit, signed);
});
