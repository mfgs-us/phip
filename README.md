# PhIP — Physical Information Protocol

A federated protocol for formatting, addressing, querying, and exchanging
information about physical objects across organizational and system
boundaries — at any point during design, manufacturing, deployment, or
end-of-life.

PhIP is to physical objects what HTTP/DNS was to documents: a universal
addressing and exchange protocol. It is **not** an ERP, MES, file format,
communication bus, or blockchain.

> **Status:** `0.1.0-draft`. The protocol is implementable but not stable
> — minor versions may introduce breaking changes until the spec hits 1.0.
> See [`VERSIONING.md`](./VERSIONING.md).

## Quick links

| Document | What it is |
|---|---|
| [**spec/phip-core.md**](./spec/phip-core.md) | The full normative specification |
| [**spec/CHANGELOG.md**](./spec/CHANGELOG.md) | What changed in each revision |
| [**schemas/**](./schemas/) | JSON Schemas: core object, attribute namespaces, capability tokens, /meta, bundle manifest |
| [**tests/conformance/**](./tests/conformance/) | Black-box HTTP conformance suite — `npm install -g @phip/conformance` |
| [**tests/vectors/**](./tests/vectors/) | Language-agnostic test fixtures: JCS, Ed25519, hash chains, lifecycle, tokens, bundles |
| [**reference/**](./reference/) | Minimal Node reference resolver (pedagogical; not a production server) |
| [**IMPLEMENTATIONS.md**](./IMPLEMENTATIONS.md) | Registry of known implementations and conformance status |
| [**CONTRIBUTING.md**](./CONTRIBUTING.md) | How to file issues and submit PRs |
| [**VERSIONING.md**](./VERSIONING.md) | Spec, schema, and library versioning rules |

## What problem PhIP solves

Cross-organizational provenance for physical things. Today, when a part
moves between Apple → Foxconn → Quanta → a datacenter operator → a
recycler, every handoff loses or rewrites information. There is no
universal way to say "this object's history is at this URL, signed by
these parties, verifiable end-to-end" — so each organization stores
its own incompatible record, and provenance evaporates at every
boundary.

PhIP defines:

- **Identity** — a federated URI scheme (`phip://{authority}/{namespace}/{local-id}`)
  resolvable via a well-known HTTPS endpoint
- **Object model** — four required fields (`phip_id`, `object_type`,
  `state`, `history`) shared by every PhIP object
- **Schema namespaces** — extensible typed attributes
  (`phip:mechanical`, `phip:datacenter`, `phip:software`,
  `phip:compliance`, `phip:geo`, `phip:access`)
- **Lifecycle state machine** — enforced transitions across two tracks:
  manufacturing (`concept` → `design` → … → `disposed`) and
  operational (`planned` → `active` → `inactive` → `archived`)
- **Trust model** — Ed25519-signed events, hash-chained append-only
  history, capability tokens for cross-org writes, foreign-authority
  key resolution for cross-org token verification
- **Federation primitives** — authority delegation (sub-namespace
  hand-off), authority transfer (acquisition / domain death),
  mirror snapshots (archival)

All data crosses the wire as canonical JSON (RFC 8785), all events
carry verifiable signatures, all writes go through an enforced state
machine.

## Architecture in five layers

| Layer | What it does |
|---|---|
| **5. Trust** | Ed25519 event signing, hash-chained history, capability tokens, mTLS / RFC 9421 caller authentication |
| **4. Lifecycle** | State machine; enforced transitions; terminal states |
| **3. Schema namespaces** | Domain-specific typed attributes (`phip:datacenter`, `phip:mechanical`, …) |
| **2. Object model** | Required fields; event log structure; history projection |
| **1. Identity** | URI scheme, resolver discovery, redirect/transfer/delegation rules |

Protocol operations: `CREATE`, `GET`, `PUSH`, `QUERY`, `history`,
`batch_create`, `batch_push`, `meta` — all over HTTPS.

## Try it

### Run the reference resolver

```bash
cd reference
npm install
PHIP_AUTHORITY=test.local PHIP_PORT=8080 npm start
```

In another terminal, prove it works:

```bash
cd tests/conformance
node run.js http://127.0.0.1:8080 --authority test.local
# 76 passed, 0 failed
```

### Validate any other PhIP server

If you've built a PhIP server in another language, install the
conformance suite globally and probe your server:

```bash
npm install -g @phip/conformance
phip-conformance http://my-resolver.example --authority my-authority.example
```

### Read the test vectors

The fixtures in [`tests/vectors/`](./tests/vectors/) are language-agnostic.
Any client library that produces byte-identical output on these inputs
is wire-compatible with the reference. Implementing PhIP in a new
language? Start there.

## Implementations

See [**IMPLEMENTATIONS.md**](./IMPLEMENTATIONS.md) for the current
registry. To add yours, open a PR after passing the vectors and (for
servers) the conformance suite.

Planned first-party implementations under
[github.com/mfgs-us](https://github.com/mfgs-us):

- `phip-py` — Python client library
- `phip-rs` — Rust client library (no_std-friendly for embedded)
- `phip-server` — production server (Go, single binary)
- `phip-cli` — operator CLI (Go)
- `phip-js` — JavaScript / TypeScript client library
- `phip-datacenter` — vertical example application

The `phip` repo (this one) holds the spec, schemas, conformance suite,
test vectors, and a minimal reference. Everything else lives in its
own repo.

## Repository layout

```
phip/
├── spec/              # The specification — phip-core.md is normative
├── schemas/           # JSON Schemas (object, namespaces, tokens, meta, bundle)
├── tests/
│   ├── vectors/       # Language-agnostic fixtures
│   └── conformance/   # HTTP conformance suite (also @phip/conformance)
├── reference/         # Minimal Node reference resolver
├── README.md
├── CONTRIBUTING.md
├── VERSIONING.md
├── IMPLEMENTATIONS.md
└── LICENSE
```

The reference resolver in `reference/` is intentionally minimal — no
persistence, no TLS, no HSM integration. It exists to validate the
spec and serve as a working example for spec readers. Production
deployments use `phip-server` (a separate repo, when it lands).

## Contributing

See [**CONTRIBUTING.md**](./CONTRIBUTING.md). The PR checklist requires
passing:

- `cd reference && npm test` — reference smoke + federation
- `cd tests && npm run self-check` — language-agnostic vectors (189
  assertions)
- `cd tests/conformance && node run.js <url>` — HTTP conformance suite
  against a running resolver (76 assertions plus federation §20)

Spec changes should reference an Appendix A entry. Editorial changes
can skip the issue step.

## License

Apache 2.0. See [`LICENSE`](./LICENSE).

## Repository

[github.com/mfgs-us/phip](https://github.com/mfgs-us/phip)
