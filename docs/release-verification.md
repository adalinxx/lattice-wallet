# Release preparation evidence

> Local October 16 draft: this file records historical 0.3.1 evidence. The proposed 0.4.0 candidate adds website provider/approval flows; the older browser and live-flow results below do not validate those additions. Current rename preparation is recorded in [Selfhold release preparation](selfhold-release.md). Store-signed upgrade remains untested and is now applicable because 0.3.1 is published. No independent audit is claimed.

Date: October 10, 2026. Candidate: 0.3.1 on the release-preparation branch. This is preparation evidence, not public-release approval. It replaces the October 8 evidence for 0.3.0, which no longer describes the code.

## Automated checks on this candidate

- TypeScript checks pass.
- 132 automated tests: 128 pass and 4 are skipped unless their environment is supplied. Three of those four were then run explicitly (below); the fourth, the funded cross-chain verifier, needs evidence from a real trade and was not run.
- 22 explicit conformance checks pass.
- Production dependency audit reports zero vulnerabilities for the wallet and, separately, for the SDK's own lockfile, which is where the shipped signing library is pinned.
- `npm run package` builds, checks manifest references and writes the ZIP and its SHA-256. The ZIP is not byte-for-byte reproducible (archive timestamps differ between runs), so its checksum identifies one packaging run, not the commit. Record the checksum of the ZIP that is actually uploaded.

The explicitly run integration tests:

- Deployed read smoke against https://lattice-mainnet-read.fly.dev passed.
- Own-node authenticated submission passed against isolated local lattice-node processes.
- Public-submit test passed against an isolated local node, including the relay-floor refusal and a refused cheaper replacement.

The isolated tests used lattice-node binaries built at 92df855bd.

## Browser checks during preparation

Each was run in Chrome for Testing 151.0.7922.34 with a temporary profile and disposable keys, on the build current at the time. They were not all repeated on the final commit.

- Upgrade, unpacked: 0.3.0 built from main was installed and created a phrase-based wallet with a second account and an imported key, then signed a transfer, a deposit and a receipt that were stored as a pending transaction, a pending sale and a pending purchase. Its files were replaced by this candidate in the same profile and the browser restarted. The extension kept its id; the wallet came back locked, refused a wrong password and unlocked with the right one; all three accounts were present in order; signing the same transfer gave the transaction id 0.3.0 had produced; the stored records were unchanged, with their signed bytes intact, and were listed under Transactions, Pending sales and Pending purchases. The vault keeps the password derivation it was created with; the stronger setting applies to new vaults only. No version has been published, so the only vaults this affects are those made with development builds; a store-signed upgrade becomes a gate from the second release, per [release live testing](release-live-testing.md). The records were placed in storage by the test, not created through the 0.3.0 screens, and no node was reachable, so status checks and resubmission were not exercised.
- Lock behaviour: a status read does not postpone the idle lock; the fifth failed export password locks the wallet; a locked signer raises the unlock prompt in place and the interrupted step then completes.
- Content security policy: from an extension page, requests to plain-http origins and an injected inline script were refused.
- Live network, read-only: choosing the hosted Nexus node, switching to testnet by discovery, and opening a request naming a sell order then listed on testnet reached the purchase review with correct amounts and the public-node acknowledgement.
- Layout at popup width with a 94-character node address and a long chain name: nothing runs past the edge on the chain, node and settings screens.

Three 1280×800 store screenshots were captured from the packaged extension. The node-choice screenshot was retaken for this candidate; the welcome and unlock screens are unchanged.

## Faults found against the live network during preparation

Recorded because the automated suite uses simulated nodes written to the wallet's own assumptions, and passed while these were present:

- a purchase could never be reviewed, because the child node's tip was required to equal the block its parent last committed;
- every unpaid sell order was rejected, because the node omits empty optional fields;
- a deposit listing whose last page omits its cursor was treated as an error.

All three are fixed and now have tests in the shape the live node sends. A read-only smoke test of the purchase review against a live node would have caught them and is not yet part of the suite.

## Security review

An AI-assisted review of the 0.3.0 commit and package was carried out during preparation. Its findings on recovery after refused submissions, offer selection, export re-authentication, cross-page state, backup bounds, lock behaviour, dependency auditing and password derivation were addressed in this candidate. One was accepted rather than fixed: state proofs are checked against the tip the nodes supply, with no independent verification of the chain, so a purchase through a node that is not on the user's computer requires an explicit acknowledgement on each review. See [node trust](node-trust.md).

That automated review was not an independent review, and no certification is claimed.

## Public-release status

- No independent audit has been carried out, and none is claimed.
- A full live purchase, payment and withdrawal back to the buyer wallet were completed by hand. This satisfies the live-flow gate and supersedes earlier pending statements; it was not reproduced independently or by the automated verifier.
- Published policy links, the publisher account and final store declarations.

No user funds or keys were used for the automated checks. The live test is recorded separately.

## October 10 follow-up validation from merged main

