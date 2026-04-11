// Cryptographic primitives — SHA-256 + Ed25519.
//
// Section 10.3: previous_hash = "sha256:" + hex(SHA-256(JCS(prevEvent)))
// Section 11.1: signature computed over JCS serialization of event minus the
//               signature field itself, using Ed25519.
//
// Uses Node.js built-in node:crypto for both.

"use strict";

const crypto = require("node:crypto");
const { canonicalBytes, canonicalJson } = require("./canonicalize");

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Hash an event the way the hash chain requires: JCS the full event, SHA-256.
function hashEvent(event) {
  return "sha256:" + sha256Hex(canonicalBytes(event));
}

// Ed25519 keypair generation. Returns raw 32-byte public key and a Node KeyObject
// for the private key (so callers don't need to touch raw bytes).
function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicRaw = publicKey.export({ format: "der", type: "spki" }).slice(-32);
  return {
    privateKey,
    publicKey,
    publicKeyBase64Url: publicRaw.toString("base64url"),
  };
}

// Build a Node KeyObject from a raw 32-byte Ed25519 public key (base64url).
function publicKeyFromBase64Url(b64url) {
  const raw = Buffer.from(b64url, "base64url");
  if (raw.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  // SPKI prefix for Ed25519: 302a300506032b6570032100
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

// Compute the Ed25519 signature bytes over the canonical JSON of an event
// that has `signature` stripped out. Returns base64url-encoded signature.
function signEventBytes(eventWithoutSig, privateKey) {
  const canonicalBuf = canonicalBytes(eventWithoutSig);
  const sig = crypto.sign(null, canonicalBuf, privateKey);
  return sig.toString("base64url");
}

function verifyEventSignatureBytes(eventWithoutSig, sigB64Url, publicKey) {
  let raw;
  // Accept optional "base64url:" prefix used in spec examples.
  if (sigB64Url.startsWith("base64url:")) {
    raw = Buffer.from(sigB64Url.slice("base64url:".length), "base64url");
  } else {
    raw = Buffer.from(sigB64Url, "base64url");
  }
  const canonicalBuf = canonicalBytes(eventWithoutSig);
  return crypto.verify(null, canonicalBuf, publicKey, raw);
}

// High-level: take a whole event, produce a signed event (attaching signature).
function signEvent(event, privateKey, keyId) {
  const { signature, ...rest } = event;
  const value = signEventBytes(rest, privateKey);
  return {
    ...rest,
    signature: { algorithm: "Ed25519", key_id: keyId, value },
  };
}

function verifyEvent(event, publicKey) {
  if (!event.signature || !event.signature.value) return false;
  const { signature, ...rest } = event;
  return verifyEventSignatureBytes(rest, signature.value, publicKey);
}

module.exports = {
  sha256Hex,
  hashEvent,
  generateEd25519KeyPair,
  publicKeyFromBase64Url,
  signEvent,
  verifyEvent,
  canonicalJson,
};
