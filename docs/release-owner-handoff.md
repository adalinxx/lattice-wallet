# The release owner's funded acceptance handoff

Current status: the release owner confirms the full live purchase/payment/withdrawal completed,
including withdrawal back to the buyer wallet. This is owner-confirmed completion,
not independent or automated reproduction. Do not repeat transactions or demand
hashes as a new release gate. The empty automated regression fixture is a separate
limitation. The steps below are reference material for a future authorized test.

Use a dedicated Chrome profile, the reviewed 0.3.1 ZIP and disposable accounts.
Keep recovery phrases/passwords in your own private custody. Do not paste them
into chat, shell commands, environment variables or evidence files.

## Before signing anything

Confirm the buyer and seller public addresses privately, parent `Nexus` at
`https://rpc.lattice.build`, child `Nexus/testnet` at
`https://lattice-mainnet-testnet.fly.dev`, maximum parent payment, maximum child
amount locked, and the total fee budget for deposit, payment, withdrawal and any
seller claim. Check chain identities, starting balances/nonces and current relay
floors. Use an amount sufficient to cover child withdrawal fees. Confirm both
chains advance; six confirmations are required. Stop if any endpoint/terms differ.

As of October 10 follow-up checks, both documented parent endpoints discover the
same testnet endpoint and that endpoint lists zero deposits. No existing disposable
offer was identified. This does not establish why the listing is empty or that all
operators share that state. Do not pay against a guessed or historical deposit.

## Smallest execution sequence (the release owner performs all signing)

1. Seller creates one small sell deposit within the approved budget. Keep its CID,
   nonce and exact child/parent amounts privately. Confirm it is listed and active.
2. Before payment, run the GET-only regression from the candidate checkout under
   Node 24: `LATTICE_LIVE_PURCHASE=https://rpc.lattice.build node --test test/live-purchase-review.test.ts`.
   Require a pass; on a failure investigate without signing another deposit/payment.
3. Buyer opens that exact request in Chrome. Exercise paste and file drag/drop,
   verify the same amounts/accounts/endpoints, acknowledge node trust and pay once.
   Save the receipt CID and confirm Pending purchases exists. Restart Chrome.
4. Unlock, reopen that pending purchase, verify receipt ownership, and complete the
   child withdrawal once. Save its CID and check the seller payment/recovery flow.
   For an uncertain response, inspect the saved attempt; never create a second payment.
5. Wait for at least six confirmations on deposit, receipt and withdrawal. Compare
   both accounts' before/after balances with amounts and all charged fees (including
   any seller claim). Confirm the offer is spent and buyer received child funds.
6. Fill the private public-data-only JSON described in release-live-testing.md and
   run `LATTICE_TRADE_EVIDENCE=/absolute/private/trade.json node --test test/live-cross-chain.test.ts`.
   Preserve recovery records and redacted evidence. Do not commit the filled JSON.

Evidence: exact candidate commit/SDK/ZIP checksum, Chrome/node versions, endpoint
and chain identities, budgets, starting/ending balances and nonces, the three CIDs,
six-confirmation inclusion, persistence across restart, exact amount review,
paste/drop observations, seller flow and read-only verifier results. A verifier
pass establishes operator-reported inclusion/proof consistency, not independent
consensus; browser behavior and balance accounting need their own observations.

## Publisher setup remains separate

The release owner chose owner security review and waived an independent reviewer. No independent
audit is claimed. Review/merge the draft PR and reconcile the final package before
submission; do not merge or publish automatically.

Mac Chrome profile of the release owner was inventoried. Two attempts to create a dashboard tab
returned `Not allowed`, without a permission name or reason. A separate native
Chrome access attempt reported macOS Accessibility and Screen Recording permissions
still pending in the Computer Use window. These are separate observations: there
is no evidence that either named OS permission was explicitly denied. No access
was bypassed and no unchanged retry should be made.

Next account input: choose the intended Google publisher account; the Chrome profile
name does not establish the Google identity. Enable pending Computer Use permissions
or open https://chrome.google.com/webstore/devconsole yourself. Before accepting
terms or paying, confirm the displayed fee, currency and payment method together
with the developer agreement/policies. Enter credentials and payment details privately.
No registration, terms acceptance or payment has been completed by the assistant.
