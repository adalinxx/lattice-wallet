# Release preparation evidence

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

That review is not the named independent review the release procedure requires, and no certification is claimed.

## Outstanding public-release gates

- A named independent security review and disposition of its findings.
- Paying for and withdrawing a purchase on the deployed network. The purchase review has been reached there; payment and withdrawal have never been executed.
- Published policy links, the publisher account and final store declarations.

No user funds or keys were used for any check above.
