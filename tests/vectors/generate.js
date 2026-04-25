// Test vector generator.
//
// Produces language-agnostic fixtures in tests/vectors/*/ from two fixed
// Ed25519 keypairs and a curated set of canonicalization inputs. The fixtures
// are committed to the repo and consumed by phip-js, phip-py, and any other
// client library to verify byte-for-byte agreement on JCS, SHA-256,
// Ed25519 sign/verify, URI parsing, hash-chain continuity, and lifecycle
// transitions.
//
// Event field names follow Section 10.1 exactly: event_id, phip_id, type,
// timestamp, actor, previous_hash, payload, signature. The first event in
// a history uses previous_hash = "genesis" per Section 10.3.
//
// Run `node vectors/generate.js` from the tests/ directory. Output is
// deterministic — the same Node version produces the same bytes every run.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const canonicalize = require("canonicalize");

const OUT = __dirname;

// Two fixed keypairs (PKCS#8 DER, base64). Used across all signing vectors.
// These are disposable test keys — do not use for anything real.
const KEYPAIRS = [
  {
    id: "test-key-alice",
    private_pkcs8_b64:
      "MC4CAQAwBQYDK2VwBCIEILYVuTR2efrX2+iRiMd6EmrgZNMaFhxPi8HpoS/N7PUh",
    public_raw_b64url: "-PMJVmvQQLw38uBOg3w4CXVk6CkadzUozxMUTzq96Ws",
  },
  {
    id: "test-key-bob",
    private_pkcs8_b64:
      "MC4CAQAwBQYDK2VwBCIEICzx/gACRv1KqpfCPNBGxWTqJ/Opc+SqwDEk5L+qEdCY",
    public_raw_b64url: "lO6Idw5fAiglC574c3jennZmmUNhgaUoUzhx6K-D6MQ",
  },
];

const keyObjects = KEYPAIRS.map((k) => {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(k.private_pkcs8_b64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const raw = Buffer.from(k.public_raw_b64url, "base64url");
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  const publicKey = crypto.createPublicKey({
    key: spki,
    format: "der",
    type: "spki",
  });
  return { ...k, privateKey, publicKey };
});

function getKey(id) {
  const k = keyObjects.find((x) => x.id === id);
  if (!k) throw new Error(`unknown test key: ${id}`);
  return k;
}

function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), "utf8");
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hashEvent(event) {
  return "sha256:" + sha256Hex(canonicalBytes(event));
}

function signEvent(event, keyId) {
  const key = getKey(keyId);
  const { signature, ...rest } = event;
  const sig = crypto.sign(null, canonicalBytes(rest), key.privateKey);
  return {
    ...rest,
    signature: {
      algorithm: "Ed25519",
      key_id: keyId,
      value: sig.toString("base64url"),
    },
  };
}

function writeJson(relPath, obj) {
  const full = path.join(OUT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(obj, null, 2) + "\n");
  console.log(`wrote ${relPath}`);
}

// ─────────────────────────────────────────────────────────────────────
// 1. Keypair fixture
// ─────────────────────────────────────────────────────────────────────

writeJson("ed25519/keypair.json", {
  description:
    "Fixed Ed25519 test keypairs in PKCS#8 DER (base64) and raw-32-byte " +
    "(base64url) form. Implementations SHOULD load the private key from " +
    "PKCS#8 DER and derive the public key from the raw 32 bytes.",
  keys: KEYPAIRS,
});

// ─────────────────────────────────────────────────────────────────────
// 2. JCS cases — RFC 8785 canonical serialization
// ─────────────────────────────────────────────────────────────────────

