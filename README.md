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
- an endpoint **discovered** through a Nexus node you choose, by the SDK's
  `EndpointResolver`: it asks `GET /api/chain/endpoints?chainPath=P/D` one
  level at a time (Nexus → A → B …), never dials a private host, and accepts a
  declared URL only if it serves the block its parent commits. Discovered
  endpoints are labelled *operator-declared, not independently verified*.
  Whether one accepts transactions is its operator's choice
  (`--public-submit`): the wallet submits there only if the host is declared
  for submit **and** its own `GET /api/chain/info` says `acceptsSubmit`.

The choice is saved per chain. Chains are selected by path (`Nexus`,
`Nexus/testnet`, …) from the header.

Reads go through the SDK's `NodeClient` (`/api/state/account`,
`/api/transaction`, `/api/chain/info`, `/api/mempool`, `/api/block`, each with
`?chainPath=`). Submit goes through the SDK's `HTTPTransactionSubmitter`
(`POST /transactions`); a refusal is shown by its name with a plain reading
(`belowMinRelayFee`, `feeTooLow`, `full`, `unknownChain`, …).

### Fees

The fee is yours: there is no fee field and no estimate service. It is the
debit-over-credit excess the miner collects (the SDK's `buildTransfer`).

- Every send has an editable fee field, prefilled with the chain's default.
- Each chain's default fee is set under **Fee** (1 unit until you change it).
- The chosen endpoint reports its own relay floor (`minRelayFee` in
  `/api/chain/info`, its operator's policy, never consensus). A fee below it
  is **warned about, not raised**: the send goes as you set it, and the node
  may refuse it (`belowMinRelayFee`).
- The review screen shows the fee, the total, and the node's minimum.

### Status

A sent transaction reads **included in block N** once the node reports it on
its canonical chain (`blockHeight`/`blockHash`), **pending** while it is in the
node's pool, and *replaced* if its nonce was spent by another transaction.
Only a node too old to report inclusion falls back to the account-nonce
reading (*nonce spent*).

> one proof. every chain.

## Why an extension (not a web page)

A static web wallet re-fetches its code on every load, so a host/DNS/supply-chain
compromise can silently steal keys (how the Bybit ~$1.4B and BadgerDAO ~$120M
thefts happened). MV3 **forbids remote code**, ships a **reviewed bundle frozen
until a signed update**, and isolates the signer from any web page.

## Trustless transactions

The wallet **builds, encodes and signs the transaction locally** with the
[Lattice SDK](https://github.com/adalinxx/lattice-sdk)
(`@adalinxx/lattice-core`): canonical DAG-CBOR, the `bodyCID`, the
`lattice-tx-v1` signing envelope, Ed25519 — it never trusts the node for *what
it signs*. Signing runs only in the background worker. The SDK path is checked
**bit-for-bit** against Lattice's published conformance vectors
(`test/vectors/`, from the Lattice release lattice-node pins;
`test/conformance.ts`): Multikey, address, TransactionBody DAG-CBOR bytes and
CIDs, the envelope, and RFC 8032 signatures, with the negative cases rejected.

## The SDK dependency

The SDK is not published to npm. It is a **git submodule pinned to an exact
commit** (`vendor/lattice-sdk`), and its packages are `file:` dependencies
(`@adalinxx/lattice-core`, `-client`, `-relay`, `-volumes`). `npm ci` runs the
`prepare` script, which installs the SDK from its own lockfile and builds it
(`npm run sdk` does the same by hand, e.g. after `npm ci --ignore-scripts`).
esbuild then inlines it into the extension bundle: no remote code.

To move the pin: `git -C vendor/lattice-sdk fetch && git -C vendor/lattice-sdk
checkout <commit>`, `npm run sdk`, run the gates below, and commit the
submodule change.

## Design

UI follows the Lattice design system
([adalinxx/lattice-design](https://github.com/adalinxx/lattice-design)):
monochrome, monospace, hairlines only, zero accent. Tokens are vendored in
`public/assets/tokens.css`.

## Keys

- **BIP39 mnemonic** + a **frozen SLIP-0010 ed25519 path** `m/44'/7878'/account'`
  (3-level, all hardened; deliberately flattened to avoid path-ambiguity).
  Coin type 7878 and the path are frozen and regression-tested
  (`test/accounts.test.ts`), including a cross-check that the SDK's address
  for each derived key equals the frozen vector.
- **Raw 32-byte key import** for interop with node/miner-generated keypairs.
- Crypto: the Lattice SDK over audited [`@noble`](https://paulmillr.com/noble/)
  / `@scure` libraries, bundled (no CDN).

## Status

**Functional.** End to end:

- Conformance-gated crypto core; HD + raw-key derivation.
- **Encrypted keystore** — Argon2id + AES-256-GCM (PBKDF2-600k fallback),
  persisted in `chrome.storage.local`; wrong password fails closed.
- **Background service-worker signer** — the sole holder of keys; the popup
  exchanges messages and never receives key material. Idle auto-lock.
- **Send** with a per-send fee (per-chain default), nonce from the node, and a
  **clear-sign review** screen; built and signed locally, then submitted to
  the chosen node. Receive, sent-transaction status (block height), lookup,
  multi-account (HD + import), chain selector, lock/unlock.

Tests (`npm test`): conformance vectors through the SDK, frozen derivation
path and SDK address cross-check, keystore round-trip/fail-closed, session
derivation, signed-transfer acceptance rules and exact decimal-string payload,
node URL rules, fees and relay-floor warnings, typed refusals, inclusion
status, discovery through the SDK resolver. Opt-in:

- `LATTICE_NODE_BIN=<lattice-node>/.build/debug node --test test/e2e-local.test.ts`
  starts isolated local nodes (`--no-default-peers`; once with
  `--public-submit --min-relay-fee 1`), funds by mining, sends with custom
  fees, sees `belowMinRelayFee`, and reads the inclusion block.
- `LATTICE_LIVE_READ=https://<read endpoint> node --test test/live-read.test.ts`
  is a read-only smoke (reads plus Nexus/testnet discovery); it never submits.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and the build.

**Next:** cross-chain swaps (deposit/receipt/withdrawal), Ledger (WebHID),
dApp-connect provider.

## Build & load

```sh
git submodule update --init   # the pinned SDK
npm ci                 # pinned deps; `prepare` builds the SDK
npm run typecheck
npm test               # conformance, derivation freeze, wallet logic (must pass)
npm run build          # -> dist/
```

Then load `dist/` as an unpacked extension: `chrome://extensions` → Developer
mode → **Load unpacked** → select `dist/`.

## Security posture

- Strict CSP: `script-src 'self' 'wasm-unsafe-eval'`, no inline, no eval, no
  remote code. `connect-src` is `https:` plus loopback `http:` (your own
  node); the wallet holds no host permission until you choose a node, and then
  asks for that host only (discovery asks once for `https://*/*`).
- Lockfile-pinned deps; the SDK pinned by commit (submodule). With
  `npm ci --ignore-scripts`, run `npm run sdk` to build it.
- Signer isolated in the background worker; popup never receives raw keys (target
  architecture).

## License

MIT — see [LICENSE](LICENSE).
