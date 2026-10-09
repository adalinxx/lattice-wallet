# Node trust and purchase safety

The wallet checks content-addressed state witnesses against the block supplied by the node. This verifies the witness's internal consistency. It is not independent header-chain, proof-of-work or finality verification. Balance, nonce, transaction inclusion and discovery answers still depend on the chosen operator. Agreement between two URLs is not proof of independent operators.

Public-node purchases are disabled until a canonical root can be independently established. Purchase review requires the desktop's own-node mode or explicit pairing of both parent and child nodes. Pairing authenticates access; it does not establish consensus. Use nodes you operate and trust. The current parent-to-child lookup is operator-supplied JSON; this restriction also covers that lookup rather than pretending it is an authenticated commitment.

Saved signed transactions remain recoverable after all submission errors, including HTTP refusals. A refusal describes the latest delivery, not whether an earlier delivery was admitted. Exact rebroadcast reuses the account nonce and CID. A newly signed payment at a later nonce is a different payment and may pay twice. Pending transfers prompt for a separate acknowledgement before signing another payment.

Depth-based completion moves recovery payloads into local confirmed archives; it does not erase them. A node's inclusion answer can be wrong or reorged. Manual dismissal remains a deliberate loss of local recovery data, not cancellation of a signed transaction. Seed-only restoration cannot recover these records without node-side discovery.

Market selection stops at offers priced more than 5% above the best eligible offer. Review shows each selected parent/child amount; the budget need not be fully spent. Offers are rechecked unchanged before signing. This protects against marginal bait prices, not against a wholly dishonest order book or an economically bad best price. Always review the displayed terms.

See [network binding](network-binding.md) for same-path replay across separate networks. No protocol change or expiry field is introduced by these wallet changes.
