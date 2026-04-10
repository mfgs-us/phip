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
15. IANA Considerations
16. References
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

### 4.3 Resolution

A PhIP URI is resolved via the authority's well-known resolver endpoint:

```
https://{authority}/.well-known/phip/resolve/{namespace}/{local-id}
```

The authority MUST serve this endpoint over HTTPS. Resolution MUST return 
the full PhIP Object or a standard error response.

[TODO: define resolver discovery, caching headers, redirect behavior]

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

[TODO: define whether sub-objects require independent lifecycle states or 
inherit from parent]

### 4.5 Authority Delegation

[TODO: define how an authority may delegate a sub-namespace to another party]

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

[TODO: define geographic position attribute schema]

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
| `instance_of` | — | The subject is a physical instance of a design or part number |
| `manufactured_by` | — | Object MUST be of type `actor` |

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

Relation metadata is not namespaced (unlike object attributes) because 
it carries simple positional or structural data, not rich domain schemas.

### 7.3 Custom Relations

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
| `phip:mechanical` | Dimensions, weight, material, tolerances | [TODO] |
| `phip:electrical` | Voltage, current, connector types | [TODO] |
| `phip:software` | Firmware, software versions, config hashes | [TODO] |
| `phip:datacenter` | Rack position, power, thermal | [TODO] |
| `phip:compliance` | Certifications, life limits, chain of custody | [TODO] |
| `phip:procurement` | PO number, supplier, lead time | [TODO] |

### 8.3 Custom Namespaces

Organizations MAY define custom namespaces using their domain:

```
org:droyd.com:teleop
```

Custom namespace schemas SHOULD be published at a resolvable URL for 
interoperability.

---

## 9. Lifecycle State Machine

### 9.1 Lifecycle Tracks

Not all object types follow the same lifecycle. PhIP defines two tracks:

**Manufacturing track** — for types that are designed, produced, and 
eventually end-of-lifed: `material`, `component`, `assembly`, `system`, 
`lot`.

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

### 10.3 Hash Chain

The `previous_hash` field of event E[n] MUST be 
SHA-256(JCS(E[n-1])), where E[n-1] is the complete canonical JSON 
serialization of the preceding event including all of its fields 
(`event_id`, `phip_id`, `type`, `timestamp`, `actor`, `previous_hash`, 
`payload`, and `signature`). No fields are excluded.

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

[TODO: define whether lot splits require equal mass conservation]

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

A token with `push_events` scope is a broad grant. The narrower scopes 
allow fine-grained delegation: a carrier transporting goods may receive 
`push_relations` (to update `located_at`) but not `push_state`. A sensor 
may receive `push_measurements` but nothing else.

#### 11.3.3 Token Presentation

Capability tokens are presented via HTTP header on PUSH requests:

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

[TODO: define standard payload format for measurement events referencing 
external telemetry]

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
error response (see Section 12.5) and MUST NOT append the event.

Response: the appended event with server-assigned sequence number. 
HTTP 201 on success.

#### 12.3.1 Concurrency and Chain Conflicts

The hash chain creates a serialization requirement: events MUST be 
appended strictly sequentially. If two actors push events concurrently, 
both will compute `previous_hash` from the same chain head. The first 
push succeeds; the second MUST be rejected with a `CHAIN_CONFLICT` error.

The rejected client MUST:

1. Re-fetch the object to obtain the new `history_head`
2. Recompute `previous_hash` using the new head
3. Re-sign the entire event (swapping `previous_hash` alone is 
   insufficient — the signature covers all fields)
4. Retry the PUSH

The resolver MUST NOT reorder, merge, or silently resolve concurrent 
pushes. The linear hash chain is the authoritative ordering.

Resolvers SHOULD process pushes to the same object serially to minimize 
conflict frequency. The spec does not define a maximum retry count or 
backoff strategy — these are client implementation concerns.

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

### 12.5 Error Responses

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

#### 12.5.1 Error Code Registry

| Code | HTTP Status | Description |
|---|---|---|
| `OBJECT_NOT_FOUND` | 404 | GET or PUSH to a non-existent PhIP ID |
| `OBJECT_EXISTS` | 409 | CREATE with a `phip_id` that is already registered |
| `CHAIN_CONFLICT` | 409 | PUSH `previous_hash` does not match current chain head. `details` MUST include `current_head` |
| `DUPLICATE_EVENT` | 409 | An event with this `event_id` already exists (replay protection) |
| `TERMINAL_STATE` | 409 | Object is in a terminal state and cannot accept events |
| `INVALID_SIGNATURE` | 401 | Event signature verification failed |
| `KEY_NOT_FOUND` | 401 | The `key_id` in the signature could not be resolved |
| `KEY_EXPIRED` | 401 | The signing key's validity window does not cover the event timestamp |
| `MISSING_CAPABILITY` | 403 | Cross-org push without a capability token |
| `INVALID_CAPABILITY` | 403 | Capability token signature invalid, expired, or scope insufficient |
| `FOREIGN_NAMESPACE` | 403 | CREATE attempted in a namespace the caller does not own |
| `INVALID_OBJECT` | 422 | Object model validation failed (missing required fields, unknown type) |
| `INVALID_EVENT` | 422 | Event structure invalid (missing fields, unknown event type) |
| `INVALID_TRANSITION` | 422 | State transition not allowed on this object type's lifecycle track. `details` SHOULD include `valid_transitions` |
| `INVALID_TRACK` | 422 | State is not valid for this object type's lifecycle track |
| `INVALID_RELATION` | 422 | Relation type constraint violated (e.g., `located_at` target is not a `location` or `vehicle`) |
| `INVALID_QUERY` | 422 | Query predicate is malformed or uses unsupported features |

