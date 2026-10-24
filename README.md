# Selfhold

Selfhold is the wallet for Lattice, previously named Lattice Wallet. Existing installations update through the same Chrome Web Store item.

See [network binding and replay](docs/network-binding.md) before reusing keys on separate networks.

Release materials: [release procedure](docs/release.md), [privacy policy](docs/privacy-policy.md), [store listing](docs/store-listing.md), and [verification evidence](docs/release-verification.md). Report vulnerabilities through [SECURITY.md](SECURITY.md).

A **self-custodial** wallet for the [Lattice](https://github.com/adalinxx)
network, including its **Nexus** root chain and child chains, built as
a **Manifest V3 browser extension**. Keys are generated and used **entirely on
your device**; the extension talks directly to a node **you choose** and signs
locally.

## Nodes: you choose

Nothing is selected until you choose it. On first use the wallet asks for a
node per chain:

- a **hosted Lattice node** — `rpc.lattice.build` for Nexus, and the hosted
  testnet node. The wallet declares these origins (`rpc.lattice.build`,
  `lattice-mainnet-read.fly.dev`, the backbones `lattice-mainnet-iad`,
  `-ams` and `-sjc.fly.dev`, and `lattice-mainnet-testnet.fly.dev`) as
  required host permissions so choosing them needs no further prompt; it
  still contacts none of them until you pick one or ask for automatic
  discovery. Automatic discovery starts from the read node and the backbones
  in turns, and picks a chain's node at random among the hosts that accept
  submits, so wallets spread over them; or
- **your own node** — its loopback API (`http://127.0.0.1:<rpc-port>`)
  accepts your submits once the wallet is **paired** with it (below); or
- an endpoint **discovered** through a Nexus node you choose, by the SDK's
  `EndpointResolver`: it asks `GET /api/chain/endpoints?chainPath=P/D` one
  level at a time (Nexus → A → B …), never dials a private host, and accepts a
  declared URL only if it serves that chain path (its `GET /api/chain/info`
  names it, with a tip) on the starting node's network (its
  `GET /api/chain/genesis` names the same Nexus genesis). What a parent chain
  commits does not decide. Accepted hosts keep their declared order. Discovered
  endpoints are labelled *operator-declared, not independently verified*.
  The first discovery asks Chrome to let the wallet reach any HTTPS node: the
  hosts it checks are named by the nodes one level up, so they cannot be
  listed before it starts.
  Whether one accepts transactions is its operator's choice
  (`--public-submit`): the wallet submits there only if the host is declared
  for submit **and** its own `GET /api/chain/info` says `acceptsSubmit`.

### Pairing with your own node

A node's loopback operator port refuses browser origins it does not list and
every request without its cookie (bitcoind-style). On the Node screen the
wallet shows the exact line to add to `lattice.json` in the node's root, with
this extension's id:

```json
"rpcAllowedOrigins": ["chrome-extension://<extension id>"]
```

Restart the node (`lattice down`, `lattice up`), then paste the content of
`<root>/chains/Nexus/.cookie`. The cookie is kept inside the encrypted vault,
beside the keys, and sent only to that node URL. The node writes a new cookie
at every start: paste it again after a restart (a refused read says so).

The choice is saved per chain. Chains are selected by path (`Nexus`,
`Nexus/testnet`, …) from the header.

Reads go through the SDK's `NodeClient` (`/api/state/account`,
`/api/transaction`, `/api/chain/info`, `/api/mempool`, `/api/block`, each with
`?chainPath=`). Submit goes through the SDK's `HTTPTransactionSubmitter`
(`POST /transactions`); a refusal is shown by its name with a plain reading
(`belowMinRelayFee`, `feeTooLow`, `full`, `unknownChain`, …).

### Fees

The fee is yours: there is no estimate service. It is the debit-over-credit
excess the miner collects (the SDK's `buildTransfer`).

- Each chain's default fee is set under **Default fee** (0 until you change
  it). Consensus accepts a zero fee; whether a node relays it is its
  operator's policy.
