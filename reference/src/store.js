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
//       5. Object model / relation constraints
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
  isTerminal,
  acceptsEventInTerminal,
} = require("./lifecycle");
const { hashEvent, verifyEvent, publicKeyFromBase64Url } = require("./crypto");

const RELATION_TARGET_TYPE_CONSTRAINTS = {
  located_at: ["location", "vehicle"],
  manufactured_by: ["actor"],
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

    this._verifySignature(event);

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

    this._validateRelationTargets(record.relations);
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

    // Hash chain continuity: previous_hash MUST match current head.
    const currentHead = hashEvent(slot.history[slot.history.length - 1]);
    if (event.previous_hash !== currentHead) {
      throw new PhipError(
        "CHAIN_CONFLICT",
        "previous_hash does not match current chain head",
        { current_head: currentHead, supplied: event.previous_hash },
      );
    }

    // Signature verification before anything that mutates state.
    this._verifySignature(event);

    // Compute the next record projection by applying the event. This also
    // runs lifecycle/type/relation validation on the result.
    const nextRecord = this._applyEventToRecord(slot.record, event);
    this._validateRelationTargets(nextRecord.relations || []);
    validateObject({ ...nextRecord, history: [] });

    slot.record = nextRecord;
    slot.history.push(event);
    this.eventsSeen.set(event.event_id, phipId);
    return event;
  }

  get(phipId) {
    const slot = this.objects.get(phipId);
    if (!slot) {
      throw new PhipError("OBJECT_NOT_FOUND", "Object not found: " + phipId);
    }
    return this._project(phipId);
  }

  history(phipId, { limit = 100, cursor = null, order = "asc" } = {}) {
    const slot = this.objects.get(phipId);
    if (!slot) {
      throw new PhipError("OBJECT_NOT_FOUND", "Object not found: " + phipId);
    }
    if (limit > 1000) limit = 1000;
    const ordered =
      order === "desc" ? [...slot.history].reverse() : slot.history;
    const start = cursor ? parseInt(cursor, 10) : 0;
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

  query({ filters = {}, attributes = {}, relations = {}, return: ret = "ids", limit = 100, cursor = null } = {}) {
    if (limit > 1000) limit = 1000;
    const matches = [];
    for (const [, slot] of this.objects) {
      const r = slot.record;
      if (!this._matchFilters(r, filters)) continue;
      if (!this._matchAttributes(r, attributes)) continue;
      if (!this._matchRelations(r, relations)) continue;
      matches.push(this._project(r.phip_id));
    }
    const start = cursor ? parseInt(cursor, 10) : 0;
    const page = matches.slice(start, start + limit);
    const nextCursor = start + limit < matches.length ? String(start + limit) : null;
    return {
      matches: ret === "objects" ? page : page.map((o) => o.phip_id),
      total: matches.length,
      next_cursor: nextCursor,
    };
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
      case "note": {
        // These events are first-class in the history but do not, by
        // themselves, modify the projected top-level fields. Effects on
        // other objects (consumed inputs, derived_from on outputs) are
        // the pushing actor's responsibility per Section 10.4.
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

  _validateRelationTargets(relations) {
    for (const rel of relations) {
      const constraint = RELATION_TARGET_TYPE_CONSTRAINTS[rel.type];
      if (!constraint) continue;
      // We can only enforce constraints when the target is a locally
      // resolvable object. Foreign targets are resolver-extended validation.
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
