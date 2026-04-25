// In-memory PhIP object store with event validation pipeline.
//
// Responsibilities:
//   - Maintain (phip_id -> object record) and a lookup for resolving local
//     key material for signature verification.
//   - Apply events to objects: CREATE, PUSH.
//   - Enforce the full validation chain per Section 12.3:
//       1. Event structure (schema)
//       2. Signature cryptographic correctness (resolving key_id locally)
//       3. Hash chain continuity
//       4. Lifecycle transition validity
//       5. Object model / relation constraints (including DANGLING_RELATION
//          for same-authority targets per Section 7.4)
//       6. Type-specific payload checks (lot conservation §10.5.1,
//          process yield_fraction §10.4.1, measurement shape §11.4.2)
//   - Project the object's top-level fields from its event history.
//
// Scope limitations for v0:
//   - Intra-namespace only; no capability token handling (Section 11.3).
//   - Keys must resolve locally — there is no HTTPS fetch to foreign
//     authorities. This matches the reference scope and keeps the smoke
//     test self-contained.
//   - No persistence. Restart wipes state.

"use strict";

const { PhipError } = require("./errors");
const { validateObject, validateEvent } = require("./validators");
const {
  getTrack,
  isValidStateForType,
  isValidTransition,
  validTransitionsFrom,
  acceptsEventInTerminal,
} = require("./lifecycle");
const { hashEvent, verifyEvent, publicKeyFromBase64Url } = require("./crypto");

const RELATION_TARGET_TYPE_CONSTRAINTS = {
  located_at: ["location", "vehicle"],
  manufactured_by: ["actor"],
  instance_of: ["design"],
  supersedes: ["design"],
  superseded_by: ["design"],
};

