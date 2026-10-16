# Selfhold 0.4.0 preparation

Selfhold is the renamed wallet for Lattice. This is a draft candidate, not publication approval. The existing icon is temporary pending logo review. Repository names, Lattice network products, verified service URLs and support@lattice.build remain unchanged.

## Source and continuity

Prepared against main `962e5775143c2bbf89c8c7bb86519292440da707`, with SDK `283d0e0e174e1a825e8a10b225f4a9a58e67e4ca`. Main had not advanced when fetched for this rename. Manifest and package versions are 0.4.0. The internal npm package name remains `lattice-wallet`; release archives use `selfhold-0.4.0.zip`.

Update existing Chrome Web Store item `amcobhbipbblfjonmoiicihhfglkhpce`; do not uninstall or create a replacement item. No storage key/schema, cryptographic identity, derivation, provider API (`window.lattice`, `isLatticeWallet`, relay channel), backup encoding or protocol identifier changes are introduced. Legacy backup download filenames remain compatible. Permission declarations and icons are unchanged from the fetched main.

Two previously prepared patches are included for review: reserve page-write nonces before broadcasting so storage failure prevents submission; bind pending approvals to Chrome's requesting document and reject stale/canceled requests. These are retained changes, not newly imposed publication prerequisites.

## Validation

On Node 24.21.0:

- Full suite: 168 tests; 163 pass, 5 opt-in skipped.
- TypeScript and diff whitespace checks pass; 22 conformance checks pass.
- Wallet and SDK production dependency audits each report zero vulnerabilities.
- Deployed read/discovery test passes, without signing or submission (Nexus height 5215; discovered testnet operators at heights 21185–21186).
- Packaging succeeds with 12 bundled package license inventories. Two builds under different process timezones are byte-identical on the recorded macOS toolchain.
- ZIP SHA-256: `f37e8d4124af7e583b41628d9ef298e3f9ee6fdb31a6a93ea6586b2e36070593`.
- Tracked source and packaged assets checked for known personal identifiers and local home paths. Required upstream attribution is retained.

Earlier disposable vault compatibility testing preserved the published baseline's three accounts and encrypted vault. This is not store-signed upgrade evidence. Historical manual funded trade evidence remains distinct from automated tests; no new live transaction was performed.

## Before submission

Review this draft, logo and updated privacy/store materials. Broad website content-script access was added upstream since the published 0.3.1 baseline; the policy now describes injection, connected-origin address disclosure (including while locked), writes/payments, message signatures and retained pending metadata. Verify final dashboard disclosures rather than copying earlier certifications.

Native Mac browser controls were unavailable during preparation, so actual Chrome Selfhold layout, provider navigation/approval behavior, fresh installation and store-signed upgrade remain unverified. Refresh historical listing screenshots after logo approval. A store-signed 0.3.1 upgrade must preserve the same extension ID, vault, settings and recovery records; the historical private-item procedure needs adaptation to the already-public item using available dashboard staging/testing options. Do not change distribution without approval.

After review and merge, rebuild the exact approved commit, record its checksum and SDK revision, and obtain authorization for submission to the existing item. Do not merge, submit, publish or claim an independent security audit from this preparation alone.