Baseline verified against GitHub: `989a09d8ef0a1d0c03429cdfc8ddddf98c41efc4`;
PR #16 merged at 2026-10-10 05:24:55 UTC. SDK:
`283d0e0e174e1a825e8a10b225f4a9a58e67e4ca`.
The original clean checkout at `02505aaeb19298a2ceb92ee3729fd3701381df41`
(settings-icon-closes) was preserved; that unmerged change is not in this candidate.

This follow-up adds the missing opt-in deployed purchase-review UI regression and
normalizes package file order, timestamps and modes. It supersedes the earlier
statement that ZIP timestamps differ. No wallet runtime code changed.

Validation on macOS, Node 24.21.0, Apple Info-ZIP 3.0:

- Clean lockfile installation and SDK build, TypeScript, and diff whitespace checks pass.
- 133 default tests: 128 pass, 5 opt-in tests skipped. 22 conformance checks pass.
- Deployed read/discovery test explicitly passes: Nexus height 4962, testnet height 12206.
- New live purchase-review test explicitly **fails its fixture precondition**:
  the proof-verified deployed testnet listing contains zero deposits. The review UI
  portion has not run against a live offer. This remains required evidence, not a pass.
- Both production dependency audits report zero vulnerabilities.
- Two Node 24 package builds, with different process timezones, compare byte-for-byte equal.
  SHA-256: `de572bc1f9374763dd5c6929f16624423b81c79f3bee2f5af967b36106daa72b`.
  Reproducibility is scoped to the recorded toolchain, not a hermetic guarantee.
- Homepage, issues/support and main-branch privacy policy URLs return HTTP 200.
  GitHub private vulnerability reporting is enabled.

No new actual-Chrome candidate acceptance or isolated-node signing/submission run
was performed in this follow-up. Earlier browser/local-node results above remain
historical evidence, not checks repeated on this candidate. No live signing,
purchase, withdrawal or transfer was attempted.

Publisher registration is pending; account identity and dashboard declarations remain unverified.
Do not infer account readiness or certify declarations from the listing draft.

### Concrete completion sequence

1. Review and merge this follow-up, then record the final main commit and rebuild;
   compare the package hash. Any subsequent runtime changes require relevant retests.
2. Resolve any blocking review findings. Record the final commit, SDK revision
   and ZIP covered by publication approval; do not describe the review or
   automated checks as an independent audit.
3. The live purchase, payment and withdrawal back to the buyer wallet are
   complete; do not repeat transactions as a new gate. Automated reproduction
   remains separately unverified.
4. Complete publisher registration in the Web Store dashboard,
   verified contact/2FA, any fees or terms, and jurisdiction/data declarations.
   Recheck final policy wording and permission explanations against the manifest.
   Use docs/store-listing.md and the existing actual-UI screenshots. Upload the
   reviewed ZIP and request review with deferred publication.
5. Publish only after all gates and store declarations are complete. Do not tag
   or announce while blocked. Store-signed upgrade is a second-release gate.

### Follow-up diff review and CI

GitHub CI run 38077628609 passed on exact head
`200f0c4d583277f1ee0815ae283a55cc9e7dc6c4`; its Linux ZIP has the same SHA-256
as the local macOS ZIP above. Subsequent diff review found the funded acceptance
verifier still required the child tip to equal the parent commitment. The verifier
now checks that the parent-committed block is on the child's current chain by
height, matching the wallet's behavior, with a regression for a fork/missing child.
This changes test code only and does not establish that funded acceptance passed.

Both `rpc.lattice.build` and `lattice-mainnet-read.fly.dev` report Nexus height
4962 and discover the same `lattice-mainnet-testnet.fly.dev` endpoint. At child
height 12214 that endpoint listed zero deposits in both checks. No existing
disposable offer was identified. Endpoint selection agrees with documented defaults;
operator intent and the historical reason for the empty listing remain unknown.
See [store upgrade and funded trade acceptance](release-live-testing.md) for
prerequisites, manual signing steps and evidence.

A live purchase, payment and withdrawal back to the buyer wallet were then
completed by hand, which closes the live-flow gate. This is recorded separately
from automated reproduction; no evidence artifact for that run is kept in this
repository. The empty current listing does not establish that no prior live test
occurred.


### Bundled-license correction (supersedes earlier ZIP checksum)

Package review found that the ZIP retained only wallet/Lucide legal texts.
Packaging now inventories every esbuild input package (12 installed package
versions, including both Noble hashes versions) and appends its exact upstream
license/notice texts. It also retains source copyright comments and supplemental
QR/ZXing, Microsoft helper, BLAKE2b and Go crypto reference attributions.
The ZIP includes `THIRD_PARTY_INVENTORY.json`; packaging fails if a bundled
package has no license text. The SDK package licenses are included separately.

The corrected ZIP SHA-256 is
`8e4fd2fad38b2d31cc1adbfd0ddc307e978770eb902befe2b8ca7381c419a072`.
This replaces the earlier `de572bc…` artifact for submission. Runtime JavaScript,
manifest and existing assets are byte-identical to the earlier candidate; the
archive changes add legal material and its inventory. No signing or permissions
changed. Two local packaging runs under different timezones compare identically.
