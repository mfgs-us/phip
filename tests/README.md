# PhIP Tests

Interop prerequisites for client-library implementations (`phip-js`,
`phip-py`, and any other language).

## Structure

* [`vectors/`](./vectors/) — language-agnostic fixtures. Any client library
  that produces byte-identical output on these inputs is wire-compatible
  with the reference implementation. Covers JCS canonicalization, SHA-256
  hashing, Ed25519 sign/verify, URI parsing, hash-chain continuity,
  lifecycle transitions, and the self-signed bootstrap key pattern.

* [`conformance/`](./conformance/) — black-box HTTP suite for PhIP servers.
  Runs CREATE, GET, PUSH, QUERY, `/history/`, and error-envelope tests
  against any server under `/.well-known/phip/*`.

## Installation

```
npm install
```

## Running

Regenerate the vectors and verify their internal consistency:

```
npm run generate
npm run self-check
```

Run the HTTP conformance suite against a server:

```
npm run conformance -- http://127.0.0.1:8080 --authority example.com
```

## Why these exist

Without shared fixtures and an HTTP-level conformance suite, two
independently written client libraries will each pass their own tests
while silently disagreeing on the wire — different key orderings in JCS,
different signature encodings, different error codes. These tests lock
down the wire contract so that `phip-js` and `phip-py` can be trusted to
talk to the same server and see the same bytes.