const JCS_INPUTS = [
  {
    name: "empty-object",
    description: "Empty JSON object.",
    input: {},
  },
  {
    name: "empty-array",
    description: "Empty JSON array.",
    input: [],
  },
  {
    name: "key-ordering",
    description:
      "Keys MUST be emitted in sorted code-point order, regardless of input order.",
    input: { c: 3, a: 1, b: 2 },
  },
  {
    name: "nested-ordering",
    description: "Sorting applies recursively to nested objects.",
    input: { outer: { z: 1, a: 2 }, alpha: { c: 3, b: 4 } },
  },
  {
    name: "unicode-values",
    description:
      "Non-ASCII strings are encoded as UTF-8. Code points below 0x20 are " +
      "escaped; printable code points are emitted literally.",
    input: { greeting: "héllo", emoji: "🧠", cjk: "日本語" },
  },
  {
    name: "unicode-keys",
    description: "Keys are sorted by UTF-16 code unit, like ECMAScript.",
    input: { "é": 1, "a": 2, "z": 3 },
  },
  {
    name: "escapes",
    description: "Mandatory JSON string escapes.",
    input: { s: 'line1\nline2\t"quoted"\\backslash' },
  },
  {
    name: "numbers-integers",
    description: "Integers are emitted without fractional part.",
    input: { zero: 0, pos: 42, neg: -17, big: 2147483647 },
  },
  {
    name: "numbers-floats",
    description:
      "Floating-point uses ECMAScript Number.prototype.toString — shortest " +
      "round-trip form.",
    input: { half: 0.5, pi: 3.14159, sci: 1e21 },
  },
  {
    name: "booleans-and-null",
    description: "true/false/null literals.",
    input: { t: true, f: false, n: null },
  },
  {
    name: "mixed-array",
    description: "Array order MUST be preserved (unlike object keys).",
    input: [3, 1, 2, { b: 2, a: 1 }],
  },
  {
    name: "deep-nesting",
    description: "Multiple levels of nesting still produce stable output.",
    input: { a: { b: { c: { d: { e: "leaf" } } } } },
  },
];

const jcsCases = JCS_INPUTS.map((c) => {
  const canonical = canonicalize(c.input);
  const bytes = Buffer.from(canonical, "utf8");
  return {
    name: c.name,
    description: c.description,
    input: c.input,
    canonical,
    canonical_bytes_hex: bytes.toString("hex"),
    canonical_byte_length: bytes.length,
  };
});

writeJson("jcs/cases.json", {
  description:
    "RFC 8785 JCS canonicalization cases. For each case, `canonical` is the " +
    "expected string output and `canonical_bytes_hex` is its UTF-8 encoding " +
    "in hex. Implementations MUST produce byte-identical output.",
  cases: jcsCases,
});

// ─────────────────────────────────────────────────────────────────────
// 3. Hash cases — SHA-256 with "sha256:" prefix, per Section 10.3
// ─────────────────────────────────────────────────────────────────────

const HASH_INPUTS = [
  { name: "empty-object", input: {} },
  { name: "single-key", input: { a: 1 } },
  {
    name: "example-event",
    input: {
      event_id: "c2b8d7e4-8f4a-4e3c-9a5f-10e4d8f9a1b2",
      phip_id: "phip://acme.example/parts/widget-001",
      type: "note",
      timestamp: "2026-01-01T00:00:00Z",
      actor: "phip://acme.example/actors/alice",
      previous_hash:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      payload: { text: "hello" },
    },
  },
];

const hashCases = HASH_INPUTS.map((c) => {
  const canonical = canonicalize(c.input);
  const hex = sha256Hex(Buffer.from(canonical, "utf8"));
  return {
    name: c.name,
    input: c.input,
    canonical,
    hash: "sha256:" + hex,
  };
});

writeJson("hash/cases.json", {
  description:
    "Event hash cases per Section 10.3. `hash` is the SHA-256 of the UTF-8 " +
    "bytes of the JCS canonicalization of `input`, prefixed with 'sha256:' " +
    "and encoded as 64 lowercase hex characters.",
  cases: hashCases,
});

// ─────────────────────────────────────────────────────────────────────
// 4. Ed25519 cases — raw bytes + event signing
// ─────────────────────────────────────────────────────────────────────

const RAW_MESSAGES = [
  { name: "empty", message_hex: "" },
  { name: "one-byte", message_hex: "61" },
  {
    name: "abc",
    message_hex: Buffer.from("abc", "utf8").toString("hex"),
  },
  {
    name: "lorem",
    message_hex: Buffer.from(
      "The quick brown fox jumps over the lazy dog",
      "utf8"
    ).toString("hex"),
  },
];

const rawCases = [];
for (const keyId of ["test-key-alice", "test-key-bob"]) {
  const key = getKey(keyId);
  for (const m of RAW_MESSAGES) {
    const sig = crypto.sign(
      null,
      Buffer.from(m.message_hex, "hex"),
      key.privateKey
    );
    rawCases.push({
      name: `${keyId}-${m.name}`,
      key_id: keyId,
      message_hex: m.message_hex,
      signature_b64url: sig.toString("base64url"),
    });
  }
}

