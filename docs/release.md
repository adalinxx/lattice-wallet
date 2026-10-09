# Release procedure

## Build and verification

Use Node 24, a clean checkout, and the recorded SDK submodule revision:

```sh
git submodule update --init --recursive
npm ci
npm run typecheck
npm test
npm run conformance
npm audit --omit=dev
npm audit --omit=dev --prefix vendor/lattice-sdk
npm run package
```

The package script builds, checks manifest references and creates a ZIP with the manifest at its root plus a SHA-256 checksum in release/. It copies LICENSE and third-party notices into the package. This is repeatable packaging; byte-for-byte reproducibility and a hermetic build have not been established. Chrome signs store-distributed extensions.

Audit both dependency trees: the SDK resolves its own pinned signing dependencies. Do not infer the shipped signer version from the wallet lockfile alone. The SDK and wallet currently use different pinned hash-library versions; each is covered by its own audit and the wallet's conformance gate. Build a release only from its reviewed/tagged commit using Node 24, and retain the SDK revision and artifact checksum.

Run the optional tests explicitly; skipped tests are not release evidence:

```sh
LATTICE_NODE_BIN=/path/to/lattice-node/.build/debug node --test test/e2e-local.test.ts
LATTICE_LIVE_READ=https://lattice-mainnet-read.fly.dev node --test test/live-read.test.ts
```

The first command starts isolated nodes, mines disposable funds, and checks authenticated and public submissions, inclusion, and relay fee refusals. The second only reads the deployed network and discovers testnet. Neither proves a funded cross-chain trade on the deployed network.

## Public release gates

- Merge branding and release preparation; package a reviewed commit from main.
- Run unit/UI/conformance tests, isolated submission tests, and deployed read/discovery smoke.
- Drive fresh-install, upgrade with existing recovery records, backup/restore, and funded cross-chain receipt/withdrawal flows in actual Chrome. Include node failures and uncertain submissions. Record the exact browser, node and wallet versions.
- Obtain an independent security review of keystore, signer messages, imported requests/proofs, chain anchoring, transaction recovery and backups; resolve blocking findings. docs/security-review-scope.md supplies the brief.
- Enable private vulnerability reporting or establish a verified private security contact.
- Publish the privacy policy and verify all listing links; create screenshots from actual UI.
- Complete the publisher account and accurate store declarations. Upload the ZIP, supply reviewer instructions, and request review with deferred publication.

Approval is tied to the tested commit and checksum. Any code change invalidates that approval until the relevant checks rerun. Do not tag or announce a public release while a gate is unresolved. Increment manifest and package versions together before subsequent uploads.

For an unpacked extension, rebuilding files is not a reload. Use Reload on its chrome://extensions card, then reopen the wallet. A browser restart alone can leave cached service-worker code in this test setup even when the new manifest/popup is visible. Check behavior, not only the displayed name/version. This development check is not evidence for a store-signed upgrade; test that separately before public release.

## Incident handling

For a signing or recovery vulnerability, preserve evidence and avoid instructing users to erase records. Assess whether to halt distribution or issue a fixed version. Communicate affected versions and concrete recovery actions without exposing user secrets. A removed extension does not reverse blockchain transactions.

Chrome publishing reference: https://developer.chrome.com/docs/webstore/publish
