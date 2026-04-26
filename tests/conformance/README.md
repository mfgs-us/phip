# @phip/conformance

A black-box test suite for PhIP servers. Any implementation that passes this
suite against an empty namespace is wire-compatible with the reference
resolver for the v0.1 scope: CREATE, GET, PUSH, QUERY, `/history/`, batch
operations, `/meta`, `phip:access` enforcement, capability tokens, and
error envelopes.

## Install

```
npm install -g @phip/conformance
```

Or run directly from a clone of the [phip repo](https://github.com/mfgs-us/phip):

```
node tests/conformance/run.js <base-url>
```

## Usage

```
phip-conformance <base-url> [--namespace <ns>] [--authority <auth>]
```

Example against a local reference server bound to `acme.example`:

```
PHIP_AUTHORITY=acme.example PHIP_PORT=8080 node reference/src/index.js &
phip-conformance http://127.0.0.1:8080 --authority acme.example
```

* `<base-url>` — where the server is reachable over HTTP(S).
* `--authority` — the PhIP authority the server is bound to. Defaults to
  the hostname from `<base-url>`. Override when the network address and the
  logical authority differ (reverse proxies, port forwarding, test harnesses).
* `--namespace` — the namespace to create objects under. Defaults to
  `conformance`.

Each run generates a fresh 8-character run-id and suffixes every object id
with it, so the suite can be executed repeatedly against the same server
without CREATE collisions.

## What it tests

| # | Section  | Behaviour                                                   |
|---|----------|-------------------------------------------------------------|
| 1 | 11.2.4   | Self-signed bootstrap actor CREATE                          |
| 2 | 12.1     | CREATE component in concept state                           |
| 3 | 12.2     | GET projects `phip_id`, `state`, `history_length`, head     |
| 4 | 12.3, 9  | PUSH `state_transition` concept → design                    |
| 5 | 12.3     | PUSH `attribute_update` into `phip:software`                |
| 6 | 9.2.1    | Invalid transition rejected with `INVALID_TRANSITION`       |
| 7 | 12.3.1   | Stale `previous_hash` → 409 `CHAIN_CONFLICT` with head      |
| 8 | 12.2.1   | `/history/` returns all events with verifiable chain        |
| 9 | 12.4     | QUERY by `object_type` and by `state`                       |
| 10| 12.5     | `OBJECT_NOT_FOUND`, `OBJECT_EXISTS` envelopes               |

The suite signs all events with the first fixed Ed25519 keypair from
`vectors/ed25519/keypair.json` — the server therefore only needs to verify
signatures, not hold any credentials of its own.

## Out of scope for v0.1

* Cross-authority GET (resolver discovery — Section 4.3, currently `[TODO]`)
* Capability tokens (Section 11.3) — v0 is intra-namespace only
* Pagination cursor behaviour past 100 events
* Archived-state `note`-only acceptance — added once operational-track
  CREATE is exercised

## Interpreting failures

When an assertion fails, the suite prints the failing check with a short
detail (often the unexpected status or error code). The harness is
intentionally minimal — a failure means the server diverges from the spec
in a way that would break client-library interop.