- The send screen states the fee in one line, with how long recent blocks
  have taken (four in five of the last 25 came within that time). The field
  stays editable under **Custom fee**.
- The chosen endpoint reports its own relay floor (`minRelayFee` in
  `/api/chain/info`, its operator's policy, never consensus). A fee below it
  is **warned about, not raised**: the send goes as you set it, and the node
  may refuse it (`belowMinRelayFee`). The hosted nodes' floor is 1.
- The review screen shows the fee, the total, and the node's minimum, and
  warns when the fee is at least half the amount.
- **Increase fee** on a pending send starts a quarter above the previous fee
  (at least 1 more). Miners rank by fee per byte and a replacement is the same
  size, so +1 on a large fee rarely moves it up.

### Status

A sent transaction reads **included in block N** once the node reports it on
its canonical chain (`blockHeight`/`blockHash`), **pending** while it is in the
node's pool, and *replaced* if its nonce was spent by another transaction.
If transaction history is unavailable but the account nonce advanced, the
result remains explicitly unknown rather than being treated as final.

The exact signed bytes for ordinary transfers with no final chain outcome are
kept in a separate, unbounded `pendingSubmissions` list. The 50-item sent list
is display history only and cannot delete recovery material. Settings exposes
pending transactions for status checks and immediate exact-byte resubmission.
At six confirmations, active recovery moves into a confirmed
archive instead of being destroyed; every recovery record also has an explicit,
confirmed **Dismiss** action for cases no endpoint can settle. Every submission
error retains the signed record: even a refusal can follow admission by an
upstream node. Check or resubmit the exact transaction before creating another
payment. The wallet requires an explicit acknowledgement when the account has
unresolved transfers.

### Cross-chain deposits

The wallet saves every signed, unwithdrawn sell deposit in a separate unbounded
`openDeposits` list before attempting submission. A buy request names the exact
sell deposits to buy (`orderType: "take"`); the wallet chooses none itself. It
proves each named deposit in the child state with the stated amount, refuses the
whole request if any is missing or already receipted, signs one parent payment
for all of them, and persists the exact signed receipt and child withdrawal in
`openPurchases`.
Withdrawal records retain every attempt and its signed nonce. A node-reported
inclusion is displayed but does not immediately delete recovery state.
Automatic completion moves a purchase into the confirmed archive only when one
of this wallet's withdrawal CIDs has six confirmations and targeted proofs show
that every claimed deposit is `0` at the
parent-committed child tip. A generic spent marker alone cannot identify who
withdrew it. Nodes without `/api/deposit-state` leave the record available for
recovery or explicit dismissal.
Until then, an uncertain network response can be recovered by resubmitting the
identical transaction rather than signing a second payment or claim. Deposit recovery checks
targeted proof-backed state instead of scanning discovery pages, because a node may prune
the original transaction while its locked deposit remains active. A refusal to
rebroadcast never deletes that deposit key. Only an explicit fee-floor refusal
(`belowMinRelayFee` or `feeTooLow`) offers a higher-fee replacement with the same account nonce and claim,
without forgetting earlier transaction CIDs. This local metadata is not
reconstructed by restoring a recovery phrase; seed-only recovery still needs
chain scanning.

> one proof. every chain.

## Web pages: `window.lattice`

A web page can ask the wallet for an address, ask it to sign writes of
records that may also pay addresses, and ask it to sign a message. The
wallet adds `window.lattice` to HTTPS pages and HTTP localhost/127.0.0.1 pages, subject to Chrome site access:

```js
const address = await lattice.connect(); // from a click; asks the person once per site
const { transactionCID } = await lattice.writeRecords({
  chainPath: ["Nexus", "stoa"],
  actions: [{ key: "profile/<address>", newValue: "{\"name\":\"Alice\"}" }],
  fee: "1", // decimal string
});

// A write that also pays, in the same transaction (a ticket and its price):
await lattice.writeRecords({
  chainPath: ["Nexus", "fanfare", "band"],
  actions: [{ key: "own/<artist>/berlin/A12", oldValue: "<holder>@250", newValue: "<buyer>" }],
  payments: [{ to: "<holder>", amount: "250" }],
  fee: "1",
});

// A message: signed as "lattice-message:" + the page's origin + "\n" + text.
const { publicKey, signature } = await lattice.signMessage({ text: "door check 7f3c…" });
```

`lattice.address()` returns the site's address without asking (or null), and
`lattice.disconnect()` forgets the site.

### Requests: `lattice://write`

A write can also travel as a request, for whichever account the person
chooses. A page hands it over with `lattice.openRequest(uri)`, from a click and
with no `connect()`. Or anyone opens it in the wallet's **Open request**
screen by scanning its QR code, loading its image, or pasting its text. That
is the same screen that opens `lattice://order`.

```js
// lattice://write?v=1&intent=<base64url JSON>
{
  "version": 1,
  "chainPath": ["Nexus", "moniker"],
  "actions": [
    { "key": "name/rae", "newValue": "{account}" },
    { "key": "user/{account}/profile", "newValue": "{\"handle\":\"rae\"}", "ifAbsent": true }
  ],
  "payments": [],            // optional, as for writeRecords
  "fee": "0",                // optional: proposed, shown in review; else the wallet's default
  "expiresAt": "2026-10-20T18:15:00Z",
  "label": "Buy @rae"        // optional, quoted as the request's own words
}
const { transactionCID } = await lattice.openRequest(uri);
```

- `{account}` in a key or a new value stands for the account the person
  chooses in the window, where the request is reviewed like any write. It may
  not appear in an old value or a payee.
- An action with `ifAbsent` writes its key only if the key holds nothing. The
  window reads that from your node, checking each step against its CID, and
  names any record it leaves out. If the key appears before the write lands,
  the chain refuses the whole write.
- The request is untrusted data. It carries no keys, nonces or node
  addresses, and the wallet refuses it after `expiresAt` and when it would pay
  the chosen account.

- **Every write is approved, and shown as what it does to you.** Each
  `writeRecords` opens the wallet's own window. It leads with what you pay
  (payments plus fee, on the chain's coin, from which account), each part
  of it, and your balance after; then each record, was → now. Addresses the
  wallet knows appear as names in an inverted tag (*you*, *payee*, an
  account's label), which no text from a page can look like. A payee is
  "named in" the record whose old value holds its address (the chain refuses
  a write whose old value is stale); a payee no record names is shown whole,
  in groups of four, with a warning beside it, and listed first. Full
  addresses, the records as sent and the nonce are under Details. The
  approving button names what it does ("Pay 251", "Sign write") and stays
  off, saying why, until the account, read from your node, covers the debit,
  and until everything that decides the request has been on screen: what
  does not fit must be scrolled to (the bar offers a way down), so nothing a
  page puts below the fold is approved unseen. There are no standing
  allowances.
- **Records, payments and a fee, nothing else.** The wallet builds the
  transaction: the records, a debit of the connected account for the
  payments plus the fee, a credit to each payee, and that account as the
  only signer. Coin leaves only the connected account. A payee is a
  canonical address other than that account, each once, each amount above
  zero (at most 16 payments). The page chose who is paid; the window says so.
- **Messages cannot be transactions.** `signMessage` signs
  `lattice-message:` + the page's origin + a newline + the text with the
  connected account's key, after the person approves it with the full text
  shown (a long one must be scrolled to its end). A message naming another site (in a URL, or a "… wants you to sign
  in" line) gets a warning. A transaction's signed bytes start `lattice-tx-v1:`, so no message
  signature passes for one, and a verifier rebuilds the bytes with the
  origin it expects, so a signature taken on one site fails on another. The
  text is at most 4 KiB of printable characters and line breaks. The page
  gets the public key (Multikey hex) and the signature (hex), and checks the
  key belongs to the address it cares about.
- **The wallet chooses the nonce.** The approval window reads the account
  from the person's own nodes (the one chosen for the chain or an ancestor,
  else one discovered from their Nexus node, once they allow it) and moves
  past every transaction the wallet knows is pending there (sends, deposits,
  receipts, withdrawals, page writes), so a page cannot
  take the nonce of a pending transaction and cancel it.
- **One request at a time per site**, and the approving button wakes a moment
  after the window is seen, so a click aimed elsewhere cannot land on it.
- **The site is the one Chrome reports.** The worker takes the origin from
  the tab's top frame, not from the page; iframes are not answered.
- **The wallet submits.** It sends the write to the node it read the nonce
  from, so a page never holds a signed write it could send later against
  the person's next transaction. The page gets the transaction's CID.
- **Connecting needs a click.** `connect()` is answered only during a click
  or key press the person just made (pages call `address()` on load), and a
  site whose request was declined waits a few seconds before asking again.

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
- **Encrypted keystore** — Argon2id (64 MiB, 3 passes) + AES-256-GCM; legacy PBKDF2 vaults remain readable, but new encryption never silently falls back,
  persisted in `chrome.storage.local`; wrong password fails closed.
- **Background service-worker signer** — the sole holder of keys; the popup
  exchanges messages and never receives key material. Idle auto-lock.
- **Send** with a per-send fee (per-chain default), nonce from the node, and a
  **clear-sign review** screen; built and signed locally, then submitted to
  the chosen node. Receive, sent-transaction status (block height), lookup,
  multi-account (HD + import, incl. `lattice key generate` key files), chain
  selector, lock/unlock.
- **Shared with the desktop app** — the UI (`src/popup/app.ts`, started with a
  `Platform`) and the signer (`src/lib/wallet/signer.ts`, over a
  `VaultStorage`) are host-agnostic; `popup.ts` and `service-worker.ts` bind
  them to the extension. The desktop app binds them to its own node, a
  loopback-only fetch, and its own files.

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

### Backup & transfer

From **Backup** (unlocked) or **Restore** (first run). In the extension these
open in a tab of the wallet: a tab can hold the camera, pick files and print,
a popup cannot. Every export asks for the password again.

- **Encrypted backup** — the recovery phrase, imported keys and labels (node
  cookies only if you tick it), encrypted with your password, as a QR
  (animated when large), a text file, or a printed sheet. Restore it on a new
  device, or merge it into / replace an open wallet.
- **SeedQR** — the recovery phrase as a Standard or Compact SeedQR, full screen
  behind strong warnings, cleared on close, printable. Scanning one restores
  the phrase; you then set a new password.
- **Send to / receive from another device** — the receiver shows a one-time
  pairing QR, the sender scans it and shows the encrypted wallet as an
  (animated) QR; both show a six-digit code to compare. No network.

Formats: [docs/qr-formats.md](docs/qr-formats.md). QR encoding, decoding and
camera handling are paulmillr's [`qr`](https://github.com/paulmillr/qr) (no
dependencies); X25519 is `@noble/curves`; HKDF/SHA-256 `@noble/hashes`;
AES-GCM is WebCrypto. All bundled.

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

Read [node trust and purchase safety](docs/node-trust.md) before using cross-chain orders. Buys through any node that is not on this computer require explicit trust acknowledgement for the displayed operators on each purchase review, whether or not a cookie is stored for it. Paired/own-node mode also relies on your node's honesty. State witnesses alone do not prove a canonical tip.

- Strict CSP: `script-src 'self' 'wasm-unsafe-eval'`, no inline, no eval, no
  remote code. `connect-src` is `https:` plus loopback `http:` (your own
  node). The three exact hosted Lattice node origins are declared as required
  host permissions, avoiding connection-time prompts for those nodes. A custom
  node is granted by its own host. Automatic discovery asks once for the
  optional grant to every HTTPS host, since each level's nodes are declared by
  the level above as it walks; that grant is kept while automatic mode is on.
  DNS rebinding of public host
  names cannot be excluded by a browser-only client; discovery sends no cookies.
- Lockfile-pinned deps; the SDK pinned by commit (submodule). With
  `npm ci --ignore-scripts`, run `npm run sdk` to build it.
- Signer isolated in the background worker; popup never receives raw keys (target
  architecture).

## License

MIT — see [LICENSE](LICENSE).
