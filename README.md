# Nexus Wallet

A **non-custodial** wallet for **Nexus** — the root chain of the
[Lattice](https://github.com/adalinxx) network — built as a **Manifest V3 browser
extension**. Keys are generated and used **entirely on your device**; the
extension talks directly to a Lattice node's RPC and signs locally.

> one proof. every chain.

## Why an extension (not a web page)

A static web wallet re-fetches its code on every load, so a host/DNS/supply-chain
compromise can silently steal keys (how the Bybit ~$1.4B and BadgerDAO ~$120M
thefts happened). MV3 **forbids remote code**, ships a **reviewed bundle frozen
until a signed update**, and isolates the signer from any web page.

## Trustless transactions

The wallet **builds and serializes the transaction body itself**, computes the
`bodyCID` locally (a faithful port of the node's deterministic DAG-CBOR encoding),
derives the signing preimage, and signs — it never trusts the node for *what it
signs*. The entire crypto path is validated **bit-for-bit** against the node's
published signing vectors (`test/conformance.ts`): multikey public key, address
CID, `bodyCID`, preimage, and signature.

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

**v0 (this commit):** proven crypto core (conformance-gated), HD + raw-key
derivation, multi-node RPC client with failover, MV3 manifest with strict CSP, and
a styled popup slice (create/import → receive address + live balance, network
switch). Keys are **in memory only** in v0.

**Next:** encrypted keystore (Argon2id + AES-GCM) with persistence, background
service-worker signer, send + clear-sign review, transaction history. See the
plan for the full roadmap.

## Build & load

```sh
npm ci                 # install pinned, audited deps
npm test               # crypto conformance + derivation regression (must pass)
node build.mjs         # -> dist/
```

Then load `dist/` as an unpacked extension: `chrome://extensions` → Developer
mode → **Load unpacked** → select `dist/`.

## Security posture

- Strict CSP: `script-src 'self' 'wasm-unsafe-eval'`, `connect-src` limited to the
  node hosts, no inline, no eval, no remote code.
- Vendored + lockfile-pinned deps; `npm ci --ignore-scripts`.
- Signer isolated in the background worker; popup never receives raw keys (target
  architecture).

## License

MIT — see [LICENSE](LICENSE).
