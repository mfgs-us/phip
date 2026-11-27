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
├── spec/
│   ├── phip-core.md       # The specification (primary artifact). RFC-style, normative.
│   │                      # Lifecycle (§9), event log/hash chain (§10), trust (§11) all live here.
│   └── CHANGELOG.md       # Per-amendment changelog; Appendix A of the spec tracks open issues
├── schemas/               # JSON Schema (draft 2020-12): core, mechanical, datacenter, software,
│                          # geo, compliance, access, meta, capability-token, bundle-manifest,
│                          # authority-transfer-payload, topology-response
├── tests/
│   ├── vectors/           # Language-agnostic fixtures + generate.js (deterministic) + self-check.js
│   ├── conformance/       # Black-box HTTP suite, published as @phip/conformance
│   └── schemas-check.js   # Compiles every schema under Ajv strict mode
├── formal/                # Non-normative Lean 4 models of lifecycle + capability tokens (lake build)
├── .github/workflows/ci.yml
├── README.md, TUTORIAL.md, IMPLEMENTATIONS.md, VERSIONING.md, CONTRIBUTING.md, LIABILITY.md
└── LICENSE                # Apache 2.0
```

## Checks (all run in CI)

```
cd tests && npm ci
npm run self-check                                     # vectors internally consistent
npm run generate && test -z "$(git status --porcelain -- vectors/)"  # committed vectors match generator
npm run schemas-check                                  # schemas compile
cd ../formal && lake build                             # Lean proofs
```

When a spec change touches wire-visible behavior, regenerate vectors in the
same change. When it touches §6.2, §9, §11.3, or the §11.5.2 scope table, update
`formal/` in the same change.

## Ecosystem (Separate Repos)

- **phip-py** — Python client library (URI resolution, event signing, hash-chain verification, federation client)
- **phip-server** — Reference + production server (Python/FastAPI, Postgres or SQLite, Docker Compose). Supersedes the earlier Node reference that used to live in `reference/`.
- **phip-cli** — `phip` command-line tool: identity + remote management, server integration, protocol plumbing. Built on phip-py.
- **phip-datacenter** — Vertical example application for datacenter ops (planned)

## Development Priorities

The spec (`spec/phip-core.md`) is the primary artifact — everything else derives from it. Don't write schemas or reference code until the corresponding spec section is stable.

Open issues are tracked in spec Appendix A (struck-through rows are resolved). The load-bearing sections (canonical JSON, key resources, query grammar, resolver discovery) are written. Remaining `[TODO]` placeholders are minor — `grep -n '\[TODO' spec/phip-core.md` for the current list (e.g. §1 motivation, §5 identity fields, §8 `phip:electrical`/`phip:procurement`, §16 IANA template).

## Spec Conventions

- Uses RFC 2119 language: MUST, SHOULD, MAY have normative meaning
- Inspired by IETF RFC format, OpenAPI spec repo, SPIFFE, ActivityPub, JSON-LD/Schema.org
- Object types and relation types use controlled vocabularies — custom extensions require namespacing

## Repository

https://github.com/mfgs-us/phip — Licensed under Apache 2.0.
