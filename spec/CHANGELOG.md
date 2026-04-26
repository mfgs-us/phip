# Changelog

All notable changes to the PhIP specification will be documented in this file.

## [0.1.0-draft] — 2026-04-09

### Added
- Library prerequisites: four new JSON Schemas (`schemas/capability-token.json`,
  `schemas/meta.json`, `schemas/authority-transfer-payload.json`,
  `schemas/bundle-manifest.json`) so client libs validate structurally
  without each one reinventing validation; pointers added from §11.3.1,
  §12.7, §4.6.2, and §4.3.4 to the corresponding schemas.
- Capability token test vectors (`tests/vectors/token/`) covering 9
  cases: valid push and read tokens, expired, not-yet-valid,
  object_filter mismatch, forged signature, post-signing tamper,
  read-history-covers-read-state, and foreign-signer.
- Bundle test vectors (`tests/vectors/bundle/`) covering 3 cases:
  one-object snapshot, multi-object snapshot, and tampered-event
  rejection. Self-check verifies manifest signatures, full chain
  walks, and embedded key actor presence.
- New §11.6 Caller Authentication: defines mTLS (§11.6.1) and signed
  HTTP requests per RFC 9421 (§11.6.2) as the two interoperable
  mechanisms for binding a capability token to its actual requester.
  Closes the bearer-token gap that made §11.5.2 step-7 tautological.
- New §12.2.2 Cursor Stability: cursors MUST survive resolver restart
  and replica swap, MUST be portable across authority transfers,
  cursor-expired surfaces as `INVALID_QUERY` with `details.reason`.
- New §12.3.2 General Retry Guidance: per-status retry semantics,
  exponential-backoff defaults, idempotency-on-`event_id` guarantee
  for safe POST retries.
- `VERSIONING.md`: spec MAJOR/MINOR/PATCH rules, library-tracks-spec
  pinning, schema-version independence, compatibility window.
- `CONTRIBUTING.md`: PR checklist, scope rules, reference-vs-server
  boundary, spec change process.
- `IMPLEMENTATIONS.md`: registry of known PhIP implementations with
  conformance status.
- `@phip/conformance` package: `tests/conformance/` is now a
  publishable npm package with a `phip-conformance` bin. Operators
  install with `npm install -g @phip/conformance` and probe any
  resolver from one command. Self-contained (test keypair embedded;
  no dependency on the wider repo).
- Conformance §20 federation mechanics (opt-in): when the resolver's
  `/meta` advertises `delegations` or `successor`, the suite probes
  the redirect machinery (`Location`, `PhIP-Delegation`,
  `PhIP-Transfer-Event` headers).
- Interop prerequisites for multi-language client libraries (`phip-js`, 
  `phip-py`, etc.): language-agnostic test vectors in `tests/vectors/` 
  covering JCS canonicalization, SHA-256 event hashing, Ed25519 signing 
  and verification, URI parsing, hash-chain continuity, lifecycle 
  transitions, and the self-signed bootstrap key pattern; HTTP black-box 
  conformance suite in `tests/conformance/` for PhIP servers.
- Section 4.3 resolver discovery, caching, and redirect policy: authority 
  name is the resolver identity (no DNS TXT/SRV lookups), `ETag`/
  `Cache-Control` guidance with tight `max-age` for active objects and 
  long `max-age` for terminal states, same-authority-only redirect 
  constraint, and `POST`-preserving redirect rules.
- Section 12.6 `/.well-known/phip/meta` capability document for resolver 
  self-description (protocol version, namespaces, supported operations, 
  schema namespaces). Resolver publication is optional.
- Four namespace schemas: `phip:mechanical` (dimensions, weight, material, 
  tolerances), `phip:datacenter` (rack position, power, thermal, network 
  ports), `phip:software` (firmware, config hashes, OS, drivers), and 
  `phip:compliance` (condition layer, certifications, life limits, chain 
  of custody). Validated against 27 test cases.
- Initial draft of PhIP Core Specification
- URI scheme definition (Section 4)
- Object model with four required fields (Section 5)
- Seven object types (Section 6)
- Seven core relation types (Section 7)
- Schema namespace extensibility mechanism (Section 8)
- Nine lifecycle states with enforced transitions (Section 9)
- Event log with hash chain structure (Section 10)
- Trust model with Ed25519 signing and capability tokens (Section 11)
- Three protocol operations: GET, PUSH, QUERY (Section 12)
- Conformance requirements (Section 13)
- Sub-object addressing via URI path segments (Section 4.4)
- `vehicle` object type for mobile locations (Section 6, 6.1)
- Condition layer separate from lifecycle state (Section 9.3)
- `process` event type for N-to-M physical transformations (Section 10.4)
- Lot split and merge operations (Section 10.5)
- IoT/automated actor guidance and telemetry boundary (Section 11.4)
- Cross-org relation write ownership rules (Section 11.3.1)
- Appendix A: open issues identified through scenario stress-testing
- CREATE protocol operation (Section 12.1) — objects can now be registered
- Dual-track lifecycle: manufacturing track (concept through disposed) and 
  operational track (active/inactive/archived) for actor/location/vehicle (Section 9.1–9.3)
