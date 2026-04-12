// Structural validation via schemas/core.json.
//
// This module loads the top-level PhIP Object schema and compiles it once,
// then exposes `validateObject` and `validateEvent` helpers that raise
// PhipErrors on failure. Structural validation is the first wall every
// incoming event must pass; semantic rules (lifecycle transitions, hash
// chain continuity, signature cryptographic correctness) are layered on
// top in store.js.

"use strict";

const path = require("node:path");
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const { PhipError } = require("./errors");

const CORE_SCHEMA_PATH = path.resolve(__dirname, "../../schemas/core.json");
const coreSchema = require(CORE_SCHEMA_PATH);

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const validateCoreObject = ajv.compile(coreSchema);

// We pull out the `event` definition so we can validate a single event in
// isolation (for PUSH) without needing a full object wrapper.
const EVENT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/mfgs-us/phip/schemas/core-event.json",
  ...coreSchema.$defs.event,
  $defs: coreSchema.$defs,
};
const validateCoreEvent = ajv.compile(EVENT_SCHEMA);

function formatErrors(errors) {
  return (errors || []).map((e) => ({
    path: e.instancePath || "/",
    message: e.message,
    params: e.params,
  }));
}

function validateObject(obj) {
  if (!validateCoreObject(obj)) {
    throw new PhipError(
      "INVALID_OBJECT",
      "Object failed core schema validation",
      { errors: formatErrors(validateCoreObject.errors) },
    );
  }
}

function validateEvent(event) {
  if (!validateCoreEvent(event)) {
    throw new PhipError(
      "INVALID_EVENT",
      "Event failed core schema validation",
      { errors: formatErrors(validateCoreEvent.errors) },
    );
  }
}

module.exports = { validateObject, validateEvent };
