# Contributing to PhIP

The PhIP repo holds the specification, JSON schemas, language-agnostic
test vectors, the HTTP conformance suite, and a minimal reference
resolver. Client libraries (`phip-js`, `phip-py`, `phip-rs`, ...) and
the production server (`phip-server`) live in their own repositories
under [github.com/mfgs-us](https://github.com/mfgs-us).

This guide covers contributing to **this** repo. For language-specific
libraries, see the CONTRIBUTING file in each lib's repo.

## What lives here

| Directory | Purpose |
|---|---|
| `spec/` | The specification — `phip-core.md` is normative, `CHANGELOG.md` tracks revisions |
| `schemas/` | JSON Schemas: core object, attribute namespaces, capability token, /meta document, bundle manifest, authority-transfer payload |
| `tests/vectors/` | Language-agnostic fixtures — JCS canonicalization, Ed25519, hash chain, lifecycle, tokens, bundles |
| `tests/conformance/` | HTTP black-box test suite for any PhIP server |
| `reference/` | Minimal Node reference resolver — pedagogical and spec-validation only, NOT a production server |

## Quick start

```bash
# Install reference + tests dependencies
cd reference && npm install
cd ../tests && npm install

# Run reference's smoke + federation tests
cd ../reference && npm test

# Validate the language-agnostic vectors
cd ../tests && npm run self-check

# Run the HTTP conformance suite against a running reference
cd ../reference && PHIP_AUTHORITY=test.local PHIP_PORT=8080 npm start &
cd ../tests && npm run conformance -- http://127.0.0.1:8080 --authority test.local
```

All four commands MUST pass before you submit a PR.

## Filing an issue

Before filing:

- For **spec questions**, search the spec text and Appendix A first. If
  your question reveals an ambiguity or gap, the issue title should
  start with `spec:`.
- For **schema bugs**, include the JSON Schema validation error and the
  input that triggered it.
- For **conformance suite bugs**, include the resolver under test and
  the failing assertion's full output.
- For **reference resolver bugs**, include `node --version`, the env
  vars passed, and a minimal reproduction.

## Pull request checklist

Every PR MUST:

- [ ] Pass `cd reference && npm test`
- [ ] Pass `cd tests && npm run self-check`
- [ ] Pass `cd tests && npm run conformance -- ...` against the reference
- [ ] Update `spec/CHANGELOG.md` if the change touches the spec
- [ ] Update the `version` field in any modified schema (per `VERSIONING.md`)
- [ ] Add or update a fixture in `tests/vectors/` if the change affects
      the wire format
- [ ] Add or update an assertion in `tests/conformance/` if the change
      affects an HTTP-visible behavior

PRs that change normative spec text SHOULD include:

- The motivation (what real-world scenario surfaced the issue)
- A link to the relevant Appendix A entry, or a new Appendix A entry
  if this raises a new issue
- A test vector or conformance assertion locking in the new behavior

## Scope rules

This repo is intentionally minimal. The following are out of scope here
and should be raised in the appropriate sibling repo:

| Concern | Repo |
|---|---|
| Client library bugs / features | `phip-js`, `phip-py`, `phip-rs` etc. |
| Production server features | `phip-server` |
| Operator CLI features | `phip-cli` |
| Vertical examples | `phip-datacenter`, etc. |
| Persistence backends | `phip-server` |
| HSM / KMS integration | `phip-cli` |
| TLS / mTLS termination | `phip-server` |

## The reference resolver is not the production server

`reference/` is intentionally small. It exists to:

1. Validate that the spec, as written, can be implemented
2. Serve as the conformance suite's target during spec changes
3. Give spec readers a working example they can read end-to-end

It does NOT have:
- Persistent storage (everything is in-memory)
- TLS termination (operators front it with a TLS-terminating proxy)
- Production observability
- HSM/KMS integration

Pull requests adding any of the above will be redirected to
`phip-server`.

## Spec change process

Substantive spec changes follow this flow:

1. **File an issue** describing the gap or ambiguity. Get rough
   agreement that the change is needed.
2. **Open a PR** with the spec text change, schema updates if any,
   test vector updates if any, conformance suite updates if any, and
   a CHANGELOG entry.
3. **Review** focuses on: spec internal consistency, conformance with
   existing sections, test coverage of the new behavior, impact on
   the reference resolver.
4. **Merge** after review approval and all checks pass.

Editorial changes (typos, rewording, clarifying examples) can skip
step 1.

## Appendix A — open issues

The spec's Appendix A is the canonical list of open spec issues.
Resolved items are crossed out with a one-line summary and a section
reference. New issues raised in PRs SHOULD be added to Appendix A
under §A.2 (Open Issues — Post-v0.1) with a severity rating.

## Code of conduct

Be civil. Disagree with code, not with people. The protocol benefits
from sharp critique; humans don't.

## Questions

For questions that aren't quite issues yet:
- GitHub Discussions on this repo
- Email the maintainers (see README)