- `consumed` terminal state for subdivided/transformed objects (Section 9.2)
- Canonical JSON serialization specified as RFC 8785 / JCS (Section 10.3)

### Changed
- Hash encoding format normatively specified: `sha256:` prefix followed by 
  64 lowercase hex characters (Section 10.3)
- `lot_merge` payload structure defined with `source_lots` array and example 
  (Section 10.5)
- `relation_removed` event payload structure clarified — same `relation` 
  object as `relation_added` (Section 7.2)
- PUSH response wording corrected: removed reference to undefined 
  "server-assigned sequence number" (Section 12.3)
- Hash chain definition clarified: hash computed over complete preceding event 
  including all fields (Section 10.3)
- Protocol operations renumbered: CREATE (12.1), GET (12.2), PUSH (12.3), 
  QUERY (12.4)
- Lot splits and process event consumed inputs now transition to `consumed` 
  instead of `disposed` (Sections 10.4, 10.5)
- Conformance requirements updated for CREATE, lifecycle tracks, process 
  validation, and JCS (Section 13)
- Appendix A reorganized with severity ratings (Blocker/High/Medium/Low) and 
  expanded to 32 open issues from systematic review
- `planned` state added to operational lifecycle track (Section 9.3)
- Object fields declared as projections of event history (Section 5.1)
- Process event atomicity downgraded to SHOULD with explicit deferral note 
  for cross-namespace transactions (Section 10.4)
- Hash chain verification: MUST on first untrusted retrieval, MAY cache 
  (Section 10.3)
- Foreign namespace CREATE explicitly disallowed (Section 12.1)
- `consumed` reachable from `qualified` and `stock` on manufacturing track
- Appendix A sorted into "must resolve before reference implementation" 
  (7 issues) and "can defer to post-v0.1" (23 issues). 11 issues now resolved

### Resolved — All 7 reference implementation blockers
- **A25: Error response format** — standard error envelope with 17 error 
  codes and HTTP status mappings (Section 12.5)
- **A24: Concurrency** — optimistic locking with CHAIN_CONFLICT (409), 
  client re-fetch/re-sign/retry protocol (Section 12.3.1)
- **A8: Public key resource format** — JWK-based key objects on operational 
  track, validity windows, bootstrap key pattern, key rotation, cache 
  guidance (Section 11.2)
- **A31: Relation metadata** — optional flat metadata object on relations, 
  carried through relation_added event payloads (Section 7.2)
- **A32: History pagination** — GET returns state projection with 
  history_length/history_head; separate /history/ sub-resource with cursor 
  pagination (Section 12.2.1)
- **A11: Capability token mechanics** — PhIP-Capability HTTP header, four 
  scope levels (push_events/push_state/push_measurements/push_relations), 
  token format, verification steps, short-lived tokens (Section 11.3)
- **A9: Query predicate grammar** — field/attribute/relation filters with 
  glob syntax, two return modes (ids/objects), cursor pagination, explicit 
  v0.1 exclusions (Section 12.4)
- RFC 7517 (JWK) moved from informative to normative references
- Conformance requirements expanded for key verification, chain conflict 
  handling, capability token scopes, pagination, error responses
- All reference implementation blockers resolved — 18 total issues resolved, 
  23 deferred to post-v0.1
- **A10: Resolver discovery, caching, redirects** — Section 4.3.1 through 
  4.3.3 plus new Section 12.6 metadata document. Section 13 conformance 
  suite TODO replaced with pointer to `tests/vectors/` and 
  `tests/conformance/`. 19 issues resolved total, 22 deferred.
- **All five remaining Low-severity issues resolved** — 41 issues 
  resolved total, 0 deferred. Spec backlog clean for v0.1.0-draft:
  - **A33: Batch operations** — new §12.5: non-atomic 
    `/objects/{ns}/batch` and `/push/{ns}/batch`, 1000-event cap, 
    per-event results, 207 Multi-Status on partial success.
  - **A34: Offline / air-gapped resolution** — new §4.3.4: warm 
    cache and signed PhIP bundle format (`manifest.json` + 
    `objects/`, `history/`, `keys/`), full chain verification on 
    import, replay-on-reconnect for buffered writes.
  - **A35: HTTP authentication** — new §12.8: 
    `Authorization: PhIP-Capability` is the only protocol-level 
    auth scheme; mTLS is a transport overlay; non-protocol 
    endpoints (admin, health) free to use any scheme; 
    basic/bearer/API-key MUST NOT route restricted reads or writes.
  - **A36: Conformance levels** — §13 restructured into Full / 
    Read-Only / Mirror / Client-Only classes. New 
    `OPERATION_NOT_SUPPORTED` (405) error code. New `conformance_class` 
    field in `/meta`.
  - **A37: Schema versioning** — new §8.4: semver MAJOR.MINOR with 
    explicit additive vs. breaking change rules, versioned `$id` 
    URLs, all v0.1 schemas seeded with `version: "1.0"`. 12-month 
    minimum compatibility window after a MAJOR bump.

