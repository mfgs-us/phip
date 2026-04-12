// Lifecycle state machine — PhIP Core Spec Section 9.
//
// Encodes the two lifecycle tracks, their state vocabularies, and the set of
// valid transitions. All transition validation in the resolver goes through
// this module; there is no other source of truth in the reference impl.

"use strict";

const MANUFACTURING_TYPES = new Set([
  "material",
  "component",
  "assembly",
  "system",
  "lot",
]);

const OPERATIONAL_TYPES = new Set(["actor", "location", "vehicle"]);

const MANUFACTURING_STATES = new Set([
  "concept",
  "design",
  "prototype",
  "qualified",
  "stock",
  "deployed",
  "maintained",
  "decommissioned",
  "consumed",
  "disposed",
]);

const OPERATIONAL_STATES = new Set([
  "planned",
  "active",
  "inactive",
  "archived",
]);

// Section 9.2.1 — Manufacturing track transitions.
const MANUFACTURING_TRANSITIONS = {
  concept: new Set(["design"]),
  design: new Set(["prototype", "qualified"]),
  prototype: new Set(["design", "qualified"]),
  qualified: new Set(["stock", "consumed"]),
  stock: new Set(["deployed", "decommissioned", "consumed"]),
  deployed: new Set(["maintained", "decommissioned"]),
  maintained: new Set(["deployed", "decommissioned"]),
  decommissioned: new Set(["consumed", "disposed"]),
  consumed: new Set(),
  disposed: new Set(),
};

// Section 9.3.1 — Operational track transitions.
const OPERATIONAL_TRANSITIONS = {
  planned: new Set(["active", "archived"]),
  active: new Set(["inactive", "archived"]),
  inactive: new Set(["active", "archived"]),
  archived: new Set(),
};

// Terminal states refuse further events (except `note` on `archived`).
const MFG_TERMINAL = new Set(["consumed", "disposed"]);
const OP_TERMINAL = new Set(["archived"]);

function getTrack(objectType) {
  if (MANUFACTURING_TYPES.has(objectType)) return "manufacturing";
  if (OPERATIONAL_TYPES.has(objectType)) return "operational";
  return null;
}

function isValidStateForType(objectType, state) {
  const track = getTrack(objectType);
  if (track === "manufacturing") return MANUFACTURING_STATES.has(state);
  if (track === "operational") return OPERATIONAL_STATES.has(state);
  return false;
}

function isValidTransition(objectType, from, to) {
  const track = getTrack(objectType);
  const table =
    track === "manufacturing"
      ? MANUFACTURING_TRANSITIONS
      : track === "operational"
        ? OPERATIONAL_TRANSITIONS
        : null;
  if (!table) return false;
  const allowed = table[from];
  if (!allowed) return false;
  return allowed.has(to);
}

function validTransitionsFrom(objectType, from) {
  const track = getTrack(objectType);
  const table =
    track === "manufacturing"
      ? MANUFACTURING_TRANSITIONS
      : track === "operational"
        ? OPERATIONAL_TRANSITIONS
        : null;
  if (!table || !table[from]) return [];
  return Array.from(table[from]);
}

function isTerminal(objectType, state) {
  const track = getTrack(objectType);
  if (track === "manufacturing") return MFG_TERMINAL.has(state);
  if (track === "operational") return OP_TERMINAL.has(state);
  return false;
}

// Per Section 9.3.1, `archived` objects MAY still accept `note` events.
// All other terminal states reject every event.
function acceptsEventInTerminal(objectType, state, eventType) {
  if (!isTerminal(objectType, state)) return true;
  if (getTrack(objectType) === "operational" && state === "archived") {
    return eventType === "note";
  }
  return false;
}

module.exports = {
  MANUFACTURING_TYPES,
  OPERATIONAL_TYPES,
  MANUFACTURING_STATES,
  OPERATIONAL_STATES,
  MANUFACTURING_TRANSITIONS,
  OPERATIONAL_TRANSITIONS,
  getTrack,
  isValidStateForType,
  isValidTransition,
  validTransitionsFrom,
  isTerminal,
  acceptsEventInTerminal,
};
