# Store upgrade and funded trade acceptance

These are release gates, not a claim that either has passed. Keep evidence private: public addresses and CIDs link test activity. Never include passwords, seeds, cookies or signed payloads in reports or CI logs. Use disposable accounts and a dedicated Chrome profile; preserve its recovery data until the trade settles.

## Store-signed upgrade

Use a private Chrome Web Store item restricted to trusted testers. See [Google's distribution instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution). Publishing requires publisher authorization and store review. Do not make the item public for this test.

1. Record the item ID, Chrome version, baseline version and reviewed baseline ZIP hash. Install the baseline **from the store** in ordinary Chrome, not Load unpacked or Pack extension.
2. Create disposable accounts. Exercise lock/unlock, custom nodes and host permissions. Prepare an uncertain transfer, open deposit and purchase with saved withdrawal attempts using an isolated funded test environment. Record their CIDs, nonces, selected chain and recovery counts privately. Do not induce ambiguous payments with valuable funds.
3. With popup and wallet tab open, save a new recovery record in one page and change a setting in the other. Verify no record is overwritten. Lock the wallet and restart Chrome; verify the records survive.
4. Upload a reviewed candidate with a strictly higher manifest version to the **same item** and publish only to its private tester audience. Record commit, SDK revision and ZIP hash. Wait for the store update. Do not uninstall, clear storage or switch to an unpacked candidate.
5. Confirm the extension ID is unchanged and the candidate version is installed. Reopen popup and tab; unlock with the existing password. Compare accounts, chain, endpoints, permissions, recovery CIDs/nonces and attempt counts with the baseline. Any missing recovery bytes fail the gate.
6. Demonstrate exact rebroadcast on an isolated node: compare CID and account nonce before/after; no new signature or second payment. Test refusal and dropped response; retained records must still survive restart. Verify archives and manual dismissal, including the warning that dismissal is not cancellation.
7. Verify fresh install separately, password-error lockout, auto-lock with passive reads, backup/restore limitations and upgrade with permission prompts refused. Capture redacted UI evidence and extension errors. Record pass/fail for each step. A displayed new version alone is insufficient evidence of new signer behavior.

## Funded deployed cross-chain trade

Obtain explicit approval of the buyer/seller public addresses, parent/child chain, maximum parent payment, maximum child amount locked and fee budget for **all** transactions. Fund disposable accounts only. Use the actual candidate in Chrome. No secrets should be supplied through chat, environment variables or evidence files.

1. Record starting balances and nonces on both chains, endpoint URLs, relay floors, node versions and the candidate build. Verify both nodes serve the intended chain and accept submissions.
2. Seller creates one small sell deposit. Save its CID, deposit nonce, deposited child amount and demanded parent amount. Verify active-deposit proof and discovery before buying. Do not proceed if state cannot be verified.
3. Buyer imports the buy request via string/file handoff (exercise drag/drop as well as paste). Verify displayed terms, node-trust acknowledgement, fees and selected account. Submit once. Preserve the parent receipt CID and local open purchase.
4. Verify receipt ownership belongs to the buyer, then complete the withdrawal in the wallet. Save the withdrawal CID. Restart Chrome between payment and withdrawal to exercise persisted recovery. Check the seller's payment/recovery flow too.
5. Wait for at least six confirmations on all three transactions. Compare actual balance deltas with transaction amounts and charged fees, including any seller-side claim required by the protocol. Confirm only the intended payment occurred, the child tokens reached the buyer, and the offer is no longer active. Keep archived recovery bytes.
6. Run the read-only acceptance test below. This checks the chosen operators' inclusion answers and state-proof consistency, not independent consensus. UI behavior and balance accounting remain separate required evidence.

Create a private JSON file with these fields (all amounts/nonces are decimal strings):

```json
{
  "parentURL": "https://rpc.lattice.build",
  "childURL": "https://lattice-mainnet-testnet.fly.dev",
  "parentChain": ["Nexus"],
  "childChain": ["Nexus", "testnet"],
  "buyer": "REPLACE_WITH_PUBLIC_ADDRESS",
  "seller": "REPLACE_WITH_PUBLIC_ADDRESS",
  "depositCID": "REPLACE_WITH_CID",
  "receiptCID": "REPLACE_WITH_CID",
  "withdrawalCID": "REPLACE_WITH_CID",
  "depositNonce": "42",
  "amountDeposited": "100",
  "amountDemanded": "10"
}
```

```sh
LATTICE_TRADE_EVIDENCE=/absolute/private/trade.json node --test test/live-cross-chain.test.ts
```

This test never signs or submits. Do not commit the filled file. Failure means investigate/recheck the existing CIDs, not create another payment. Test uncertain submissions and higher-fee replacements first on isolated nodes; never intentionally double-pay or abandon a deployed deposit to manufacture a failure case.

The evidence report must distinguish automated read checks, actual Chrome observations, balance accounting, and any unexecuted edge cases. Store upgrade and funded trade remain pending until the corresponding evidence exists.