class Store {
  constructor() {
    // phip_id -> { record, history }  (record is the projected object;
    // history is the raw ordered event list with signatures.)
    this.objects = new Map();

    // event_id -> phip_id  (replay / duplicate detection.)
    this.eventsSeen = new Map();
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  create(event) {
    validateEvent(event);
    if (event.type !== "created") {
      throw new PhipError(
        "INVALID_EVENT",
        "CREATE must receive a 'created' event, got " + event.type,
      );
    }
    if (event.previous_hash !== "genesis") {
      throw new PhipError(
        "INVALID_EVENT",
        "First event MUST have previous_hash = 'genesis'",
      );
    }
    if (this.objects.has(event.phip_id)) {
      throw new PhipError(
        "OBJECT_EXISTS",
        "Object already registered: " + event.phip_id,
      );
    }
    if (this.eventsSeen.has(event.event_id)) {
      throw new PhipError("DUPLICATE_EVENT", "Event ID already seen");
    }

    // Signature verification — step 2 per Section 12.3 validation order.
    // Must come before lifecycle/type checks below.
    this._verifySignature(event);

    const { object_type, state } = event.payload;
    if (getTrack(object_type) === null) {
      throw new PhipError(
        "INVALID_OBJECT",
        "Unknown object_type: " + object_type,
      );
    }
    if (!isValidStateForType(object_type, state)) {
      throw new PhipError(
        "INVALID_TRACK",
        "State '" +
          state +
          "' is not valid for object_type '" +
          object_type +
          "'",
        { object_type, state, track: getTrack(object_type) },
      );
    }

    // Build the initial projected record from the created event payload.
    const record = {
      phip_id: event.phip_id,
      object_type,
      state,
      identity: event.payload.identity || undefined,
      relations: event.payload.relations ? [...event.payload.relations] : [],
      attributes: event.payload.attributes
        ? { ...event.payload.attributes }
        : undefined,
    };

    this._validateRelationTargets(record.relations, record.phip_id);
    validateObject({ ...record, history: [] });

    this.objects.set(event.phip_id, { record, history: [event] });
    this.eventsSeen.set(event.event_id, event.phip_id);
    return this._project(event.phip_id);
  }

  push(phipId, event) {
    const slot = this.objects.get(phipId);
    if (!slot) {
      throw new PhipError(
        "OBJECT_NOT_FOUND",
        "Object not found: " + phipId,
      );
    }
    validateEvent(event);
    if (event.phip_id !== phipId) {
      throw new PhipError(
        "INVALID_EVENT",
        "Event phip_id does not match target object",
      );
    }
    if (event.type === "created") {
      throw new PhipError(
        "INVALID_EVENT",
        "'created' events may only be appended via CREATE",
      );
    }
    if (this.eventsSeen.has(event.event_id)) {
      throw new PhipError("DUPLICATE_EVENT", "Event ID already seen");
    }

    // Signature verification — step 2 per Section 12.3 validation order.
    this._verifySignature(event);

    // Step 3: capability token (skipped — v0 is intra-namespace only).

    // Step 4: hash chain continuity.
    const currentHead = hashEvent(slot.history[slot.history.length - 1]);
    if (event.previous_hash !== currentHead) {
      throw new PhipError(
        "CHAIN_CONFLICT",
        "previous_hash does not match current chain head",
        { current_head: currentHead, supplied: event.previous_hash },
      );
    }

    // Step 5: lifecycle transition validity.
    if (!acceptsEventInTerminal(slot.record.object_type, slot.record.state, event.type)) {
      throw new PhipError(
        "TERMINAL_STATE",
        "Object is in terminal state '" +
          slot.record.state +
          "' and cannot accept events of type '" +
          event.type +
          "'",
        { state: slot.record.state },
      );
    }

    // Step 6: object model constraints (relation type, track validity).
    // Compute the next record projection by applying the event. This also
    // runs lifecycle/type/relation validation on the result.
    this._validatePayloadConstraints(event, slot.record);
    const nextRecord = this._applyEventToRecord(slot.record, event);
    this._validateRelationTargets(nextRecord.relations || [], nextRecord.phip_id);
    validateObject({ ...nextRecord, history: [] });

    slot.record = nextRecord;
    slot.history.push(event);
    this.eventsSeen.set(event.event_id, phipId);
    return event;
  }

  get(phipId, caller = null) {
    const slot = this.objects.get(phipId);
    if (!slot) {
      throw new PhipError("OBJECT_NOT_FOUND", "Object not found: " + phipId);
    }
    this._enforceReadAccess(slot.record, caller, "read_state");
    return this._project(phipId);
  }

  history(phipId, { limit = 100, cursor = null, order = "asc" } = {}, caller = null) {
    const slot = this.objects.get(phipId);
    if (!slot) {
      throw new PhipError("OBJECT_NOT_FOUND", "Object not found: " + phipId);
    }
    this._enforceReadAccess(slot.record, caller, "read_history");
    if (limit > 1000) limit = 1000;
    const ordered =
      order === "desc" ? [...slot.history].reverse() : slot.history;
    const start = Math.max(0, cursor ? parseInt(cursor, 10) || 0 : 0);
    const end = Math.min(start + limit, ordered.length);
    const events = ordered.slice(start, end);
    const nextCursor = end < ordered.length ? String(end) : null;
    return {
      phip_id: phipId,
      history_length: slot.history.length,
      events,
      next_cursor: nextCursor,
    };
  }

  query({ filters = {}, attributes = {}, relations = {}, return: ret = "ids", limit = 100, cursor = null } = {}, caller = null) {
    if (limit > 1000) limit = 1000;
    const matches = [];
    for (const [, slot] of this.objects) {
      const r = slot.record;
      if (!this._matchFilters(r, filters)) continue;
      if (!this._matchAttributes(r, attributes)) continue;
      if (!this._matchRelations(r, relations)) continue;
      // Restricted objects are silently omitted from query results
      // (§11.5.3) — omission is the only signal of inaccessibility.
      try {
        this._enforceReadAccess(r, caller, "read_query");
      } catch (e) {
        if (e instanceof PhipError && (e.code === "ACCESS_DENIED" || e.code === "MISSING_CAPABILITY" || e.code === "INVALID_CAPABILITY")) {
          continue;
        }
        throw e;
      }
      matches.push(this._project(r.phip_id));
    }
    const start = Math.max(0, cursor ? parseInt(cursor, 10) || 0 : 0);
    const page = matches.slice(start, start + limit);
    const nextCursor = start + limit < matches.length ? String(start + limit) : null;
    return {
      matches: ret === "objects" ? page : page.map((o) => o.phip_id),
      total: matches.length,
      next_cursor: nextCursor,
    };
  }

  // Distinct namespaces present in the store. Used by /meta (§12.7) to
  // advertise this resolver's namespace coverage.
  namespaces() {
    const out = new Set();
    for (const phipId of this.objects.keys()) {
      const m = /^phip:\/\/[^/]+\/([^/]+)\//.exec(phipId);
      if (m) out.add(m[1]);
    }
    return Array.from(out).sort();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  _project(phipId) {
    const slot = this.objects.get(phipId);
    const headEvent = slot.history[slot.history.length - 1];
    return {
      ...slot.record,
      history_length: slot.history.length,
      history_head: headEvent ? hashEvent(headEvent) : null,
      history: [],
    };
  }

  _verifySignature(event) {
    const keyId = event.signature && event.signature.key_id;
    if (!keyId) {
      throw new PhipError("INVALID_SIGNATURE", "Event is missing key_id");
    }

    // Self-signed bootstrap: a 'created' event for a key actor whose
    // key_id equals its own phip_id is allowed to sign itself.
    let keyRecord;
    const isSelfSigned =
      event.type === "created" && keyId === event.phip_id;
    if (isSelfSigned) {
      // Temporarily seed the key from the event payload so verification
      // can resolve it. The actual store insert happens only after the
      // whole validation chain succeeds.
      keyRecord = this._keyMaterialFromCreatedPayload(event);
    } else {
      keyRecord = this._resolveKeyRecord(keyId);
    }

    if (!keyRecord) {
      throw new PhipError("KEY_NOT_FOUND", "Could not resolve key_id: " + keyId);
    }
    this._checkKeyValidity(keyRecord, event.timestamp);

    const publicKey = publicKeyFromBase64Url(keyRecord.x);
    const ok = verifyEvent(event, publicKey);
    if (!ok) {
      throw new PhipError(
        "INVALID_SIGNATURE",
        "Ed25519 signature verification failed",
      );
    }
  }

  _keyMaterialFromCreatedPayload(event) {
    const payload = event.payload || {};
    if (payload.object_type !== "actor") return null;
    const attrs = payload.attributes || {};
    const keys = attrs["phip:keys"];
    if (!keys) return null;
    return keys;
  }

  _resolveKeyRecord(keyId) {
    const slot = this.objects.get(keyId);
    if (!slot) return null;
    if (slot.record.object_type !== "actor") return null;
    const keys = slot.record.attributes && slot.record.attributes["phip:keys"];
    if (!keys) return null;
    // Per Section 11.2.2, signing is only valid while the key is 'active'.
    if (slot.record.state !== "active") {
      throw new PhipError(
        "KEY_EXPIRED",
        "Key '" + keyId + "' is in state '" + slot.record.state + "' and cannot sign",
      );
    }
    return keys;
  }

  _checkKeyValidity(keyRecord, eventTimestampIso) {
    const ts = Date.parse(eventTimestampIso);
    const nbf = Date.parse(keyRecord.not_before);
    const naf = Date.parse(keyRecord.not_after);
    if (isNaN(ts) || isNaN(nbf) || isNaN(naf)) {
      throw new PhipError("INVALID_EVENT", "Invalid timestamp or key validity window");
    }
    if (ts < nbf || ts > naf) {
      throw new PhipError(
        "KEY_EXPIRED",
        "Event timestamp falls outside key validity window",
        { event_timestamp: eventTimestampIso, not_before: keyRecord.not_before, not_after: keyRecord.not_after },
      );
    }
  }

  _applyEventToRecord(record, event) {
    const next = {
      ...record,
      relations: record.relations ? [...record.relations] : [],
      attributes: record.attributes ? { ...record.attributes } : {},
    };

    switch (event.type) {
      case "state_transition": {
        const { from, to } = event.payload;
        if (record.state !== from) {
          throw new PhipError(
            "INVALID_TRANSITION",
            "state_transition 'from' does not match current state",
            { current_state: record.state, requested_from: from },
          );
        }
        if (!isValidTransition(record.object_type, from, to)) {
          throw new PhipError(
            "INVALID_TRANSITION",
            "Cannot transition from '" + from + "' to '" + to + "' on " + getTrack(record.object_type) + " track",
            {
              current_state: from,
              requested_state: to,
              valid_transitions: validTransitionsFrom(record.object_type, from),
            },
          );
        }
        next.state = to;
        break;
      }

      case "attribute_update": {
        const { namespace, updates } = event.payload;
        const current = next.attributes[namespace] || {};
        next.attributes[namespace] = { ...current, ...updates };
        break;
      }

      case "relation_added": {
        const rel = event.payload.relation;
        // §7.4: same-authority dangling relations MUST be rejected.
        // We treat any phip_id whose authority equals this object's
        // authority as same-authority. Cross-authority targets are
        // verified lazily by readers, not the resolver.
        if (this._isSameAuthorityTarget(record.phip_id, rel.phip_id)) {
          if (!this.objects.has(rel.phip_id)) {
            throw new PhipError(
              "DANGLING_RELATION",
              "relation_added references unknown same-authority object: " + rel.phip_id,
              { relation_type: rel.type, target: rel.phip_id },
            );
          }
        }
        const exists = next.relations.some(
          (r) => r.type === rel.type && r.phip_id === rel.phip_id,
        );
        if (!exists) next.relations.push(rel);
        break;
      }

      case "relation_removed": {
        const rel = event.payload.relation;
        next.relations = next.relations.filter(
          (r) => !(r.type === rel.type && r.phip_id === rel.phip_id),
        );
        break;
      }

      case "software_update": {
        // Software updates are recorded in the history; they do not mutate
        // top-level fields. Domain-specific projections (e.g. firmware
        // version under phip:software) are a resolver extension.
        break;
      }

      case "process":
      case "lot_split":
      case "lot_merge":
      case "measurement":
      case "note":
      case "authority_transfer": {
        // These events are first-class in the history but do not, by
        // themselves, modify the projected top-level fields. Effects on
        // other objects (consumed inputs, derived_from on outputs) are
        // the pushing actor's responsibility per Section 10.4.
        // authority_transfer is recorded on the authority record for
        // verifier-side trust-chain extension; full transfer mechanics
        // (root-key issuance, successor-side acceptance) are out of
        // scope for v0.1 reference.
        break;
      }

      default:
        throw new PhipError("INVALID_EVENT", "Unhandled event type: " + event.type);
    }

    // Clean up empty attributes object to keep projections tidy.
    if (next.attributes && Object.keys(next.attributes).length === 0) {
      delete next.attributes;
    }

    return next;
  }

  // Type-specific payload constraints layered on top of structural validation.
  // Fires for both CREATE and PUSH; only inspects fields the event itself
  // declares (most events are constraint-free at this layer).
  _validatePayloadConstraints(event, currentRecord) {
    const t = event.type;
    const p = event.payload || {};
    if (t === "process") this._validateProcessYields(p);
    else if (t === "lot_split") this._validateLotSplit(p, currentRecord);
    else if (t === "lot_merge") this._validateLotMerge(p, currentRecord);
    else if (t === "measurement") this._validateMeasurement(p);
  }

  // §10.4.1: yield_fraction values are non-negative reals in [0,1]. The sum
  // of fractions on outputs that share an input (via derived_from) MUST be
  // ≤ 1 + ε. Per-input enforcement requires resolving each output object
  // to read its derived_from relations.
  _validateProcessYields(payload) {
    const outputs = payload.outputs || [];
    if (!outputs.length) return;
    // Per-output range check (always enforceable from the event alone).
    for (const o of outputs) {
      if (o.yield_fraction === undefined || o.yield_fraction === null) continue;
      const f = o.yield_fraction;
      if (typeof f !== "number" || f < 0 || f > 1) {
        throw new PhipError(
          "INVALID_EVENT",
          "yield_fraction must be a number in [0,1], got " + JSON.stringify(f),
          { output: o.phip_id, yield_fraction: f },
        );
      }
    }

    const inputs = payload.inputs || [];
    if (!inputs.length) return;
    const EPSILON = 1e-6;
    const inputIds = new Set(inputs.map((i) => i.phip_id));

    // Single-input case: per-input sum collapses to the total over outputs
    // that have any yield_fraction, since they all draw from the one input.
    if (inputs.length === 1) {
      let total = 0;
      let any = false;
      for (const o of outputs) {
        if (typeof o.yield_fraction === "number") {
          total += o.yield_fraction;
          any = true;
        }
      }
      if (any && total > 1 + EPSILON) {
        throw new PhipError(
          "INVALID_EVENT",
          "Sum of yield_fraction across outputs exceeds 1.0 (mass duplication)",
          { input: [...inputIds][0], sum: total, tolerance: EPSILON },
        );
      }
      return;
    }

    // Multi-input case: per-input check requires reading each output's
    // `derived_from` relations to know which inputs it draws from. We do
    // this best-effort against the local store; outputs that aren't yet
    // registered (or live under another authority) are skipped.
    const sumPerInput = new Map();
    for (const o of outputs) {
      if (typeof o.yield_fraction !== "number") continue;
      const slot = this.objects.get(o.phip_id);
      if (!slot) continue;
      const derivedFrom = (slot.record.relations || [])
        .filter((r) => r.type === "derived_from" && inputIds.has(r.phip_id))
        .map((r) => r.phip_id);
      for (const inputId of derivedFrom) {
        sumPerInput.set(inputId, (sumPerInput.get(inputId) || 0) + o.yield_fraction);
      }
    }
    for (const [inputId, sum] of sumPerInput) {
      if (sum > 1 + EPSILON) {
        throw new PhipError(
          "INVALID_EVENT",
          "Sum of yield_fraction across outputs exceeds 1.0 for input '" + inputId + "'",
          { input: inputId, sum, tolerance: EPSILON },
        );
      }
    }
    // Outputs whose derived_from we could not resolve are not enforced
    // here; readers SHOULD re-verify from the event log. This is a known
    // gap when outputs span authorities.
  }

  // §10.5.1: lot_split — sum of resulting quantities (+ optional loss) must
  // not exceed source. Operates on the structured `{value, unit}` form
  // and the shorthand `quantity_<unit>` form (§6.4.1.1).
  _validateLotSplit(payload, sourceRecord) {
    const resulting = payload.resulting_lots || [];
    const sourceQty = this._readQuantity(sourceRecord && sourceRecord.identity);
    if (!sourceQty) return; // no quantity tracked — nothing to enforce
    const sumResulting = this._sumQuantities(resulting, sourceQty.unit);
    const loss = this._readQuantityFromShorthand(payload, sourceQty.unit) || 0;
    if (sumResulting === null) return; // mismatched units; spec prefers a process event
    const epsilon = this._tolerance(sourceQty);
    if (sumResulting + loss > sourceQty.value + epsilon) {
      throw new PhipError(
        "INVALID_EVENT",
        "lot_split mass conservation violated: sum(resulting) + loss > source",
        {
          source: sourceQty.value,
          sum_resulting: sumResulting,
          loss,
          unit: sourceQty.unit,
          tolerance: epsilon,
        },
      );
    }
  }

  // §10.5.1: lot_merge — sum of source quantities MUST equal the resulting
  // (target) lot's quantity within tolerance. The check fires only when
  // ALL sources are locally resolvable with a quantity in the target's
  // unit. If any source is unresolvable (foreign authority) or has a
  // missing/mismatched quantity, the check is skipped — partial sums
  // would produce false positives. Already-consumed source lots MUST be
  // rejected (re-merging would double-count).
  _validateLotMerge(payload, targetRecord) {
    const sources = payload.source_lots || [];
    const targetQty = this._readQuantity(targetRecord && targetRecord.identity);
    if (!targetQty) return;

    // Reject already-consumed sources before any conservation math.
    for (const s of sources) {
      const slot = this.objects.get(s.phip_id);
      if (slot && slot.record && slot.record.state === "consumed") {
        throw new PhipError(
          "INVALID_EVENT",
          "lot_merge source is already consumed: " + s.phip_id,
          { source: s.phip_id, state: "consumed" },
        );
      }
    }

    // Resolve each source's quantity. Skip the conservation check if any
    // source can't be resolved (foreign authority or missing quantity).
    const resolved = [];
    for (const s of sources) {
      const slot = this.objects.get(s.phip_id);
      const inlineQty = this._readQuantity(s);
      const recordQty = slot && slot.record ? this._readQuantity(slot.record.identity) : null;
      const qty = inlineQty || recordQty;
      if (!qty || qty.unit !== targetQty.unit) {
        return; // partial reads → can't check; spec permits skipping
      }
      resolved.push(qty);
    }
    let sumSources = 0;
    for (const q of resolved) sumSources += q.value;
    const epsilon = this._tolerance(targetQty);
    if (Math.abs(sumSources - targetQty.value) > epsilon) {
      throw new PhipError(
        "INVALID_EVENT",
        "lot_merge mass conservation violated: |sum(sources) - target| > tolerance",
        {
          target: targetQty.value,
          sum_sources: sumSources,
          unit: targetQty.unit,
          tolerance: epsilon,
        },
      );
    }
  }

  // §11.4.2: measurement payload basic shape — `metric` and `as_of` MUST be
  // present, `value` MUST be present (any JSON type per spec).
  _validateMeasurement(payload) {
    const missing = [];
    if (typeof payload.metric !== "string" || !payload.metric) missing.push("metric");
    if (payload.value === undefined) missing.push("value");
    if (typeof payload.as_of !== "string" || !payload.as_of) missing.push("as_of");
    if (missing.length) {
      throw new PhipError(
        "INVALID_EVENT",
        "measurement payload missing required field(s): " + missing.join(", "),
        { missing },
      );
    }
  }

  // Read either structured `quantity: {value, unit, ...}` or shorthand
  // `quantity_<unit>: <value>` from a payload-like object. Returns
  // {value, unit, precision?} or null.
  _readQuantity(src) {
    if (!src || typeof src !== "object") return null;
    if (src.quantity && typeof src.quantity === "object") {
      const { value, unit, precision } = src.quantity;
      if (typeof value === "number" && typeof unit === "string") {
        return { value, unit, precision };
      }
    }
    return this._readQuantityShorthandAny(src);
  }

  _readQuantityShorthandAny(src) {
    for (const k of Object.keys(src)) {
      const m = /^quantity_(.+)$/.exec(k);
      if (m && typeof src[k] === "number") {
        return { value: src[k], unit: m[1] };
      }
    }
    return null;
  }

  _readQuantityFromShorthand(payload, expectedUnit) {
    for (const k of Object.keys(payload)) {
      const m = /^loss_quantity_(.+)$/.exec(k);
      if (m && m[1] === expectedUnit && typeof payload[k] === "number") {
        return payload[k];
      }
    }
    return 0;
  }

  // Sum quantities across a list of {quantity_<unit>} or {quantity:{}} entries.
  // Returns null on unit mismatch (caller skips conservation check; spec says
  // unit-mismatched lot ops should be process events instead).
  _sumQuantities(entries, expectedUnit) {
    let total = 0;
    for (const e of entries) {
      const q = this._readQuantity(e) || this._readQuantityShorthandAny(e);
      if (!q) continue; // entry without a quantity — skip
      if (q.unit !== expectedUnit) return null;
      total += q.value;
    }
    return total;
  }

  // §6.4.1 / §10.5.1: tolerance ε is the smaller of 0.1% of the source
  // value or the unit precision (when supplied). When precision is absent,
  // fall back to 0.1% with a tiny floor to avoid zero-tolerance on
  // zero-value lots.
  _tolerance(qty) {
    const pct = qty.value * 0.001;
    if (typeof qty.precision === "number" && qty.precision > 0) {
      return Math.max(Math.min(pct, qty.precision), 1e-9);
    }
    return Math.max(pct, 1e-9);
  }

  // §11.5: enforce phip:access policy on read operations.
  //
  // `caller` is the parsed PhIP-Capability token (or null for unauthenticated
  // requests). Token cryptographic verification — checking the signature
  // against the granting authority's key — is OUT OF SCOPE for the v0.1
  // reference because it requires resolving foreign authority keys, which
  // this resolver does not yet do. Tokens are accepted on structural validity
  // and expiry only. Production resolvers MUST add cryptographic verification
  // per §11.3.4.
  _enforceReadAccess(record, caller, requestedScope) {
    const access = record.attributes && record.attributes["phip:access"];
    const policy = (access && access.policy) || "public";

    if (policy === "public") return;

    if (policy === "private") {
      // The reference resolver does not have a concept of "the authority
      // itself" as a distinguishable caller — production resolvers would
      // tie this to operator credentials. Always deny.
      throw new PhipError(
        "ACCESS_DENIED",
        "Object access is restricted to the authority",
        { policy },
      );
    }

    // authenticated / capability — token required. Surface a deferred
    // parse error here (it was suppressed for public objects).
    if (caller && caller.parseError) throw caller.parseError;
    if (!caller || !caller.token) {
      throw new PhipError("MISSING_CAPABILITY", "Read access requires a capability token");
    }
    const token = caller.token;
    if (!token.scope || !token.scope.startsWith("read_")) {
      throw new PhipError(
        "INVALID_CAPABILITY",
        "Capability token does not grant any read scope",
        { presented_scope: token.scope },
      );
    }
    // read_history covers read_state. read_query covers QUERY only.
    const allowed =
      token.scope === requestedScope ||
      (requestedScope === "read_state" && token.scope === "read_history");
    if (!allowed) {
      throw new PhipError(
        "INVALID_CAPABILITY",
        "Capability token scope '" + token.scope + "' does not cover requested operation '" + requestedScope + "'",
      );
    }
    // Object filter check.
    if (token.object_filter && !this._globMatch(record.phip_id, token.object_filter)) {
      throw new PhipError(
        "INVALID_CAPABILITY",
        "Capability token object_filter does not match this object",
      );
    }
    // Expiry check.
    const now = Date.now();
    if (token.not_before && Date.parse(token.not_before) > now) {
      throw new PhipError("INVALID_CAPABILITY", "Capability token not yet valid");
    }
    if (token.expires && Date.parse(token.expires) < now) {
      throw new PhipError("INVALID_CAPABILITY", "Capability token has expired");
    }
    // §11.5.2 step 7: if policy is `capability`, granted_to MUST match the
    // requesting actor. The reference resolver derives `caller.actor` from
    // the token's own granted_to (parseCapabilityHeader), so this check is
    // *currently* tautological — production resolvers identify the caller
    // via mTLS or signed request, then compare against granted_to. We
    // keep the check shape so the production drop-in is small, and skip
    // it when the actor was derived from the token.
    if (policy === "capability" && caller.actor_authenticated_externally) {
      if (token.granted_to !== caller.actor) {
        throw new PhipError(
          "ACCESS_DENIED",
          "Capability token granted_to does not match the requesting actor",
        );
      }
    }
  }

  _isSameAuthorityTarget(subjectPhipId, targetPhipId) {
    // PhIP URIs are phip://{authority}/{namespace}/{local-id}.
    // Same authority iff the host segments match.
    const m1 = /^phip:\/\/([^/]+)\//.exec(subjectPhipId);
    const m2 = /^phip:\/\/([^/]+)\//.exec(targetPhipId);
    return m1 && m2 && m1[1] === m2[1];
  }

  _validateRelationTargets(relations, subjectPhipId) {
    for (const rel of relations) {
      // §7.4: same-authority dangling targets MUST be rejected (CREATE
      // path; the relation_added handler does the same in push).
      // subjectPhipId may be undefined when called from contexts that do
      // not need the dangling check (e.g., recomputing projections); skip
      // gracefully in that case.
      if (subjectPhipId && this._isSameAuthorityTarget(subjectPhipId, rel.phip_id)) {
        if (!this.objects.has(rel.phip_id)) {
          throw new PhipError(
            "DANGLING_RELATION",
            "Relation references unknown same-authority object: " + rel.phip_id,
            { relation_type: rel.type, target: rel.phip_id },
          );
        }
      }
      const constraint = RELATION_TARGET_TYPE_CONSTRAINTS[rel.type];
      if (!constraint) continue;
      // Type constraint check — only enforceable for locally resolvable
      // targets. Foreign targets are reader-side concerns.
      const target = this.objects.get(rel.phip_id);
      if (!target) continue;
      if (!constraint.includes(target.record.object_type)) {
        throw new PhipError(
          "INVALID_RELATION",
          "Relation '" + rel.type + "' target must be of type " + constraint.join(" or "),
          {
            relation_type: rel.type,
            target: rel.phip_id,
            target_type: target.record.object_type,
            allowed: constraint,
          },
        );
      }
    }
  }

  // --- Query matching helpers ---

  _matchFilters(record, filters) {
    for (const [field, value] of Object.entries(filters)) {
      const actual = record[field];
      if (!this._globMatch(actual, value)) return false;
    }
    return true;
  }

  _matchAttributes(record, attrFilters) {
    const attrs = record.attributes || {};
    for (const [ns, fields] of Object.entries(attrFilters)) {
      const nsAttrs = attrs[ns];
      if (!nsAttrs) return false;
      for (const [k, v] of Object.entries(fields)) {
        if (!this._globMatch(nsAttrs[k], v)) return false;
      }
    }
    return true;
  }

  _matchRelations(record, relFilters) {
    const rels = record.relations || [];
    for (const [type, targetGlob] of Object.entries(relFilters)) {
      const match = rels.some(
        (r) => r.type === type && this._globMatch(r.phip_id, targetGlob),
      );
      if (!match) return false;
    }
    return true;
  }

  // `*` is the only wildcard — no regex, no ranges. Matches zero or more chars.
  _globMatch(actual, pattern) {
    if (actual === undefined || actual === null) return false;
    if (typeof pattern !== "string") return actual === pattern;
    const actualStr = String(actual);
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
    return re.test(actualStr);
  }
}

module.exports = { Store };
