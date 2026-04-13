# Changelog

All notable changes to the PhIP specification will be documented in this file.

## [0.1.0-draft] — 2026-04-09

### Added
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