Error responses MUST NOT be signed. They are informational, not 
historical records. HTTPS is the integrity mechanism for error responses.

---

## 13. Conformance

A conformant PhIP resolver MUST:

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
  `current_head` in error details (Section 12.3.1)
- Verify and enforce capability tokens for cross-org writes, including 
  scope validation (Section 11.3)
- Return standard error responses per Section 12.5
- Return objects in terminal states (`disposed`, `consumed`, `archived`) 
  on GET
- Return `history_length` and `history_head` on GET responses
- Support cursor pagination on history retrieval and QUERY responses

A conformant PhIP resolver SHOULD:

- Support the `depth` parameter on GET
- Support the `at` parameter on GET for point-in-time queries
- Validate condition values against the standard vocabulary
- Support `Cache-Control` headers on key resource responses
- Publish its supported schema namespaces

[TODO: define a conformance test suite reference]

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

## 15. IANA Considerations

This document requests registration of the `phip` URI scheme.

[TODO: complete IANA URI scheme registration template]

---

## 16. References

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
| ~~A25~~ | Error response format | Standard error envelope with 17 error codes and HTTP status mappings. See Section 12.5 |
| ~~A31~~ | Relation metadata | Optional flat `metadata` object on relations, carried through `relation_added` event payloads. See Section 7.2 |
| ~~A32~~ | History pagination | GET returns state projection with `history_length`/`history_head`; separate `/history/` sub-resource with cursor pagination. See Section 12.2.1 |

### A.2 Open Issues — Post-v0.1

No issues currently block the reference implementation. The following 
are real issues to address in subsequent spec revisions or appendices.

These are real issues but do not block the reference implementation. 
They can be addressed in subsequent spec revisions or appendices.

| # | Issue | Severity | Section |
|---|---|---|---|
| A1 | Sub-object addressing: path segments vs. fragment identifiers. Do sub-objects have independent lifecycle states? | High | 4.4 |
| A13 | Design revision model and `design`/`specification` object type for `instance_of` targets | High | 6, 7 |
| A23 | Authority transfer / domain death: no mechanism for ownership transfer or domain migration | High | 4.2 |
| A26 | No read access control: trust model covers write authorization only. All objects publicly readable by default | High | 11, 12 |
| A27 | Privacy / GDPR: append-only history conflicts with right-to-erasure. Standard mitigations (PII hashing, off-chain pointers) are well-understood — needs a privacy annex | High | 10, 14 |
| A2 | Proportional provenance: `yield_fraction` math (conservation, rounding) needs normative rules | Medium | 10.4 |
| A3 | Geographic position attribute schema for vehicles and mobile locations | Medium | 6.1 |
| A4 | Cross-org relation write ownership during multi-party custody transfers | Medium | 11.3.1 |
| A5 | Lot split mass conservation rules | Medium | 10.5 |
| A6 | Measurement event payload format for referencing external telemetry | Medium | 11.4.1 |
| A10 | Resolver discovery, caching headers, redirect behavior | Medium | 4.3 |
| A12 | Authority delegation mechanism | Medium | 4.5 |
| A14 | Fungibility flag for lot objects | Medium | 6 |
| A15 | Quantity tracking on lots without lot splitting | Medium | 5, 10 |
| A16 | Regulatory jurisdiction in compliance schema | Medium | 8.2 |
| A18 | Uncertainty / confidence qualifiers on identity fields for legacy onboarding | Medium | 5.2 |
| A29 | `connected_to` bidirectionality unenforceable cross-org | Medium | 7 |
| A30 | Dangling relation references: guidance on unresolvable targets | Medium | 7 |
| A33 | Batch/transaction operations for bulk object creation | Low | 12 |
| A34 | Offline / air-gapped resolution | Low | 4.3 |
| A35 | HTTP authentication mechanism | Low | 12 |
| A36 | Conformance levels (read-only resolvers) | Low | 13 |
| A37 | Schema versioning and evolution strategy | Low | 8 |

---

*End of PhIP Core Specification v0.1.0-draft*
