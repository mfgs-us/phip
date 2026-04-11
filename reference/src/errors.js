// Error envelope and code registry — Section 12.5.
//
// Each error code has a fixed HTTP status. Handlers throw a `PhipError` with a
// code, optional human-readable message, and optional `details` object. The
// HTTP layer serializes it into the standard envelope.

"use strict";

const ERROR_CODES = {
  OBJECT_NOT_FOUND: 404,
  OBJECT_EXISTS: 409,
  CHAIN_CONFLICT: 409,
  DUPLICATE_EVENT: 409,
  TERMINAL_STATE: 409,
  INVALID_SIGNATURE: 401,
  KEY_NOT_FOUND: 401,
  KEY_EXPIRED: 401,
  MISSING_CAPABILITY: 403,
  INVALID_CAPABILITY: 403,
  FOREIGN_NAMESPACE: 403,
  INVALID_OBJECT: 422,
  INVALID_EVENT: 422,
  INVALID_TRANSITION: 422,
  INVALID_TRACK: 422,
  INVALID_RELATION: 422,
  INVALID_QUERY: 422,
};

class PhipError extends Error {
  constructor(code, message, details) {
    super(message);
    if (!(code in ERROR_CODES)) {
      throw new Error("Unknown PhIP error code: " + code);
    }
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }

  toEnvelope() {
    const env = { error: { code: this.code, message: this.message } };
    if (this.details !== undefined) env.error.details = this.details;
    return env;
  }
}

module.exports = { ERROR_CODES, PhipError };
