# Nexus Wallet

A **non-custodial** wallet for **Nexus** — the root chain of the
[Lattice](https://github.com/adalinxx) network — and its child chains, built as
a **Manifest V3 browser extension**. Keys are generated and used **entirely on
your device**; the extension talks directly to a node **you choose** and signs
locally.

## Nodes: you choose, there is no default

The wallet ships with **no node URL**. On first use it asks for one per chain:

- **your own node** — its loopback API (`http://127.0.0.1:<rpc-port>`)
  accepts your submits; or
- an endpoint **discovered** through a Nexus node you choose: the wallet asks
  `GET /api/chain/endpoints?chainPath=P/D` one level at a time (Nexus → A →
  B …), and accepts a declared URL only if it serves the block its parent
  commits. Discovered endpoints are operator-declared and **not independently
  verified**. Whether one accepts transactions is its operator's choice
  (`--public-submit`); the wallet confirms it from that endpoint's own
  `GET /api/chain/info` (`acceptsSubmit`).

The choice is saved per chain. Chains are selected by path (`Nexus`,
`Nexus/testnet`, …) from the header.

Reads: `GET /api/state/account/:addr` (balance, nonce) and
`GET /api/transaction/:cid`, each with `?chainPath=`. Submit:
`POST /transactions`; a refusal is shown in the node's own words
(`feeTooLow`, `full`, `unknownChain`, …). The fee is yours to set (default 1
unit; it is the debit-over-credit excess, there is no fee field and no
estimate route).

> one proof. every chain.

## Why an extension (not a web page)

A static web wallet re-fetches its code on every load, so a host/DNS/supply-chain
compromise can silently steal keys (how the Bybit ~$1.4B and BadgerDAO ~$120M
thefts happened). MV3 **forbids remote code**, ships a **reviewed bundle frozen
until a signed update**, and isolates the signer from any web page.

## Trustless transactions

The wallet **builds and serializes the transaction body itself**, computes the
`bodyCID` locally (a faithful port of the node's deterministic DAG-CBOR encoding),
derives the `lattice-tx-v1` signing envelope (the only signing form since
Lattice 44), and signs — it never trusts the node for *what it signs*. The
crypto path is validated **bit-for-bit** against Lattice's published
conformance vectors (`test/vectors/`, from the Lattice release lattice-node
pins; `test/conformance.ts`): Multikey, address, TransactionBody DAG-CBOR bytes
and CIDs, the envelope, and RFC 8032 signatures, with the negative cases
rejected.

## Design

UI follows the Lattice design system
([adalinxx/lattice-design](https://github.com/adalinxx/lattice-design)):
monochrome, monospace, hairlines only, zero accent. Tokens are vendored in
`public/assets/tokens.css`.

## Keys

- **BIP39 mnemonic** + a **frozen SLIP-0010 ed25519 path** `m/44'/7878'/account'`
  (3-level, all hardened; deliberately flattened to avoid path-ambiguity).
  The path is frozen and regression-tested (`test/accounts.test.ts`).
- **Raw 32-byte key import** for interop with node/miner-generated keypairs.
- Crypto: audited [`@noble`](https://paulmillr.com/noble/) / `@scure` libraries,
  bundled (no CDN).

## Status

**Functional.** End to end:

- Conformance-gated crypto core; HD + raw-key derivation.
- **Encrypted keystore** — Argon2id + AES-256-GCM (PBKDF2-600k fallback),
  persisted in `chrome.storage.local`; wrong password fails closed.
- **Background service-worker signer** — the sole holder of keys; the popup
  exchanges messages and never receives key material. Idle auto-lock.
- **Send** with a user-set fee, nonce from the node, and a **clear-sign review**
  screen; built and signed locally, then submitted to the chosen node.
  Receive, sent-transaction status, transaction lookup, multi-account
  (HD + import), chain selector, lock/unlock.

Sent-transaction status: the node keeps no transaction-to-block index, so a
sent transaction reads `pending` while in the pool and `nonce spent` once the
account's nonce passes it.

Tests: conformance vectors, derivation freeze, keystore round-trip/fail-closed,
session derivation, transfer acceptance rules and exact-integer submit JSON,
node URL rules, client refusals, recursive discovery (`npm test`).
`test/e2e-local.test.ts` runs the wallet against a local node (skipped unless
`LATTICE_E2E_RPC` is set; see the file). `npm run typecheck` is clean.

**Next:** cross-chain swaps (deposit/receipt/withdrawal), Ledger (WebHID),
dApp-connect provider.

## Build & load

```sh
npm ci                 # install pinned, audited deps
npm test               # crypto conformance + derivation regression (must pass)
node build.mjs         # -> dist/
```

Then load `dist/` as an unpacked extension: `chrome://extensions` → Developer
mode → **Load unpacked** → select `dist/`.

## Security posture

- Strict CSP: `script-src 'self' 'wasm-unsafe-eval'`, no inline, no eval, no
  remote code. `connect-src` is `https:` plus loopback `http:` (your own
  node); the wallet holds no host permission until you choose a node, and then
  asks for that host only (discovery asks once for `https://*/*`).
- Vendored + lockfile-pinned deps; `npm ci --ignore-scripts`.
- Signer isolated in the background worker; popup never receives raw keys (target
  architecture).

## License

MIT — see [LICENSE](LICENSE).