// Event-signing cases — canonicalize the event minus its signature, then sign.
const EVENT_INPUTS = [
  {
    name: "note-event",
    key_id: "test-key-alice",
    event: {
      event_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      phip_id: "phip://acme.example/parts/widget-001",
      type: "note",
      timestamp: "2026-01-01T00:00:00Z",
      actor: "phip://acme.example/actors/alice",
      previous_hash:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      payload: { text: "hello world" },
    },
  },
  {
    name: "state-transition",
    key_id: "test-key-bob",
    event: {
      event_id: "b2c3d4e5-f6a7-8901-bcde-f23456789012",
      phip_id: "phip://acme.example/parts/widget-001",
      type: "state_transition",
      timestamp: "2026-01-02T12:00:00Z",
      actor: "phip://acme.example/actors/bob",
      previous_hash:
        "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      payload: { from: "stock", to: "deployed" },
    },
  },
];

const eventCases = EVENT_INPUTS.map((c) => {
  const canonical = canonicalize(c.event);
  const bytes = Buffer.from(canonical, "utf8");
  const signed = signEvent(c.event, c.key_id);
  return {
    name: c.name,
    key_id: c.key_id,
    event_unsigned: c.event,
    canonical_bytes_hex: bytes.toString("hex"),
    signature_b64url: signed.signature.value,
    signed_event: signed,
  };
});

writeJson("ed25519/cases.json", {
  description:
    "Ed25519 signing cases per Section 11.1. `raw` cases sign arbitrary byte " +
    "strings; `events` cases sign the canonical JSON of a PhIP event with " +
    "the `signature` field stripped. Signatures are deterministic (RFC 8032). " +
    "`signature_b64url` is the raw base64url-encoded 64-byte signature — the " +
    "reference implementation stores this directly in `signature.value`.",
  raw: rawCases,
  events: eventCases,
});

// ─────────────────────────────────────────────────────────────────────
// 5. URI parsing cases — Section 4
// ─────────────────────────────────────────────────────────────────────

writeJson("uri/cases.json", {
  description:
    "PhIP URI parsing per Section 4. Valid URIs decompose into authority, " +
    "namespace, local_id, and optional sub_path (array of path segments " +
    "after local_id, if any). Invalid URIs MUST be rejected.",
  valid: [
    {
      uri: "phip://acme.example/parts/widget-001",
      authority: "acme.example",
      namespace: "parts",
      local_id: "widget-001",
      sub_path: [],
    },
    {
      uri: "phip://acme.example/parts/widget-001/sensors/temp-1",
      authority: "acme.example",
      namespace: "parts",
      local_id: "widget-001",
      sub_path: ["sensors", "temp-1"],
    },
    {
      uri: "phip://sub.acme.example/lots/LOT-2026-04-001",
      authority: "sub.acme.example",
      namespace: "lots",
      local_id: "LOT-2026-04-001",
      sub_path: [],
    },
    {
      uri: "phip://acme-mfg.co.uk/racks/R1.A.07",
      authority: "acme-mfg.co.uk",
      namespace: "racks",
      local_id: "R1.A.07",
      sub_path: [],
    },
  ],
  invalid: [
    { uri: "http://acme.example/parts/x", reason: "wrong scheme" },
    { uri: "phip:/acme.example/parts/x", reason: "missing //" },
    { uri: "phip://acme.example/parts", reason: "missing local-id segment" },
    { uri: "phip://acme.example//widget", reason: "empty namespace segment" },
    { uri: "phip:///parts/widget", reason: "empty authority" },
    { uri: "phip://acme example/parts/x", reason: "space in authority" },
  ],
});

// ─────────────────────────────────────────────────────────────────────
// 6. Hash chain sequence — Section 10.3
// ─────────────────────────────────────────────────────────────────────

const PHIP_ID = "phip://acme.example/parts/widget-001";
const chainEvents = [];

let event0 = {
  event_id: "10000000-0000-4000-a000-000000000001",
  phip_id: PHIP_ID,
  type: "created",
  timestamp: "2026-01-01T00:00:00Z",
  actor: "phip://acme.example/actors/alice",
  previous_hash: "genesis",
  payload: { object_type: "component", state: "concept" },
};
event0 = signEvent(event0, "test-key-alice");
chainEvents.push(event0);

let event1 = {
  event_id: "10000000-0000-4000-a000-000000000002",
  phip_id: PHIP_ID,
  type: "state_transition",
  timestamp: "2026-01-02T00:00:00Z",
  actor: "phip://acme.example/actors/alice",
  previous_hash: hashEvent(event0),
  payload: { from: "concept", to: "design" },
};
event1 = signEvent(event1, "test-key-alice");
chainEvents.push(event1);

let event2 = {
  event_id: "10000000-0000-4000-a000-000000000003",
  phip_id: PHIP_ID,
  type: "note",
  timestamp: "2026-01-03T00:00:00Z",
  actor: "phip://acme.example/actors/bob",
  previous_hash: hashEvent(event1),
  payload: { text: "Design review complete" },
};
event2 = signEvent(event2, "test-key-bob");
chainEvents.push(event2);

