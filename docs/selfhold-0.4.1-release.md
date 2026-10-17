# Selfhold 0.4.1 candidate

Prepared from main `fb7c04d237c0b3fefca7464447a55999665a4899`. Compared with submitted 0.4.0 (`adbeb8c891d74c4ec16c18c88861885a6e7734b5`, merged as `fd19e4543076607ac61aa9cc15414cc477903104`), main adds account-name editing from PR #13 and the version-specific privacy-policy heading from PR #12. This is a new runtime package, not a resubmission of identical bytes.

## Changes

Accounts can be renamed in place; a newly added account opens with its name selected; imported accounts accept an optional name. Names are saved in the existing encrypted vault label fields. Label validation normalizes whitespace/Unicode, limits length to 64 characters, rejects reserved review labels and checks explicitly chosen names for duplicates. Enter/blur saves and Escape cancels the edit. The shared backup length bound remains 64.

The SDK stays at `283d0e0e174e1a825e8a10b225f4a9a58e67e4ca`; no SDK update is included. No storage schema, derivation/signing identity, provider protocol, permission, icon, service URL or support-contact change is introduced. Version 0.4.1 exceeds submitted 0.4.0. Use the existing store item; do not uninstall or create another item. The privacy applicability line includes both 0.4.0 and 0.4.1 and retains the historical 0.3.1 policy link.

## Validation

Node 24.21.0, macOS packaging:

- 172 default tests: 167 pass, 5 opt-in skipped.
- 22 conformance checks pass; TypeScript and whitespace checks pass.
- Wallet and SDK production dependency audits each report zero vulnerabilities.
- Two builds under different timezones compare byte-for-byte equal.
- Manifest equals the submitted 0.4.0 manifest except for version.
- Tracked-source and ZIP scans find no known personal identifiers or local home paths; no source maps, ZIP comments or extra metadata. Required attribution retained for 12 bundled dependency versions.

Artifact: `release/selfhold-0.4.1.zip`.
SHA-256: `43c83e94e3f0f202a4b822e8b0a424f969a3d937fe4925abf61a1f5099eb1b5b`.

## Browser/store handoff

Run focused actual-Chrome acceptance on this candidate: existing-account rename, Enter/blur/Escape, new-account naming, named import using disposable fixture data, invalid/reserved/duplicate names, lock/unlock persistence, and account identity/settings/recovery preservation across local upgrade. Recheck layout and screenshots with long names and light/dark UI. Tests passing on 0.4.0 do not establish these new UI checks. Local compatibility remains distinct from a store-signed upgrade.

Confirm the existing item's current uploaded/review version before upload; if a version newer than 0.4.0 already exists, resolve the version before submission. Coordinate the pending-review replacement through the browser/store task. No store action or live transaction was performed while preparing this candidate; Analytics remains untouched. Do not withdraw, upload or submit based on this document alone.
