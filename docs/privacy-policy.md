# Lattice Wallet Privacy Policy

Effective date: October 8, 2026

Lattice Wallet is a non-custodial browser extension maintained by the Lattice project. This policy covers the extension, not third-party nodes, websites, Chrome, or community services.

## Data on your device

The wallet creates or imports recovery phrases and private keys and encrypts its vault before storing it in your browser profile. Node authentication cookies are also kept in the encrypted vault. Your password is used locally to unlock the vault; it is not sent to nodes or the publisher. The unlocked session retains a non-extractable encryption key, not your password. Keys remain available in memory while the signer is unlocked. Locking ends that signing session and wipes mutable secret buffers; JavaScript cannot guarantee erasure of strings or runtime copies.

Addresses, account labels, chain and node choices, fees, transaction history, deposit keys, purchase records, and signed transaction recovery payloads are stored locally outside the encrypted vault. These records contain financial and account information. Signed transactions can be rebroadcast by someone who obtains them; they do not contain private keys. Anyone with access to your browser profile may be able to read this unencrypted metadata.

## Network requests

The wallet connects to nodes you select and to services used for chain discovery. Requests may disclose your IP address, selected chain, queried account addresses, and requested transaction or state identifiers to those operators. When you approve a transaction, the wallet sends its signed transaction to the selected submission endpoint. Transactions admitted to a public blockchain may become public and cannot be erased by uninstalling the wallet.

An authentication cookie is sent only to the node it belongs to when required for authorized requests. Recovery phrases, private keys, and the wallet password are not sent to nodes. Node operators have their own privacy practices.

The wallet declares required network access to exactly rpc.lattice.build, lattice-mainnet-read.fly.dev and lattice-mainnet-testnet.fly.dev over HTTPS. Connecting to these hosted nodes does not require a runtime permission prompt; Chrome may show permissions during installation or upgrade. Other operators require explicit custom-node selection and optional network permission. Previous unrestricted HTTPS grants are revoked on upgrade. Connection settings provide “Remove unused node permissions” for unused optional grants; saved nodes and required hosted origins are retained. Access can also be managed through Chrome's extension settings; removing the extension revokes it. Allowlisting network access does not authenticate an operator's chain data or remove purchase trust acknowledgement.

## Camera, clipboard, and backups

Camera scanning is initiated by you and processes QR frames locally. The wallet does not upload camera images. Address copying writes the selected address to your clipboard. Files and QR images you import are processed locally. Exported backups are saved or displayed at your request; encrypted backups require their password, while a SeedQR contains an unencrypted recovery phrase. Protect exported files, printed codes, and clipboard contents.

## Publisher collection and sharing

The extension contains no publisher analytics, advertising, or telemetry service. The publisher does not receive your vault or wallet history through the extension, sell user data, use it for advertising, or use it to determine creditworthiness. Data is processed or transmitted only to provide the wallet features you request. Lattice Wallet's use of information complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

Support reports you voluntarily submit to GitHub or another community service are handled by that service and may be public. Never submit recovery phrases, private keys, passwords, authentication cookies, or unredacted backups.

## Retention and deletion

Local data remains in your browser profile until removed. Pending recovery records and confirmed archives are retained to support transaction recovery; dismissal removes selected records. Resetting the vault removes the vault but must not be assumed to remove all settings or recovery metadata. To remove all extension data, uninstall the extension and remove any separately exported backups. Browser backups and copies on other devices are outside the extension's control. Blockchain records remain public according to the chain's retention rules.

## Contact and changes

For privacy questions, use https://github.com/adalinxx/lattice-wallet/issues without including sensitive information. Security reports should follow SECURITY.md in that repository. Policy changes will be published with an updated effective date.
