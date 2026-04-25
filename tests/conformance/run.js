// PhIP HTTP conformance suite.
//
// Exercises any PhIP server over HTTPS (or HTTP) to verify it implements the
// wire contract from phip-core.md Sections 4, 10, 11, 12. This is a
// black-box test — the server must only expose the standard endpoints under
// /.well-known/phip/.
//
// Usage:   node conformance/run.js <base-url> [namespace]
// Example: node conformance/run.js http://localhost:3000 conformance
//
// The suite creates a self-signed bootstrap actor, then a component object,
// pushes state transitions and attribute updates, reads history, runs
// queries, and asserts error envelopes. All object ids are suffixed with a
// random run-id so the suite is safe to run repeatedly against the same
// server.

"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");
const canonicalize = require("canonicalize");

// Parse argv: base-url is positional; namespace and authority can be
// positional or passed as --flag. Authority defaults to the URL hostname but
// MUST be overridable because PhIP authorities are names, not network
// addresses — a server bound to authority "acme.example" can be reached at
// http://localhost:8080 during testing.
const raw = process.argv.slice(2);
let BASE_URL = null;
let NAMESPACE = "conformance";
let AUTHORITY_OVERRIDE = null;
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a === "--namespace") NAMESPACE = raw[++i];
  else if (a === "--authority") AUTHORITY_OVERRIDE = raw[++i];
  else if (!BASE_URL) BASE_URL = a;
  else NAMESPACE = a;
}
if (!BASE_URL) {
  console.error(
    "usage: node conformance/run.js <base-url> [--namespace <ns>] [--authority <auth>]"
  );
  process.exit(2);
}

const RUN_ID = crypto.randomBytes(4).toString("hex");
const KEY_LOCAL_ID = `keys/bootstrap-${RUN_ID}`;
const OBJ_LOCAL_ID = `units/${RUN_ID}`;
const AUTHORITY = AUTHORITY_OVERRIDE || new URL(BASE_URL).host.split(":")[0];
const KEY_PHIP_ID = `phip://${AUTHORITY}/${NAMESPACE}/${KEY_LOCAL_ID}`;
const OBJ_PHIP_ID = `phip://${AUTHORITY}/${NAMESPACE}/${OBJ_LOCAL_ID}`;

// ── crypto helpers (using fixed test keypair from vectors) ────────────

const keypairs = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "vectors", "ed25519", "keypair.json"), "utf8")
).keys;
const TESTKEY = keypairs[0];

const privateKey = crypto.createPrivateKey({
  key: Buffer.from(TESTKEY.private_pkcs8_b64, "base64"),
  format: "der",
  type: "pkcs8",
});

function canonicalBytes(v) {
  return Buffer.from(canonicalize(v), "utf8");
}
function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function hashEvent(event) {
  return "sha256:" + sha256Hex(canonicalBytes(event));
}
function signEvent(event, keyId) {
  const { signature, ...rest } = event;
  const sig = crypto.sign(null, canonicalBytes(rest), privateKey);
  return {
    ...rest,
    signature: {
      algorithm: "Ed25519",
      key_id: keyId,
      value: sig.toString("base64url"),
    },
  };
}
function newEventId() {
  return crypto.randomUUID();
}

// ── HTTP client ──────────────────────────────────────────────────────

