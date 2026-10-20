# Chrome Web Store submission materials

Local draft for the next release. The Selfhold name and round-two logo A are selected; the production reconstruction and final declarations remain available for review.

Name: Selfhold

Short description: Open-source, self-custodial wallet for Lattice chains. Keys stay on your device; you choose the node.

## Description

Selfhold is an open-source, self-custodial wallet for Lattice. Manage accounts and transact across Lattice chains from your browser.

- Create a wallet or import an existing recovery phrase or private key.
- Switch between parent and child chains.
- Choose a hosted service or connect to your own node.
- Review amounts, recipients, and fees before signing locally.
- Import cross-chain requests as text, files, or QR codes.
- Keep recovery records for uncertain transaction submissions.
- Back up your wallet using encrypted files or QR codes.

You control your keys. Keep an offline backup of your recovery phrase. Node availability, transaction confirmation, and cross-chain order availability depend on the selected network and operators.

Homepage: https://lattice.build/
Support email: support@lattice.build
Support: https://github.com/adalinxx/lattice-wallet/issues
Privacy policy: https://github.com/adalinxx/lattice-wallet/blob/main/docs/privacy-policy.md

The main-branch privacy URL returned HTTP 200 during October 10 release validation after PR #16 merged. Recheck it at submission time; do not submit a draft branch URL as the permanent policy URL.

## Privacy dashboard

Single purpose: Manage Lattice accounts and review, sign, submit, and recover transactions on user-selected Lattice chains.

storage: Store the encrypted signing vault and local account, chain, node, history, and recovery settings.

alarms: Automatically lock the signing session after the configured inactivity interval.

Address copying uses the Clipboard API inside a user gesture, without a clipboard permission.

Required HTTPS hosts: rpc.lattice.build, lattice-mainnet-read.fly.dev, lattice-mainnet-iad.fly.dev, lattice-mainnet-ams.fly.dev, lattice-mainnet-sjc.fly.dev and lattice-mainnet-testnet.fly.dev provide hosted submission, explorer and discovery reads, and testnet access without connection-time prompts. These are exact hosts, not wildcard subdomains.

Optional HTTPS hosts: Connect to user-selected custom operators, including endpoints discovered through parent chains outside the fixed hosted allowlist. Access is requested through Chrome permissions. These optional node permissions are separate from the content-script matches described below.

Optional loopback HTTP hosts: localhost and 127.0.0.1 connect to a node running locally on the user's device. Literal HTTP IPv6 addresses are not supported by the extension CSP. Authentication and explicit node pairing are required where the node demands them.

Content scripts: A page-world API and an isolated relay run at document start on HTTPS sites and HTTP localhost/127.0.0.1 pages, subject to Chrome site access. They relay `window.lattice` calls, not page text or browsing history. The worker accepts only top-frame requests and uses Chrome's reported origin. Connection approval discloses one chosen address; subsequent reads by that origin do not prompt. Every record write, payment and message signature requires a separate extension-window approval. No standing signing permission is granted. Website access may require an installation/upgrade acknowledgement.

Local storage also retains site-origin/account connections and pending page-write chain/account/nonce/CID/node metadata. Approved writes go to the selected node and the site receives the CID; approved messages return the public key and origin-bound signature to the site. The privacy policy must describe these disclosures before submission. Reassess the dashboard data categories against this behavior; do not automatically carry forward the prior certifications.

Remote code: No. JavaScript and WebAssembly dependencies are bundled in the package; node responses are data.

Data disclosures: Financial/payment information (addresses, balances, transactions and recovery records) and authentication information (locally encrypted keys and node cookies). Camera images are processed locally when scanning. Explain local processing and node transmission consistently with the privacy policy; do not claim the wallet handles no user data simply because it has no analytics.

Certifications: No sale of user data; no use unrelated to the wallet's single purpose; no use for creditworthiness or lending. Verify the final dashboard wording before certifying.

## Reviewer instructions

1. Open the extension and create a disposable wallet. Use a unique test password and save the generated test phrase privately.
2. Choose Use lattice.build: no runtime host prompt is expected for the three required hosted origins. For a custom node, accept its optional permission when requested. Confirm the displayed chain. Chrome may require acknowledgement of new required permissions during an upgrade.
3. Copy the address; verify the full address is visible and clipboard copying works.
4. Open the chain dropdown, select a direct child, and use the arrow to return to its parent.
5. Open Send. Invalid addresses and non-positive amounts are refused before signing. Review displays sender, recipient, amount and fee.
6. Lock from Settings, then unlock with the test password. A wrong password must fail.
7. Backup and import can be tested with disposable accounts. Camera permission is needed only for camera scanning; paste/file import is also available.
8. On a disposable HTTPS or loopback test site, call `connect()` from a click. Confirm the correct origin and account in the extension window. Decline and close requests, test a second simultaneous request, and navigate/reload the requesting page before approval. Confirm these cannot produce a signature or payment without a valid request and explicit approval.
9. Inspect a record write with payments: check each recipient, total, fee, chain and record change. Check message-signing review and a message naming a different origin. Use disposable local funds only for submission tests; do not provide shared funded credentials.
10. Actual submission needs funds on the selected chain. No funded shared credential is included. For repeatable funded verification, run the isolated-node tests described in docs/release.md.

## Assets and account tasks

Use the selected Selfhold S/key mark: SVG master and 16/32/48/128px exports in public/assets. Existing screenshots are historical and must be reviewed/refreshed for Selfhold branding before submission. Three actual 1280×800 Chrome screenshots are checked in under docs/store-assets: welcome, node choice, and unlock. They contain disposable data and no seeds, passwords or cookies. Regenerate with PLAYWRIGHT_MODULE pointing to your installed Playwright package and `node scripts/store-screenshots.cjs`; generated files appear in release/store-assets. A 440×280 promotional image is provided at docs/store-assets/selfhold-promo-440x280.png; it is artwork, not a browser screenshot.

Retain the established pseudonymous publisher account and support@lattice.build contact; verify two-step verification in the dashboard. Do not create a new item: update the existing item to preserve its extension ID and storage. The product rename does not authorize changing publisher identity. Publisher registration, account verification, fees, jurisdiction declarations, and final certification are account-owner actions. Select deferred publication while the release gates remain open.
