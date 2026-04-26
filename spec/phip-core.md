# PhIP Core Specification
## Physical Information Protocol — Core
**Version:** 0.1.0-draft  
**Status:** Draft  
**Repository:** https://github.com/mfgs-us/phip

---

## Abstract

The Physical Information Protocol (PhIP) defines a standard for formatting, 
addressing, querying, and exchanging information about physical objects across 
organizational and system boundaries, at any point during the design, 
manufacturing, deployment, and end-of-life processes.

PhIP specifies a globally resolvable URI scheme for physical object identity, 
a normative object model with controlled vocabularies, a standard lifecycle 
state machine, an append-only tamper-evident event history, and a 
cross-organizational trust model based on signed events and capability tokens.

HTTP is the transport. The protocol is defined in the layers above it.

---

## Status of This Document

This document is an early draft. Sections marked [TODO] are placeholders.
Breaking changes are expected before v1.0.0.

---

## Table of Contents

1. Introduction
2. Conventions and Terminology
3. Design Goals
4. PhIP URIs
5. Object Model
6. Object Types
7. Relation Vocabulary
8. Schema Namespaces
9. Lifecycle State Machine
10. Event Log
11. Trust Model
12. Protocol Operations
13. Conformance
14. Security Considerations
15. Privacy Considerations
16. IANA Considerations
17. References
Appendix A. Open Issues

---

## 1. Introduction

Physical objects — components, assemblies, systems, materials — move through 
complex chains of custody across organizations, systems, and time. A server 
moves from ODM to datacenter operator. A medical implant moves from 
manufacturer to hospital to patient. An aircraft engine moves between airlines 
and MRO shops.

At each boundary, data about the object is re-entered, re-formatted, or lost. 
Existing systems (ERP, MES, CMDB, DCIM, PLM) maintain local records but have 
no standard mechanism for exchanging those records across organizational 
boundaries with verifiable provenance.

PhIP addresses this by defining a protocol — not an application — that any 
system can implement to make physical object records globally addressable, 
structured, and trustworthy.

### 1.1 Scope

PhIP defines:

- A URI scheme (`phip://`) for persistent global object identity
- A normative object model and controlled vocabularies
- A standard lifecycle state machine with enforced transitions
- An append-only, hash-chained, signed event log
- A capability token model for cross-organizational write authorization
- Three protocol operations: GET, PUSH, QUERY

PhIP does not define:

- File formats for CAD, geometry, or simulation data
- Workflow or business logic
- A specific database or storage implementation
- A centralized registry or authority

### 1.2 Motivation

[TODO: expand with concrete failure modes this solves — 
interoperability gaps, traceability failures, bilateral integration cost]

---

## 2. Conventions and Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", 
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this 
document are to be interpreted as described in RFC 2119.

**PhIP Object** — a structured record representing a physical thing or 
logical grouping of physical things.

**PhIP ID** — a globally unique, persistent URI identifying a PhIP Object.

**Authority** — the domain that controls a PhIP namespace, responsible for 
resolving PhIP URIs within that namespace.

**Event** — an append-only record of something that happened to a PhIP Object.

**History** — the complete, ordered, append-only sequence of events for a 
PhIP Object.

**Capability Token** — a signed authorization granting an external actor 
permission to push events to objects in a foreign namespace.

**Resolver** — a server that implements PhIP protocol operations for a given 
authority.

**Actor** — an entity (person, system, or organization) that pushes events. 
Actors are themselves PhIP-addressable resources.

---

## 3. Design Goals

**G1 — Global Identity Without Central Authority**  
Any two organizations MUST be able to reference the same physical object 
without coordinating through a central registry.

**G2 — Portable Records**  
A PhIP Object record MUST be transferable across system and organizational 
boundaries without loss of meaning or provenance.

**G3 — Tamper-Evident History**  
It MUST be possible for any party to verify that an object's history has not 
been altered after the fact.

**G4 — Cross-Org Trust Without Bilateral Setup**  
Any party MUST be able to verify the authenticity of an event without a 
pre-existing relationship with the pushing party.

**G5 — Extensibility Without Fragmentation**  
Implementers MUST be able to extend the object model for domain-specific 
attributes without breaking interoperability on core fields.

**G6 — Implementation Neutrality**  
The protocol MUST be implementable on any stack. No specific database, 
language, or infrastructure is required.

---

## 4. PhIP URIs

### 4.1 Syntax

A PhIP URI has the following structure:

```
phip-uri   = "phip://" authority "/" namespace "/" local-id
authority  = domain-name
namespace  = segment
local-id   = segment *( "/" segment )
segment    = 1*( unreserved / pct-encoded )
```

Example:

```
phip://droyd.com/units/047
phip://quanta.com/servers/QCT88421-0042
phip://foxconn.com/builds/logic-board-A18/SN00042
```

### 4.2 Persistence

PhIP URIs are permanent. A URI that has ever identified a PhIP Object MUST 
NOT be reassigned to a different object. A decommissioned or disposed object's 
URI MUST continue to resolve, returning the object in its terminal state.

Persistence of the URI is independent of persistence of the original 
authority's DNS record or operational organization. An authority that 
ceases operation, is acquired, or migrates to a new domain transfers 
its records via the mechanism in Section 4.6 (Authority Transfer). 
Section 4.3.3 redirect rules and Section 12.7 metadata `mirror_urls` 
provide the runtime mechanics for clients to follow such transfers.

### 4.3 Resolution

A PhIP URI is resolved via the authority's well-known resolver endpoint:

```
https://{authority}/.well-known/phip/resolve/{namespace}/{local-id}
```

The authority MUST serve this endpoint over HTTPS. Resolution MUST return 
the full PhIP Object or a standard error response.

#### 4.3.1 Resolver Discovery

The default resolver for a URI `phip://{authority}/...` is reached by:

1. Treating `{authority}` as a DNS name.
2. Opening an HTTPS connection to that name on port 443.
3. Requesting the path under `/.well-known/phip/` per RFC 8615.

No additional discovery step is required. Clients MUST NOT perform DNS
TXT, SRV, or similar lookups to locate a different resolver host — the
authority name is the resolver's identity, and moving the resolver to a
different host without keeping the authority name stable would break
URI persistence (Section 4.2).

An authority MAY publish a metadata document at
`/.well-known/phip/meta` describing its supported protocol version,
namespaces, and optional capabilities. The document format is defined in
Section 12.7. Clients SHOULD fetch this document at most once per
authority per session and cache it per the HTTP response headers.

#### 4.3.2 Caching

Resolver responses for GET `/resolve/` and GET `/history/` SHOULD include
standard HTTP cache headers. The resolver SHOULD emit:

- `ETag` — set to the object's current `history_head` for `/resolve/`
  responses, or to a stable identifier for a committed history page.
- `Cache-Control: private, max-age={seconds}` — resolver-chosen.
  Resolvers SHOULD use a short `max-age` (≤ 60 seconds) for objects on
  the manufacturing or operational track that may still receive events,
  and MAY use a long `max-age` (days or more) for objects in terminal
  states (`disposed`, `consumed`, `archived`) since their state cannot
  change.

Clients SHOULD:

- Send `If-None-Match` with the cached `ETag` on subsequent fetches and
  treat `304 Not Modified` as a confirmation that the cached projection
  is current.
- Invalidate all cached state for an object on any `CHAIN_CONFLICT`
  received against it (the cached head is stale).
- Re-verify the hash chain (Section 10.3) whenever the chain head
  advances; a change of head MUST trigger re-verification from the last
  verified point rather than from genesis.

Clients MUST NOT cache responses from an untrusted resolver past the
point where the signing key in `phip:keys` leaves a valid state
(Section 11.2): a cached projection continues to be a valid snapshot of
past history, but any new event observed after a key expires or is
revoked MUST be re-verified against a currently-valid key.

#### 4.3.3 Redirects

Resolvers MAY respond with HTTP `301`, `307`, or `308` to redirect a
client to a different URL — for example, to route through an internal
reverse proxy or to steer traffic between replicas.

Clients MUST follow redirects only when the redirect target's authority
(the `host` component of the `Location` URL) is identical to the
authority in the requested PhIP URI. A redirect that would change the
authority MUST be treated as an error, and the client MUST NOT continue
the request: a cross-authority redirect would silently re-bind a PhIP
URI to a different organization, which violates URI persistence
(Section 4.2) and creates a namespace-hijacking vector.

**Exception — authority transfer.** A redirect that crosses authority 
boundaries is permitted iff it is justified by a verified 
`authority_transfer` event covering the requested namespace (Section 
4.6). Resolvers signalling such a redirect SHOULD include a 
`PhIP-Transfer-Event: <event-id>` header naming the transfer event. 
Clients MUST resolve and verify the transfer event (per Section 4.6.3) 
before following the redirect; an unverified transfer header MUST be 
treated as if absent.

Clients MUST NOT follow `302` redirects on `POST` operations
(`CREATE`, `PUSH`, `QUERY`). Resolvers that need to redirect writes
MUST use `307` or `308` so the method and body are preserved.

Clients SHOULD limit redirect chains to five hops and treat longer
chains as a resolver misconfiguration (surface as a transport-layer
error, not a PhIP error envelope).

#### 4.3.4 Offline and Air-Gapped Resolution

Some deployments resolve PhIP URIs without an internet connection: 
factory floors with disconnected MES networks, military and aviation 
maintenance environments, and supply-chain audits in remote 
locations. PhIP supports these via two mechanisms — local cache 
warm-up and signed bundle distribution.

**Local cache warm-up.** A connected client populates its cache 
(per §4.3.2) with the objects, key resources, and `/meta` 
documents it expects to need, then disconnects. The cached 
projections continue to verify against their hash chains and 
signatures with no further network access. Reads against cached 
objects work normally; writes are queued locally and replayed when 
connectivity returns.

The on-disk format for a warm cache is implementation-defined, but 
clients SHOULD follow these constraints to maximize reuse:

- Each cached object stored as the JCS-canonical bytes of its full 
  state projection plus the JCS bytes of every event in its 
  history.
- Each cached key resource stored alongside the object whose 
  signatures depend on it.
- The cache index is keyed by `phip_id`.

**Signed bundle distribution.** When a connected reference machine 
needs to distribute records to a wholly disconnected site, the 
authoritative wire format is a **PhIP bundle**: a signed archive 
of one or more objects' states and histories. The manifest shape is
defined by `schemas/bundle-manifest.json`. Bundle format:

```
phip-bundle.tar
├── manifest.json          // bundle metadata + signature
├── objects/
│   ├── {urlencoded-phip-id-1}.json    // full object projection
│   └── ...
├── history/
│   ├── {urlencoded-phip-id-1}.jsonl   // events in chain order, one per line
│   └── ...
└── keys/
    └── {urlencoded-key-phip-id}.json  // key resources referenced by signatures
```

The `manifest.json` MUST contain:

| Field | Required | Description |
|---|---|---|
| `bundle_version` | MUST | `"1.0"` |
| `created_at` | MUST | ISO 8601 timestamp the bundle was assembled |
| `created_by` | MUST | PhIP URI of the actor producing the bundle |
| `authority` | MUST | Source authority name |
| `objects` | MUST | Array of bundled `phip_id`s with `history_head` per object — bundle-level integrity manifest |
| `snapshot_of` | MAY | ISO 8601 timestamp this bundle represents the source authority's state as of. Used by mirror snapshots (§4.6.5) to declare currency; ad-hoc exports omit it |
| `signature` | MUST | Ed25519 signature over the JCS canonicalization of the manifest minus this field, signed by `created_by` |

A consumer importing a bundle MUST:

1. Verify the manifest signature against the producer's key 
   resource (which MAY be embedded in `keys/`).
2. For each object, verify the full hash chain from genesis to 
   the manifest's claimed `history_head`.
3. Verify each event signature against the corresponding key 
   resource.
4. Reject the bundle on any failure; do NOT partially apply.

Bundles are append-only on the consumer side: importing the same 
bundle twice is a no-op. Importing a bundle whose chain conflicts 
with locally-held state MUST surface a `CHAIN_CONFLICT`-style error 
to operators rather than overwriting silently.

**Replay-on-reconnect.** A disconnected client that accepts local 
PUSH operations buffers them as a queue. On reconnect, the client 
replays the queue against the upstream resolver in order, handling 
`CHAIN_CONFLICT` per §12.3.1 (re-fetch, re-sign, retry). The queue 
SHOULD be persisted across client restarts; events MUST be replayed 
in the order they were originally signed.

Bundles, warm caches, and replay queues are all client-side 
concerns. A resolver itself does not need to know whether its 
clients are operating online or offline — the protocol is 
indifferent.

### 4.4 Sub-Object Addressing

PhIP URIs MAY use path segments to address sub-components within a parent 
object. For example, a server's NIC port:

```
phip://google.com/servers/srv-042/ports/eth0
```

A sub-object address is syntactically a PhIP URI and resolves like any other. 
The path structure implies a physical containment relationship, but the 
sub-object MUST also have an explicit `contained_in` relation to its parent 
for the relationship to be normative. Path structure alone is informational.

#### 4.4.1 When to Register a Sub-Object

A sub-part MUST be registered as an independent PhIP object — with its 
own `phip_id`, event history, lifecycle state, and signing — when **any** 
of the following holds:

- The sub-part is field-replaceable (it can be removed, swapped, or 
  installed without destroying the parent).
- The sub-part has its own provenance trail (manufacturer, lot, 
  certifications) that needs to be queryable independently.
- The sub-part can be transferred to a different parent during its 
  lifetime (e.g. an SSD moving between chassis, a battery moving 
  between vehicles).
- The sub-part has its own lifecycle state changes that do not coincide 
  with the parent (e.g. a port `decommissioned` while the chassis is 
  still `deployed`).

Examples that MUST be independent objects: SSDs, DIMMs, NICs, line 
cards, batteries, removable sensors, FRU modules.

A sub-part MAY be modeled as an attribute facet on the parent — with no 
independent PhIP record — when none of the above holds. In this case 
the sub-part is part of the parent's object model and changes to it 
flow through `attribute_update` events on the parent.

Examples that MAY be facets: solder joints, PCB traces, stamped 
features, integrated (non-removable) components, paint layers.

#### 4.4.2 Lifecycle Independence

Sub-objects that are independent (per 4.4.1) have their **own** 
lifecycle state. A sub-object MUST NOT inherit state from its parent.

A `decommissioned` chassis MAY contain a `deployed` line card if the 
operator intends to harvest the line card for reuse. A `disposed` 
parent does not transitively dispose of its still-physically-present 
sub-objects; each sub-object's terminal state MUST be recorded by an 
explicit `state_transition` event on that sub-object.

When a parent object is consumed, decommissioned, or disposed, its 
sub-objects' `contained_in` relations remain pointing at the parent 
URI. Section 4.2 (URI persistence) ensures the parent URI continues to 
resolve.

#### 4.4.3 Path Segment Semantics

URI path segments after the local-id are **purely informational**. They 
provide a convenient lookup convention but carry no normative weight:

- A sub-object SHOULD be resolvable both by its full path 
  (`phip://acme.example/servers/srv-042/ports/eth0`) and by the 
  flattened `phip_id` recorded in its object record. An authority MAY 
  treat these as the same object or as distinct entries that point at 
  the same underlying record.
- The `contained_in` relation, **not** the path, is the source of 
  truth for parent-child structure. Tools that infer hierarchy from 
  path segments alone MUST be considered non-conformant.
- An authority MAY register sub-objects with flat `phip_id`s 
  (`phip://acme.example/ports/eth0-srv-042`) instead of nested paths. 
  Both styles are conformant.

### 4.5 Authority Delegation

An authority MAY delegate a namespace (or a sub-prefix within a 
namespace) to another party without transferring it. Delegation is 
useful when a parent organization wants a subsidiary, contractor, or 
business unit to operate its own slice of the namespace under the 
parent's URI authority.

Delegation differs from transfer (§4.6): the parent retains 
ultimate authority and can revoke the delegation, whereas transfer 
is a permanent cession.

#### 4.5.1 Delegation Mechanism

Delegation is recorded as an entry in the authority's metadata 
document (§12.7) under a new `delegations` field:

```json
{
  "delegations": [
    {
      "namespace": "logistics",
      "prefix": "shipments/eu-",
      "delegate_authority": "logistics-eu.partner.example",
      "delegate_root_key": "phip://logistics-eu.partner.example/keys/root",
      "scope": ["create", "push", "get", "history", "query"],
      "effective_from": "2026-04-01T00:00:00Z",
      "expires": "2027-04-01T00:00:00Z"
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `namespace` | MUST | Namespace name being delegated. Use `"*"` to delegate the entire authority (rare; usually transfer is more appropriate) |
| `prefix` | MAY | Local-id prefix the delegation applies to. If omitted, applies to the entire namespace |
| `delegate_authority` | MUST | Authority name that operates the delegated slice |
| `delegate_root_key` | MUST | PhIP URI of the delegate's root key |
| `scope` | MUST | Operations the delegate may perform: subset of `["create", "push", "get", "history", "query"]` |
| `effective_from` | MUST | ISO 8601 timestamp the delegation begins |
| `expires` | MAY | Optional expiry; an absent `expires` indicates an open-ended delegation |
| `revocable` | MAY | Boolean. If `true`, the parent authority may revoke the delegation by removing the entry from its metadata document. Default `true` |

#### 4.5.2 Resolution Under Delegation

A client resolving `phip://parent.example/{namespace}/{local-id}` 
SHOULD:

1. Fetch the parent's `/meta` document and check `delegations`.
2. If a delegation entry matches the requested namespace and 
   prefix, follow the parent's redirect to the delegate's resolver. 
   The redirect MUST be accompanied by a `PhIP-Delegation: 
   <delegation-namespace>` header so the client knows the basis 
   for the cross-authority redirect.
3. Verify the delegate's responses by chaining trust from the 
   parent's root key to the delegate's root key (the delegation 
   entry in the parent's `/meta` constitutes the trust bridge).
4. Cache the delegation per `Cache-Control` headers; re-fetch on 
   `effective_from`/`expires` boundary or on cache invalidation.

**Delegation redirect mechanics.** The same-authority redirect rule 
of §4.3.3 has a second exception (the first being authority transfer 
in §4.6.4): a redirect from the parent authority to the delegate 
authority is permitted iff it is justified by an active delegation 
entry covering the requested namespace and prefix. The redirect 
response MUST include a `PhIP-Delegation: <namespace>` header naming 
the parent's namespace whose delegation justifies the cross-authority 
hop. Clients receiving such a redirect MUST:

1. Fetch the parent's `/meta` document if not already cached.
2. Locate a `delegations` entry whose `namespace`, optional `prefix`, 
   and `effective_from`/`expires` window cover the request.
3. Verify the entry's `delegate_authority` matches the redirect 
   target's host and the entry's `scope` includes the operation 
   being attempted.
4. If any check fails, treat the redirect as if it crossed authority 
   boundaries without justification — abort the request and surface 
   a transport-layer error (§4.3.3).

A `PhIP-Delegation` header without a corresponding `delegations` entry 
in the parent's `/meta` MUST be treated as if absent. Clients MUST 
NOT follow the redirect on faith.

#### 4.5.3 Writes Under Delegation

CREATE and PUSH operations against a delegated slice MUST be sent 
to the delegate's resolver, not the parent's. The parent's resolver 
MAY choose to:

- Reject CREATEs in the delegated slice with `FOREIGN_NAMESPACE` 
  (the delegate is now the owner of that slice).
- Forward via `307`/`308` redirect to the delegate.

Either is conformant. Authorities SHOULD document their behavior 
in the `/meta` document.

#### 4.5.4 Revocation

Revocation of a delegation is a metadata change at the parent's 
`/meta` endpoint: the delegation entry is removed (or has its 
`expires` shortened to a past time). After revocation:

- New writes to the delegated slice at the delegate's resolver 
  remain locally valid but are no longer recognized by the parent.
- Reads SHOULD continue to be served by the delegate for the 
  pre-revocation history. The parent SHOULD publish mirror URLs 
  (§4.6.5) covering the revoked slice if the delegate becomes 
  uncooperative.
- Hash chains accumulated during the delegation period remain 
  valid. The parent does not retroactively invalidate the chain — 
  it just stops accepting new events under the parent's authority 
  for that slice.

Resolvers SHOULD log delegation revocations and SHOULD make them 
visible via `/meta` history (an authority's `/meta` document is 
itself addressable as a PhIP object — its event history records 
delegation lifecycles).

#### 4.5.5 Sub-Delegation

A delegate MAY further delegate its slice if its root key is used to 
sign the sub-delegation entry in its own `/meta`. Sub-delegation 
chains MUST NOT exceed the depth permitted by the original parent. 
The original parent MAY constrain depth via a `max_subdelegation` 
field on the delegation entry; absence means unlimited depth, which 
is RECOMMENDED only for trusted partner relationships.

### 4.6 Authority Transfer

PhIP URIs MUST keep resolving past the operational lifetime of the 
original authority (Section 4.2). When an authority is acquired, 
renamed, dissolved, or otherwise becomes unable to host its own 
resolver, it transfers control of its namespaces to a successor via 
the mechanism in this section.

This section defines the cryptographic and protocol machinery; 
governance — who is allowed to declare an authority defunct, how 
disputes are resolved — is outside the scope of v0.1.

#### 4.6.1 Root Authority Key

Each authority SHOULD provision a **root authority key**: a long-lived 
Ed25519 keypair held in cold storage and used **only** to sign 
authority-level events. The root key is distinct from operational 
signing keys (Section 11.2).

The root key is published as a key resource on the operational track 
under a well-known local-id:

```
phip://{authority}/keys/root
```

The root key resource SHOULD use a long validity window 
(`not_after` ≥ 10 years from `not_before`) and SHOULD NOT be used to 
sign individual events. Its purpose is to authorize transfer events 
and to anchor trust when the authority is no longer reachable.

An authority that does not provision a root key MAY still operate but 
forfeits the ability to perform a verifiable authority transfer; in 
practice, its URIs become irrecoverable when the DNS name expires.

#### 4.6.2 The authority_transfer Event

Authority transfer is recorded as a new event type:

| Type | Description |
|---|---|
| `authority_transfer` | The authority of one or more namespaces is transferred to a successor. MUST be signed by the source authority's root key |

The event is appended to a special **authority record**:

```
phip://{authority}/.well-known/authority
```

This is a PhIP object of type `actor` representing the authority 
itself. Its history records key rotations, namespace registrations, 
and any transfer events. The authority record's `created` event MUST 
be signed by the root key (a self-signed bootstrap, per Section 
11.2.4 conventions adapted for the authority record).

The payload shape is defined by `schemas/authority-transfer-payload.json`
alongside the prose below.

An `authority_transfer` event payload:

```json
{
  "type": "authority_transfer",
  "payload": {
    "namespaces": ["parts", "lots", "racks"],
    "successor_authority": "newco.example",
    "successor_root_key": "phip://newco.example/keys/root",
    "effective_from": "2027-01-01T00:00:00Z",
    "rationale": "Acme acquired by NewCo (2026-12-15). Sole transfer of all asset records."
  }
}
```

| Field | Required | Description |
|---|---|---|
| `namespaces` | MUST | Array of namespace strings transferred. MAY be `["*"]` to transfer all namespaces under the authority |
| `successor_authority` | MUST | Authority name (DNS label) the namespaces transfer to |
| `successor_root_key` | MUST | PhIP URI of the successor's root key resource. Verifiers MUST resolve and validate this key before accepting subsequent events under the transferred namespaces |
| `effective_from` | MUST | ISO 8601 timestamp at which the transfer takes effect. Events appended after this timestamp under the transferred namespaces SHOULD be hosted by the successor |
| `rationale` | SHOULD | Human-readable explanation |

After `effective_from`, GETs to the source authority for objects in 
the transferred namespaces SHOULD respond with `308 Permanent 
Redirect` to the successor's URL (Section 4.3.3 same-authority 
redirect rule is relaxed for transferred objects — see 4.6.4).

#### 4.6.3 Verification

A client receiving an object whose history includes events under both 
the source and successor authorities MUST verify:

1. The chain is intact across the transfer point (no break in 
   `previous_hash` continuity).
2. The transfer event is signed by the source authority's root key.
3. The source authority's root key was within its validity window at 
   `effective_from`.
4. Events appended after `effective_from` under the transferred 
   namespaces are signed by keys whose chain of trust roots in the 
   successor's root key.
5. The transfer event's `successor_authority` matches the authority 
   serving the post-transfer events.

If any of these checks fail, the client MUST reject the chain as 
non-authentic. Implementations SHOULD cache root key fingerprints out 
of band (e.g., trust-on-first-use with explicit pinning for 
high-stakes deployments) to mitigate the risk of root key compromise.

#### 4.6.4 Redirects After Transfer

The same-authority-only redirect rule in Section 4.3.3 has one 
exception: a redirect from the source authority to the successor 
authority is permitted **iff** the response includes (or the client 
has previously fetched and cached) a valid `authority_transfer` event 
covering the requested object's namespace.

Resolvers MAY signal a transfer to clients via a 
`PhIP-Transfer-Event: <event-id>` HTTP header on the redirect, naming 
the transfer event the redirect is justified by. Clients that have not 
yet seen this event MUST fetch it from either the source or successor 
authority record before following the redirect.

#### 4.6.5 Mirrors and Archival

When the source authority is unreachable (DNS expiration, server 
shutdown), clients fall back to mirrors listed in the successor's 
metadata document (Section 12.7 `mirror_urls`). A mirror is a 
read-only host serving a frozen snapshot of the source authority's 
records as of `effective_from` (or a later snapshot if the source 
continued to operate post-transfer).

Mirrors MUST serve the snapshot under the source authority's URI 
namespace (`/.well-known/phip/resolve/{namespace}/{local-id}`) so 
that hash chains continue to verify byte-for-byte. Mirror responses 
MUST set `Cache-Control: public, immutable` and SHOULD set a long 
`max-age` (≥ 1 year), since mirrored data does not change.

A client that retrieves an object from a mirror MUST verify the 
authority-transfer chain back to the original authority record, not 
just the local hash chain. This prevents a malicious mirror from 
serving a forked history.

#### 4.6.6 Multiple Transfers

An authority that has already received transfers MAY transfer 
namespaces onward. The verification chain extends accordingly: a 
client validating an object that has passed through three authorities 
MUST verify two transfer events, each signed by the previous 
authority's root key. There is no fixed depth limit; resolvers SHOULD 
limit transfer-chain depth to a configurable maximum (RECOMMENDED: 
10) to bound verification cost.

#### 4.6.7 Non-Goals

This section deliberately does not specify:

- Who decides an authority is defunct. (Governance is out of scope.)
- How root keys are recovered or rotated under coercion. (Recovery 
  procedures are an authority's internal concern.)
- Cross-authority dispute resolution if two parties claim to be 
  successors. (Off-protocol; rely on the legal record.)

These are real problems. v0.1 provides the cryptographic primitive; 
operational ecosystems will need to build governance on top.

---

## 5. Object Model

Every PhIP Object MUST contain the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `phip_id` | PhIP URI | MUST | Globally unique persistent identifier |
| `object_type` | string (controlled) | MUST | See Section 6 |
| `state` | string (controlled) | MUST | Current lifecycle state. See Section 9 |
| `history` | array | MUST | Append-only event log. See Section 10. MUST NOT be null or absent. MAY be empty for newly created objects |
| `identity` | object | SHOULD | Human-meaningful identifiers. See 5.1 |
| `relations` | array | SHOULD | Links to related PhIP Objects. See Section 7 |
| `attributes` | object | MAY | Namespaced schema attributes. See Section 8 |

### 5.1 Object Fields as Projections

All top-level object fields (`state`, `identity`, `relations`, `attributes`) 
are projections derived from the event history. The `created` event payload 
is the authoritative source for initial field values. Subsequent events that 
modify fields (`state_transition`, `attribute_update`, `relation_added`, 
`relation_removed`, etc.) are the authoritative source for current values. 
Top-level fields MUST NOT be modified directly — they are computed from 
the history.

### 5.2 Identity Block

The `identity` block carries human-meaningful identifiers. These are 
informational and MUST NOT be used as the primary identifier in place of 
`phip_id`. Fields are OPTIONAL unless marked otherwise.

```json
{
  "identity": {
    "serial": "QCT88421-0042",
    "part_number": "QCT-SYS-E26G-2U",
    "manufacturer": "Quanta Computer",
    "revision": "B",
    "lot": "2026-Q1-BATCH-04"
  }
}
```

[TODO: define additional standard identity fields]

#### 5.2.1 Uncertainty Qualifiers

When ingesting legacy systems or rebuilding records from incomplete 
sources, identity fields are often imperfectly known. PhIP does not 
require certainty: any identity field MAY be qualified by appending a 
parallel `_quality` field carrying provenance metadata.

```json
{
  "identity": {
    "serial": "QCT88421-0042",
    "serial_quality": {
      "confidence": "high",
      "source": "manufacturer_label_scan",
      "as_of": "2026-04-12T09:00:00Z"
    },
    "lot": "2026-Q1-BATCH-04",
    "lot_quality": {
      "confidence": "low",
      "source": "operator_recollection",
      "note": "lot label damaged; inferred from adjacent units"
    }
  }
}
```

A `_quality` object MAY contain:

| Field | Description |
|---|---|
| `confidence` | One of `high`, `medium`, `low`, `unverified`. `high` = direct observation or trusted source; `unverified` = transcribed without checking |
| `source` | Free-text provenance (`manufacturer_label_scan`, `erp_export_2024`, `operator_recollection`, `inferred`) |
| `as_of` | ISO 8601 timestamp the value was last verified |
| `corrected_from` | Previous value if this field has been corrected. Useful for legacy onboarding |
| `note` | Free-text context |

Tools that consume identity fields MUST handle the qualified form 
identically to the unqualified form for matching and equality. 
`_quality` is metadata only — it does not change the field's value 
semantics.

The convention applies to any identity field. A field named `serial` 
has its qualifier as `serial_quality`; `part_number` → 
`part_number_quality`. Resolvers MUST NOT enforce that qualifiers 
exist for any particular field.

### 5.3 Minimal Valid Object

```json
{
  "phip_id": "phip://example.com/components/abc-001",
  "object_type": "component",
  "state": "stock",
  "history": []
}
```

---

## 6. Object Types

The `object_type` field MUST be one of the following values. Object type 
constrains which relations and lifecycle transitions are valid.

| Type | Description |
|---|---|
| `material` | Raw stock, bulk input, or substrate before discrete identity |
| `component` | Discrete manufactured or procured part with a serial identity |
| `assembly` | Two or more components joined into a higher-level unit |
| `system` | An assembly with active behavior (software, firmware, network identity) |
| `location` | A named physical place: facility, room, rack, shelf, bin |
| `vehicle` | A mobile location: truck, train car, ship, drone. May carry objects via `contains` and has a position that changes over time |
| `lot` | A logical grouping of identical items sharing a production identity |
| `actor` | A person, organization, or automated system that pushes events |
| `design` | A design specification or part-number revision. Target of `instance_of` relations. Has no physical instance. See Section 6.2 |

Custom types are NOT permitted in the core vocabulary. Domain extensions 
that require additional types SHOULD be proposed as amendments to this spec.

### 6.1 Location vs. Vehicle

A `location` is a fixed physical place. A `vehicle` is a mobile container 
whose geographic position changes over time. Both can be the target of 
`located_at` relations. Objects in transit are `located_at` a vehicle, which 
is itself `located_at` a geographic position or route.

A vehicle's position MAY be updated via `attribute_update` events on the 
vehicle object. Continuous GPS telemetry SHOULD NOT be stored as PhIP events; 
instead, a PhIP `attribute_update` SHOULD capture waypoints at meaningful 
state changes (departure, arrival, border crossing).

The standard schema for position, address, route, and geofence data is 
the `phip:geo` namespace (`schemas/geo.json`). Vehicles and locations 
SHOULD use it; custom geographic schemas are permitted but reduce 
interoperability.

### 6.2 Design Objects

A `design` object represents a specification, part-number revision, or 
build target — the abstract definition of a thing, not a physical 
instance. Designs are the target of `instance_of` relations from 
physical objects (components, assemblies, systems).

PhIP does not aim to replace product lifecycle management (PLM) systems 
such as Windchill, Teamcenter, or Arena. The `design` type is a thin 
addressable handle that lets `instance_of` resolve to a verifiable 
target across organizational boundaries — the authoritative design 
content typically lives in a PLM system referenced via 
`phip:external_record` (Section 15.3).

A `design` object MUST include the following identity fields:

| Field | Required | Description |
|---|---|---|
| `part_number` | MUST | Manufacturer's part number for the design |
| `revision` | MUST | Design revision identifier (e.g. `"A"`, `"3.2"`, `"2026-04-rev-7"`) |
| `description` | SHOULD | Human-readable description |
| `external_ref` | MAY | URL of the canonical design document in a PLM, drive, or other system |

Design objects follow the manufacturing track lifecycle (Section 9.2). 
The states map to design release status:

- `concept` — initial idea; subject to change
- `design` — actively under design work
- `prototype` — in physical prototyping
- `qualified` — design is approved
- `stock` — released for production use; physical objects MAY 
  `instance_of` this revision
- `decommissioned` — superseded; new physical objects SHOULD NOT use 
  this revision but existing instances remain valid
- `consumed` / `disposed` — design is retired

Design revisions are separate `design` objects, linked via the 
`supersedes` relation (Section 7.1). A new revision does not invalidate 
physical objects that `instance_of` the prior revision; their 
provenance trail continues to point at the revision they were actually 
built against.

### 6.3 instance_of Target Constraint

The `instance_of` relation MUST target a `design` object. An 
`instance_of` relation pointing at any other object type is invalid 
and MUST be rejected by the resolver with `INVALID_RELATION` (422).

This is a tightening of Section 7. Implementations published before 
this revision of the spec MAY have written `instance_of` relations 
pointing at `component` or `system` objects acting as informal type 
records. Authorities migrating to this version SHOULD register 
corresponding `design` objects and rewrite the relations via 
`relation_removed` + `relation_added` event pairs.

### 6.4 Lot Identity: Fungibility and Quantity

Lot objects represent groupings of identical or interchangeable items. 
Two fields on a `lot`'s `identity` are normative:

| Field | Type | Required | Description |
|---|---|---|---|
| `fungible` | boolean | MUST | `true` if the lot's units are mutually interchangeable for downstream use; `false` if individual units retain distinct identity within the lot |
| `quantity` | object | SHOULD | Current quantity. See 6.4.1 |

**Fungible lots** (`fungible: true`) — bulk materials (resin pellets, 
solder paste, copper bars), commodity ingredients (coffee beans, 
flour), and any grouping where pulling 1 kg from one end is 
equivalent to pulling 1 kg from the other. Fungible lots support 
`lot_split` and `lot_merge` operations freely.

**Non-fungible lots** (`fungible: false`) — batches of serialized 
items (a tray of 24 PCBs each with their own serial number, a pallet 
of named LiDAR units). Non-fungible lots SHOULD also be modeled as 
parents-of-components via `contains` relations to the individual 
items. `lot_split` on a non-fungible lot MUST preserve the identity 
of each contained item; the `resulting_lots` payload MUST list which 
items go to which resulting lot.

When `fungible` is absent, the resolver MUST treat the lot as 
fungible. New authorities SHOULD set the field explicitly.

#### 6.4.1 Quantity Tracking

A lot's `identity.quantity` field is an object with these fields:

| Field | Required | Description |
|---|---|---|
| `value` | MUST | Numeric quantity. MUST be ≥ 0 |
| `unit` | MUST | SI unit symbol (`kg`, `g`, `m`, `L`, `units`, etc.) |
| `as_of` | SHOULD | ISO 8601 timestamp of the most recent measurement |
| `precision` | MAY | Quantity precision (e.g., `0.001` for milligram precision on a kg-scale). Used as the conservation tolerance `ε` in §10.5.1 |

The current quantity is a projection of the event history. Each 
`lot_split`, `lot_merge`, and `attribute_update` that changes the 
quantity MUST be reflected by updating the lot's `identity.quantity`. 
The lot history is the authoritative record; the `identity.quantity` 
field is a convenience.

When a lot is partially consumed by a `process` event without a full 
split (e.g., 2 kg drawn from a 10 kg lot for a single build), the 
authority SHOULD emit an `attribute_update` event reducing 
`identity.quantity.value` accordingly. The remaining lot keeps its 
`phip_id`. This is the lightweight pattern for routine draw-down — 
`lot_split` is for events that produce new addressable sub-lots.

`quantity` is not strictly required for non-fungible lots that 
maintain a `contains` relation to every member, since the count is 
derivable. Authorities MAY include it anyway for query convenience.

##### 6.4.1.1 Shorthand Form in Event Payloads

Event payloads (`lot_split`, `lot_merge`, and ad-hoc `attribute_update`
content) MAY use a flat shorthand for terseness: a single `quantity_<unit>`
key carrying just the numeric value. The shorthand `quantity_kg: 12000`
is equivalent to the structured form `quantity: { value: 12000, unit: "kg" }`.
The mapping is purely lexical — `quantity_<unit>` SHALL be parsed as
`{ value: <number>, unit: "<unit>" }`.

The shorthand exists because lot event payloads commonly inline many 
quantities and the structured form bloats them. Outside of event 
payloads — including the lot's `identity.quantity` projection — the 
structured form is the canonical representation. Resolvers projecting 
shorthand into `identity.quantity` MUST emit the structured form.

When a payload uses shorthand, all quantities in that payload MUST 
share the same unit; mixed-unit shorthand (`quantity_kg` next to 
`quantity_units` in the same payload) is invalid. The `loss_quantity_<unit>`
form follows the same rule.

---

## 7. Relation Vocabulary

Relations express physical, logical, or temporal relationships between 
PhIP Objects. Each relation is a tuple of (type, phip_id).

### 7.1 Core Relations

| Relation | Inverse | Semantics |
|---|---|---|
| `contains` | `contained_in` | Spatial containment. The subject physically encloses the object |
| `connected_to` | `connected_to` | Physical interface connection. Bidirectional |
| `located_at` | — | Current position. Target MUST be of type `location` or `vehicle` |
| `derived_from` | — | Material provenance. The subject was produced from the object. Multiple `derived_from` relations express many-to-one derivation (e.g., metals recovered from multiple sources) |
| `replaces` | `replaced_by` | Temporal substitution. Subject took the place of object |
| `instance_of` | — | Subject is a physical instance of a design. Target MUST be of type `design` (Section 6.3) |
| `supersedes` | `superseded_by` | Subject `design` revision replaces an older `design`. Both endpoints MUST be of type `design` |
| `manufactured_by` | — | Subject was produced by the object. Object MUST be of type `actor` |

### 7.2 Relation Format

Each relation is a tuple of (type, phip_id) with an optional `metadata` 
object for positional, structural, or qualifying information.

```json
{
  "relations": [
    {
      "type": "contains",
      "phip_id": "phip://samsung.com/drives/MZ7L3960-SN8821",
      "metadata": {
        "slot": "drive-bay-3",
        "position": "front"
      }
    },
    {
      "type": "located_at",
      "phip_id": "phip://google.com/locations/SJC-DC4/row-7/rack-A/U12",
      "metadata": {
        "rack_unit": 12,
        "orientation": "front"
      }
    }
  ]
}
```

The `metadata` field is OPTIONAL. When present, it is a flat object of 
key-value pairs. PhIP defines no required metadata fields — the content 
is domain-specific and fully extensible. Common metadata fields include 
`slot`, `position`, `orientation`, `port`, and `rack_unit`.

Relation metadata MUST be included in `relation_added` event payloads 
so that it is part of the signed event chain:

```json
{
  "type": "relation_added",
  "payload": {
    "relation": {
      "type": "contains",
      "phip_id": "phip://samsung.com/drives/MZ7L3960-SN8821",
      "metadata": {
        "slot": "drive-bay-3"
      }
    }
  }
}
```

A `relation_removed` event payload uses the same structure — the 
`relation` field identifies the relation being removed by `type` and 
`phip_id`. The `metadata` field MAY be omitted in removal payloads.

Relation metadata is not namespaced (unlike object attributes) because 
it carries simple positional or structural data, not rich domain schemas.

### 7.3 Bidirectional Relations Across Authorities

Some relations are inherently bidirectional: `connected_to` describes 
an interface link that is symmetric by physics, and `contains` /
`contained_in` are inverses. When both endpoints live under the same 
authority, the resolver can validate that both sides agree. When the 
endpoints span authorities, **only the side under the writing 
authority can be enforced**.

The rules:

- A relation is **owned** by the object it is attached to (per §7.2). 
  An object's relations are mutable only by that object's authority 
  or by holders of capability tokens (§11.3).
- For `connected_to`, the writing authority MUST emit a 
  `relation_added` on its own object. The far-side object's 
  authority is expected (but not required) to emit a matching 
  `relation_added` of their own. The two events are independent.
- A `relation_added` event referencing a far-side `phip_id` MUST 
  NOT trigger any write on the far-side authority. Cross-authority 
  writes only happen via capability tokens (§11.3) and are explicit.
- Verifiers reading either side MAY check that the other side has 
  also recorded the relation. **Asymmetric relations 
  (one-side-only) MUST NOT be treated as proof of an actual physical 
  connection** — they may indicate a misconfiguration, a stale 
  record, or a deliberately partial view.

For `connected_to` specifically, the convention is:

```json
// On rack-007 (Acme):
{ "type": "connected_to", "phip_id": "phip://quanta.com/servers/Q88421" }

// On Q88421 (Quanta), if Quanta wishes to record the connection:
{ "type": "connected_to", "phip_id": "phip://acme.example/racks/rack-007" }
```

Quanta is under no obligation to record the inverse. Tools that need 
strong topology guarantees SHOULD prefer modeling both endpoints 
under one authority's namespace, or use cross-authority 
attestations that are explicitly signed by both parties (out of 
scope for v0.1).

For `contains` / `contained_in`, the same asymmetry holds. An 
authority that places an object inside a foreign container records 
`contained_in` on its own object; the container's authority is 
free to record the inverse `contains` or not. Resolvers MUST NOT 
require the inverse to be present.

### 7.4 Dangling Relations

A relation references a `phip_id` that may, at any later time:

- Be unreachable (the target authority is offline or has been 
  transferred without a reachable mirror).
- Return `404 OBJECT_NOT_FOUND` (the target was never registered or 
  was registered under a different `phip_id`).
- Return `403 ACCESS_DENIED` (the target is private to another 
  reader; §11.5).
- Resolve to a different object than expected (e.g. due to a 
  malicious authority).

PhIP does **not** guarantee referential integrity across the 
federation. The protocol is link-style, not foreign-key-style.

Consumers MUST handle dangling relations gracefully:

- Treat unreachable targets as **unknown**, not as evidence of 
  malformed data. Surface the unreachability to operators rather 
  than silently dropping the relation.
- Cache last-known state of frequently referenced foreign objects 
  to reduce the visible failure rate.
- On `OBJECT_NOT_FOUND` from a once-resolvable target, retain the 
  relation (the target may return) but flag the link as stale.

A new error code conveys the case where a relation in an event 
references a target that fails an integrity check the resolver does 
enforce locally:

| Code | HTTP | Description |
|---|---|---|
| `DANGLING_RELATION` | 422 | A `relation_added` event references a `phip_id` that the resolver was asked to verify and could not (e.g., the target lives in this authority's namespace but does not exist) |

`DANGLING_RELATION` is emitted only for **same-authority** lookups — 
when a relation_added in namespace A points at namespace A and the 
target does not exist. Cross-authority targets MUST NOT produce this 
error; they are accepted as-written and verified lazily by the 
reader.

### 7.5 Custom Relations

Custom relations MAY be used under a namespaced type:

```json
{ "type": "org:mycompany:mounted_on", "phip_id": "phip://..." }
```

Custom relation types MUST be namespaced. Bare unrecognized relation types 
MUST be rejected by a conformant resolver.

---

## 8. Schema Namespaces

The `attributes` block carries domain-specific data organized by schema 
namespace. This is the primary extensibility mechanism.

### 8.1 Namespace Format

```json
{
  "attributes": {
    "phip:datacenter": {
      "rack_units": 2,
      "power_draw_watts": 1200
    },
    "phip:software": {
      "firmware": "droyd-fw-2.1.4",
      "config_hash": "sha256:a3f9..."
    }
  }
}
```

### 8.2 Core Namespaces

| Namespace | Description | Status |
|---|---|---|
| `phip:mechanical` | Dimensions, weight, material, tolerances | Defined — `schemas/mechanical.json` |
| `phip:electrical` | Voltage, current, connector types | [TODO] |
| `phip:software` | Firmware, software versions, config hashes | Defined — `schemas/software.json` |
| `phip:datacenter` | Rack position, power, thermal | Defined — `schemas/datacenter.json` |
| `phip:compliance` | Certifications, life limits, chain of custody | Defined — `schemas/compliance.json` |
| `phip:geo` | Geographic position, address, route, geofence | Defined — `schemas/geo.json` |
| `phip:access` | Read access policy (Section 11.5) | Defined — `schemas/access.json` |
| `phip:keys` | Public key material on actor objects (Section 11.2) | Defined inline in Section 11.2 |
| `phip:procurement` | PO number, supplier, lead time | [TODO] |

### 8.3 Custom Namespaces

Organizations MAY define custom namespaces using their domain:

```
org:droyd.com:teleop
```

Custom namespace schemas SHOULD be published at a resolvable URL for 
interoperability.

### 8.4 Schema Versioning and Evolution

Schemas evolve over time as domains add fields, refine vocabularies, 
or correct mistakes. PhIP applies semantic versioning to schemas with 
explicit rules about which changes are additive and which are 
breaking.

#### 8.4.1 Versioning Scheme

Each schema version is identified by a semver string `MAJOR.MINOR`:

- `MAJOR` increments on breaking changes — anything that could cause 
  a previously-valid attribute block to be rejected by the new 
  schema, or that would change the interpretation of existing 
  fields.
- `MINOR` increments on additive changes — new optional fields, new 
  enum values, additional documentation.

Patch numbers are not used; documentation-only changes do not 
require a version bump (the schema content is unchanged).

The version is encoded in the schema's `$id`:

```
https://github.com/mfgs-us/phip/schemas/mechanical/v1.2.json
```

The unversioned URL (`schemas/mechanical.json`) MUST resolve to the 
latest stable version. Authorities that pin a specific version 
SHOULD use the versioned URL.

A schema's top-level `version` field carries the same string for 
in-document reference:

```json
{
  "$id": "...mechanical/v1.2.json",
  "version": "1.2",
  "title": "phip:mechanical",
  ...
}
```

#### 8.4.2 Additive Changes (MINOR bump)

The following changes MAY be made within a MAJOR version:

- Add a new OPTIONAL property.
- Add a new value to an enum (existing values keep their meaning).
- Tighten the description of an existing property without changing 
  its validation rules.
- Add a new pattern alternative to a `oneOf` schema.
- Mark a field as `deprecated` (the field still validates; consumers 
  are notified to migrate away).

Implementations validating against an older MINOR version MUST still 
accept attribute blocks that include newer optional fields — they 
will simply ignore unknown properties (which is consistent with the 
default `additionalProperties: true` of all PhIP core schemas).

#### 8.4.3 Breaking Changes (MAJOR bump)

The following changes REQUIRE a new MAJOR version:

- Remove a property.
- Rename a property (equivalent to remove + add).
- Tighten validation: change a property from optional to required, 
  add a new required property, narrow a numeric range, restrict an 
  enum.
- Change the type of a property.
- Change the semantic meaning of a value (even if the type and 
  validation are unchanged).

A new MAJOR version is a new schema. Both versions remain published 
at their respective `$id` URLs; the unversioned URL points at the 
latest, but resolvers SHOULD continue to validate against older 
versions for objects that were created against them.

Authorities migrating data between MAJOR versions SHOULD record the 
migration as an `attribute_update` event whose payload contains the 
rewritten data; the historical events with the old shape remain in 
the chain (consistent with §15's privacy framing — history is 
append-only).

#### 8.4.4 Schema Resolution

When validating an attribute block, a resolver follows this 
procedure:

1. If the attribute block contains a `$schema` field, validate 
   against that exact schema URL.
2. Otherwise, look up the namespace (`phip:mechanical`) in the 
   resolver's schema registry and validate against the latest 
   MINOR version of the latest MAJOR version the registry holds.
3. A `$schema` URL whose host or version is not in the registry 
   MUST be fetched from its `$id` URL on first use; the resolver 
   SHOULD cache fetched schemas with TTL guidance from the `/meta` 
   document of the schema host.

#### 8.4.5 Advertising Supported Schemas

A resolver's `/meta` document (§12.7) lists supported schema 
namespaces. To advertise version coverage, the entry MAY be a 
string (latest MAJOR.MINOR supported) or an object listing the 
exact range:

```json
{
  "schema_namespaces": [
    "phip:mechanical@1.2",
    {
      "namespace": "phip:datacenter",
      "min": "1.0",
      "max": "2.1"
    },
    "phip:software"
  ]
}
```

A bare namespace string (`"phip:software"`) means "latest version 
the resolver supports, no range constraint advertised." Clients 
SHOULD treat it as a soft signal only and rely on `$schema` URLs in 
attribute blocks for authoritative version selection.

#### 8.4.6 Compatibility Window

Authorities SHOULD support at least one MAJOR version older than 
the current one (i.e., N and N-1) for a minimum of 12 months after 
N is released. This gives downstream consumers time to migrate 
their writes. After the compatibility window, a resolver MAY 
reject `attribute_update` events that target the deprecated MAJOR 
version with `INVALID_OBJECT` (422), but it MUST continue to 
serve historical events written against the deprecated version 
unchanged.

#### 8.4.7 Initial Versioning

The schemas published with PhIP v0.1 are version `1.0`. The 
versioning rules above apply prospectively — future schema 
revisions move forward from 1.0. The unversioned URLs 
(`schemas/mechanical.json` etc.) currently resolve to v1.0; when 
v1.1 is published, they will resolve to v1.1.

---

## 9. Lifecycle State Machine

### 9.1 Lifecycle Tracks

Not all object types follow the same lifecycle. PhIP defines two tracks:

**Manufacturing track** — for types that are designed, produced, and 
eventually end-of-lifed: `material`, `component`, `assembly`, `system`, 
`lot`, `design`.

**Operational track** — for types that exist to support the protocol and 
don't go through a manufacturing lifecycle: `actor`, `location`, `vehicle`.

A resolver MUST enforce that each object type uses only its assigned track. 
An `actor` object MUST NOT use manufacturing track states, and a 
`component` MUST NOT use operational track states.

### 9.2 Manufacturing Track States

| State | Description |
|---|---|
| `concept` | Object exists as an idea or design intent only |
| `design` | Active design work. No physical instance exists |
| `prototype` | Physical instance exists for validation only |
| `qualified` | Approved for production. Design is frozen |
| `stock` | Physical instance exists, not yet deployed |
| `deployed` | In active use at an operational location |
| `maintained` | Temporarily removed from service for maintenance |
| `decommissioned` | Permanently removed from service |
| `consumed` | Subdivided, transformed, or absorbed into another object (lot splits, process inputs). The original identity no longer exists as a discrete unit but was not destroyed |
| `disposed` | Physically destroyed or scrapped |

#### 9.2.1 Manufacturing Track Transitions

A resolver MUST reject any event that attempts an invalid state transition.

```
concept        → design
design         → prototype, qualified
prototype      → design, qualified
qualified      → stock, consumed
stock          → deployed, decommissioned, consumed
deployed       → maintained, decommissioned
maintained     → deployed, decommissioned
decommissioned → consumed, disposed
```

`consumed` and `disposed` are terminal states. Objects in a terminal state 
MUST remain resolvable but MUST NOT accept further events.

### 9.3 Operational Track States

| State | Description |
|---|---|
| `planned` | Exists as an intent but not yet operational. A rack under construction, a vehicle being built, an employee not yet onboarded |
| `active` | In normal operation. An actor can push events, a location can receive objects, a vehicle can carry cargo |
| `inactive` | Temporarily unavailable. A person on leave, a facility closed for renovation, a vehicle in maintenance |
| `archived` | Permanently retired from use but preserved for historical reference |

#### 9.3.1 Operational Track Transitions

```
planned  → active, archived
active   → inactive, archived
inactive → active, archived
```

`archived` is a terminal state. Objects in `archived` state MUST remain 
resolvable but MUST NOT accept further events except `note`.

### 9.4 Condition Layer

Lifecycle state represents physical existence (where an object is in its 
life). Condition represents fitness for purpose (whether the object can 
fulfill its intended use). These are orthogonal — an object can be `deployed` 
but `condemned`, or `stock` but `degraded`.

Condition is expressed via the `phip:compliance` schema namespace, not as a 
lifecycle state:

```json
{
  "type": "attribute_update",
  "payload": {
    "namespace": "phip:compliance",
    "updates": {
      "condition": "condemned",
      "condition_reason": "temperature_exceedance",
      "condition_set_by": "phip://qaco.com/actors/inspector-44",
      "condition_timestamp": "2026-04-09T18:00:00Z"
    }
  }
}
```

Standard condition values:

| Condition | Description |
|---|---|
| `serviceable` | Fit for intended use |
| `degraded` | Partially fit, with restrictions |
| `condemned` | Not fit for intended use, pending disposition |
| `quarantined` | Held for inspection, fitness unknown |

Condition changes are recorded as `attribute_update` events and are 
subject to the same signing and hash chain requirements as all events.

### 9.5 Transition Events

A state transition MUST be recorded as an event in the history log before 
the object's `state` field is updated. The state field is a derived 
projection of the history — the history is canonical.

---

## 10. Event Log

### 10.1 Structure

The history is an append-only, ordered array of event objects. Events MUST 
NOT be deleted or modified after appending.

Each event MUST contain:

| Field | Type | Required | Description |
|---|---|---|---|
| `event_id` | string (UUID) | MUST | Unique identifier for this event |
| `phip_id` | PhIP URI | MUST | The object this event belongs to |
| `type` | string (controlled) | MUST | See 10.2 |
| `timestamp` | string (ISO 8601) | MUST | When the event occurred |
| `actor` | PhIP URI | MUST | The actor responsible. MUST be of type `actor` |
| `previous_hash` | string | MUST | SHA-256 hash of the previous event. `"genesis"` for the first event |
| `payload` | object | SHOULD | Event-type-specific data |
| `signature` | object | MUST | See Section 11 |

### 10.2 Event Types

| Type | Description |
|---|---|
| `created` | Object record created for the first time |
| `state_transition` | Lifecycle state changed. `payload` MUST include `from` and `to` |
| `attribute_update` | One or more attribute values changed |
| `relation_added` | A relation was added |
| `relation_removed` | A relation was removed |
| `software_update` | Software or firmware updated. `payload` MUST include `from` and `to` |
| `measurement` | A measurement or inspection result recorded |
| `process` | A transformation that consumes N input objects and produces M output objects, with optional yield ratios. See 10.4 |
| `lot_split` | A lot was divided into two or more new lots. See 10.5 |
| `lot_merge` | Two or more lots were combined into one. See 10.5 |
| `note` | Free-text annotation |
| `authority_transfer` | Authority over one or more namespaces transferred to a successor. MUST be signed by the source authority's root key and appear in the authority record. See Section 4.6 |

### 10.3 Hash Chain

The `previous_hash` field of event E[n] MUST be 
SHA-256(JCS(E[n-1])), where E[n-1] is the complete canonical JSON 
serialization of the preceding event including all of its fields 
(`event_id`, `phip_id`, `type`, `timestamp`, `actor`, `previous_hash`, 
`payload`, and `signature`). No fields are excluded.

The `previous_hash` value MUST be encoded as the string `sha256:` 
followed by the lowercase hexadecimal representation of the 32-byte 
SHA-256 digest (64 hex characters). Example: 
`sha256:a4f2c8e1...` (truncated).

The first event in a history (the `created` event) MUST set 
`previous_hash` to the string `"genesis"`.

This creates a verifiable chain. Any modification to a historical event 
invalidates all subsequent hashes.

Consumers MUST verify the full hash chain from genesis to head on first 
retrieval of an object from an untrusted source. Consumers MAY cache 
verification status and skip re-verification on subsequent retrievals 
from the same source, provided the chain head has not advanced. 
Re-verification is RECOMMENDED whenever the chain head changes.

Canonical JSON serialization MUST follow RFC 8785 (JSON Canonicalization 
Scheme / JCS). Specifically: keys sorted lexicographically, no insignificant 
whitespace, numbers serialized per ECMAScript rules, no duplicate keys. 
The hash is computed over the UTF-8 encoding of the canonical form.

This definition is load-bearing — the trust model (Section 11) depends 
entirely on deterministic serialization for both hash chain verification 
and signature computation.

### 10.4 Process Events

A `process` event represents a physical transformation — N inputs consumed 
to produce M outputs. This covers manufacturing steps (machining a part from 
a billet), recycling (melting electronics to recover metals), chemical 
processing, and similar transformations.

```json
{
  "type": "process",
  "payload": {
    "process_type": "metal_recovery",
    "inputs": [
      { "phip_id": "phip://recycler.com/intake/server-SN042", "consumed": true },
      { "phip_id": "phip://recycler.com/intake/server-SN043", "consumed": true }
    ],
    "outputs": [
      { "phip_id": "phip://recycler.com/materials/gold-batch-0042", "yield_fraction": 0.0002 },
      { "phip_id": "phip://recycler.com/materials/copper-batch-0042", "yield_fraction": 0.15 }
    ]
  }
}
```

When an input is marked `"consumed": true`, a corresponding `state_transition` 
event to `consumed` SHOULD be pushed to that input object. Output objects 
SHOULD have `derived_from` relations pointing to all input objects. 
Resolvers SHOULD reject a `consumed` input that has no corresponding 
`process` or `lot_split` event referencing it in any object's history.

**Note on atomicity:** PhIP v0.1 does not provide cross-object or 
cross-namespace transactional guarantees. A `process` event is a claim 
about a transformation, not an atomic transaction. The side effects on 
input objects (transition to `consumed`) and output objects (`derived_from` 
relations) are the pushing actor's responsibility and may fail independently. 
Full cross-namespace atomicity (two-phase commit or saga patterns) is 
deferred to a future version of this specification.

The `yield_fraction` field is OPTIONAL and represents the mass fraction of 
the input that contributed to this output. This enables proportional 
provenance tracking for regulated materials.

#### 10.4.1 Yield Fraction Semantics

When `yield_fraction` is supplied on outputs, the values MUST be 
non-negative real numbers in the closed interval `[0, 1]`.

The yield fractions on outputs that share a single input describe how 
that input was distributed across outputs. For each input referenced 
by one or more outputs, the sum of `yield_fraction` values on outputs 
that point at that input via `derived_from` MUST satisfy:

```
sum(yield_fraction_i) ≤ 1.0 + ε
```

where `ε` is a small rounding tolerance. Authorities SHOULD use 
`ε = 1e-6`. A sum strictly less than 1 is permitted — it represents 
material loss (slag, scrap, evaporation) that is not tracked as a 
distinct output.

A sum exceeding `1 + ε` MUST be rejected by the resolver with 
`INVALID_EVENT` (422). Sums exceeding 1 imply mass duplication, which 
violates conservation.

When an input has multiple `derived_from` outputs but yield fractions 
are absent, the resolver MAY treat the fractions as unspecified rather 
than implicit-equal-share — equal-share would be a guess, and absence 
is more honest. Tools that compute aggregate provenance SHOULD treat 
missing fractions as "unknown" and propagate uncertainty rather than 
substituting `1/N`.

#### 10.4.2 Numerical Representation

`yield_fraction` is serialized as a JSON number per RFC 8785 (JCS) — 
the canonical form is the shortest round-trip ECMAScript representation 
(Section 10.3). Authorities SHOULD avoid yield fractions with more than 
six significant digits; finer precision is below the rounding tolerance 
and creates spurious chain divergence.

When a single input is split across many outputs (e.g. a copper lot 
distributed across 100 cable spools), the recommended pattern is to 
quote each output's yield as a fraction with explicit shared 
denominator (e.g. `0.01` for each of 100 equal shares). Renormalizing 
to compensate for floating-point drift after the fact MUST NOT mutate 
already-emitted events; if the sum exceeds tolerance, the authority 
MUST emit a corrective `process` event (typically representing the 
lost or unaccounted material as an explicit output).

### 10.5 Lot Operations

Lots may be split or merged during their lifecycle.

**Lot Split:** A `lot_split` event is pushed to the original lot. The 
original lot transitions to `consumed`. New lots are created with 
`derived_from` relations pointing to the original.

```json
{
  "type": "lot_split",
  "payload": {
    "reason": "partial_spoilage",
    "resulting_lots": [
      { "phip_id": "phip://farmco.com/lots/arabica-LOT-0099-A", "quantity_kg": 12000 },
      { "phip_id": "phip://farmco.com/lots/arabica-LOT-0099-B", "quantity_kg": 6000 }
    ]
  }
}
```

**Lot Merge:** A `lot_merge` event is pushed to the resulting lot. Source 
lots transition to `consumed`. The resulting lot has `derived_from` relations 
pointing to all sources.

```json
{
  "type": "lot_merge",
  "payload": {
    "reason": "consolidation",
    "source_lots": [
      { "phip_id": "phip://farmco.com/lots/arabica-LOT-0099-A" },
      { "phip_id": "phip://farmco.com/lots/arabica-LOT-0099-B" }
    ]
  }
}
```

#### 10.5.1 Quantity Conservation

When source and resulting lots carry a quantity field 
(`quantity_kg`, `quantity_units`, etc.; see §6.4), lot operations 
MUST satisfy mass conservation within a small tolerance.

**Lot Split.** Sum of resulting `quantity_*` values MUST satisfy:

```
sum(resulting) ≤ source_quantity + ε
```

A sum strictly less than the source quantity is permitted — it 
represents recorded loss (the `reason` field SHOULD describe it: 
`partial_spoilage`, `sampling_loss`). The lot_split payload MAY 
include a `loss_quantity` field naming the lost amount explicitly:

```json
{ "type": "lot_split", "payload": { "loss_quantity_kg": 200, ... } }
```

A split where `sum(resulting) + loss_quantity > source_quantity + ε` 
MUST be rejected with `INVALID_EVENT` (422).

**Lot Merge.** Sum of source `quantity_*` values MUST equal the 
resulting lot's quantity within tolerance:

```
abs(sum(source) - resulting_quantity) ≤ ε
```

Mergers that introduce mass (e.g., adding a non-tracked filler) MUST 
NOT use `lot_merge`; a `process` event with the filler as an explicit 
input is the correct representation.

**Tolerance.** `ε` SHOULD be set to the smaller of:
- 0.1 % of the source quantity, or
- the unit precision of the relevant measurement (e.g. ε = 1g for 
  measurements taken on a gram-precision scale).

Resolvers MUST validate conservation only when **all** participating 
lots carry comparable quantity fields. Splits or merges between lots 
with mismatched units (`quantity_kg` and `quantity_units`) MUST NOT 
be silently allowed; the authority SHOULD emit a `process` event 
instead, since unit conversion is a transformation.

The `source_lots` array MUST contain at least two entries. Each source 
lot SHOULD be transitioned to `consumed` by the pushing actor.

---

## 11. Trust Model

### 11.1 Event Signing

Every event MUST be signed by the pushing actor. The signature is computed 
over the canonical JSON serialization of the event object excluding the 
`signature` field itself.

```json
{
  "signature": {
    "algorithm": "Ed25519",
    "key_id": "phip://droyd.com/keys/ops-signing-2026",
    "value": "base64url:..."
  }
}
```

The `key_id` MUST be a resolvable PhIP URI returning a public key resource. 
Verifiers resolve the key and verify locally. No online verification step 
is required.

### 11.2 Key Resources

A key resource is a PhIP object on the operational lifecycle track 
(`planned`, `active`, `inactive`, `archived`). Keys use the `actor` 
object type and carry their cryptographic material in the `phip:keys` 
attribute namespace.

#### 11.2.1 Key Object Format

```json
{
  "phip_id": "phip://droyd.com/keys/ops-signing-2026",
  "object_type": "actor",
  "state": "active",
  "identity": {
    "label": "Droyd Operations Signing Key 2026"
  },
  "relations": [
    { "type": "manufactured_by", "phip_id": "phip://droyd.com/actors/root-authority" }
  ],
  "attributes": {
    "phip:keys": {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "base64url-encoded-public-key",
      "not_before": "2026-01-01T00:00:00Z",
      "not_after": "2027-01-01T00:00:00Z"
    }
  },
  "history": [ ... ]
}
```

The `phip:keys` namespace uses JWK (RFC 7517) fields for the 
cryptographic material (`kty`, `crv`, `x`), extended with PhIP-specific 
validity fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `kty` | string | MUST | Key type. MUST be `"OKP"` for Ed25519 |
| `crv` | string | MUST | Curve. MUST be `"Ed25519"` |
| `x` | string | MUST | Public key, base64url-encoded |
| `not_before` | string (ISO 8601) | MUST | Start of key validity window |
| `not_after` | string (ISO 8601) | MUST | End of key validity window |

Private keys MUST NOT appear in key resources. Only public keys are 
published.

#### 11.2.2 Key Validity

An event signature is valid if and only if:

1. The `key_id` resolves to an `active` key resource
2. The event's `timestamp` falls within the key's `not_before` / 
   `not_after` window
3. The cryptographic signature verifies against the public key

A key transitions to `inactive` when revoked (compromised or 
superseded). A key transitions to `archived` when it has expired and is 
retained for historical verification only.

Events signed before a key's `not_after` or before its transition to 
`inactive` remain valid. Events signed after either boundary MUST be 
rejected by the resolver.

#### 11.2.3 Key Rotation

To rotate keys, an authority:

1. Creates a new key object signed by the current active key
2. Transitions the old key to `inactive` (if revoking) or allows it to 
   expire naturally (if retiring)

Multiple keys MAY be `active` simultaneously during a rotation window. 
Verifiers MUST accept signatures from any `active` key whose validity 
window covers the event timestamp.

#### 11.2.4 Bootstrap Key

An authority's first key has no prior key to sign its `created` event. 
The bootstrap key's `created` event is self-signed — the key signs its 
own creation. This is analogous to a self-signed root certificate in 
X.509.

A self-signed bootstrap key MUST be the first object created in any 
new PhIP namespace. All subsequent object creation events MUST be signed 
by the bootstrap key or by a key whose trust chain traces back to it.

Verifiers encountering a self-signed key MUST treat it as a trust anchor 
for that authority. Cross-authority trust (whether to trust another 
authority's bootstrap key) is outside the scope of this specification.

#### 11.2.5 Key Caching

Key resources change infrequently. Resolvers serving key objects SHOULD 
return `Cache-Control: max-age=86400` (24 hours) or longer. Verifiers 
SHOULD cache resolved keys aggressively and revalidate only when a 
signature references an unknown `key_id` or when the cached key's 
`not_after` has passed.

### 11.3 Capability Tokens

To push events to objects in a foreign namespace, an actor MUST present 
a capability token issued by the namespace authority.

#### 11.3.1 Token Format

The token shape is defined by `schemas/capability-token.json` 
(machine-readable JSON Schema) alongside the prose below.

```json
{
  "phip_capability": "1.0",
  "token_id": "cap-uuid-...",
  "granted_by": "phip://apple.com/actors/supply-chain-auth",
  "granted_to": "phip://foxconn.com/actors/build-system",
  "scope": "push_events",
  "object_filter": "phip://apple.com/objects/logic-board-*",
  "not_before": "2026-01-01T00:00:00Z",
  "expires": "2026-06-30T23:59:59Z",
  "signature": {
    "algorithm": "Ed25519",
    "key_id": "phip://apple.com/keys/supply-chain-signing-2026",
    "value": "base64url:..."
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `phip_capability` | string | MUST | Version. MUST be `"1.0"` |
| `token_id` | string (UUID) | MUST | Unique identifier for this token |
| `granted_by` | PhIP URI | MUST | The authority issuing the token. MUST be an `actor` in the target namespace |
| `granted_to` | PhIP URI | MUST | The actor authorized to use this token |
| `scope` | string | MUST | Permission granted. See 11.3.2 |
| `object_filter` | string | MUST | Glob pattern matching target `phip_id`s. Uses `*` for wildcard |
| `not_before` | string (ISO 8601) | MUST | Token validity start |
| `expires` | string (ISO 8601) | MUST | Token validity end |
| `signature` | object | MUST | Signature by the granting authority's key |

The `object_filter` uses simple glob syntax with `*` as the only 
wildcard character. `phip://apple.com/objects/logic-board-*` matches 
any object whose `phip_id` starts with that prefix.

#### 11.3.2 Scope Vocabulary

| Scope | Grants |
|---|---|
| `push_events` | Append any event type to matching objects |
| `push_state` | Append `state_transition` events only |
| `push_measurements` | Append `measurement` events only |
| `push_relations` | Append `relation_added` and `relation_removed` events only |
| `read_state` | Read object projection via GET (no history) |
| `read_history` | Read object projection AND full event history |
| `read_query` | Match objects via QUERY |

A token with `push_events` scope is a broad grant. The narrower scopes 
allow fine-grained delegation: a carrier transporting goods may receive 
`push_relations` (to update `located_at`) but not `push_state`. A sensor 
may receive `push_measurements` but nothing else.

The `read_*` scopes gate access to objects whose `phip:access` policy 
restricts reads (Section 11.5). A token MAY combine read and write 
scopes by being issued multiple times with different scope values; a 
single token has exactly one scope.

#### 11.3.3 Token Presentation

Capability tokens are presented via HTTP header on PUSH, GET, and QUERY 
requests:

```
Authorization: PhIP-Capability <base64url-encoded-token>
```

The custom `PhIP-Capability` scheme is used instead of `Bearer` because 
the token is self-contained and verifiable without contacting an 
authorization server.

Tokens MUST NOT be placed in the request body or query parameters. 
Request body is reserved for the event payload. Query parameters appear 
in server logs.

#### 11.3.4 Token Verification

A resolver MUST verify the following before accepting a cross-org push, 
in order:

1. Decode the token from the `Authorization` header
2. Verify the token's `signature` by resolving the `key_id` and checking 
   against the `granted_by` authority's public key
3. Check that the current time falls within `not_before` / `expires`
4. Check that the pushing actor's `phip_id` matches `granted_to`
5. Check that the target object's `phip_id` matches `object_filter`
6. Check that the event type is permitted by `scope`

If any check fails, the resolver MUST return `INVALID_CAPABILITY` (403). 
If no token is presented on a cross-org push, the resolver MUST return 
`MISSING_CAPABILITY` (403).

#### 11.3.5 Token Lifecycle

Tokens are issued out of band — the authority creates and signs the 
token and delivers it to the grantee via any mechanism (API call, secure 
email, manual exchange). PhIP v0.1 does not define an issuance protocol.

Tokens are short-lived by design. The `not_before` / `expires` window 
provides the primary security boundary. Resolvers SHOULD reject tokens 
with validity windows exceeding a configurable maximum (RECOMMENDED: 
90 days).

Revocation in v0.1 is handled by expiry. If a token must be invalidated 
before its `expires` time, the authority SHOULD rotate the signing key 
used to issue it, which invalidates all tokens signed by that key. 
Formal revocation lists are deferred to a future version.

#### 11.3.6 Cross-Org Relation Writes

When an object in namespace A has a `located_at` relation pointing to an 
object in namespace B (e.g., cargo located at a rail car), updating that 
relation requires a capability token from namespace A. The relation is 
owned by the object it is attached to, not the target it points to.

During custody transfers (e.g., goods in transit), the shipping party 
SHOULD issue a capability token with `push_relations` scope to the 
carrier, allowing the carrier to push `relation_added` and 
`relation_removed` events for `located_at` relations on the shipped 
objects.

#### 11.3.7 Multi-Party Custody Transfers

A custody transfer involves three actors: the **prior custodian** 
(who held the goods), the **carrier** (who moves them), and the 
**next custodian** (who receives them). The `located_at` relation on 
each shipped object MUST track this chain.

The recommended pattern:

1. The prior custodian issues a capability token with 
   `push_relations` scope, `granted_to` the carrier, and 
   `object_filter` matching the shipped objects. The token's 
   `expires` SHOULD bound the expected transit window plus a small 
   buffer.
2. At pickup, the carrier emits `relation_removed` for the previous 
   `located_at` (e.g., the warehouse) and `relation_added` for the 
   carrier's vehicle.
3. In transit, the carrier MAY emit further `attribute_update` 
   events on the vehicle (position via `phip:geo`) but SHOULD NOT 
   emit further `located_at` updates on the goods until handoff.
4. At delivery, the carrier emits a final `relation_removed` (off 
   the vehicle) and `relation_added` (at the next custodian's 
   location). The carrier's token SHOULD be allowed to expire 
   shortly after.
5. The next custodian, on accepting the goods, MAY then issue their 
   own tokens for downstream handling.

If transit is interrupted (theft, accident, force majeure), the 
prior custodian retains the right to update relations on the goods 
since the original token has not been revoked. They SHOULD emit a 
`note` event documenting the disruption and SHOULD revoke the 
carrier's token (per §11.3.5) before re-routing.

The carrier MUST NOT issue capability tokens of their own against 
the shipped objects — they hold a delegated capability, not 
ownership. Sub-delegation requires the prior custodian to issue a 
new token directly to the sub-carrier.

### 11.4 Automated and IoT Actors

Automated systems (IoT sensors, MES controllers, OTA update services) are 
valid PhIP actors. They MUST have their own PhIP-addressable actor records 
and signing keys, just like human actors.

Key management for IoT devices differs from human actors:

- Device keys SHOULD be provisioned at manufacturing time and stored in 
  hardware security modules (HSM) or trusted platform modules (TPM) where 
  available.
- Device keys SHOULD have shorter expiry periods than organizational keys.
- A device actor's record SHOULD include the `manufactured_by` relation to 
  its manufacturer and an `instance_of` relation to its device type.

#### 11.4.1 Telemetry Boundary

PhIP events are discrete, meaningful state changes — not continuous telemetry 
streams. An IoT sensor SHOULD NOT push every reading as a PhIP event. 
Instead:

- Continuous telemetry (temperature, vibration, GPS) SHOULD be stored in 
  external time-series systems.
- PhIP `measurement` events SHOULD capture conclusions drawn from telemetry: 
  threshold exceedances, anomaly detections, or periodic summaries.
- A `measurement` event MAY reference an external telemetry source via a 
  URL in its payload for detailed data.

#### 11.4.2 Measurement Event Payload

A `measurement` event MUST carry a payload of the following shape:

```json
{
  "type": "measurement",
  "payload": {
    "metric": "internal_temperature_c",
    "value": 87.4,
    "unit": "°C",
    "as_of": "2026-04-23T14:32:11Z",
    "method": "ntc_thermistor",
    "uncertainty": 0.5,
    "thresholds": {
      "warning": 80,
      "critical": 95
    },
    "outcome": "warning",
    "external_ref": {
      "url": "https://telemetry.acme.example/series/srv-042/temp?from=...&to=...",
      "content_hash": "sha256:8f4a...",
      "media_type": "application/json",
      "window": {
        "from": "2026-04-23T14:00:00Z",
        "to": "2026-04-23T15:00:00Z"
      }
    },
    "samples": 360
  }
}
```

| Field | Required | Description |
|---|---|---|
| `metric` | MUST | Identifier for what was measured (e.g. `internal_temperature_c`, `vibration_rms_mm_s`, `pressure_psi`). SHOULD reuse a domain vocabulary; custom metrics SHOULD be namespaced (`acme:nozzle_flow`) |
| `value` | MUST | Numeric or string measurement result. For derived results (`pass`/`fail`, `warning`), use a string |
| `unit` | SHOULD | SI or domain unit symbol. Omitted for unitless metrics or pass/fail outcomes |
| `as_of` | MUST | ISO 8601 timestamp the measurement applies to (the observation time, not the push time) |
| `method` | MAY | Free-text or controlled identifier for measurement method or instrument class |
| `uncertainty` | MAY | Numeric 1-σ uncertainty in the same `unit` as `value` |
| `thresholds` | MAY | Object naming the limits used to interpret the result. Common keys: `warning`, `critical`, `nominal_min`, `nominal_max` |
| `outcome` | MAY | Conclusion drawn from the measurement: `nominal`, `warning`, `critical`, `pass`, `fail`, `out_of_range` |
| `external_ref` | MAY | Pointer to detailed telemetry the measurement is summarizing or derived from. Format follows §15.3 (`url`, `content_hash`, `media_type`) plus an optional `window` describing the time range |
| `samples` | MAY | If derived from aggregated telemetry, the number of underlying samples |

The `external_ref.window` field SHOULD be present whenever 
`external_ref.url` returns time-series data — it lets verifiers 
re-derive the measurement from raw data without ambiguity about 
which slice was used.

A measurement that exists purely as a `value` + `as_of` (no 
external reference) is conformant. The external reference is for 
auditability when the source data is voluminous or proprietary.

Resolvers MUST NOT validate `metric` against a controlled vocabulary 
in v0.1; this would prevent domain extension. They SHOULD reject 
measurements whose `value` type does not match `unit` (e.g., a 
string `value` with a numeric unit makes no sense).

The `outcome` field is a derived assessment, not a raw datum. 
Authorities MAY emit subsequent `measurement` events with different 
`outcome` values if interpretation thresholds are revised; the 
historical `outcome` records what was concluded at the time. This 
distinction matters for regulated domains where the conclusion 
itself is auditable.

### 11.5 Read Access Control

PhIP objects are publicly readable by default. An authority MAY restrict
read access by attaching a `phip:access` attribute to an object.

#### 11.5.1 Access Policy

The `phip:access` attribute namespace defines the following fields:

| Field | Required | Description |
|---|---|---|
| `policy` | MUST | One of `public`, `authenticated`, `capability`, `private` (table below) |
| `policy_set_by` | MAY | PhIP URI of the actor who applied the current policy. Informational; the authoritative record is the event history |
| `policy_set_at` | MAY | ISO 8601 timestamp the current policy was applied |
| `rationale` | MAY | Human-readable note explaining the policy choice (e.g., "customer BOM under NDA", "public regulatory disclosure") |

`policy` values:

| Policy | Meaning |
|---|---|
| `public` | Anyone may GET, read history, and match in QUERY. Default if `phip:access` is absent. |
| `authenticated` | Caller MUST present a valid capability token with any `read_*` scope, regardless of `granted_to` |
| `capability` | Caller MUST present a capability token whose `granted_to` matches the requesting actor and whose scope covers the requested operation |
| `private` | No external reads. Only the authority itself may read. |

The policy applies to GET (`/resolve/`), GET history (`/history/`), and 
QUERY (`/query/`). It does not apply to PUSH or CREATE — those are 
gated separately by the existing write scopes.

The `phip:access` attribute MUST be writable only by the authority that 
owns the object. Attempts to update `phip:access` from a foreign 
namespace MUST be rejected with `FOREIGN_NAMESPACE` (403) regardless of 
any held capability tokens.

#### 11.5.2 Resolution Order

For a GET, GET-history, or QUERY request the resolver MUST evaluate, in 
order:

1. If the object's `phip:access.policy` is `public` (or `phip:access` is 
   absent), allow.
2. If the policy is `private`, reject with `ACCESS_DENIED` (403) unless 
   the requesting actor is the authority itself.
3. If the policy is `authenticated` or `capability`, decode any 
   `Authorization: PhIP-Capability` header. If absent, reject with 
   `MISSING_CAPABILITY` (403).
4. Verify the token signature, expiry, and `granted_to` per Section 
   11.3.4 steps 1–4.
5. Verify the token's `scope` covers the requested operation:
   - GET requires `read_state` or `read_history`
   - GET history requires `read_history`
   - QUERY requires `read_query`
6. Verify the token's `object_filter` matches the target `phip_id`. For 
   QUERY, the filter restricts which objects can be returned in the 
   match list — objects outside the filter MUST be silently omitted, 
   not returned with an error.
7. If the policy is `capability`, verify the requesting actor matches 
   `granted_to`.

If any check fails, return `ACCESS_DENIED` (403) for policy mismatches 
or `INVALID_CAPABILITY` (403) for token defects.

#### 11.5.3 QUERY Filtering

When QUERY is invoked without a token, the resolver MUST return only 
objects whose policy is `public`. When invoked with a token, the 
resolver MUST return only objects whose policy and ACL admit the 
requesting actor. Restricted objects MUST NOT appear in the response — 
omission is the only signal of inaccessibility.

This means QUERY result counts depend on the caller's identity. 
Resolvers SHOULD NOT advertise total counts that would leak the 
existence of restricted objects.

#### 11.5.4 Hash Chain Integrity Under Restriction

A restricted object's hash chain remains valid for any party who can 
read its history. The chain head MUST NOT be exposed via metadata 
documents, error responses, or any other side channel that bypasses 
the access policy. In particular, `CHAIN_CONFLICT` responses on PUSH 
to a restricted object MUST NOT include `current_head` if the pushing 
actor lacks a `read_state` or `read_history` scope; the resolver MUST 
instead return `ACCESS_DENIED` (403) and require the pusher to obtain 
read scope before retrying.

#### 11.5.5 Public-By-Default Rationale

PhIP keeps `public` as the default to preserve cross-organizational 
discovery for regulatory disclosures, safety certifications, and 
provenance claims that are intended to be verifiable by any party. 
Authorities that hold commercially sensitive data MUST attach 
`phip:access` explicitly — silence is consent.

### 11.6 Caller Authentication

Capability tokens (Section 11.3) declare *what* an actor is permitted 
to do. To enforce them under a `policy: capability` access mode 
(Section 11.5.1), the resolver also needs to know *who is making the 
request* — independently of the bearer-style token they present. 
Without a separate caller identity, the §11.5.2 step-7 check 
(`granted_to` matches the requesting actor) is structurally present 
but tautological.

PhIP defines two interoperable mechanisms for caller authentication. 
Resolvers that enforce `policy: capability` MUST implement at least 
one. Resolvers MAY accept both and let operators choose.

#### 11.6.1 Mutual TLS

The simplest mechanism: the resolver requires the client to present 
an X.509 certificate during the TLS handshake. The certificate is 
signed by a CA the resolver trusts. The certificate's identity field 
maps to a PhIP actor URI as follows:

1. The resolver looks for a Subject Alternative Name (SAN) of type 
   `URI` whose value is a PhIP URI (`phip://...`). If present and 
   valid, that URI is the caller's actor.
2. Otherwise, the resolver maps the certificate's Subject Common Name 
   (CN) to a PhIP actor URI via an operator-configured policy 
   (typically `cn → phip://{authority}/actors/{cn}`). This fallback 
   exists for compatibility with PKI deployments that don't issue 
   PhIP-aware certificates.

The resolver MUST then perform the §11.5.2 step-7 check: the 
identified actor MUST equal the token's `granted_to`.

mTLS is operationally heavy (cert provisioning, rotation, revocation 
via CRL/OCSP) but battle-tested. It is the recommended mechanism for 
production deployments that already operate a PKI.

#### 11.6.2 Signed Requests

For deployments that prefer not to operate mTLS (browser-originated 
calls, edge runtimes, mobile clients), the resolver MAY accept signed 
HTTP requests per RFC 9421 (HTTP Message Signatures). The caller 
signs the request with their PhIP actor key; the resolver verifies 
the signature against that actor's `phip:keys` material.

A PhIP signed request MUST satisfy the following profile:

1. **Algorithm.** `Ed25519` (RFC 9421 §3.3.6).
2. **Covered components.** Per RFC 9421 §2, "covered components" are
   the named items listed in the `Signature-Input` parentheses. The
   signature MUST cover the following four components, in this order:
   - `@method` (RFC 9421 derived component)
   - `@target-uri` (derived component)
   - `content-digest` (header, RFC 9530 SHA-256 digest of the request
     body; the header MAY be omitted only when the body is empty, in
     which case `content-digest` is also omitted from the covered set)
   - `phip-actor` (header — defined in 3 below)
3. **Required signature parameters.** The `Signature-Input` value
   MUST also carry these RFC 9421 §2.3 parameters:
   - `keyid` — a PhIP URI identifying the signing key actor
   - `created` — the Unix timestamp at which the signature was
     produced; used for the freshness check in 5 below
   The `alg` parameter is OPTIONAL; when present it MUST be `"ed25519"`.
4. **Header: `PhIP-Actor`.** A new request header carrying the PhIP
   URI of the signing actor. `keyid` and `PhIP-Actor` MAY be different
   — `keyid` is the key actor, `PhIP-Actor` is the requesting actor;
   the relationship is established by the requesting actor's
   `phip:keys` attribute or by the requesting actor delegating signing
   to the key actor.
5. **Signature freshness.** The `created` parameter MUST be within
   ±300 seconds of the resolver's current time. Older or future-dated
   requests MUST be rejected to mitigate replay.
6. **Replay window.** Resolvers SHOULD maintain a short-lived cache
   (≥ 600 seconds) of seen signature values keyed by `keyid` and
   `created` to reject exact replays.

Example (RFC 9421 illustrative format):

```
POST /.well-known/phip/push/parts/widget-001 HTTP/1.1
Host: acme.example
Content-Type: application/json
Content-Digest: sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:
PhIP-Actor: phip://acme.example/actors/operator-jane
Signature-Input: phip=("@method" "@target-uri" "content-digest" "phip-actor");\
                 keyid="phip://acme.example/keys/jane-laptop-2026";\
                 created=1735689600
Signature: phip=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKSrw==:
```

The resolver verifies by:
1. Resolving `keyid` to a key actor (locally or via federation).
2. Confirming the key actor is `active` and the request's `created` 
   timestamp falls within its validity window.
3. Reconstructing the signature base per RFC 9421 from the listed 
   covered components.
4. Verifying the Ed25519 signature against the resolved key.
5. Mapping `PhIP-Actor` to the requesting-actor identity for the 
   §11.5.2 step-7 check. The resolver MUST verify that the signing 
   key (`keyid`) is authorized to act for `PhIP-Actor` — typically 
   by checking that `PhIP-Actor`'s `phip:keys` attribute references 
   the same key, or that the key actor's history records a 
   `delegated_signing_for` relation pointing at `PhIP-Actor` (an 
   informal pattern; v0.1 leaves the binding mechanism to operator 
   policy).

If any step fails, the resolver MUST reject with `INVALID_SIGNATURE` 
(401) for cryptographic failures or `MISSING_CAPABILITY` (403) for 
absent signature headers on a `policy: capability` object.

#### 11.6.3 Header Co-existence

Both mechanisms MAY appear on the same request:

- mTLS provides transport-level identity (the connection is from 
  this client cert).
- `PhIP-Capability` provides the authorization grant (this client is 
  permitted to do X).
- `Signature` (RFC 9421) provides application-level identity — 
  optional when mTLS is used, required when mTLS is not.

When both mTLS and signed-request are presented, the resolver MUST 
verify that the identities agree. Disagreement MUST be treated as 
`INVALID_SIGNATURE` (401).

#### 11.6.4 Bearer Tokens Are Insufficient

A capability token alone is a bearer secret: anyone who steals the 
token impersonates the grantee. Section 11.6 exists because PhIP's 
trust model requires the resolver to bind the token to the actual 
requesting party, not just accept the token at face value. 
Resolvers serving `policy: capability` objects MUST NOT skip caller 
authentication on the grounds that the token "looks valid" — the 
bearer-only path is reserved for `policy: authenticated`, where any 
holder of any read scope is admitted.

---

## 12. Protocol Operations

All operations are over HTTPS. Request and response bodies are 
`application/json`.

### 12.1 CREATE

Register a new PhIP Object.

```
POST https://{authority}/.well-known/phip/objects/{namespace}
```

Request body: a signed `created` event containing the initial object 
record. The event MUST include the proposed `phip_id`, `object_type`, 
initial `state`, and any initial `identity`, `relations`, or `attributes`.

```json
{
  "event_id": "evt-uuid-...",
  "phip_id": "phip://droyd.com/units/047",
  "type": "created",
  "timestamp": "2026-04-09T10:00:00Z",
  "actor": "phip://droyd.com/actors/manufacturing-system",
  "previous_hash": "genesis",
  "payload": {
    "object_type": "system",
    "state": "concept",
    "identity": {
      "serial": "DRD-047",
      "model": "Droyd-v1"
    }
  },
  "signature": { ... }
}
```

The resolver MUST validate: event signature, `phip_id` uniqueness within 
the namespace, and that the initial state is valid for the object type 
(see Section 9). The resolver MUST reject creation if the `phip_id` is 
already registered.

CREATE is only valid within the caller's own authority. An actor MUST NOT 
create objects in a foreign namespace. Cross-org object creation requires 
the foreign authority to create the object and issue a capability token 
(Section 11.3) granting permission to push events to it.

Response: the created PhIP Object with the `created` event as the first 
(and only) entry in its `history`. HTTP 201 on success.

The `created` event becomes the genesis event of the object's hash chain. 
Its `previous_hash` MUST be the string `"genesis"`.

### 12.2 GET

Retrieve a PhIP Object by ID.

```
GET https://{authority}/.well-known/phip/resolve/{namespace}/{local-id}
```

Optional query parameters:

| Parameter | Description |
|---|---|
| `fields` | Comma-separated list of top-level fields to include |
| `depth` | Integer. How many levels of relations to resolve inline. Default 0 |
| `at` | ISO 8601 timestamp. Return the object's state at that point in time |

Response: PhIP Object JSON. HTTP 200 on success.

By default, GET returns the current state projection of the object with 
an empty `history` array. The response MUST include `history_length` 
(total event count) and `history_head` (SHA-256 hash of the most recent 
event) so that clients can determine chain state without fetching 
history.

```json
{
  "phip_id": "phip://droyd.com/units/047",
  "object_type": "system",
  "state": "deployed",
  "history_length": 847,
  "history_head": "sha256:a4f2c8...",
  "history": [],
  "identity": { ... },
  "relations": [ ... ],
  "attributes": { ... }
}
```

The `history_head` value is what a client MUST use as `previous_hash` 
when constructing a PUSH event.

#### 12.2.1 History Retrieval

The full event history is accessed via a sub-resource endpoint:

```
GET https://{authority}/.well-known/phip/history/{namespace}/{local-id}
    ?limit=100&cursor=...&order=asc
```

| Parameter | Description |
|---|---|
| `limit` | Maximum number of events to return. Default 100, max 1000 |
| `cursor` | Opaque pagination token from a previous response |
| `order` | `asc` (oldest first, default) or `desc` (newest first) |

Response:

```json
{
  "phip_id": "phip://droyd.com/units/047",
  "history_length": 847,
  "events": [ ... ],
  "next_cursor": "opaque-string-or-null"
}
```

The `events` array contains event objects in the requested order. 
`next_cursor` is `null` when there are no more events.

This is not a separate protocol operation — it is a sub-resource of GET, 
providing paginated access to the same history that the object model 
references.

#### 12.2.2 Cursor Stability

Cursors are opaque from the client's perspective: the resolver decides 
the encoding. Stability guarantees:

- **Within an object's lifetime**, a cursor returned by the resolver 
  MUST remain valid as long as the object exists. New events appended 
  after the cursor was issued are returned by subsequent paginated 
  requests; previously-returned events are NOT re-returned.
- **Across resolver restarts**, cursors MUST remain valid. Cursors 
  encode position in the chain (e.g., a hash, an index, a timestamp); 
  they MUST NOT depend on in-memory state lost on restart.
- **Across resolver replicas**, cursors MUST be portable. A cursor 
  issued by one replica of a resolver MUST be valid against any other 
  replica serving the same authority. This rules out memory-only 
  sequence counters as cursor encodings.
- **Across authority transfers** (§4.6), cursors MUST remain valid 
  against the successor for objects whose namespace was transferred, 
  provided the successor serves the full pre-transfer history.

A resolver that cannot honor a cursor (e.g., because it was issued 
against a snapshot the resolver no longer holds) MUST return 
`INVALID_QUERY` (422) with a `details.reason` of `cursor_expired` or 
`cursor_unrecognized`. Clients receiving this MUST re-request from 
the beginning rather than retrying with the same cursor.

Resolvers SHOULD NOT encode authority-private state in cursors. A 
cursor of the form `sha256:<hash-of-last-returned-event>` is a 
recommended pattern: stable across restart, portable across replicas, 
and verifiable client-side.

### 12.3 PUSH

Append an event to an object's history.

```
POST https://{authority}/.well-known/phip/push/{namespace}/{local-id}
```

Request body: a signed event object. The event's `previous_hash` field 
MUST match the current chain head of the target object.

The resolver MUST validate, in order:

1. Event structure (required fields, known event type)
2. Event signature (resolve `key_id`, verify)
3. Capability token (if cross-org push)
4. Hash chain continuity (`previous_hash` matches current head)
5. Lifecycle transition validity (if `state_transition` event)
6. Object model constraints (relation type constraints, track validity)

If validation fails at any step, the resolver MUST return the appropriate 
error response (see Section 12.6) and MUST NOT append the event.

Response: the appended event as stored. HTTP 201 on success.

#### 12.3.1 Concurrency and Chain Conflicts

The hash chain creates a serialization requirement: events MUST be 
appended strictly sequentially. If two actors push events concurrently, 
both will compute `previous_hash` from the same chain head. The first 
push succeeds; the second MUST be rejected with a `CHAIN_CONFLICT` error.

`CHAIN_CONFLICT` responses MUST include `current_head` in `details`, so 
the rejected client can re-sign and retry without an additional GET. 
The one exception is the read-access carve-out in §11.5.4: when the 
target object is restricted and the pushing actor lacks read scope, 
the resolver MUST suppress `current_head` and return `ACCESS_DENIED` 
(403) instead of `CHAIN_CONFLICT` (409). The pusher must obtain read 
scope before they can recover. §11.5.4 is the only condition under 
which `current_head` is withheld.

The rejected client MUST:

1. Re-fetch the object to obtain the new `history_head`
2. Recompute `previous_hash` using the new head
3. Re-sign the entire event (swapping `previous_hash` alone is 
   insufficient — the signature covers all fields)
4. Retry the PUSH

The resolver MUST NOT reorder, merge, or silently resolve concurrent 
pushes. The linear hash chain is the authoritative ordering.

Resolvers SHOULD process pushes to the same object serially to minimize 
conflict frequency. Maximum retry count and backoff strategy for 
`CHAIN_CONFLICT` recovery are client concerns; see §12.3.2 for general 
guidance that applies to retry behavior across all status codes, 
including the recommended exponential-backoff defaults.

#### 12.3.2 General Retry Guidance

Beyond `CHAIN_CONFLICT`, clients face transient transport-layer 
failures (network errors, 5xx responses, connection resets). To 
prevent every PhIP client library from inventing its own retry 
policy, the spec gives the following normative guidance:

**By HTTP status:**

| Status range | Retry semantics |
|---|---|
| `2xx` | Don't retry — operation succeeded |
| `3xx` | Don't retry as PhIP — follow the redirect per §4.3.3 / §4.5.2 / §4.6.4 |
| `400` | Don't retry — client error; retry will fail identically |
| `401`, `403` | Don't retry without remediation — auth/cap error; the client must obtain a valid token or actor identity first |
| `404` | Don't retry — object doesn't exist |
| `408`, `429` | Retry — honor `Retry-After` if present, else exponential backoff |
| `409` | Retry only if the underlying error code is recoverable: `CHAIN_CONFLICT` per §12.3.1; `OBJECT_EXISTS` and `DUPLICATE_EVENT` are NOT recoverable |
| `4xx` (other) | Don't retry — client error |
| `5xx` | Retry with exponential backoff |
| Network error (no response) | Retry with exponential backoff for idempotent methods (GET, HEAD); for POST, retry only when the resolver explicitly advertises idempotency via response headers, or when the client knows the request was idempotent (e.g., `event_id` deduplication on PUSH) |

**Backoff:** Clients SHOULD use exponential backoff with jitter. A 
recommended default: base 1 second, multiplier 2.0, jitter ±50%, 
maximum 30 seconds, maximum 5 attempts. Resolvers MAY advertise 
preferred backoff parameters via `/meta` in a future revision.

**Idempotency on POST.** PhIP events carry a unique `event_id`. A 
resolver receiving a duplicate `event_id` MUST return 
`DUPLICATE_EVENT` (409) without applying it twice. This makes PUSH 
safe to retry on transport failures: if the original request 
succeeded but the response was lost, the retry sees `DUPLICATE_EVENT` 
and the client knows the operation completed. Clients MAY treat 
`DUPLICATE_EVENT` as success when retrying after a transport failure.

CREATE is similarly idempotent on `event_id` (the genesis event's 
id is unique per object), but the natural error on retry is 
`OBJECT_EXISTS` rather than `DUPLICATE_EVENT` because the resolver 
sees the prior CREATE succeeded.

**Don't retry forever.** Clients SHOULD enforce a maximum total wall 
time per logical operation (recommended: 30 seconds for interactive 
calls, 5 minutes for batch ingestion). Retries that exceed this 
budget MUST surface the underlying error to the caller rather than 
masking it as a hang.

### 12.4 QUERY

Find objects matching criteria within a namespace.

```
POST https://{authority}/.well-known/phip/query/{namespace}
```

#### 12.4.1 Query Request Format

```json
{
  "filters": {
    "object_type": "component",
    "state": "deployed"
  },
  "attributes": {
    "phip:datacenter": {
      "rack_units": 2
    }
  },
  "relations": {
    "contains": "phip://nvidia.com/gpus/H100-*",
    "located_at": "phip://google.com/locations/SJC-DC4/*"
  },
  "return": "ids",
  "limit": 100,
  "cursor": "..."
}
```

All predicates are implicitly AND — every specified predicate must match 
for an object to be included in the result.

#### 12.4.2 Predicate Types

**Field filters** (`filters`): equality match on top-level object fields. 
Supported fields: `object_type`, `state`, `phip_id`. String values 
support glob patterns using `*` as the only wildcard character.

```json
{ "filters": { "object_type": "system", "state": "deployed" } }
```

**Attribute filters** (`attributes`): equality match on values within 
namespaced attribute schemas. The namespace must be specified. String 
values support glob patterns.

```json
{ "attributes": { "phip:software": { "firmware": "droyd-fw-2.*" } } }
```

**Relation filters** (`relations`): match objects that have a relation 
of the specified type whose target `phip_id` matches the given glob 
pattern.

```json
{ "relations": { "contains": "phip://damiao.com/motors/*" } }
```

Multiple relation filters are AND — the object must have all specified 
relations.

#### 12.4.3 Glob Pattern Syntax

Glob patterns use `*` as a wildcard matching zero or more characters. 
No other wildcard characters are defined. `*` does not match across 
the `://` scheme separator.

Examples:
- `phip://nvidia.com/gpus/*` — any GPU in Nvidia's namespace
- `droyd-fw-2.*` — any firmware version starting with 2.
- `*` alone matches any value

Regular expressions, range queries (greater than, less than), boolean 
combinators (OR, NOT), full-text search, aggregations, and 
cross-namespace joins are explicitly excluded from PhIP v0.1.

#### 12.4.4 Response Format

The `return` field controls response content:

**`"return": "ids"`** (default): returns an array of matching PhIP URIs.

```json
{
  "matches": [
    "phip://google.com/servers/srv-042",
    "phip://google.com/servers/srv-043"
  ],
  "total": 847,
  "next_cursor": "opaque-string-or-null"
}
```

**`"return": "objects"`**: returns an array of full PhIP Object 
projections (current state, no history).

```json
{
  "matches": [
    { "phip_id": "phip://google.com/servers/srv-042", "object_type": "system", ... },
    { "phip_id": "phip://google.com/servers/srv-043", "object_type": "system", ... }
  ],
  "total": 847,
  "next_cursor": "opaque-string-or-null"
}
```

`total` is the total count of matching objects (MAY be approximate for 
performance). `next_cursor` is `null` when no more results exist. 
`limit` defaults to 100 and MUST NOT exceed 1000.

#### 12.4.5 Query Scope

QUERY operates within a single namespace on a single authority. 
Cross-namespace and cross-authority queries are not supported in PhIP 
v0.1. A client that needs to query across authorities MUST issue 
separate QUERY requests to each authority.

QUERY does not require authentication by default — it returns the same 
objects that GET would return. Access control on QUERY results, if 
implemented, SHOULD be consistent with access control on GET.

### 12.5 Batch Operations

Resolvers MAY support batched CREATE and PUSH for bulk ingestion. 
Batch endpoints exist as siblings to the single-event endpoints:

```
POST https://{authority}/.well-known/phip/objects/{namespace}/batch
POST https://{authority}/.well-known/phip/push/{namespace}/batch
```

A resolver that supports batch operations MUST advertise it in the 
`/meta` document via `supported_operations` containing the values 
`"batch_create"` and/or `"batch_push"`.

#### 12.5.1 Batch Request

Request body is a JSON object with an `events` array. Each entry 
is a complete signed event identical in shape to a single-event 
CREATE or PUSH request.

```json
{
  "events": [
    { "event_id": "...", "phip_id": "phip://acme.example/parts/p-001", "type": "created", ... },
    { "event_id": "...", "phip_id": "phip://acme.example/parts/p-002", "type": "created", ... },
    { "event_id": "...", "phip_id": "phip://acme.example/parts/p-003", "type": "created", ... }
  ]
}
```

The batch MUST contain at most 1000 events. Resolvers MAY enforce a 
lower limit and MUST advertise it via 
`/meta.batch_max_events` (a positive integer, advisory).

#### 12.5.2 Batch Semantics

PhIP batches are **non-atomic**. Each event in the array is 
processed independently — there is no all-or-nothing behavior 
across the batch. This is consistent with the cross-namespace 
atomicity deferral in §10.4: PhIP v0.1 does not provide 
transactional guarantees.

The resolver processes events in array order. For PUSH batches 
targeting the same `phip_id`, this matters: each event in the 
batch sees the chain head left by the previous event in the batch 
(if it succeeded). For CREATE batches and PUSH batches targeting 
different `phip_id`s, ordering is not significant for correctness.

If an event fails (signature verification, chain conflict, schema 
violation, etc.), the resolver MUST:

- Record the failure in the response.
- Continue processing subsequent events in the batch (not abort).
- NOT roll back any successfully-processed events.

If a downstream client requires atomicity, it MUST submit the 
events one at a time and handle failures itself.

#### 12.5.3 Batch Response

The response body shape is the same regardless of individual event 
outcomes; the HTTP status code reflects the distribution per the 
table below. Body:

```json
{
  "results": [
    { "status": "created", "phip_id": "phip://acme.example/parts/p-001", "history_head": "sha256:..." },
    { "status": "error", "phip_id": "phip://acme.example/parts/p-002", "error": { "code": "OBJECT_EXISTS", ... } },
    { "status": "created", "phip_id": "phip://acme.example/parts/p-003", "history_head": "sha256:..." }
  ],
  "summary": { "total": 3, "succeeded": 2, "failed": 1 }
}
```

Each entry in `results` corresponds positionally to the input 
`events` array. Entries have:

| Field | Required | Description |
|---|---|---|
| `status` | MUST | `"created"`, `"appended"`, or `"error"` |
| `phip_id` | MUST | Object id the event targeted (echoed from the input) |
| `history_head` | When status is created/appended | New chain head |
| `error` | When status is error | Standard error envelope (§12.6) |

The HTTP status code is determined by the **distribution** of per-event 
outcomes, not by their absolute count:

| Outcome | HTTP status |
|---|---|
| All events in the batch succeeded | `200 OK` |
| Batch contains both successes and failures | `207 Multi-Status` (RFC 4918) |
| Every event in the batch failed | `422 Unprocessable Content` |
| Batch envelope itself is malformed (not a JSON object with an `events` array, or `events` exceeds the resolver's maximum) | `400 Bad Request` |

The 200 / 207 / 422 cases all return the body shape above; only the 
400 case returns a top-level error envelope (§12.6) without a 
`results` array. The batch operation itself does not produce a 5xx 
status when failures are per-event — 5xx is reserved for actual 
resolver-side problems.

#### 12.5.4 Batches Across Conformance Classes

Read-Only and Mirror resolvers (§13.2, §13.3) MUST reject batch 
endpoints with `405 OPERATION_NOT_SUPPORTED` since they do not 
implement writes.

### 12.6 Error Responses

All error responses MUST use `application/json` and the following format:

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Cannot transition from 'stock' to 'disposed' on manufacturing track",
    "details": {
      "current_state": "stock",
      "requested_state": "disposed",
      "valid_transitions": ["deployed", "decommissioned", "consumed"]
    }
  }
}
```

The `code` field is a machine-parseable string from the registry below. 
The `message` field is a human-readable description. The `details` field 
is OPTIONAL and carries error-code-specific context for debugging; its 
structure is not normative.

#### 12.6.1 Error Code Registry

| Code | HTTP Status | Description |
|---|---|---|
| `OBJECT_NOT_FOUND` | 404 | GET or PUSH to a non-existent PhIP ID |
| `OBJECT_EXISTS` | 409 | CREATE with a `phip_id` that is already registered |
| `CHAIN_CONFLICT` | 409 | PUSH `previous_hash` does not match current chain head. `details` MUST include `current_head`, except as carved out by §11.5.4 (restricted-read access) |
| `DUPLICATE_EVENT` | 409 | An event with this `event_id` already exists (replay protection) |
| `TERMINAL_STATE` | 409 | Object is in a terminal state and cannot accept events |
| `INVALID_SIGNATURE` | 401 | Event signature verification failed |
| `KEY_NOT_FOUND` | 401 | The `key_id` in the signature could not be resolved |
| `KEY_EXPIRED` | 401 | The signing key's validity window does not cover the event timestamp |
| `MISSING_CAPABILITY` | 403 | Cross-org push or restricted read without a capability token |
| `INVALID_CAPABILITY` | 403 | Capability token signature invalid, expired, or scope insufficient |
| `ACCESS_DENIED` | 403 | Read denied by the object's `phip:access` policy (Section 11.5) |
| `FOREIGN_NAMESPACE` | 403 | CREATE attempted in a namespace the caller does not own, or `phip:access` write attempted from a foreign namespace |
| `INVALID_OBJECT` | 422 | Object model validation failed (missing required fields, unknown type) |
| `INVALID_EVENT` | 422 | Event structure invalid (missing fields, unknown event type) |
| `INVALID_TRANSITION` | 422 | State transition not allowed on this object type's lifecycle track. `details` SHOULD include `valid_transitions` |
| `INVALID_TRACK` | 422 | State is not valid for this object type's lifecycle track |
| `INVALID_RELATION` | 422 | Relation type constraint violated (e.g., `located_at` target is not a `location` or `vehicle`) |
| `DANGLING_RELATION` | 422 | A same-authority relation references a `phip_id` that does not exist (Section 7.4) |
| `INVALID_QUERY` | 422 | Query predicate is malformed or uses unsupported features. For history pagination, `details.reason` MAY be `cursor_expired` (resolver no longer holds the cursor's anchor point) or `cursor_unrecognized` (cursor not issued by this resolver). See §12.2.2 |
| `OPERATION_NOT_SUPPORTED` | 405 | Resolver does not implement the requested operation under its declared conformance class (Section 13). Examples: writes against a Read-Only or Mirror resolver, QUERY against a Mirror resolver |

Error responses MUST NOT be signed. They are informational, not 
historical records. HTTPS is the integrity mechanism for error responses.

### 12.7 Metadata Document

The document shape is defined by `schemas/meta.json` (machine-readable
JSON Schema) alongside the prose below.

An authority MAY publish a metadata document describing its resolver's
capabilities:

```
GET https://{authority}/.well-known/phip/meta
```

A `200 OK` response is an `application/json` document with the following
fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol_version` | string | MUST | Spec version this resolver targets (e.g. `"0.1.0-draft"`) |
| `authority` | string | MUST | The authority name this resolver serves |
| `namespaces` | array of strings | MUST | Namespaces this resolver will accept CREATEs into |
| `schema_namespaces` | array of strings | SHOULD | Attribute namespaces whose schemas this resolver validates (e.g. `phip:mechanical`, `phip:software`) |
| `supported_operations` | array of strings | SHOULD | Subset of `["create", "get", "push", "query", "history", "batch_create", "batch_push"]` |
| `query_capabilities` | object | MAY | Optional map describing supported filter operators, glob syntax, sort orders |
| `root_key` | string | SHOULD | PhIP URI of this authority's root key (Section 4.6.1). Clients use this to anchor trust for transfer verification |
| `mirror_urls` | array of strings | MAY | URLs of read-only mirrors hosting frozen snapshots of this authority's records. See Section 4.6.5 |
| `successor` | object | MAY | Present iff this authority has been transferred. Object: `{ "authority": "newco.example", "transfer_event_id": "...", "effective_from": "..." }`. Clients SHOULD redirect subsequent requests to the successor |
| `delegations` | array of objects | MAY | Active sub-namespace delegations. See Section 4.5.1 for entry shape |
| `conformance_class` | string | SHOULD | One of `full`, `read-only`, `mirror`, `client-only` (Section 13). Absence implies `full` for compatibility with v0.1 resolvers |
| `batch_max_events` | integer | MAY | Advisory upper bound on events per batch CREATE/PUSH (cap is 1000 per §12.5; resolvers MAY enforce lower) |
| `mtls_required` | boolean | MAY | If `true`, clients MUST present a TLS client cert (Section 12.8.1) |
| `mtls_ca_bundle_url` | string | MAY | URL where the resolver publishes its CA bundle for client cert issuance (Section 12.8.1) |

A resolver that does not publish `/meta` is still conformant. Clients
that need a feature not advertised in `/meta` SHOULD attempt the
operation and handle the resulting error rather than refusing to
connect.

Servers responding to `/meta` SHOULD set `Cache-Control: public, max-age=3600`
or longer — the document changes infrequently.

### 12.8 HTTP Authentication

PhIP defines exactly one wire-level authentication mechanism for 
authorized operations:

- `Authorization: PhIP-Capability <base64url-encoded-token>` — a 
  signed capability token (§11.3). Used for cross-authority writes 
  and for restricted reads (§11.5).

This is the only authentication scheme that conformant resolvers 
MUST recognize on protocol endpoints (`/.well-known/phip/objects`, 
`/.well-known/phip/resolve`, `/.well-known/phip/push`, 
`/.well-known/phip/query`, `/.well-known/phip/history`).

#### 12.8.1 Transport Layer

All PhIP traffic MUST be carried over TLS (§4.3 requires HTTPS for 
the resolver endpoint). TLS provides confidentiality and integrity 
for the request/response stream; PhIP signatures provide 
authenticity for the events themselves.

A resolver MAY require mutual TLS (mTLS) to its protocol endpoints 
as an additional access control layer. mTLS is **transport-level** 
authentication and operates orthogonally to PhIP-Capability tokens — 
both can be required, neither replaces the other. A resolver that 
uses mTLS:

- MUST still validate any presented PhIP-Capability tokens per 
  §11.3.4.
- MUST NOT skip event signature verification on the basis of mTLS 
  (the event signature is what writes into the chain; mTLS does 
  not touch it).
- SHOULD document its trust anchor in the `/meta` document under a 
  new optional field:

  | Field | Type | Description |
  |---|---|---|
  | `mtls_required` | boolean | If `true`, clients MUST present a TLS client certificate signed by an acceptable CA |
  | `mtls_ca_bundle_url` | string | URL where the resolver publishes its CA bundle for client cert issuance |

#### 12.8.2 Non-Protocol Endpoints

Resolvers commonly expose endpoints outside `/.well-known/phip/` — 
admin consoles, health checks, metrics, log shipping, replication. 
These are not part of the PhIP wire contract. Resolvers MAY use any 
appropriate authentication mechanism on them: HTTP Basic, OAuth 2.0 
Bearer, session cookies, mTLS, etc. PhIP imposes no constraint on 
non-protocol endpoint authentication.

A resolver MUST NOT accept PhIP protocol writes on a non-protocol 
endpoint to bypass capability-token enforcement. Operations that 
modify chain state MUST go through the standard endpoints with 
their standard authentication, regardless of how the operator 
authenticates to the management plane.

#### 12.8.3 Other Authentication Schemes

PhIP v0.1 deliberately does NOT define:

- HTTP Basic authentication for protocol endpoints.
- OAuth 2.0 Bearer tokens for protocol endpoints.
- API-key headers for protocol endpoints.

Adding any of these would create ambiguity about which scheme 
authoritatively identifies the writing actor — `granted_to` in a 
PhIP-Capability is the only way an authority can verify the claim 
chain back to its issuing key. A bearer token issued by some other 
system cannot anchor the same chain of trust.

Resolvers MAY accept these schemes for **read-only** operations on 
**public** objects as a developer-convenience layer (e.g. an API 
key gates access to a query endpoint without authorizing any 
write), but MUST NOT route restricted reads (`phip:access` policy 
not `public`) or any writes through them.

---

## 13. Conformance

PhIP defines four conformance classes. A resolver MUST claim exactly 
one class in its `/meta` document via the `conformance_class` field 
(see §12.7) and MUST satisfy that class's full requirement set.

| Class | Operations | Use case |
|---|---|---|
| **Full** | CREATE, GET, PUSH, QUERY, history | A primary resolver — runs an authority's namespaces day-to-day |
| **Read-Only** | GET, QUERY, history | Public-facing replica, reporting endpoint, regulator-facing portal |
| **Mirror** | GET, history (frozen snapshot) | Archival mirror for a transferred or defunct authority (§4.6.5) |
| **Client-Only** | None as server; consumes the protocol | A client library or application — does not host objects |

The four classes share most requirements; they differ on which 
operations they expose and on the strictness of certain checks.

### 13.1 Full Resolver

A Full resolver MUST:

- Implement CREATE, GET (including history sub-resource), PUSH, and 
  QUERY operations
- Assign and maintain persistent PhIP URIs
- Validate object model structure on write, including relation metadata
- Enforce the correct lifecycle track (manufacturing or operational) per 
  object type
- Enforce lifecycle transition rules within the assigned track
- Validate process event inputs/outputs and enforce `consumed` transitions
- Validate lot split/merge operations
- Verify event signatures against resolved key resources (Section 11.2)
- Validate key validity windows (`not_before` / `not_after`) against 
  event timestamps
- Maintain hash chain integrity per RFC 8785 (JCS) serialization
- Return `CHAIN_CONFLICT` (409) on concurrent push conflicts with 
  `current_head` in error details, subject to the §11.5.4 read-access 
  carve-out (Section 12.3.1)
- Verify and enforce capability tokens for cross-org writes, including 
  scope validation (Section 11.3)
- Return standard error responses per Section 12.6
- Return objects in terminal states (`disposed`, `consumed`, `archived`) 
  on GET
- Return `history_length` and `history_head` on GET responses
- Support cursor pagination on history retrieval and QUERY responses

A Full resolver SHOULD:

- Support the `depth` parameter on GET
- Support the `at` parameter on GET for point-in-time queries
- Validate condition values against the standard vocabulary
- Support `Cache-Control` headers on key resource responses
- Publish its supported schema namespaces

### 13.2 Read-Only Resolver

A Read-Only resolver MUST satisfy every requirement of a Full 
resolver **except** the write operations. Specifically, it MUST:

- Implement GET (including history sub-resource) and QUERY
- Validate signatures and hash-chain integrity on served events
- Return objects in terminal states unchanged
- Return `history_length` and `history_head` on GET responses
- Support cursor pagination

A Read-Only resolver MUST reject CREATE and PUSH attempts with 
`405 Method Not Allowed` (HTTP-level — there is no PhIP error code 
for this case, since the server is not refusing on protocol grounds 
but on capability). The response body SHOULD include an error 
envelope with code `OPERATION_NOT_SUPPORTED`:

| Code | HTTP | Description |
|---|---|---|
| `OPERATION_NOT_SUPPORTED` | 405 | Resolver does not implement the requested operation under its declared conformance class |

A Read-Only resolver SHOULD obtain its data by replication from a 
Full resolver of the same authority. The replication mechanism is 
out of scope for v0.1; the only normative requirement is that 
served events MUST verify against the authority's keys.

### 13.3 Mirror Resolver

A Mirror resolver serves a frozen snapshot of another authority's 
records (§4.6.5). It MUST:

- Implement GET and history sub-resource only
- Serve content under the **original** authority's URI namespace 
  (`/.well-known/phip/resolve/...`), not its own
- Set `Cache-Control: public, immutable` and a long `max-age` 
  (≥ 1 year) on all responses
- Decline QUERY with `405 OPERATION_NOT_SUPPORTED` — query results 
  against a mirror could go out of date silently as the mirror's 
  index drifts; clients needing query MUST use the Full resolver 
  or a Read-Only replica

Mirror operators MUST publish their mirror URL in the source 
authority's `/meta.mirror_urls` (§12.7) for discoverability.

### 13.4 Client-Only Implementations

A client library or end-user application that consumes PhIP but 
does not host objects MUST:

- Implement RFC 8785 (JCS) canonicalization producing byte-identical 
  output to the test vectors (`tests/vectors/jcs/`)
- Compute hashes per §10.3 (the `sha256:` + 64-hex form)
- Sign and verify Ed25519 signatures per §11.1
- Verify hash chains per §10.3 on read
- Honor the same-authority redirect policy of §4.3.3 and the 
  authority-transfer exception of §4.6.4

A client-only implementation SHOULD reproduce every fixture in 
`tests/vectors/` from its native runtime before being declared 
conformant. The HTTP suite at `tests/conformance/` does not apply 
to client-only implementations — the conformance suite exercises 
server endpoints, which clients do not host.

### 13.5 Cross-Class Notes

Resolvers MAY change conformance class over their lifetime — for 
example, a Full resolver becomes a Read-Only resolver when its 
authority is transferred (§4.6) and writes are redirected. The 
class change SHOULD be reflected in `/meta` and SHOULD trigger a 
client-side cache invalidation.

A resolver MUST NOT silently downgrade: if it stops accepting 
writes, it MUST return `405 OPERATION_NOT_SUPPORTED` rather than 
appearing to accept them. Silent downgrade is a high-impact 
failure mode that breaks chain integrity from the writer's 
perspective.

A conformance test suite is maintained alongside this specification in the
`tests/` directory of the reference repository. It has two independent
components:

- `tests/vectors/` — language-agnostic fixtures that lock down the wire
  format: RFC 8785 canonicalization output, SHA-256 hash encoding,
  Ed25519 signing and verification, URI parsing, hash-chain continuity,
  lifecycle transition tables, and the self-signed bootstrap key pattern
  (Section 11.2.4). A client library is byte-compatible with the reference
  implementation iff it produces identical output on every fixture.

- `tests/conformance/` — a black-box HTTP suite that exercises a running
  PhIP server's `/.well-known/phip/*` endpoints through the full v0.1
  contract: CREATE, GET, PUSH, QUERY, `/history/`, chain-conflict
  handling, and error envelopes from Section 12.6.

Compliant implementations SHOULD execute both components before publishing
a release.

---

## 14. Security Considerations

[TODO: expand each]

- **Key compromise** — if a signing key is compromised, historical events 
  signed with it remain in the record. Key rotation and revocation procedures 
  are required.
- **Authority compromise** — an authority can issue fraudulent capability 
  tokens. Downstream consumers should apply skepticism proportional to 
  object criticality.
- **Replay attacks** — event timestamps and UUIDs MUST be validated. 
  Resolvers MUST reject duplicate event_ids.
- **Denial of service** — QUERY endpoints are a potential amplification 
  vector. Rate limiting is RECOMMENDED.
- **URI squatting** — PhIP relies on DNS for authority. DNS hijacking 
  would compromise namespace integrity.

---

## 15. Privacy Considerations

PhIP histories are append-only and signed. This is the right design for 
provenance, but it sits in tension with privacy-by-design and with 
data-protection regimes (GDPR, CCPA, PIPEDA, and similar) that grant 
data subjects a right to erasure. PhIP does not solve this conflict; it 
provides hooks that let an authority remain compliant by keeping 
personal data **out of the chain in the first place**.

**This section defines architectural conventions, not a compliance 
framework.** Legal compliance is the authority's responsibility. PhIP's 
job is to not prevent it.

### 15.1 No Raw PII in Events

A conformant authority MUST NOT place raw personal data in event 
payloads. "Personal data" includes (non-exhaustively): names, email 
addresses, postal addresses, phone numbers, government identifiers, 
biometric data, precise geolocation, and any unique identifier that 
maps directly to a natural person.

Acceptable event metadata includes:

- Actor URIs (`phip://acme.example/actors/operator-7421`) — these are 
  pseudonymous identifiers under the authority's control and can be 
  re-mapped or retired without rewriting history.
- Timestamps, lifecycle states, lifecycle transitions, hash values.
- Object-level attributes that describe the *thing*, not the person 
  (serial numbers, dimensions, certifications).

A `note` event payload of `"Inspected by Jane Doe at 555-1234"` is a 
spec violation. The same information rendered as `"Inspected by 
phip://acme.example/actors/inspector-jane-d"` is conformant.

### 15.2 Personal Data Namespace Convention

When an event MUST reference personal data — for traceability, 
regulatory audit, or contractual obligation — the data MUST be carried 
indirectly via the `phip:personal_data` attribute namespace.

Values under `phip:personal_data` MUST be **commitments** (cryptographic 
hashes with per-record salts), never raw values:

```json
{
  "phip:personal_data": {
    "subject_commitment": "sha256:c2b8d7e4...8f4a4e3c",
    "salt_id": "salt-2026-04-001",
    "data_class": "operator_identity",
    "external_record": "phip://acme.example/records/operator-mapping-2026"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `subject_commitment` | MUST | Salted hash of the personal data, encoded per Section 10.3 |
| `salt_id` | MUST | Identifier of the salt used. Salts MUST be unique per record |
| `data_class` | SHOULD | Free-text category (e.g. `operator_identity`, `customer_contact`) |
| `external_record` | MAY | PhIP URI or URL of the off-chain record holding the raw data |

Salts and the salt → raw-data mapping MUST be stored outside the PhIP 
chain, in a system that supports deletion. Erasing a salt 
cryptographically severs the commitment from any subject — the 
commitment becomes an opaque hash with no recoverable original. This 
is the spec's primary erasure mechanism: **delete the salt, and the 
chain forgets.**

### 15.3 External Record References

When an event references off-chain data that is not itself personal 
(e.g., a measurement file, an inspection photo, a contract PDF), the 
reference SHOULD use the `phip:external_record` attribute namespace:

```json
{
  "phip:external_record": {
    "url": "https://records.acme.example/inspections/2026/04/INS-99421",
    "content_hash": "sha256:8f4a4e3c...c2b8d7e4",
    "media_type": "application/pdf",
    "retention_policy": "7y"
  }
}
```

The `url` resolves through a system that supports deletion. The 
`content_hash` lets the chain prove the referenced bytes existed at the 
time of the event without storing them in the chain. After the 
retention period elapses or a deletion request is honored, the URL may 
return 404 — the chain remains valid but the referenced content is 
gone.

### 15.4 Pseudonymous Actors

Authorities that process personal data SHOULD provision a separate 
`actor` PhIP object per natural person rather than hard-coding 
identifying strings into events. The actor's `identity` field MAY 
contain personal data, but personal-data fields on actors are governed 
by the same erasure mechanism: the authority deletes the actor's 
external mapping and replaces the actor's `identity` block with a 
sanitized projection (the historical events still reference the actor 
URI but the URI no longer maps to a natural person).

This approach trades exact replay fidelity for compliance: a verifier 
can confirm "actor X signed this event in 2027" but cannot recover 
which natural person actor X was, once the mapping is deleted.

### 15.5 Salt Compromise

If a salt itself leaks, every commitment using that salt becomes 
opener and effectively reveals the underlying personal data. The 
authority MUST treat salt compromise as a privacy incident and:

1. Issue new salts for affected records going forward.
2. Where contractual or legal duties require, notify affected subjects 
   per the applicable regime (the spec does not define notification 
   procedures).
3. Update `phip:personal_data` attributes on subsequent events with the 
   new salt; historical events using the leaked salt remain in the 
   chain.

A leaked salt cannot be "rotated out" of historical events — that is a 
fundamental property of an append-only chain. The mitigation is 
prospective. Authorities holding high-sensitivity data SHOULD generate 
short-lifetime salts and rotate them on a schedule shorter than the 
expected attack discovery window.

### 15.6 Read Access Control as a Privacy Tool

The `phip:access` mechanism (Section 11.5) is not by itself a privacy 
control — restricting reads still leaves personal data in the chain 
for the authority and any actor with read scope. Compliance regimes 
generally require that personal data not exist in append-only form, 
not merely that it be hidden from outside readers. Use Section 11.5 
for confidentiality; use Section 15.1–15.5 for privacy.

---

## 16. IANA Considerations

This document requests registration of the `phip` URI scheme.

[TODO: complete IANA URI scheme registration template]

---

## 17. References

### Normative

- RFC 2119 — Key words for use in RFCs
- RFC 3986 — Uniform Resource Identifier (URI): Generic Syntax
- RFC 7517 — JSON Web Key (JWK)
- RFC 8037 — CFRG Elliptic Curves for JOSE (Ed25519)
- RFC 8785 — JSON Canonicalization Scheme (JCS)

### Informative
- W3C Verifiable Credentials Data Model
- SPIFFE Verifiable Identity Document specification
- ActivityPub W3C Recommendation

---

---

## Appendix A. Open Issues

Issues identified through scenario stress-testing and systematic review.

### A.1 Resolved Issues

| # | Issue | Resolution |
|---|---|---|
| ~~A7~~ | Canonical JSON serialization | Adopted RFC 8785 (JCS). See Section 10.3 |
| ~~A17~~ | Object retirement vs. destruction | Operational track has `archived`; manufacturing track separates `consumed` from `disposed`. See Section 9 |
| ~~A19~~ | No CREATE operation | Added Section 12.1 |
| ~~A20~~ | Hash chain wording ambiguity | Clarified in Section 10.3: hash complete preceding event, all fields |
| ~~A21~~ | Lifecycle doesn't fit actor/location/vehicle types | Dual-track lifecycle: manufacturing + operational. See Sections 9.1–9.3 |
| ~~A22~~ | `disposed` overloaded for splits/transforms vs. destruction | Added `consumed` terminal state. See Section 9.2 |
| ~~A28~~ | Cross-object atomicity in process events | Downgraded to SHOULD with explicit atomicity deferral note. See Section 10.4 |
| ~~A38~~ | Relations are projections of history but not stated | Added Section 5.1: all top-level fields are projections derived from event history |
| ~~A39~~ | Operational track missing pre-active state | Added `planned` state. See Section 9.3 |
| ~~A40~~ | Foreign namespace CREATE restriction | Stated explicitly in Section 12.1 |
| ~~A41~~ | Hash chain verification strictness | MUST on first untrusted retrieval, MAY cache. See Section 10.3 |
| ~~A8~~ | Public key resource format | JWK-based key objects on operational lifecycle track with `not_before`/`not_after` validity, bootstrap key pattern, cache guidance. See Section 11.2 |
| ~~A9~~ | Query predicate grammar | Field, attribute, and relation filters with glob syntax, two return modes, cursor pagination. See Section 12.4 |
| ~~A11~~ | Capability token mechanics | `PhIP-Capability` HTTP header, four scope levels, token format with verification steps, short-lived tokens with expiry-based revocation. See Section 11.3 |
| ~~A24~~ | Concurrency | Optimistic locking: PUSH requires `previous_hash` match, 409 `CHAIN_CONFLICT` on mismatch, client re-fetches/re-signs/retries. See Section 12.3.1 |
| ~~A25~~ | Error response format | Standard error envelope with 17 error codes and HTTP status mappings. See Section 12.6 |
| ~~A31~~ | Relation metadata | Optional flat `metadata` object on relations, carried through `relation_added` event payloads. See Section 7.2 |
| ~~A32~~ | History pagination | GET returns state projection with `history_length`/`history_head`; separate `/history/` sub-resource with cursor pagination. See Section 12.2.1 |
| ~~A10~~ | Resolver discovery, caching headers, redirect behavior | Authority name = DNS = HTTPS endpoint (no DNS TXT/SRV); `ETag`/`Cache-Control` guidance; same-authority-only redirect policy; `/.well-known/phip/meta` capability document. See Section 4.3 and Section 12.7 |
| ~~A1~~ | Sub-object addressing: independent objects vs. facets | Field-replaceable rule, no lifecycle inheritance, `contained_in` is normative source of truth, path segments are informational. See Section 4.4 |
| ~~A13~~ | Design revision model and `instance_of` target type | Added `design` object type (Section 6.2) on the manufacturing track; `instance_of` MUST target a `design`; `supersedes`/`superseded_by` relations link revisions. See Sections 6.2, 6.3, 7.1 |
| ~~A23~~ | Authority transfer / domain death | New `authority_transfer` event type signed by a long-lived root authority key; authority record at `/.well-known/authority`; `mirror_urls` and `successor` fields in `/meta`; same-authority redirect rule relaxed for verified transfers. See Section 4.6 |
| ~~A26~~ | No read access control | New `phip:access` namespace (`public`/`authenticated`/`capability`/`private`); capability tokens extended with `read_state`/`read_history`/`read_query` scopes; `ACCESS_DENIED` error code; QUERY filtering by access. See Section 11.5 and `schemas/access.json` |
| ~~A27~~ | Privacy / GDPR | New Section 15 privacy annex: no-raw-PII rule, `phip:personal_data` salted-commitment convention, `phip:external_record` for off-chain references, salt deletion as the erasure mechanism, pseudonymous-actor pattern. See Section 15 |
| ~~A2~~ | Proportional provenance: yield_fraction math | Yields constrained to [0,1]; sum-per-input ≤ 1 + ε with ε = 1e-6; missing fractions treated as unknown (no implicit equal-share); corrective process events for drift. See Section 10.4.1, 10.4.2 |
| ~~A3~~ | Geographic position schema | New `phip:geo` namespace covering position (WGS 84 lat/lon/alt/accuracy), address, route with waypoints/carrier, and geofence. See `schemas/geo.json` |
| ~~A4~~ | Cross-org custody transfer ownership | New Section 11.3.7: prior custodian → carrier → next custodian token chain with explicit pickup/transit/delivery roles and disruption handling. Sub-delegation requires direct issuance, not carrier re-delegation |
| ~~A5~~ | Lot split mass conservation | New Section 10.5.1: `sum(resulting) ≤ source + ε` with optional `loss_quantity`; merge enforces equality; unit-mismatched merges require a `process` event |
| ~~A6~~ | Measurement event payload | New Section 11.4.2: normative `metric`/`value`/`unit`/`as_of`/`method`/`uncertainty`/`thresholds`/`outcome`/`external_ref`/`samples` shape with derived-vs-raw distinction |
| ~~A12~~ | Authority delegation | New Section 4.5.1–4.5.5: `delegations` array in `/meta`, scoped operations, revocation by metadata edit, sub-delegation depth control. Same-authority redirect rule relaxed for verified delegations |
| ~~A14~~ | Lot fungibility | New Section 6.4: required `fungible` boolean on lot identity; non-fungible lots MUST `contains` member items; default-fungible if absent |
| ~~A15~~ | Lot quantity tracking | New Section 6.4.1: `identity.quantity` with `value`/`unit`/`as_of`/`precision`; partial draw-down via `attribute_update` (no split needed); split is for new addressable sub-lots |
| ~~A16~~ | Regulatory jurisdiction | Added `jurisdiction`, `regulatory_authority`, `applicable_jurisdictions`, and `export_control` (regime/classification/license) to `phip:compliance`. ISO 3166 codes |
| ~~A18~~ | Uncertainty qualifiers | New Section 5.2.1: parallel `<field>_quality` convention with `confidence`/`source`/`as_of`/`corrected_from`/`note`. Tools MUST treat qualified and unqualified fields identically for matching |
| ~~A29~~ | connected_to bidirectional cross-org | New Section 7.3: relations are owned by their writing object; `connected_to` and `contains`/`contained_in` only enforceable on the writing side; asymmetric relations MUST NOT be treated as proof of physical state |
| ~~A30~~ | Dangling relations | New Section 7.4: graceful degradation rules + new `DANGLING_RELATION` (422) error code for same-authority broken refs only; cross-authority targets verified lazily by readers |
| ~~A33~~ | Batch operations | New Section 12.5: non-atomic `/objects/{ns}/batch` and `/push/{ns}/batch` endpoints with per-event results, 1000-event cap, advertised via `supported_operations` in `/meta`. Read-Only/Mirror resolvers reject with `OPERATION_NOT_SUPPORTED` |
| ~~A34~~ | Offline / air-gapped resolution | New Section 4.3.4: warm cache, signed PhIP bundle format (manifest + objects + history + keys), full chain verification on import, replay-on-reconnect with `CHAIN_CONFLICT` handling |
| ~~A35~~ | HTTP authentication | New Section 12.8: PhIP-Capability is the only protocol-level auth scheme; mTLS is a transport overlay (does not replace event signatures); non-protocol endpoints free to use any scheme; basic/bearer/API-key MUST NOT route restricted reads or writes |
| ~~A36~~ | Conformance levels | Section 13 restructured into four classes (Full / Read-Only / Mirror / Client-Only); new `OPERATION_NOT_SUPPORTED` (405) error code; new `conformance_class` field in `/meta` |
| ~~A37~~ | Schema versioning | New Section 8.4: semver MAJOR.MINOR with explicit additive vs. breaking change rules, versioned `$id` URLs, `version` field in schemas (all v0.1 schemas seeded at 1.0), advertise via `/meta.schema_namespaces`, 12-month minimum compatibility window |

### A.2 Open Issues — Post-v0.1

All issues identified through v0.1 stress-testing are resolved. Future 
revisions will add issues as they surface.

---

*End of PhIP Core Specification v0.1.0-draft*
