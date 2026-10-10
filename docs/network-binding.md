# Networks, chain paths, and replay

Lattice signs the complete transaction body, absolute chain path, and account nonce. A transaction for Nexus/testnet cannot be changed into a transaction for Nexus or Nexus/payments without invalidating the signature.

The current signing format does not include a network or genesis identifier. Separate networks or forks with the same chain path may accept the same signed transaction when its account nonce, balances, policies and other validity conditions match. Someone operating a development network can obtain a payment you approve there and submit the unchanged bytes to another network. They cannot change its recipient or amount.

Use separate keys for separate networks. A child named testnet within the Nexus hierarchy is already distinguished from Nexus by its path; a separate network also naming its root Nexus is a different case. Endpoint names and wallet labels alone do not prevent replay. Verifying an expected genesis helps identify the network but does not bind already-signed bytes to it.

Transactions need not have on-chain expiry to be safe. Preserve signed recovery records after network errors or refusals: a gateway may admit the transaction before returning an error. Rebroadcast the exact saved bytes to retry. Creating a new payment with a later nonce can pay twice if the first payment confirms. The wallet warns when the account has unresolved transfers and requires an explicit decision before signing another one.

Specification: https://github.com/adalinxx/Lattice/blob/43.1.0/docs/spec.md#71-signature-verification
