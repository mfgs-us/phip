# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PhIP (Physical Information Protocol) is a specification project defining a protocol for formatting, addressing, querying, and exchanging information about physical objects across organizational and system boundaries — at any point during design, manufacturing, deployment, and end-of-life.

PhIP is to physical objects what HTTP/DNS was to documents: a universal addressing and exchange protocol. It is NOT an ERP, MES, file format, communication bus, or blockchain.

## Architecture

Five protocol layers, each building on the one below:

1. **Identity** — federated URI scheme (`phip://{authority}/{namespace}/{local-id}`), resolved via `/.well-known/phip/resolve/`
2. **Object Model** — normative fields: `phip_id`, `object_type`, `state`, `history` (all required)
3. **Schema Namespaces** — extensible typed attributes (`phip:mechanical`, `phip:datacenter`, `phip:software`, etc.)
4. **Lifecycle State Machine** — enforced transitions: concept → design → prototype → qualified → stock → deployed → maintained → decommissioned → disposed
5. **Trust** — Ed25519 signed events, hash-chained append-only history, capability tokens for cross-org writes

Protocol operations: GET, PUSH, QUERY over HTTPS.

## Repository Structure

```
phip/
├── spec/                  # The specification documents (primary artifact)
│   ├── phip-core.md       # Main spec — RFC-style, normative
│   ├── lifecycle.md       # State machine details
│   ├── trust.md           # Signing, hash chain, capability tokens
│   └── CHANGELOG.md
├── schemas/               # JSON Schema definitions for core namespaces
│   ├── core.json          # phip:core
│   ├── mechanical.json
│   ├── datacenter.json
│   └── software.json
├── reference/             # Minimal reference resolver implementation
├── tests/                 # Conformance test suite
├── README.md
├── LICENSE                # Apache 2.0
└── CLAUDE.md
```

## Ecosystem (Separate Repos)

- **phip-js** — client library (URI resolution, event signing, hash chain verification)
- **phip-server** — production-ready PhIP server implementation
- **phip-datacenter** — vertical example application for datacenter ops

## Development Priorities

The spec (`spec/phip-core.md`) is the primary artifact — everything else derives from it. Don't write schemas or reference code until the corresponding spec section is stable.

Key unresolved spec sections (marked `[TODO]`):
- Canonical JSON serialization (Section 10.3) — most load-bearing, trust model depends on it
- Public key resource format (Section 11.2)
- Query predicate grammar (Section 12.3)
- Resolver discovery, caching, redirects (Section 4.3)

## Spec Conventions

- Uses RFC 2119 language: MUST, SHOULD, MAY have normative meaning
- Inspired by IETF RFC format, OpenAPI spec repo, SPIFFE, ActivityPub, JSON-LD/Schema.org
- Object types and relation types use controlled vocabularies — custom extensions require namespacing

## Repository

https://github.com/mfgs-us/phip — Licensed under Apache 2.0.
