# Selfhold 0.5.0 release preparation

Baseline: main `c1042d03634d81f4511fc9f87fba4a3240276de9`, inspected October 20, 2026. PR #20 is merged; its `lattice://write` handoff is included. No unrelated open features were merged. Previous release baseline: PR #19 merge `a7ed85f7d2b3a9c9869caa1c5948cbd655c04ab3`. SDK remains `c50f38c73c7fa73f18b7e76e5cb98c4777bc0136`.

This preparation changes version metadata, documentation and read-only regression tests; no runtime code. Package, lockfile and manifest are 0.5.0. The manifest is identical to 0.4.2 except version: no new required/optional hosts, permissions, content scripts or CSP. The removed unused-node-permission control stays removed, and switching to custom nodes retains grants.

## Behavior and disclosure review

PR #20 adds write requests through text/file/QR import or `window.lattice.openRequest(uri)`, without requiring a prior site connection. Opening only requests review; it does not grant standing access or authorize signing. The chosen account, records, payments and fee are reviewed separately. The worker validates account ownership and expiry before signing; page requests remain bound to Chrome's document identity. The wallet chooses nonce and node. Labels remain unverified text. Existing-record reads for `ifAbsent` use CID-verified data rooted in the selected node's claimed tip, not independently verified consensus. False presence can omit a record; review lists omissions and rereads before approval. Approved website requests return a CID, while imported requests display the outcome locally.

Privacy and store drafts now describe unconnected requests, chain/content-identifier disclosure and record access patterns, explicit approval, and imported-request results. Existing financial/payment and authentication disclosures still require reconciliation with the actual dashboard. No certification or independent security review is claimed. No new code fix was needed in this preparation; this bounded source review is not an audit.

## Validation

Toolchain: Node 24.21.0, macOS Info-ZIP. Clean lockfile installation and pinned SDK build.

- Wallet tests: 192 total, 187 pass, five opt-in skipped; zero failures.
- TypeScript checks and 22 conformance checks pass.
- SDK tests: 121 pass after fetching hash-pinned vector fixtures. An initial run lacked those fixtures; the final run includes them.
- Wallet and SDK production audits: zero reported vulnerabilities.
- Deployed read/discovery smoke: one pass, GET only.
- Deployed purchase-review test: **blocked by fixture precondition**, no eligible unpaid offer among the first 30 deposits. No live review acceptance claimed and no offer created.
- Two package builds with different process timezones match byte-for-byte. ZIP has root manifest, no source maps, ZIP comments or extra metadata, and required third-party notices. Known personal identifiers and home paths are absent from packaged bytes.

Artifact: `release/selfhold-0.5.0.zip`.
SHA-256: `ff0b80c61870b94473fc60b194a24c5bbecd18f5da78bc432b55f0b33907ad62`.
The prior 0.4.2 checkout and ZIP were preserved separately.

## Actual browser evidence and limitations

Chrome for Testing 153.0.8010.12 on macOS, separate disposable profiles, synthetic imported account, no signing or live transactions:

- Fresh 0.5.0 install/import passes.
- Malformed and expired requests are rejected.
- Valid pasted write request opens approval with account choice, unverified label and pasted-request origin. Insufficient balance disables signing. Decline closes the approval.
- Retained-grant guidance is present; the unsupported cleanup control is absent.
- Unpacked 0.4.2-to-0.5.0 upgrade passes using the actual chrome://extensions Reload control: same extension identity, account, active address, settings and password; manifest 0.5.0; the new worker opens write approval successfully. Earlier file replacement plus restart left stale worker code, and a runtime reload attempt failed. Those were harness/development-loading limitations; the correct management reload did not reproduce an upgrade defect. This is not Store-signed upgrade evidence.
- Actual text-file and QR-image import both reach review and decline. A localhost website opens a request without connecting first, displays its Chrome-reported origin, receives the decline, and has no standing account connection afterward. Camera hardware capture was not exercised.
- A local synthetic unpaid-offer fixture reaches actual-browser purchase review: 50 parent units, 300 child units, mandatory node-trust acknowledgement and disabled Pay before acknowledgement. No Pay click or network write. This does not replace the missing deployed offer.
- Synthetic CID-verified record fixtures test absent/present lookup and corrupt-content rejection. Both automated UI and actual Chrome tests change conditional-record state after review but before the approval handler rereads it; the wallet redraws review without sending an approval to the signer. The browser test installs an additional hard guard against approval messages, asserts it was never reached, and then declines.

Private logs/screenshots are in `release/validation/`. The browser sessions are closed. Camera capture, forced node outage and Store-signed upgrade remain untested. All conditional-state and purchase fixtures above are local synthetic responses, not deployed-network evidence. Isolated funded submission tests were not rerun. Earlier manually completed funded trade remains historical; no new transfer, purchase, withdrawal or user-key operation occurred.

## Publication handoff

This branch is preparation for review, not approval to merge or submit. Reconcile the PR, browser limitations and store readiness with the release owner. The read-only request import/website and unpacked upgrade checks above are complete; Store-signed upgrade remains a separate acceptance limitation. A deployed eligible offer is needed for live purchase-review regression; do not create one without separate transaction authorization. After approved merge and exact-head CI, verify the merge tree and rebuild/hash correspondence, publish the corrected policy on main, update the existing store item, and review declarations against the new request flow. Do not describe automated tests as a named independent security signoff.
