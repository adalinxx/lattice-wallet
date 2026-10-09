# Independent security review brief

Target: reviewed Lattice Wallet commit and its SHA-256 release package, with the exact recorded lattice-sdk revision. Source: https://github.com/adalinxx/lattice-wallet

Review boundaries: popup to background signer; encrypted vault to settings; untrusted node to verified proof; parent commitment to child state; imported order/QR/file to signing; storage across multiple wallet pages; backup and device transfer.

Assess password derivation, AEAD validation, unlocked-memory lifetime, auto-lock, secret export reauthentication, malformed backup resource bounds, signer message authorization, amount/nonce bounds, fee replacement, exact resubmission, concurrent saves, receipt/deposit ownership, tip anchoring, witness completeness, and retention of ambiguous attempts. Include extension CSP, dependency provenance, and host permissions.

Use disposable keys and isolated nodes. Exercise rejection cases and recovery after network timeout, proxy refusal, node pruning, stale tips, permission-popup closure, browser restart and upgrade. Explain any protocol assumption against the corresponding Lattice specification.

Deliver findings with affected commit, severity, reproduction, fund/record impact, recommended fix and retest result. Produce a public summary with disclosure limitations; do not claim certification. All blocking fund-loss, secret-exposure and unverifiable-state issues must be resolved before public launch.
