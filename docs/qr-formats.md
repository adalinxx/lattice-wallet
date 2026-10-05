# Backup and transfer formats

Three QR payloads, all [Uniform Resources](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-005-ur.md)
(UR, BCR-2020-005) with [Bytewords minimal](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-012-bytewords.md)
bodies, plus SeedSigner's SeedQR. The UR encoder, the fountain code and the
decoder are `src/lib/qr/ur.ts`, byte-for-byte compatible with the reference
(test/vectors/ur.json, including BCR-2020-005's published `ur:bytes/1-9` part).

A payload whose single-part UR is at most 500 characters is shown as one QR.
A longer one is shown as an animated multi-part UR (`ur:<type>/<seq>-<len>/…`,
120-byte fragments, a frame every 300 ms): parts 1…len are the plain
fragments, later parts are fountain-coded XOR mixes, so a scanner that drops
frames still completes. QR codes carry the UR uppercased (alphanumeric mode),
error correction L. All CBOR below is canonical (definite lengths, integer map
keys in ascending order); every map has key 1 = version (1).

## `ur:lattice-vault` — encrypted wallet backup

The vault's contents re-encrypted with the wallet password, in the keystore's
own scheme (`src/lib/crypto/keystore.ts`):

| key | value |
| --- | --- |
| 1 | version: `1` |
| 2 | KDF: `1` = Argon2id, `2` = PBKDF2-HMAC-SHA256 |
| 3 | KDF parameters: Argon2id `[memoryKiB, iterations, parallelism]` (today `[19456, 2, 1]`); PBKDF2 `[iterations]` (600000) |
| 4 | salt (16 bytes) |
| 5 | AES-256-GCM IV (12 bytes) |
| 6 | AES-256-GCM ciphertext + 16-byte tag |

The 32-byte AES key is the KDF output over the password and salt. The
plaintext is UTF-8 JSON: `{ mnemonic: string | null, hd: [{ index, label }],
imported: [{ priv: hex, label }], active, nodeCookies? }`. `nodeCookies` (the
operator-port cookies of paired nodes) is present only when the user opts in.
A decoder refuses KDF costs above Argon2id m = 256 MiB, t = 10, p = 4 or
PBKDF2 10M iterations, and validates every decrypted field.

Saved as a file it is a text file whose non-comment line is the single-part
UR. Printed, it is the plain fragments (1…len) as a grid; scanning all of
them, in any order, completes it.

## `ur:lattice-pair` — a receiver's one-time pairing offer

| key | value |
| --- | --- |
| 1 | version: `1` |
| 2 | session id (8 random bytes) |
| 3 | receiver's one-time X25519 public key R (32 bytes) |
| 4 | expiry, Unix seconds (now + 300) |

## `ur:lattice-transfer` — the sealed transfer

| key | value |
| --- | --- |
| 1 | version: `1` |
| 2 | session id (from the offer) |
| 3 | sender's one-time X25519 public key S (32 bytes) |
| 4 | AES-256-GCM IV (12 bytes) |
| 5 | AES-256-GCM ciphertext + tag |

    transcript = "lattice-transfer-v1" ‖ 0x01 ‖ sid ‖ R ‖ S
    shared     = X25519(s, R) = X25519(r, S)      (all-zero refused)
    salt       = SHA-256(transcript)
    key        = HKDF-SHA256(shared, salt, "lattice-transfer-v1 key", 32)
    sas        = HKDF-SHA256(shared, salt, "lattice-transfer-v1 sas", 4)
                 as big-endian uint32 mod 1 000 000, six digits
    ciphertext = AES-256-GCM(key, iv, plaintext, aad = transcript)

The plaintext is a `ur:lattice-vault` CBOR (above, without node cookies),
encrypted with the sending wallet's password. The receiver's secret r lives
only in its signer, is used for one open attempt (good or bad) and is
discarded; an offer past its expiry is refused by both sides.

Both screens show the six-digit code; the receiver imports only after the user
confirms they match, and then needs the sending wallet's password. The code is
20 bits, so an active attacker who can swap both QR codes could search for a
colliding one; the password layer is why that only ever yields what an
encrypted backup QR would (an Argon2id-protected blob), never the keys. The
ECDH layer keeps the transfer unreadable to anyone who merely films it.

## SeedQR (SeedSigner)

For the recovery phrase only (12 or 24 English words), per
[SeedSigner's spec](https://github.com/SeedSigner/seedsigner/blob/dev/docs/seed_qr/README.md):
**Standard** is each word's 0-based BIP39 index as four digits (numeric mode;
25×25 for 12 words, 29×29 for 24); **Compact** is the raw entropy, 16 or 32
bytes (byte mode; 21×21 / 25×25). Error correction L. Tested against the
spec's four vectors. The QR is rendered to SVG inside the signer after the
password is re-entered; the phrase itself never reaches the page.
