# PhIP Test Vectors

Language-agnostic fixtures for implementing a PhIP client library in any
language. Every fixture here is reproducible from two fixed Ed25519 keypairs
and the RFC 8785 (JCS) canonicalization algorithm — if your implementation
produces byte-identical output on these inputs, it is wire-compatible with
the reference implementation.

## Directory layout

| Path                           | Covers                                          |
| ------------------------------ | ----------------------------------------------- |
| `ed25519/keypair.json`         | Fixed test keypairs (PKCS#8 DER and raw-32)     |
| `jcs/cases.json`               | RFC 8785 canonical serialization                |
| `hash/cases.json`              | SHA-256 + `sha256:` prefix (Section 10.3)       |
| `ed25519/cases.json`           | Raw-byte and event signing (Section 11.1)       |
| `uri/cases.json`               | URI parsing (Section 4)                         |
| `hashchain/sequence.json`      | Hash-chain continuity (Section 10.3)            |
| `lifecycle/manufacturing.json` | Manufacturing track transitions (Section 9.2)   |
| `lifecycle/operational.json`   | Operational track transitions (Section 9.3)     |
| `bootstrap/example.json`       | Self-signed bootstrap key (Section 11.2.4)      |

## How to consume

Each fixture is plain JSON. Load the file, iterate the `cases` (or other
top-level array), and assert your implementation's output equals the expected
field. For signature vectors, both *produce* and *verify* paths should be
tested:

* **Produce**: given the private key and input bytes, your `sign()` MUST
  return `signature_b64url` (Ed25519 is deterministic per RFC 8032, so there
  is exactly one correct signature).
* **Verify**: given the public key, input bytes, and signature, your
  `verify()` MUST return true.

For JCS vectors, check both the string output (`canonical`) and the UTF-8
byte encoding (`canonical_bytes_hex`) — mismatched string handling (e.g.
UTF-16 vs UTF-8) will only show up in the byte check.

## Regenerating

```
npm install
node vectors/generate.js
```

The generator is deterministic. Regenerate whenever the spec changes any
wire-visible behavior (canonicalization rules, hash format, signature
scheme, lifecycle tables) and re-run `self-check.js` to confirm internal
consistency.

## Self-check

```
node vectors/self-check.js
```

This runs the same checks a client-library conformance test would run, but
using only the committed fixtures and Node's built-in crypto + the
`canonicalize` npm package. If this passes, the committed vectors are
internally consistent and any client implementation producing identical
output is byte-compatible.
