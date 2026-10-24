# Selfhold 0.5.1 release preparation

Inspected October 24, 2026. Baseline main: `114f949ab60b10f28540fb4235a1eb1cc9188697`. Previous verified 0.5.0 merge: `2dc42e6fca3a56e6b5631eb3093f5307ef902d1f`. Canonical repository is now `adalinxx/selfhold-wallet`; the old repository URL redirects there.

## Scope and version

Merged changes since 0.5.0:

- PR #23 (`6342d0564cc79e5ab62a94bf7fe8069135686af8`): a website record write may omit its fee. Review resolves the saved default for the requested chain; approval carries the fee shown. Explicit fees, including zero, are preserved. The worker validates the chosen fee and total debit before signing.
- PR #24 (`114f949ab60b10f28540fb4235a1eb1cc9188697`): canonical repository links.

PR #22 (new-account connection/Moniker labels) is still open and excluded. No unrelated feature was merged. Source remained at 0.5.0, so 0.5.1 is selected as the next patch release for this compatible fee-handling change. This preparation updates package/lock/manifest versions, policy/reviewer text, and approval UI regression tests; it adds no runtime changes beyond merged main.

SDK remains `c50f38c73c7fa73f18b7e76e5cb98c4777bc0136`. Dependencies and lockfile entries are unchanged except the root version. Manifest is identical to 0.5.0 except version: no additional required/optional hosts, permissions, content scripts or CSP changes. The unsupported unused-node-permission control remains absent, with retained-grant guidance intact.

Privacy applicability now includes 0.5.1 and explains the default-fee behavior. Repository/support/privacy URLs use the canonical name. The update introduces no additional data categories or transmission path identified in this bounded source review; final Store declarations remain an account-owner review, not an automated certification. No independent security audit is claimed.

## Validation

Node 24.21.0, macOS Info-ZIP, clean lockfile install and pinned SDK build:

- Wallet suite: 195 total, 190 pass, five opt-in skipped, zero failures.
- TypeScript and 22 conformance checks pass.
- SDK suite: 121 pass using hash-pinned vectors.
- Wallet and SDK production audits: zero reported vulnerabilities.
- New approval regressions verify the omitted fee uses the reviewed chain default even if settings subsequently change, and explicit zero is not replaced. Existing parser/worker tests cover omitted, explicit and invalid fees and signing-side validation.
- Deployed read/discovery smoke passes, GET only.
- Deployed purchase-review regression remains blocked by its fixture precondition: no eligible unpaid offer among the first 30 deposits. This is not a pass; no fixture was created on the network.
- Two package builds under different process timezones are byte-identical. ZIP inspection verifies root manifest/version, unchanged permissions, no maps/comments/extra metadata, retained license notices and absence of known personal identifiers/home paths and credential-pattern matches. Pattern scanning is not a guarantee against every possible secret.

Artifact: `release/selfhold-0.5.1.zip`.
SHA-256: `9b54b4ac46f314cd00e33e08250d2cb3790a3d36cc4309db127a4a0594ae4c7a`.
Existing 0.5.0 and older artifacts remain untouched in their prior checkouts.

## Actual browser acceptance

Chrome for Testing 153.0.8010.12 on macOS, isolated synthetic profile and disposable imported account. No real keys, browser signing or transaction submissions:

- Unpacked 0.5.0→0.5.1 update via chrome://extensions Reload preserves extension identity, account, active address, password, settings and saved default fee. The new manifest reports 0.5.1 and the new worker accepts the changed website flow.
- Malformed/expired write requests are rejected. Valid paste, text-file, QR-image and unconnected website handoff reach review and decline. Website origin is correctly shown and the unconnected request does not establish standing account access.
- A connected synthetic website's record write with omitted fee shows saved default 7. Explicit 0 and 3 remain 0 and 3. Each transaction request is declined. Unfunded nonzero-fee writes are disabled.
- Retained-grant guidance remains; unused-node-permission cleanup is absent.

Logs/screenshots and the local browser harness are retained privately under `release/validation/`. Browser sessions are closed. Camera capture, forced-outage failover, Store-signed upgrade and funded submission were not rerun. Earlier 0.5.0 synthetic purchase/conditional-record tests are historical browser evidence, not newly repeated deployed acceptance. The full automated conditional-state regression is included in this run.

## Handoff

Keep the release PR in draft until reconciliation. No merge or Store action is authorized by this preparation. Review 0.5.1 scope, exact-head CI and the remaining acceptance limits, then separately authorize merge/submission. On merge, verify source-tree and package correspondence and the updated public policy. Update the existing Store item, preserving identity and storage. Do not fold PR #22 into this artifact or describe local unpacked testing as Store-signed upgrade acceptance.
