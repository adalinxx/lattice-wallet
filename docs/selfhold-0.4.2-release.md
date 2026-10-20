# Selfhold 0.4.2 local release preparation

This candidate uses main `b76c7370555a511103e02d9c3881cd6805ae4873`, inspected October 20, 2026. No open PRs were present. PR #16 merged as `334baee8ffcbe3e20d6da3f53c075d5dcb2af8be`; PR #17 merged as `b76c7370555a511103e02d9c3881cd6805ae4873`. No unmerged features were included. Local preparation changes only the package/manifest version and adds this evidence document. Nothing has been pushed, merged or submitted by this preparation.

## Release notes

- Use the SDK's chain-node list for reads, trying another node on failure.
- Spread automatic Nexus discovery over the read service and the IAD, AMS and SJC backbone nodes; rotate/randomize node selection instead of always starting at one host.
- Use declared child hosts that serve the requested chain; the finder no longer requires a child host to serve its parent's committed block. Operator-provided chain answers are not independent consensus verification.
- Automatic discovery asks once for optional access to all HTTPS nodes; selected local HTTP nodes are requested by name. Permission cleanup retains the broad grant only while automatic selection is enabled.

SDK changes from `283d0e0e174e1a825e8a10b225f4a9a58e67e4ca` to `c50f38c73c7fa73f18b7e76e5cb98c4777bc0136`: bounded wallet reads, child-host resolution, full-tree node finding and ordered/round-robin `ChainNodes`. Signing/derivation code is not changed by that SDK diff.

## Permission decision before release

Compared with the older 0.4.1 artifact, required access adds:

- `https://lattice-mainnet-iad.fly.dev/*`
- `https://lattice-mainnet-ams.fly.dev/*`
- `https://lattice-mainnet-sjc.fly.dev/*`

The optional `https://*/*` declaration already existed, but requesting and retaining it for automatic discovery is new behavior. After consent, discovered HTTPS operators can receive requests without separate per-host prompts. Current main already updates the policy and store draft to describe this, including 0.4.2 applicability. Optional loopback permissions, content-script matches, CSP, storage/alarms permissions and Selfhold icons are unchanged from 0.4.1. No runtime permission was granted during preparation. Review/approve this behavior before upload; actual Chrome permission/upgrade behavior needs testing.

## Validation

Node 24.21.0, clean lockfile install and pinned SDK build:

- Wallet suite: 179 total; 174 pass, 5 optional skipped.
- Conformance: 22 pass. SDK suite: 121 pass, none skipped.
- TypeScript and whitespace checks pass.
- Wallet and SDK production dependency audits: zero reported vulnerabilities.
- Deployed read/discovery smoke: 1 pass, no signing or submission.
- Two package builds under different timezones compare byte-for-byte equal on this macOS toolchain.
- Tracked wallet/SDK source and packaged assets scanned for known personal identifiers and home paths; no matches. No source maps, ZIP comments or extra metadata. Required notices retained for 12 bundled package versions.

Artifact: `release/selfhold-0.4.2.zip`.
SHA-256: `fd92b8c1061dc956f30050f8a7fbf67d5a3f17f6e2b463d2a6ea1c27a3354bf3`.
The older 0.4.1 ZIP remains untouched with SHA-256 `5e835bd4842da2cb51112ce6551a39017d8c405ac8297c621d8095f6200ffffe`.

## Handoff and remaining checks

The public main CI passed at the baseline, but this local version-bump commit has no hosted CI until a push/PR is authorized. No public commit/push, merge or submission is performed here. Version 0.4.2 is the next version after repository 0.4.1 and is already anticipated by main's policy; the independent store task must confirm no equal/newer uploaded version before use.

Browser QA should cover first optional all-HTTPS consent, denial, persistence, cleanup when changing node mode, named HTTP local grants, required-host upgrade prompts, fallback/round-robin behavior and provider nonce/payment review when a node fails. Preserve identity, password, labels, settings and pending recovery on upgrade. Recheck deployed purchase review with a suitable fixture; this optional UI check and real settlement were not run here. Store-signed upgrade remains distinct from local compatibility. No real-fund transactions or user-key handling occurred.

Continue on existing item `amcobhbipbblfjonmoiicihhfglkhpce`, preserving storage and signing identity. Keep Selfhold branding, verified service URLs and support@lattice.build. Analytics is unchanged. Coordinate all dashboard actions through the store task.
