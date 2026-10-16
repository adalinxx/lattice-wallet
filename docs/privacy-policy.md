# Selfhold Privacy Policy

Draft for the next release; not yet effective.

Selfhold (previously Lattice Wallet) is a non-custodial browser extension for Lattice maintained by the Lattice project. This policy covers the extension, not third-party nodes, websites, Chrome, or community services.

## Data on your device

The wallet creates or imports recovery phrases and private keys and encrypts its vault before storing it in your browser profile. Node authentication cookies are also kept in the encrypted vault. Your password is used locally to unlock the vault; it is not sent to nodes or the publisher. The unlocked session retains a non-extractable encryption key, not your password. Keys remain available in memory while the signer is unlocked. Locking ends that signing session and wipes mutable secret buffers; JavaScript cannot guarantee erasure of strings or runtime copies. The signer locks after ten minutes without use. While a wallet page is in view the session lasts until then; once no wallet page is in view the browser ends it sooner. When a step needs keys and the signer has locked, the wallet asks for the password on that screen.

Addresses, account labels, chain and node choices, fees, transaction history, deposit keys, purchase records, and signed transaction recovery payloads are stored locally outside the encrypted vault. These records contain financial and account information. Signed transactions can be rebroadcast by someone who obtains them; they do not contain private keys. Anyone with access to your browser profile may be able to read this unencrypted metadata.

## Network requests

The wallet connects to nodes you select and to services used for chain discovery. Requests may disclose your IP address, selected chain, queried account addresses, and requested transaction or state identifiers to those operators. When you approve a transaction, the wallet sends its signed transaction to the selected submission endpoint. Transactions admitted to a public blockchain may become public and cannot be erased by uninstalling the wallet.

An authentication cookie is sent only to the node it belongs to when required for authorized requests. Recovery phrases, private keys, and the wallet password are not sent to nodes. Node operators have their own privacy practices.

The wallet declares required network access to exactly rpc.lattice.build, lattice-mainnet-read.fly.dev and lattice-mainnet-testnet.fly.dev over HTTPS. Connecting to these hosted nodes does not require a runtime permission prompt; Chrome may show permissions during installation or upgrade. Other operators require explicit custom-node selection and optional network permission. Previous unrestricted HTTPS grants are revoked on upgrade. Connection settings provide “Remove unused node permissions” for unused optional grants; saved nodes and required hosted origins are retained. Access can also be managed through Chrome's extension settings; removing the extension revokes it. Allowlisting network access does not authenticate an operator's chain data or remove purchase trust acknowledgement.

## Websites and wallet requests

The extension injects a page-world `window.lattice` API and an isolated relay script at document start on HTTPS pages and HTTP pages on localhost and 127.0.0.1. The provider handles requests from the top-level document; iframe requests are refused. Chrome controls whether the scripts may run on a site. This is broader website access than the three hosted-node network permissions and may require consent when installing or upgrading.

The scripts relay wallet API calls and responses; they do not scan page text, forms, or browsing history. The wallet receives the requesting origin from Chrome and displays it in an extension-owned approval window. Pages can detect the provider. A connection requires approval before a site receives a chosen account address. The origin-to-address connection is stored locally outside the encrypted vault, persists across restarts, and lets that origin read its connected address without another prompt, including while the wallet is locked. A site can call `disconnect()` to remove its connection.

Each record-write/payment request and each message-signing request requires a separate approval. Record keys/values, chain, payments, recipients and fees come from the requesting site and are displayed for review. Approved writes are signed and submitted by the wallet to a node; the site receives the transaction identifier, not the signed transaction bytes. Pending page writes store the chain, account, nonce, transaction identifier and node URL locally. Nodes and public chains can receive the records and payments in these transactions.

Approved messages return a public key and signature to the requesting site. Signed message bytes include a distinct message prefix, the requesting origin and the message text. A message signature can prove control of an account to that site; it is not a transaction signature. The wallet does not submit signed messages to a blockchain. Sites receiving addresses, transaction identifiers or signatures have their own privacy practices. Private keys, recovery phrases, vault passwords and node cookies are not given to websites through this API.

## Camera, clipboard, and backups

Camera scanning is initiated by you and processes QR frames locally. The wallet does not upload camera images. Address copying writes the selected address to your clipboard. Files and QR images you import are processed locally. Exported backups are saved or displayed at your request; encrypted backups require their password, while a SeedQR contains an unencrypted recovery phrase. Protect exported files, printed codes, and clipboard contents.

## Publisher collection and sharing

The extension contains no publisher analytics, advertising, or telemetry service. The publisher does not receive your vault or wallet history through the extension, sell user data, use it for advertising, or use it to determine creditworthiness. Data is processed or transmitted only to provide the wallet features you request. Selfhold's use of information complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

Support reports you voluntarily submit to GitHub or another community service are handled by that service and may be public. Never submit recovery phrases, private keys, passwords, authentication cookies, or unredacted backups.

## Retention and deletion

Local data, including site connections and pending page-write metadata, remains in your browser profile until removed. Pending recovery records and confirmed archives are retained to support transaction recovery; dismissal removes selected records. Resetting the vault removes the vault but must not be assumed to remove all settings or recovery metadata. To remove all extension data, uninstall the extension and remove any separately exported backups. Browser backups and copies on other devices are outside the extension's control. Blockchain records remain public according to the chain's retention rules.

## Contact and changes

For privacy questions, contact support@lattice.build or use https://github.com/adalinxx/lattice-wallet/issues without including sensitive information. Security reports should follow SECURITY.md in that repository. Policy changes will be published with an updated effective date.