function request(method, relPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + relPath);
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const lib = url.protocol === "https:" ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": payload.length }
        : {},
    };
    const req = lib.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        if (data.length) {
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            return reject(new Error(`non-JSON response (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── test harness ─────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures = [];

function test(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── endpoints ────────────────────────────────────────────────────────

const OBJECTS = (ns) => `/.well-known/phip/objects/${ns}`;
const RESOLVE = (ns, id) => `/.well-known/phip/resolve/${ns}/${id}`;
const PUSH = (ns, id) => `/.well-known/phip/push/${ns}/${id}`;
const HISTORY = (ns, id) => `/.well-known/phip/history/${ns}/${id}`;
const QUERY = (ns) => `/.well-known/phip/query/${ns}`;

// ── suite ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nPhIP conformance suite`);
  console.log(`base:      ${BASE_URL}`);
  console.log(`namespace: ${NAMESPACE}`);
  console.log(`run id:    ${RUN_ID}`);

  // ── 1. Bootstrap self-signed key ───────────────────────────────────
  console.log(`\n[1] bootstrap key`);
  const bootstrapEvent = signEvent(
    {
      event_id: newEventId(),
      phip_id: KEY_PHIP_ID,
      type: "created",
      timestamp: new Date().toISOString(),
      actor: KEY_PHIP_ID,
      previous_hash: "genesis",
      payload: {
        object_type: "actor",
        state: "active",
        identity: { label: `conformance run ${RUN_ID}` },
        attributes: {
          "phip:keys": {
            kty: "OKP",
            crv: "Ed25519",
            x: TESTKEY.public_raw_b64url,
            not_before: "2026-01-01T00:00:00Z",
            not_after: "2030-01-01T00:00:00Z",
          },
        },
      },
    },
    KEY_PHIP_ID
  );

  const r1 = await request("POST", OBJECTS(NAMESPACE), bootstrapEvent);
  test("CREATE bootstrap returns 201", r1.status === 201, `got ${r1.status}`);
  test("CREATE bootstrap phip_id matches", r1.body && r1.body.phip_id === KEY_PHIP_ID);
  test("CREATE bootstrap state=active", r1.body && r1.body.state === "active");
  test(
    "CREATE bootstrap history_head is sha256:",
    r1.body && typeof r1.body.history_head === "string" && r1.body.history_head.startsWith("sha256:")
  );
  test("CREATE bootstrap history_length=1", r1.body && r1.body.history_length === 1);

  // ── 2. Create component object (concept state) ────────────────────
  console.log(`\n[2] CREATE component`);
  const createEvent = signEvent(
    {
      event_id: newEventId(),
      phip_id: OBJ_PHIP_ID,
      type: "created",
      timestamp: new Date().toISOString(),
      actor: KEY_PHIP_ID,
      previous_hash: "genesis",
      payload: {
        object_type: "component",
        state: "concept",
        identity: { serial: `CONF-${RUN_ID}` },
      },
    },
    KEY_PHIP_ID
  );
  const r2 = await request("POST", OBJECTS(NAMESPACE), createEvent);
  test("CREATE component returns 201", r2.status === 201, `got ${r2.status}`);
  test("CREATE component state=concept", r2.body && r2.body.state === "concept");
  test("CREATE component object_type=component", r2.body && r2.body.object_type === "component");

  // ── 3. Idempotent GET ─────────────────────────────────────────────
  console.log(`\n[3] GET`);
  const r3 = await request("GET", RESOLVE(NAMESPACE, OBJ_LOCAL_ID));
  test("GET returns 200", r3.status === 200);
  test("GET phip_id matches", r3.body && r3.body.phip_id === OBJ_PHIP_ID);
  test("GET history_length=1", r3.body && r3.body.history_length === 1);
  const headAfterCreate = r3.body && r3.body.history_head;
  test("GET history_head present", !!headAfterCreate);

  // ── 4. PUSH a valid state_transition ──────────────────────────────
  console.log(`\n[4] PUSH state_transition`);
  const transitionEvent = signEvent(
    {
      event_id: newEventId(),
      phip_id: OBJ_PHIP_ID,
      type: "state_transition",
      timestamp: new Date().toISOString(),
      actor: KEY_PHIP_ID,
      previous_hash: headAfterCreate,
      payload: { from: "concept", to: "design" },
    },
    KEY_PHIP_ID
  );
  const r4 = await request("POST", PUSH(NAMESPACE, OBJ_LOCAL_ID), transitionEvent);
  test("PUSH returns 201", r4.status === 201, `got ${r4.status}`);
  test("PUSH body echoes the appended event", r4.body && r4.body.event_id === transitionEvent.event_id);
  const afterPush = await request("GET", RESOLVE(NAMESPACE, OBJ_LOCAL_ID));
  test("after PUSH state=design", afterPush.body && afterPush.body.state === "design");
  test("after PUSH history_length=2", afterPush.body && afterPush.body.history_length === 2);

  // ── 5. PUSH attribute_update ──────────────────────────────────────
  console.log(`\n[5] PUSH attribute_update`);
  const head5 = afterPush.body.history_head;
  const attrEvent = signEvent(
    {
      event_id: newEventId(),
      phip_id: OBJ_PHIP_ID,
      type: "attribute_update",
      timestamp: new Date().toISOString(),
      actor: KEY_PHIP_ID,
      previous_hash: head5,
      payload: {
        namespace: "phip:software",
        updates: { firmware: `conf-fw-${RUN_ID}` },
      },
    },
    KEY_PHIP_ID
  );
  const r5 = await request("POST", PUSH(NAMESPACE, OBJ_LOCAL_ID), attrEvent);
  test("attribute_update returns 201", r5.status === 201, `got ${r5.status}`);
  const afterAttr = await request("GET", RESOLVE(NAMESPACE, OBJ_LOCAL_ID));
  test(
    "attribute_update reflected in projection",
    afterAttr.body &&
      afterAttr.body.attributes &&
      afterAttr.body.attributes["phip:software"] &&
      afterAttr.body.attributes["phip:software"].firmware === `conf-fw-${RUN_ID}`
  );

  // ── 6. Invalid transition — design → stock ────────────────────────
  console.log(`\n[6] invalid transition rejected`);
  const head6 = afterAttr.body.history_head;
  const badTransition = signEvent(
    {
      event_id: newEventId(),
      phip_id: OBJ_PHIP_ID,
      type: "state_transition",
      timestamp: new Date().toISOString(),
      actor: KEY_PHIP_ID,
      previous_hash: head6,
      payload: { from: "design", to: "stock" },
    },
    KEY_PHIP_ID
  );
  const r6 = await request("POST", PUSH(NAMESPACE, OBJ_LOCAL_ID), badTransition);
  test("invalid transition returns 4xx", r6.status >= 400 && r6.status < 500, `got ${r6.status}`);
  test(
    "invalid transition error envelope",
    r6.body && r6.body.error && r6.body.error.code === "INVALID_TRANSITION",
    `got ${r6.body && r6.body.error && r6.body.error.code}`
  );

  // ── 7. Stale previous_hash — CHAIN_CONFLICT 409 ───────────────────
  console.log(`\n[7] chain conflict`);
  const staleEvent = signEvent(
    {
      event_id: newEventId(),
      phip_id: OBJ_PHIP_ID,
      type: "state_transition",
      timestamp: new Date().toISOString(),
      actor: KEY_PHIP_ID,
      previous_hash: "sha256:" + "0".repeat(64),
      payload: { from: "design", to: "qualified" },
    },
    KEY_PHIP_ID
  );
  const r7 = await request("POST", PUSH(NAMESPACE, OBJ_LOCAL_ID), staleEvent);
  test("stale previous_hash returns 409", r7.status === 409, `got ${r7.status}`);
  test(
    "CHAIN_CONFLICT error code",
    r7.body && r7.body.error && r7.body.error.code === "CHAIN_CONFLICT"
  );
  test(
    "CHAIN_CONFLICT details.current_head present",
    r7.body && r7.body.error && r7.body.error.details && typeof r7.body.error.details.current_head === "string"
  );

  // ── 8. History sub-resource ───────────────────────────────────────
  console.log(`\n[8] history pagination`);
  const r8 = await request("GET", HISTORY(NAMESPACE, OBJ_LOCAL_ID) + "?limit=100");
  test("history returns 200", r8.status === 200);
  test("history has 3 events", r8.body && r8.body.events && r8.body.events.length === 3);
  test("history_length=3", r8.body && r8.body.history_length === 3);

  // Verify chain continuity client-side.
  const events = r8.body.events;
  let chainOk = events[0].previous_hash === "genesis";
  for (let i = 1; chainOk && i < events.length; i++) {
    chainOk = events[i].previous_hash === hashEvent(events[i - 1]);
  }
  test("hash chain verifies end-to-end", chainOk);

  // ── 9. QUERY by object_type ───────────────────────────────────────
  console.log(`\n[9] QUERY`);
  const r9 = await request("POST", QUERY(NAMESPACE), {
    filters: { object_type: "component" },
  });
  test("QUERY returns 200", r9.status === 200);
  test(
    "QUERY result contains our object",
    r9.body && Array.isArray(r9.body.matches) && r9.body.matches.includes(OBJ_PHIP_ID)
  );

  const r9b = await request("POST", QUERY(NAMESPACE), {
    filters: { state: "design" },
  });
  test("QUERY by state returns 200", r9b.status === 200);
  test(
    "QUERY by state=design contains object",
    r9b.body && r9b.body.matches.includes(OBJ_PHIP_ID)
  );

  // ── 10. Error envelopes ───────────────────────────────────────────
  console.log(`\n[10] error envelopes`);
  const r10 = await request("GET", RESOLVE(NAMESPACE, `nonexistent-${RUN_ID}`));
  test("GET unknown object returns 404", r10.status === 404);
  test(
    "OBJECT_NOT_FOUND error code",
    r10.body && r10.body.error && r10.body.error.code === "OBJECT_NOT_FOUND"
  );

  const r10b = await request("POST", OBJECTS(NAMESPACE), bootstrapEvent);
  test("duplicate CREATE returns 409", r10b.status === 409, `got ${r10b.status}`);
  test(
    "OBJECT_EXISTS error code",
    r10b.body && r10b.body.error && r10b.body.error.code === "OBJECT_EXISTS"
  );

  // ── summary ───────────────────────────────────────────────────────
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log(`\nfailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("conformance suite crashed:", err);
  process.exit(2);
});
