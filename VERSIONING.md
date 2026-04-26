# Versioning Policy

This document defines the versioning rules for the PhIP specification,
the schemas, and the client libraries that implement them. The same
rules apply to every PhIP package across every language.

## Spec versioning

The PhIP Core Specification (`spec/phip-core.md`) is versioned with a
single semver-style string carried in `protocol_version`:

```
MAJOR . MINOR . PATCH (- prerelease)?
```

- **MAJOR** — incompatible wire-format change (new required field on
  events, removal of an event type, change to canonicalization rules,
  change to hash algorithm). Bumped only with strong justification.
- **MINOR** — backward-compatible additive change (new optional field
  on events, new event type, new error code, new endpoint, new
  conformance class). v0.1 implementations MUST continue to interoperate
  with v0.2 resolvers for the operations they both support.
- **PATCH** — clarification, typo fix, schema-equivalent rephrasing.
  No implementation changes required.
- **prerelease** — `-draft`, `-rc.1`, etc. The current spec is
  `0.1.0-draft` and remains so until the spec is declared stable.

Resolvers advertise their target spec version via
`/.well-known/phip/meta.protocol_version`. Clients SHOULD warn (not
fail) on MAJOR mismatch, since most operations remain compatible
across MAJOR boundaries when the resolver maintains backward
compatibility.

## Schema versioning

Each JSON Schema file under `schemas/` carries its own `version` field
and follows the same rules described in spec §8.4 (Schema Versioning).
In summary:

- Additive changes (new optional property, new enum value) → MINOR bump.
- Breaking changes (removed property, narrowed validation, type change)
  → MAJOR bump.
- Documentation-only changes don't bump the schema version.

The unversioned URL (`schemas/mechanical.json`) MUST resolve to the
latest stable version. Pinned consumers use the versioned URL
(`schemas/mechanical/v1.2.json`).

Schema MAJOR versions are independent of spec MAJOR versions —
`phip:mechanical` v2.0 can ship under PhIP spec v0.1.

## Library versioning

Every PhIP client library (`phip-js`, `phip-py`, `phip-rs`, etc.) MUST
follow these rules:

### Pin to spec MAJOR

A library at version `X.Y.Z` implements PhIP spec `X.*.*`. PhIP spec
v1.0 → library v1.x.y. PhIP spec v2.0 → library v2.x.y. Libraries
SHOULD NOT support multiple spec MAJOR versions simultaneously; the
12-month compatibility window in §8.4.6 applies to **operators**
deploying resolvers, not to libraries.

### Library MINOR tracks spec MINOR

When the spec adds a new event type or endpoint (a MINOR bump), the
library bumps its own MINOR version once it implements the new
surface. Libraries MAY ship MINOR-version-behind support — a library
at v0.1.5 implementing PhIP v0.1.0 is fine, as long as it doesn't
silently drop fields it doesn't recognize.

### Library PATCH for internal changes

Bug fixes, performance improvements, dependency bumps, internal
refactors that don't change the lib's public API → PATCH bump.

### Public API breaking change

A library's own public API can break independently of the spec:

- Lib at `0.x.y` may break the public API on any MINOR bump.
- Lib at `1.x.y` and above MUST follow strict SemVer for public-API
  changes: breaking change → MAJOR bump.

When a public-API break and a spec MAJOR change happen together, both
bump simultaneously and the changelog explains both.

### Compatibility window

Libraries SHOULD support at least the current and previous spec
MINOR within a single major (e.g., v0.1 lib supports talking to
both v0.1 and v0.2 resolvers). Across MAJOR boundaries (e.g.,
v0.x ↔ v1.x), libraries pick a side and document which.

Operators following spec §8.4.6 must support N-1 MAJOR for at least
12 months. Libraries SHOULD aim for the same window where practical.

## Schema namespace versioning vs. spec versioning

These are independent. `phip:mechanical@1.0` is a separate version
track from PhIP-Core@0.1.0-draft. Adding `phip:electrical@1.0` does
not bump the spec; tightening the core lifecycle table does.

The `/.well-known/phip/meta` document advertises both:
- `protocol_version` for the spec
- `schema_namespaces` listing supported namespaces with optional
  `@MAJOR.MINOR` suffixes

## Reference implementation

The reference resolver in `reference/` tracks the **current spec
version** at HEAD. It does not maintain backward-compatibility
shims. When the spec adds a new feature, the reference adds support
in the same PR. When the spec breaks something, the reference breaks
in the same PR.

The reference is a spec-validation tool, not a deployable
production server. Production servers (`phip-server` and any
language-specific equivalents) are responsible for their own
backward-compatibility windows.

## Conformance suite versioning

The HTTP conformance suite (`tests/conformance/`) and the
language-agnostic vectors (`tests/vectors/`) version with the spec
MAJOR. A library that claims to implement PhIP v0.1 MUST pass the
v0.1 conformance suite, not the v0.2 suite (they may differ in test
counts as new operations are added).

## Pre-1.0 caveats

While the spec is at `0.x`, MINOR bumps MAY introduce breaking
changes. The protocol is explicitly not stable until v1.0. Libraries
SHOULD warn consumers about this in their READMEs.

When the spec hits 1.0, this document is updated to remove this
caveat and the strict-SemVer rules above take effect for all
versioned components.
