// RFC 8785 — JSON Canonicalization Scheme (JCS).
//
// Per Section 10.3 of the spec, the hash chain and event signatures are
// computed over the JCS serialization of the event. Keys lexicographically
// sorted, no insignificant whitespace, ECMAScript number serialization,
// UTF-8 encoding.
//
// We delegate to the `canonicalize` npm package, which is the reference JCS
// implementation.

"use strict";

const canonicalizePkg = require("canonicalize");

function canonicalJson(value) {
  return canonicalizePkg(value);
}

function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), "utf8");
}

module.exports = { canonicalJson, canonicalBytes };