- Section 12 sub-numbering: 12.5 (was Error Responses) → 12.6, 12.6 
  (was Metadata Document) → 12.7, plus new 12.5 Batch Operations and 
  new 12.8 HTTP Authentication. All cross-references updated.

- **All twelve remaining Medium-severity issues resolved** — 36 issues 
  resolved total, 5 deferred (12 Medium → 0 Medium, all remaining are 
  Low):
  - **A2: Yield fraction math** — non-negative real values in [0,1]; 
    sum-per-input ≤ 1 + ε with ε = 1e-6; missing fractions are 
    "unknown" not implicit-equal-share; numeric representation 
    guidance. New §10.4.1, §10.4.2.
  - **A3: Geographic position** — new `phip:geo` namespace covering 
    WGS 84 position (lat/lon/altitude/accuracy/source), address, 
    route with waypoints/carrier, and geofence. New 
    `schemas/geo.json`.
  - **A4: Multi-party custody transfer** — new §11.3.7 specifying the 
    prior-custodian → carrier → next-custodian token chain with 
    pickup/transit/delivery roles, disruption handling, and 
    sub-delegation rules.
  - **A5: Lot split mass conservation** — new §10.5.1: 
    `sum(resulting) ≤ source + ε` with optional `loss_quantity`; 
    `lot_merge` enforces equality; unit-mismatched merges require a 
    `process` event.
  - **A6: Measurement payload** — new §11.4.2 normative shape: 
    `metric`/`value`/`unit`/`as_of`/`method`/`uncertainty`/
    `thresholds`/`outcome`/`external_ref`/`samples`. Derived-vs-raw 
    distinction preserved through history.
  - **A12: Authority delegation** — new §4.5.1–4.5.5: 
    `delegations` array in `/meta`, scoped ops, revocation via 
    metadata edit, depth-limited sub-delegation.
  - **A14: Lot fungibility** — new §6.4: required `fungible` boolean 
    on lot identity; non-fungible lots MUST `contains` member items.
  - **A15: Lot quantity tracking** — new §6.4.1: 
    `identity.quantity` (`value`/`unit`/`as_of`/`precision`); 
    partial draw-down via `attribute_update`; split reserved for 
    new sub-lots.
  - **A16: Regulatory jurisdiction** — added `jurisdiction`, 
    `regulatory_authority`, `applicable_jurisdictions`, and 
    `export_control` to `phip:compliance` schema.
  - **A18: Uncertainty qualifiers** — new §5.2.1: parallel 
    `<field>_quality` convention with `confidence`/`source`/`as_of`/
    `corrected_from`/`note`. Tools MUST treat qualified and 
    unqualified fields identically for matching.
  - **A29: connected_to bidirectional cross-org** — new §7.3: 
    relations are owned by the writing object; cross-authority 
    inverses are not required; asymmetric relations are not proof 
    of physical state.
  - **A30: Dangling relations** — new §7.4: graceful-degradation 
    rules; new `DANGLING_RELATION` (422) error for same-authority 
    broken refs; cross-authority targets verified lazily by readers.

- **All five remaining High-severity issues resolved** — 24 issues 
  resolved total, 17 deferred (5 High → 0 High):
  - **A26: Read access control** — `phip:access` namespace 
    (`public`/`authenticated`/`capability`/`private`); capability tokens 
    gain `read_state`, `read_history`, `read_query` scopes; new 
    `ACCESS_DENIED` (403) error code; QUERY silently omits inaccessible 
    objects. New Section 11.5; new `schemas/access.json`.
  - **A27: Privacy / GDPR annex** — new Section 15 (Privacy 
    Considerations). No-raw-PII rule, `phip:personal_data` salted-
    commitment convention, `phip:external_record` for off-chain 
    references, salt deletion as the erasure mechanism, pseudonymous-
    actor pattern. IANA renumbered to Section 16, References to 17.
  - **A1: Sub-object addressing** — Section 4.4 expanded with 4.4.1 
    (when to register), 4.4.2 (no lifecycle inheritance), 4.4.3 (paths 
    are informational; `contained_in` is normative).
  - **A13: Design revision model** — new `design` object type on the 
    manufacturing track; new Section 6.2 (design objects with 
    `part_number`/`revision`); new Section 6.3 tightening 
    `instance_of` to require a `design` target; new `supersedes`/
    `superseded_by` relation pair.
  - **A23: Authority transfer / domain death** — new Section 4.6: 
    long-lived root authority key, new `authority_transfer` event 
    type, authority record at `/.well-known/authority`, mirror hosts 
    via `mirror_urls`, same-authority redirect rule relaxed for 
    verified transfers. `/meta` document gains `root_key`, 
    `mirror_urls`, `successor` fields.
