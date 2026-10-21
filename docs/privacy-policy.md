# Selfhold Privacy Policy

This policy applies to Selfhold 0.4.0, 0.4.1, 0.4.2 and 0.5.0 when installed, including review and test builds. Lattice Wallet 0.3.1 remains covered by the [policy effective October 8, 2026](https://github.com/adalinxx/lattice-wallet/blob/dd64bbe81cdfce0cc9ddd2ae7f36d7a05bfa7cf2/docs/privacy-policy.md).

Selfhold (previously Lattice Wallet) is a self-custodial browser extension for Lattice maintained by the Lattice project. This policy covers the extension, not third-party nodes, websites, Chrome, or community services.

## Data on your device

The wallet creates or imports recovery phrases and private keys and encrypts its vault before storing it in your browser profile. Node authentication cookies are also kept in the encrypted vault. Your password is used locally to unlock the vault; it is not sent to nodes or the publisher. The unlocked session retains a non-extractable encryption key, not your password. Keys remain available in memory while the signer is unlocked. Locking ends that signing session and wipes mutable secret buffers; JavaScript cannot guarantee erasure of strings or runtime copies. The signer locks after ten minutes without use. While a wallet page is in view the session lasts until then; once no wallet page is in view the browser ends it sooner. When a step needs keys and the signer has locked, the wallet asks for the password on that screen.

Addresses, account labels, chain and node choices, fees, transaction history, deposit keys, purchase records, and signed transaction recovery payloads are stored locally outside the encrypted vault. These records contain financial and account information. Signed transactions can be rebroadcast by someone who obtains them; they do not contain private keys. Anyone with access to your browser profile may be able to read this unencrypted metadata.

## Network requests

The wallet connects to nodes you select and to services used for chain discovery. Requests may disclose your IP address, selected chain, queried account addresses, and requested transaction or state identifiers to those operators. When you approve a transaction, the wallet sends its signed transaction to the selected submission endpoint. Transactions admitted to a public blockchain may become public and cannot be erased by uninstalling the wallet.

An authentication cookie is sent only to the node it belongs to when required for authorized requests. Recovery phrases, private keys, and the wallet password are not sent to nodes. Node operators have their own privacy practices.

The wallet declares required network access to exactly rpc.lattice.build, lattice-mainnet-read.fly.dev, lattice-mainnet-iad.fly.dev, lattice-mainnet-ams.fly.dev, lattice-mainnet-sjc.fly.dev and lattice-mainnet-testnet.fly.dev over HTTPS. When you have not chosen a Nexus node, automatic discovery reads from lattice-mainnet-read.fly.dev and the three lattice-mainnet backbone nodes in turns. Connecting to these hosted nodes does not require a runtime permission prompt; Chrome may show permissions during installation or upgrade. Other operators require optional network permission. In 0.4.0 and 0.4.1, the wallet requested each operator through explicit custom-node selection and attempted to revoke earlier unrestricted HTTPS grants on upgrade. Chrome can reject that removal because the same origins are required for content scripts; do not assume earlier access was revoked. From 0.4.2, automatic node discovery asks once for optional access to every HTTPS host, because the nodes that serve a chain are named by its parent chain's nodes only as discovery proceeds; once granted, discovery contacts the hosts those nodes declare without asking again, and each such host receives the wallet's requests, including your IP address and the account addresses read from it. Custom-node selection still asks for one host at a time. Switching to custom nodes does not revoke previously granted access. Chrome treats origins shared with required content scripts as required, so the wallet cannot remove those grants through its permissions API. Connection settings explain how to manage site access through Chrome's extension settings. Restricting access can interrupt discovery and website connections; removing the extension revokes access. Allowlisting network access does not authenticate an operator's chain data or remove purchase trust acknowledgement.

## Websites and wallet requests

The extension injects a page-world `window.lattice` API and an isolated relay script at document start on HTTPS pages and HTTP pages on localhost and 127.0.0.1. The provider handles requests from the top-level document; iframe requests are refused. Chrome controls whether the scripts may run on a site. This is broader website access than the three hosted-node network permissions and may require consent when installing or upgrading.

The scripts relay wallet API calls and responses; they do not scan page text, forms, or browsing history. The wallet receives the requesting origin from Chrome and displays it in an extension-owned approval window. Pages can detect the provider. A connection requires approval before a site receives a chosen account address. The origin-to-address connection is stored locally outside the encrypted vault, persists across restarts, and lets that origin read its connected address without another prompt, including while the wallet is locked. A site can call `disconnect()` to remove its connection.

Each record-write/payment request and each message-signing request requires a separate approval. Record keys/values, chain, payments, recipients and fees come from the requesting site and are displayed for review. Approved writes are signed and submitted by the wallet to a node; the site receives the transaction identifier, not the signed transaction bytes. Pending page writes store the chain, account, nonce, transaction identifier and node URL locally. Nodes and public chains can receive the records and payments in these transactions.

Approved messages return a public key and signature to the requesting site. Signed message bytes include a distinct message prefix, the requesting origin and the message text. A message signature can prove control of an account to that site; it is not a transaction signature. The wallet does not submit signed messages to a blockchain. Sites receiving addresses, transaction identifiers or signatures have their own privacy practices. Private keys, recovery phrases, vault passwords and node cookies are not given to websites through this API.

From 0.5.0, you can open a `lattice://write` request by pasting text, importing a file/QR image, scanning a QR code, or through a website's `openRequest` call. A website does not need a prior wallet connection to ask for this review. Opening a request does not approve it or create a standing connection. You choose an account and separately approve its records, payments and fee. Request labels are unverified text. The wallet uses its own node choices and nonce, checks expiry again before signing, and reads existing records when a request asks to write only if absent. These reads disclose the requested chain and content identifiers for block/state data to the selected node; the access pattern may reveal which records are being checked. Content is checked against the node's supplied state, not independently verified consensus; records omitted as already present are shown in review. A requesting website receives the transaction identifier or error after the decision; a pasted/scanned request shows its result in the wallet without a callback to a website.

## Camera, clipboard, and backups

Camera scanning is initiated by you and processes QR frames locally. The wallet does not upload camera images. Address copying writes the selected address to your clipboard. Files and QR images you import are processed locally. Exported backups are saved or displayed at your request; encrypted backups require their password, while a SeedQR contains an unencrypted recovery phrase. Protect exported files, printed codes, and clipboard contents.

## Publisher collection and sharing

The extension contains no publisher analytics, advertising, or telemetry service. The publisher does not receive your vault or wallet history through the extension, sell user data, use it for advertising, or use it to determine creditworthiness. Data is processed or transmitted only to provide the wallet features you request. Selfhold's use of information complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

Support reports you voluntarily submit to GitHub or another community service are handled by that service and may be public. Never submit recovery phrases, private keys, passwords, authentication cookies, or unredacted backups.

## Retention and deletion

Local data, including site connections and pending page-write metadata, remains in your browser profile until removed. Pending recovery records and confirmed archives are retained to support transaction recovery; dismissal removes selected records. Resetting the vault removes the vault but must not be assumed to remove all settings or recovery metadata. To remove all extension data, uninstall the extension and remove any separately exported backups. Browser backups and copies on other devices are outside the extension's control. Blockchain records remain public according to the chain's retention rules.

## Contact and changes

For privacy questions, contact support@lattice.build or use https://github.com/adalinxx/lattice-wallet/issues without including sensitive information. Security reports should follow SECURITY.md in that repository. Policy changes will be published with an updated effective date.