writeJson("hashchain/sequence.json", {
  description:
    "A three-event hash chain. Implementations MUST verify that each " +
    "event's `previous_hash` equals the SHA-256-prefixed hash of the " +
    "full canonical-JSON serialization of the preceding event " +
    "(signature field included), per Section 10.3. The first event's " +
    "previous_hash is the literal string \"genesis\".",
  phip_id: PHIP_ID,
  events: chainEvents,
  expected_hashes: chainEvents.map((e) => hashEvent(e)),
});

// ─────────────────────────────────────────────────────────────────────
// 7. Lifecycle transition cases — Section 9
// ─────────────────────────────────────────────────────────────────────

const MANUFACTURING_TRANSITIONS = {
  concept: ["design"],
  design: ["prototype", "qualified"],
  prototype: ["design", "qualified"],
  qualified: ["stock", "consumed"],
  stock: ["deployed", "decommissioned", "consumed"],
  deployed: ["maintained", "decommissioned"],
  maintained: ["deployed", "decommissioned"],
  decommissioned: ["consumed", "disposed"],
  consumed: [],
  disposed: [],
};

const OPERATIONAL_TRANSITIONS = {
  planned: ["active", "archived"],
  active: ["inactive", "archived"],
  inactive: ["active", "archived"],
  archived: [],
};

function expandTransitions(table) {
  const valid = [];
  const invalid = [];
  const states = Object.keys(table);
  for (const from of states) {
    for (const to of states) {
      if (table[from].includes(to)) {
        valid.push({ from, to });
      } else if (from !== to) {
        invalid.push({ from, to });
      }
    }
  }
  return { valid, invalid };
}

writeJson("lifecycle/manufacturing.json", {
  description:
    "Manufacturing track state transitions per Section 9.2.1. Applies to " +
    "object types: material, component, assembly, system, lot, design.",
  object_types: ["material", "component", "assembly", "system", "lot", "design"],
  states: Object.keys(MANUFACTURING_TRANSITIONS),
  terminal_states: ["consumed", "disposed"],
  transitions: MANUFACTURING_TRANSITIONS,
  ...expandTransitions(MANUFACTURING_TRANSITIONS),
});

writeJson("lifecycle/operational.json", {
  description:
    "Operational track state transitions per Section 9.3.1. Applies to " +
    "object types: actor, location, vehicle. Archived objects MAY accept " +
    "`note` events; all other terminal states reject every event.",
  object_types: ["actor", "location", "vehicle"],
  states: Object.keys(OPERATIONAL_TRANSITIONS),
  terminal_states: ["archived"],
  archived_accepts_note: true,
  transitions: OPERATIONAL_TRANSITIONS,
  ...expandTransitions(OPERATIONAL_TRANSITIONS),
});

// ─────────────────────────────────────────────────────────────────────
// 8. Bootstrap key self-signing — Section 11.2.4
// ─────────────────────────────────────────────────────────────────────

const BOOTSTRAP_PHIP_ID = "phip://acme.example/keys/alice-bootstrap";
let bootstrapCreated = {
  event_id: "20000000-0000-4000-a000-000000000001",
  phip_id: BOOTSTRAP_PHIP_ID,
  type: "created",
  timestamp: "2026-01-01T00:00:00Z",
  actor: BOOTSTRAP_PHIP_ID,
  previous_hash: "genesis",
  payload: {
    object_type: "actor",
    state: "active",
    identity: { label: "Alice bootstrap key" },
    attributes: {
      "phip:keys": {
        kty: "OKP",
        crv: "Ed25519",
        x: getKey("test-key-alice").public_raw_b64url,
        not_before: "2026-01-01T00:00:00Z",
        not_after: "2030-01-01T00:00:00Z",
      },
    },
  },
};
bootstrapCreated = signEvent(bootstrapCreated, "test-key-alice");

writeJson("bootstrap/example.json", {
  description:
    "Self-signed bootstrap key registration per Section 11.2.4. The object " +
    "being created is an actor whose phip:keys attribute contains the " +
    "public key used to sign the event itself. Verifiers MUST accept this " +
    "pattern only for the `created` event on an actor whose `actor` field " +
    "equals its own `phip_id`.",
  bootstrap_actor_id: BOOTSTRAP_PHIP_ID,
  key_id: "test-key-alice",
  created_event: bootstrapCreated,
});

console.log("\nall vectors written.");
