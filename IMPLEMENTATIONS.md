# PhIP Implementations

Known PhIP implementations and their conformance status. To add an
entry, open a PR — at minimum the implementation MUST pass the
language-agnostic vectors (`tests/vectors/`) and (for resolvers) the
HTTP conformance suite (`tests/conformance/`).

## Resolvers

Implementations that **host** PhIP objects.

| Implementation | Language | Class | Spec | Vectors | HTTP | Federation | Notes |
|---|---|---|---|---|---|---|---|
| [phip reference](./reference) | Node 20+ | Full | 0.1.0-draft | 189/189 | 76/76 | 30/30 | In-tree; pedagogical, in-memory only, NOT for production |

Conformance class definitions are in spec §13.

## Client libraries

Implementations that **consume** PhIP via HTTP.

| Implementation | Language | Spec | Vectors | Status |
|---|---|---|---|---|
| _(none yet — `phip-js` and `phip-py` are next)_ | | | | |

## How to claim conformance

A new implementation claims conformance by:

1. **Passing the language-agnostic vectors** (`tests/vectors/self-check.js`
   if you ported the harness to your language; otherwise re-implement
   the assertions and compare byte-for-byte against each fixture).
2. **For resolvers**, passing the HTTP conformance suite — install
   `@phip/conformance` and run it against a live instance.
3. **For federated resolvers**, additionally passing the federation
   conformance suite covering cross-authority token verification,
   delegation, and transfer.

Add a row to the table above with:
- Direct link to the implementation
- Language and runtime
- Conformance class (resolver) or "Client" (lib)
- Spec version targeted
- Test pass count (e.g. `189/189`)
- Notes on production readiness

## Why this list matters

For a federated protocol, implementation diversity is a goal — multiple
servers and clients prove the spec is not accidentally tied to one
codebase. This list is the public record of who has done what and
makes it easy for new integrators to find a library in their language.

## Reporting a broken implementation

If an implementation listed here has stopped passing conformance, file
an issue and we will mark it as such. Implementations remain on the
list (with a note) for at least 90 days after a regression to give
maintainers time to fix; persistently broken implementations are
removed.
