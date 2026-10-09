# Chrome Web Store submission materials

Name: Lattice Wallet

Short description: Non-custodial wallet for Lattice chains. Keys stay on your device; you choose the node.

## Description

Manage accounts and transact across Lattice chains from your browser.

- Create a wallet or import an existing recovery phrase or private key.
- Switch between parent and child chains.
- Choose a hosted service or connect to your own node.
- Review amounts, recipients, and fees before signing locally.
- Import cross-chain requests as text, files, or QR codes.
- Keep recovery records for uncertain transaction submissions.
- Back up your wallet using encrypted files or QR codes.

You control your keys. Keep an offline backup of your recovery phrase. Node availability, transaction confirmation, and cross-chain order availability depend on the selected network and operators.

Homepage: https://lattice.build/
Support: https://github.com/adalinxx/lattice-wallet/issues
Privacy policy: https://github.com/adalinxx/lattice-wallet/blob/main/docs/privacy-policy.md

The privacy URL becomes valid after the release-preparation PR merges. Do not submit a draft branch URL as the permanent policy URL.

## Privacy dashboard

Single purpose: Manage Lattice accounts and review, sign, submit, and recover transactions on user-selected Lattice chains.

storage: Store the encrypted signing vault and local account, chain, node, history, and recovery settings.

alarms: Automatically lock the signing session after the configured inactivity interval.

Address copying uses the Clipboard API inside a user gesture, without a clipboard permission.

Optional HTTPS hosts: Connect to user-selected nodes and operator-declared endpoints discovered through parent chains. Lattice permits arbitrary node operators, so the final endpoint cannot be fixed at build time. Access is requested through Chrome permissions. The extension does not inject scripts into websites or read their browsing content.

Optional loopback HTTP hosts: Connect to a node running locally on the user's device. Authentication and explicit node pairing are required where the node demands them.

Remote code: No. JavaScript and WebAssembly dependencies are bundled in the package; node responses are data.

Data disclosures: Financial/payment information (addresses, balances, transactions and recovery records) and authentication information (locally encrypted keys and node cookies). Camera images are processed locally when scanning. Explain local processing and node transmission consistently with the privacy policy; do not claim the wallet handles no user data simply because it has no analytics.

Certifications: No sale of user data; no use unrelated to the wallet's single purpose; no use for creditworthiness or lending. Verify the final dashboard wording before certifying.

## Reviewer instructions

1. Open the extension and create a disposable wallet. Use a unique test password and save the generated test phrase privately.
2. Choose Use lattice.build or a custom node. Accept the optional host permission once requested. Confirm the displayed chain.
3. Copy the address; verify the full address is visible and clipboard copying works.
4. Open the chain dropdown, select a direct child, and use the arrow to return to its parent.
5. Open Send. Invalid addresses and non-positive amounts are refused before signing. Review displays sender, recipient, amount and fee.
6. Lock from Settings, then unlock with the test password. A wrong password must fail.
7. Backup and import can be tested with disposable accounts. Camera permission is needed only for camera scanning; paste/file import is also available.
8. Actual submission needs funds on the selected chain. No funded shared credential is included. For repeatable funded verification, run the isolated-node tests described in docs/release.md.

## Assets and account tasks

Use the existing 128px PNG icon. Three actual 1280×800 Chrome screenshots are checked in under docs/store-assets: welcome, node choice, and unlock. They contain disposable data and no seeds, passwords or cookies. Regenerate with PLAYWRIGHT_MODULE pointing to your installed Playwright package and `node scripts/store-screenshots.cjs`; generated files appear in release/store-assets. Provide a 440×280 promotional image if requested by the dashboard.

Use Lattice as the public publisher name and an organization-controlled verified email with two-step verification. Publisher registration, account verification, fees, jurisdiction declarations, and final certification are account-owner actions. Select deferred publication while the release gates remain open.
