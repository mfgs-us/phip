#!/usr/bin/env node
// PhIP HTTP conformance suite.
//
// Exercises any PhIP server over HTTPS (or HTTP) to verify it implements the
// wire contract from phip-core.md Sections 4, 10, 11, 12. This is a
// black-box test — the server must only expose the standard endpoints under
// /.well-known/phip/.
//
// Installed via `npm install -g @phip/conformance`, then:
//   phip-conformance <base-url> [--namespace ns] [--authority host]
//
// Or run directly from a checkout:
//   node conformance/run.js <base-url>
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
const canonicalize = require("canonicalize");

// Parse argv: base-url is positional; namespace and authority can be
// positional or passed as --flag. Authority defaults to the URL hostname but
// MUST be overridable because PhIP authorities are names, not network
// addresses — a server bound to authority "acme.example" can be reached at
// http://localhost:8080 during testing.
function printUsage() {
  console.error(
    "usage: phip-conformance <base-url> [--namespace <ns>] [--authority <auth>]\n" +
    "\n" +
    "  <base-url>     URL where the resolver is reachable (e.g. https://acme.example).\n" +
    "  --namespace    Namespace to create test objects under. Default: 'conformance'.\n" +
    "  --authority    PhIP authority name the resolver claims to be. Defaults to the\n" +
    "                 URL hostname; override when network address ≠ authority name."
  );
}
const raw = process.argv.slice(2);
if (raw.length === 0 || raw.includes("--help") || raw.includes("-h")) {
  printUsage();
  process.exit(raw.length === 0 ? 2 : 0);
}
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
  printUsage();
  process.exit(2);
}

const RUN_ID = crypto.randomBytes(4).toString("hex");
const KEY_LOCAL_ID = `keys/bootstrap-${RUN_ID}`;
const OBJ_LOCAL_ID = `units/${RUN_ID}`;
const AUTHORITY = AUTHORITY_OVERRIDE || new URL(BASE_URL).host.split(":")[0];
const KEY_PHIP_ID = `phip://${AUTHORITY}/${NAMESPACE}/${KEY_LOCAL_ID}`;
const OBJ_PHIP_ID = `phip://${AUTHORITY}/${NAMESPACE}/${OBJ_LOCAL_ID}`;

// ── crypto helpers ──────────────────────────────────────────────────
//
// The conformance suite needs a deterministic Ed25519 keypair for
// signing the bootstrap actor's events. We embed one directly so the
// package is self-contained when published — no dependency on the
// vectors/ tree. This is the same `test-key-alice` keypair from
// `tests/vectors/ed25519/keypair.json`, kept in sync.
const TESTKEY = {
  private_pkcs8_b64:
    "MC4CAQAwBQYDK2VwBCIEILYVuTR2efrX2+iRiMd6EmrgZNMaFhxPi8HpoS/N7PUh",
  public_raw_b64url: "-PMJVmvQQLw38uBOg3w4CXVk6CkadzUozxMUTzq96Ws",
};

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

function request(method, relPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + relPath);
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const lib = url.protocol === "https:" ? https : http;
    const headers = Object.assign(
      payload
        ? { "Content-Type": "application/json", "Content-Length": payload.length }
        : {},
      extraHeaders || {},
    );
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
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

  // ── 11. /meta endpoint (§12.7 — OPTIONAL) ─────────────────────────
  // Spec: "A resolver that does not publish /meta is still conformant."
  // We assert shape only when the resolver opts in. A 404 (or any non-200)
  // means the resolver elected not to publish; the entire §11/§12 block
  // becomes informational.
  console.log(`\n[11] /meta endpoint`);
  const rMeta = await request("GET", "/.well-known/phip/meta");
  const metaPublished = rMeta.status === 200 && rMeta.body && typeof rMeta.body === "object";
  if (!metaPublished) {
    console.log("  (skipped — resolver does not publish /meta, which is OPTIONAL per §12.7)");
  } else {
    test("/meta returns 200", rMeta.status === 200);
    test("/meta has protocol_version", typeof rMeta.body.protocol_version === "string");
    test("/meta has authority", rMeta.body.authority === AUTHORITY);
    test(
      "/meta has conformance_class",
      typeof rMeta.body.conformance_class === "string",
    );
    test(
      "/meta supported_operations is an array",
      Array.isArray(rMeta.body.supported_operations),
    );
    test(
      "/meta sets Cache-Control header",
      rMeta.headers && typeof rMeta.headers["cache-control"] === "string"
        && rMeta.headers["cache-control"].includes("max-age"),
    );
  }

  // ── 12. Batch CREATE — mixed outcomes → 207 ───────────────────────
  // Skips entire section if the resolver does not advertise batch support.
  console.log(`\n[12] batch CREATE`);
  const supportsBatchCreate = metaPublished && Array.isArray(rMeta.body.supported_operations)
    && rMeta.body.supported_operations.includes("batch_create");
  if (!supportsBatchCreate) {
    console.log("  (skipped — resolver does not advertise batch_create)");
  } else {
    const batchCreateEvents = [
      signEvent({
        event_id: newEventId(),
        phip_id: `phip://${AUTHORITY}/${NAMESPACE}/units/batch-A-${RUN_ID}`,
        type: "created", timestamp: new Date().toISOString(), actor: KEY_PHIP_ID,
        previous_hash: "genesis",
        payload: { object_type: "component", state: "concept" },
      }, KEY_PHIP_ID),
      signEvent({
        event_id: newEventId(),
        phip_id: `phip://${AUTHORITY}/${NAMESPACE}/units/batch-B-${RUN_ID}`,
        type: "created", timestamp: new Date().toISOString(), actor: KEY_PHIP_ID,
        previous_hash: "genesis",
        payload: { object_type: "component", state: "concept" },
      }, KEY_PHIP_ID),
      // Duplicate of A — must error.
      signEvent({
        event_id: newEventId(),
        phip_id: `phip://${AUTHORITY}/${NAMESPACE}/units/batch-A-${RUN_ID}`,
        type: "created", timestamp: new Date().toISOString(), actor: KEY_PHIP_ID,
        previous_hash: "genesis",
        payload: { object_type: "component", state: "concept" },
      }, KEY_PHIP_ID),
    ];
    const rBatch = await request("POST", `/.well-known/phip/objects/${NAMESPACE}/batch`, {
      events: batchCreateEvents,
    });
    test("batch with mixed outcomes returns 207", rBatch.status === 207, `got ${rBatch.status}`);
    test(
      "batch summary 2 succeeded / 1 failed",
      rBatch.body && rBatch.body.summary &&
        rBatch.body.summary.succeeded === 2 && rBatch.body.summary.failed === 1,
    );
    test(
      "batch results carry status field",
      Array.isArray(rBatch.body && rBatch.body.results) &&
        rBatch.body.results.every((r) => typeof r.status === "string"),
    );

    // All-succeed → 200.
    const allOkEvents = [
      signEvent({
        event_id: newEventId(),
        phip_id: `phip://${AUTHORITY}/${NAMESPACE}/units/batch-C-${RUN_ID}`,
        type: "created", timestamp: new Date().toISOString(), actor: KEY_PHIP_ID,
        previous_hash: "genesis",
        payload: { object_type: "component", state: "concept" },
      }, KEY_PHIP_ID),
      signEvent({
        event_id: newEventId(),
        phip_id: `phip://${AUTHORITY}/${NAMESPACE}/units/batch-D-${RUN_ID}`,
        type: "created", timestamp: new Date().toISOString(), actor: KEY_PHIP_ID,
        previous_hash: "genesis",
        payload: { object_type: "component", state: "concept" },
      }, KEY_PHIP_ID),
    ];
    const rAllOk = await request("POST", `/.well-known/phip/objects/${NAMESPACE}/batch`, {
      events: allOkEvents,
    });
    test("batch with all successes returns 200", rAllOk.status === 200, `got ${rAllOk.status}`);

    // Malformed envelope → 400.
    const rMalformed = await request("POST", `/.well-known/phip/objects/${NAMESPACE}/batch`, {
      not_events: [],
    });
    test("batch with malformed envelope returns 400", rMalformed.status === 400, `got ${rMalformed.status}`);
  }

  // ── 13. design type + instance_of constraint (§6.2, §6.3) ─────────
  console.log(`\n[13] design type and instance_of`);
  const DESIGN_LOCAL = `designs/widget-r1-${RUN_ID}`;
  const DESIGN_PHIP = `phip://${AUTHORITY}/${NAMESPACE}/${DESIGN_LOCAL}`;
  const designEvt = signEvent({
    event_id: newEventId(), phip_id: DESIGN_PHIP, type: "created",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: "genesis",
    payload: {
      object_type: "design", state: "qualified",
      identity: { part_number: `WGT-${RUN_ID}`, revision: "A" },
    },
  }, KEY_PHIP_ID);
  const rDesign = await request("POST", OBJECTS(NAMESPACE), designEvt);
  test("design CREATE returns 201", rDesign.status === 201, `got ${rDesign.status}`);

  // instance_of must target a design — pointing at the actor (key) MUST fail.
  const badInstEvt = signEvent({
    event_id: newEventId(),
    phip_id: `phip://${AUTHORITY}/${NAMESPACE}/units/bad-inst-${RUN_ID}`,
    type: "created", timestamp: new Date().toISOString(), actor: KEY_PHIP_ID,
    previous_hash: "genesis",
    payload: {
      object_type: "component", state: "concept",
      relations: [{ type: "instance_of", phip_id: KEY_PHIP_ID }],
    },
  }, KEY_PHIP_ID);
  const rBadInst = await request("POST", OBJECTS(NAMESPACE), badInstEvt);
  test(
    "instance_of pointing at actor returns 422",
    rBadInst.status === 422,
    `got ${rBadInst.status}`,
  );
  test(
    "instance_of constraint surfaces INVALID_RELATION",
    rBadInst.body && rBadInst.body.error && rBadInst.body.error.code === "INVALID_RELATION",
  );

  // instance_of pointing at a valid design — must succeed.
  const goodInstEvt = signEvent({
    event_id: newEventId(),
    phip_id: `phip://${AUTHORITY}/${NAMESPACE}/units/good-inst-${RUN_ID}`,
    type: "created", timestamp: new Date().toISOString(), actor: KEY_PHIP_ID,
    previous_hash: "genesis",
    payload: {
      object_type: "component", state: "stock",
      relations: [{ type: "instance_of", phip_id: DESIGN_PHIP }],
    },
  }, KEY_PHIP_ID);
  const rGoodInst = await request("POST", OBJECTS(NAMESPACE), goodInstEvt);
  test(
    "instance_of pointing at a design is accepted",
    rGoodInst.status === 201,
    `got ${rGoodInst.status}`,
  );

  // ── 14. DANGLING_RELATION (§7.4) ──────────────────────────────────
  console.log(`\n[14] DANGLING_RELATION`);
  const danglingCreateEvt = signEvent({
    event_id: newEventId(),
    phip_id: `phip://${AUTHORITY}/${NAMESPACE}/units/dangling-${RUN_ID}`,
    type: "created", timestamp: new Date().toISOString(), actor: KEY_PHIP_ID,
    previous_hash: "genesis",
    payload: {
      object_type: "component", state: "stock",
      relations: [{
        type: "contains",
        phip_id: `phip://${AUTHORITY}/${NAMESPACE}/parts/does-not-exist-${RUN_ID}`,
      }],
    },
  }, KEY_PHIP_ID);
  const rDangCreate = await request("POST", OBJECTS(NAMESPACE), danglingCreateEvt);
  test(
    "same-authority dangling relation on CREATE returns 422",
    rDangCreate.status === 422,
    `got ${rDangCreate.status}`,
  );
  test(
    "DANGLING_RELATION error code",
    rDangCreate.body && rDangCreate.body.error && rDangCreate.body.error.code === "DANGLING_RELATION",
  );

  // Cross-authority targets MUST be accepted (§7.4 — verified lazily by readers).
  const crossAuthEvt = signEvent({
    event_id: newEventId(),
    phip_id: `phip://${AUTHORITY}/${NAMESPACE}/units/cross-auth-${RUN_ID}`,
    type: "created", timestamp: new Date().toISOString(), actor: KEY_PHIP_ID,
    previous_hash: "genesis",
    payload: {
      object_type: "component", state: "stock",
      relations: [{ type: "contains", phip_id: "phip://other-authority.example/parts/anything" }],
    },
  }, KEY_PHIP_ID);
  const rCrossAuth = await request("POST", OBJECTS(NAMESPACE), crossAuthEvt);
  test(
    "cross-authority relation target accepted on CREATE",
    rCrossAuth.status === 201,
    `got ${rCrossAuth.status}`,
  );

  // ── 15. yield_fraction sum (§10.4.1) ──────────────────────────────
  console.log(`\n[15] yield_fraction`);
  // Need a stock lot to use as process input.
  const STOCK_LOCAL = `lots/stock-${RUN_ID}`;
  const STOCK_PHIP = `phip://${AUTHORITY}/${NAMESPACE}/${STOCK_LOCAL}`;
  const stockEvt = signEvent({
    event_id: newEventId(), phip_id: STOCK_PHIP, type: "created",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: "genesis",
    payload: { object_type: "lot", state: "stock", identity: { fungible: true } },
  }, KEY_PHIP_ID);
  await request("POST", OBJECTS(NAMESPACE), stockEvt);
  const stockHead = (await request("GET", RESOLVE(NAMESPACE, STOCK_LOCAL))).body.history_head;

  const badYieldEvt = signEvent({
    event_id: newEventId(), phip_id: STOCK_PHIP, type: "process",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: stockHead,
    payload: {
      process_type: "test_overshoot",
      inputs: [{ phip_id: STOCK_PHIP, consumed: false }],
      outputs: [
        { phip_id: `phip://${AUTHORITY}/${NAMESPACE}/lots/out-1-${RUN_ID}`, yield_fraction: 0.7 },
        { phip_id: `phip://${AUTHORITY}/${NAMESPACE}/lots/out-2-${RUN_ID}`, yield_fraction: 0.5 },
      ],
    },
  }, KEY_PHIP_ID);
  const rBadYield = await request("POST", PUSH(NAMESPACE, STOCK_LOCAL), badYieldEvt);
  test("yield_fraction sum > 1 returns 422", rBadYield.status === 422, `got ${rBadYield.status}`);
  test(
    "yield_fraction overshoot is INVALID_EVENT",
    rBadYield.body && rBadYield.body.error && rBadYield.body.error.code === "INVALID_EVENT",
  );

  const goodYieldEvt = signEvent({
    event_id: newEventId(), phip_id: STOCK_PHIP, type: "process",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: stockHead,
    payload: {
      process_type: "split_evenly",
      inputs: [{ phip_id: STOCK_PHIP, consumed: false }],
      outputs: [
        { phip_id: `phip://${AUTHORITY}/${NAMESPACE}/lots/outA-${RUN_ID}`, yield_fraction: 0.6 },
        { phip_id: `phip://${AUTHORITY}/${NAMESPACE}/lots/outB-${RUN_ID}`, yield_fraction: 0.4 },
      ],
    },
  }, KEY_PHIP_ID);
  const rGoodYield = await request("POST", PUSH(NAMESPACE, STOCK_LOCAL), goodYieldEvt);
  test("yield_fraction sum = 1.0 accepted", rGoodYield.status === 201, `got ${rGoodYield.status}`);

  // ── 16. lot mass conservation (§10.5.1) ───────────────────────────
  console.log(`\n[16] lot mass conservation`);
  const LOT_LOCAL = `lots/grain-${RUN_ID}`;
  const LOT_PHIP = `phip://${AUTHORITY}/${NAMESPACE}/${LOT_LOCAL}`;
  const lotEvt = signEvent({
    event_id: newEventId(), phip_id: LOT_PHIP, type: "created",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: "genesis",
    payload: {
      object_type: "lot", state: "stock",
      identity: { fungible: true, quantity: { value: 1000, unit: "kg" } },
    },
  }, KEY_PHIP_ID);
  await request("POST", OBJECTS(NAMESPACE), lotEvt);
  const lotHead = (await request("GET", RESOLVE(NAMESPACE, LOT_LOCAL))).body.history_head;

  const badSplitEvt = signEvent({
    event_id: newEventId(), phip_id: LOT_PHIP, type: "lot_split",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: lotHead,
    payload: {
      reason: "test_overshoot",
      resulting_lots: [
        { phip_id: `phip://${AUTHORITY}/${NAMESPACE}/lots/grain-${RUN_ID}-A`, quantity_kg: 700 },
        { phip_id: `phip://${AUTHORITY}/${NAMESPACE}/lots/grain-${RUN_ID}-B`, quantity_kg: 500 },
      ],
    },
  }, KEY_PHIP_ID);
  const rBadSplit = await request("POST", PUSH(NAMESPACE, LOT_LOCAL), badSplitEvt);
  test("lot_split mass overshoot returns 422", rBadSplit.status === 422, `got ${rBadSplit.status}`);

  const goodSplitEvt = signEvent({
    event_id: newEventId(), phip_id: LOT_PHIP, type: "lot_split",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: lotHead,
    payload: {
      reason: "test_within_tolerance",
      resulting_lots: [
        { phip_id: `phip://${AUTHORITY}/${NAMESPACE}/lots/grain-${RUN_ID}-X`, quantity_kg: 600 },
        { phip_id: `phip://${AUTHORITY}/${NAMESPACE}/lots/grain-${RUN_ID}-Y`, quantity_kg: 400 },
      ],
    },
  }, KEY_PHIP_ID);
  const rGoodSplit = await request("POST", PUSH(NAMESPACE, LOT_LOCAL), goodSplitEvt);
  test(
    "lot_split with sum = source accepted",
    rGoodSplit.status === 201,
    `got ${rGoodSplit.status}`,
  );

  // ── 17. measurement payload (§11.4.2) ─────────────────────────────
  console.log(`\n[17] measurement payload`);
  // Need a target object (stock lot from §15 already exists).
  const m1Head = (await request("GET", RESOLVE(NAMESPACE, STOCK_LOCAL))).body.history_head;
  const goodMeasEvt = signEvent({
    event_id: newEventId(), phip_id: STOCK_PHIP, type: "measurement",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: m1Head,
    payload: { metric: "moisture_pct", value: 12.4, unit: "%", as_of: "2026-07-10T00:00:00Z" },
  }, KEY_PHIP_ID);
  const rGoodMeas = await request("POST", PUSH(NAMESPACE, STOCK_LOCAL), goodMeasEvt);
  test("well-formed measurement accepted", rGoodMeas.status === 201, `got ${rGoodMeas.status}`);

  const m2Head = (await request("GET", RESOLVE(NAMESPACE, STOCK_LOCAL))).body.history_head;
  const badMeasEvt = signEvent({
    event_id: newEventId(), phip_id: STOCK_PHIP, type: "measurement",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: m2Head,
    payload: { value: 12.4 }, // missing metric, as_of
  }, KEY_PHIP_ID);
  const rBadMeas = await request("POST", PUSH(NAMESPACE, STOCK_LOCAL), badMeasEvt);
  test("measurement missing fields returns 422", rBadMeas.status === 422, `got ${rBadMeas.status}`);

  // ── 18. phip:access (§11.5) ───────────────────────────────────────
  console.log(`\n[18] phip:access`);

  // Object with policy=private — GET returns ACCESS_DENIED.
  const PRIV_LOCAL = `units/private-${RUN_ID}`;
  const PRIV_PHIP = `phip://${AUTHORITY}/${NAMESPACE}/${PRIV_LOCAL}`;
  const privEvt = signEvent({
    event_id: newEventId(), phip_id: PRIV_PHIP, type: "created",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: "genesis",
    payload: {
      object_type: "component", state: "stock",
      attributes: { "phip:access": { policy: "private" } },
    },
  }, KEY_PHIP_ID);
  await request("POST", OBJECTS(NAMESPACE), privEvt);
  const rPrivGet = await request("GET", RESOLVE(NAMESPACE, PRIV_LOCAL));
  test("private GET returns 403", rPrivGet.status === 403, `got ${rPrivGet.status}`);
  test(
    "private GET surfaces ACCESS_DENIED",
    rPrivGet.body && rPrivGet.body.error && rPrivGet.body.error.code === "ACCESS_DENIED",
  );

  // Object with policy=authenticated — no token → MISSING_CAPABILITY.
  const AUTH_LOCAL = `units/auth-${RUN_ID}`;
  const AUTH_PHIP = `phip://${AUTHORITY}/${NAMESPACE}/${AUTH_LOCAL}`;
  const authEvt = signEvent({
    event_id: newEventId(), phip_id: AUTH_PHIP, type: "created",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: "genesis",
    payload: {
      object_type: "component", state: "stock",
      attributes: { "phip:access": { policy: "authenticated" } },
    },
  }, KEY_PHIP_ID);
  await request("POST", OBJECTS(NAMESPACE), authEvt);
  const rAuthNoToken = await request("GET", RESOLVE(NAMESPACE, AUTH_LOCAL));
  test("authenticated GET no token returns 403", rAuthNoToken.status === 403, `got ${rAuthNoToken.status}`);
  test(
    "authenticated GET no token surfaces MISSING_CAPABILITY",
    rAuthNoToken.body && rAuthNoToken.body.error && rAuthNoToken.body.error.code === "MISSING_CAPABILITY",
  );

  // Same object with a structurally-valid token → 200.
  // (Cryptographic verification is implementation-specific; the conformance
  // suite does not exercise foreign-key resolution. Resolvers that require
  // signature verification beyond shape checking will reject this and the
  // assertion will fail — that is intentional. The token's `granted_by` and
  // `key_id` reference KEY_PHIP_ID which is registered in this resolver, so
  // a single-authority resolver that verifies signatures against locally
  // resolvable keys can pass. If yours doesn't, sign the token correctly.)
  const tokenObj = {
    phip_capability: "1.0",
    token_id: newEventId(),
    granted_by: KEY_PHIP_ID,
    granted_to: KEY_PHIP_ID,
    scope: "read_state",
    object_filter: `phip://${AUTHORITY}/*`,
    not_before: "2026-01-15T00:00:00Z",
    expires: "2099-01-01T00:00:00Z",
  };
  const tokenForSig = { ...tokenObj };
  const tokenSigBytes = crypto.sign(null, canonicalBytes(tokenForSig), privateKey);
  tokenObj.signature = {
    algorithm: "Ed25519",
    key_id: KEY_PHIP_ID,
    value: tokenSigBytes.toString("base64url"),
  };
  const tokenB64 = Buffer.from(JSON.stringify(tokenObj), "utf8").toString("base64url");
  const rAuthWithToken = await request(
    "GET",
    RESOLVE(NAMESPACE, AUTH_LOCAL),
    null,
    { Authorization: `PhIP-Capability ${tokenB64}` },
  );
  test(
    "authenticated GET with valid token returns 200",
    rAuthWithToken.status === 200,
    `got ${rAuthWithToken.status}`,
  );

  // Forged token — correct shape but garbage signature. §11.3.4 step 2
  // mandates signature verification, so this MUST be rejected.
  const forgedToken = {
    ...tokenObj,
    token_id: newEventId(),
    signature: {
      algorithm: "Ed25519",
      key_id: KEY_PHIP_ID,
      value: Buffer.alloc(64, 0).toString("base64url"),
    },
  };
  const forgedB64 = Buffer.from(JSON.stringify(forgedToken), "utf8").toString("base64url");
  const rForged = await request(
    "GET",
    RESOLVE(NAMESPACE, AUTH_LOCAL),
    null,
    { Authorization: `PhIP-Capability ${forgedB64}` },
  );
  test(
    "forged token signature returns 4xx (not 200)",
    rForged.status >= 400 && rForged.status < 500,
    `got ${rForged.status}`,
  );
  test(
    "forged token surfaces INVALID_SIGNATURE or INVALID_CAPABILITY",
    rForged.body && rForged.body.error &&
      (rForged.body.error.code === "INVALID_SIGNATURE" ||
       rForged.body.error.code === "INVALID_CAPABILITY"),
  );

  // Expired token MUST be rejected (§11.3.4 step 3).
  const expiredToken = {
    phip_capability: "1.0",
    token_id: newEventId(),
    granted_by: KEY_PHIP_ID,
    granted_to: KEY_PHIP_ID,
    scope: "read_state",
    object_filter: `phip://${AUTHORITY}/*`,
    not_before: "2026-01-15T00:00:00Z",
    expires: "2026-04-01T00:00:00Z",
  };
  const expiredSig = crypto.sign(null, canonicalBytes(expiredToken), privateKey);
  expiredToken.signature = {
    algorithm: "Ed25519",
    key_id: KEY_PHIP_ID,
    value: expiredSig.toString("base64url"),
  };
  const expiredB64 = Buffer.from(JSON.stringify(expiredToken), "utf8").toString("base64url");
  const rExpired = await request(
    "GET",
    RESOLVE(NAMESPACE, AUTH_LOCAL),
    null,
    { Authorization: `PhIP-Capability ${expiredB64}` },
  );
  test(
    "expired token returns 4xx",
    rExpired.status >= 400 && rExpired.status < 500,
    `got ${rExpired.status}`,
  );
  test(
    "expired token surfaces INVALID_CAPABILITY",
    rExpired.body && rExpired.body.error && rExpired.body.error.code === "INVALID_CAPABILITY",
  );

  // object_filter mismatch — token is valid but for a different object.
  const wrongFilterToken = {
    phip_capability: "1.0",
    token_id: newEventId(),
    granted_by: KEY_PHIP_ID,
    granted_to: KEY_PHIP_ID,
    scope: "read_state",
    object_filter: "phip://other.example/*",
    not_before: "2026-01-15T00:00:00Z",
    expires: "2099-01-01T00:00:00Z",
  };
  const wrongFilterSig = crypto.sign(null, canonicalBytes(wrongFilterToken), privateKey);
  wrongFilterToken.signature = {
    algorithm: "Ed25519",
    key_id: KEY_PHIP_ID,
    value: wrongFilterSig.toString("base64url"),
  };
  const wrongFilterB64 = Buffer.from(JSON.stringify(wrongFilterToken), "utf8").toString("base64url");
  const rWrongFilter = await request(
    "GET",
    RESOLVE(NAMESPACE, AUTH_LOCAL),
    null,
    { Authorization: `PhIP-Capability ${wrongFilterB64}` },
  );
  test(
    "object_filter mismatch returns 4xx",
    rWrongFilter.status >= 400 && rWrongFilter.status < 500,
    `got ${rWrongFilter.status}`,
  );
  test(
    "object_filter mismatch surfaces INVALID_CAPABILITY",
    rWrongFilter.body && rWrongFilter.body.error && rWrongFilter.body.error.code === "INVALID_CAPABILITY",
  );

  // read_state token MUST NOT cover history (which requires read_history).
  // tokenObj from above has scope=read_state.
  const rHistoryWithReadState = await request(
    "GET",
    HISTORY(NAMESPACE, AUTH_LOCAL),
    null,
    { Authorization: `PhIP-Capability ${tokenB64}` },
  );
  test(
    "read_state token cannot read history",
    rHistoryWithReadState.status === 403,
    `got ${rHistoryWithReadState.status}`,
  );

  // Public object with a malformed Authorization header — must succeed
  // (a stray malformed header MUST NOT deny access on a public object).
  const rPubBadHeader = await request(
    "GET",
    RESOLVE(NAMESPACE, OBJ_LOCAL_ID),
    null,
    { Authorization: "PhIP-Capability not-a-token" },
  );
  test(
    "public GET with malformed Authorization still 200",
    rPubBadHeader.status === 200,
    `got ${rPubBadHeader.status}`,
  );

  // QUERY silently omits restricted objects (§11.5.3).
  const rQueryAfter = await request("POST", QUERY(NAMESPACE), {
    filters: { object_type: "component" },
  });
  test(
    "QUERY omits restricted (private) object",
    rQueryAfter.body && Array.isArray(rQueryAfter.body.matches)
      && !rQueryAfter.body.matches.includes(PRIV_PHIP),
  );
  test(
    "QUERY omits restricted (authenticated, no token) object",
    rQueryAfter.body && Array.isArray(rQueryAfter.body.matches)
      && !rQueryAfter.body.matches.includes(AUTH_PHIP),
  );

  // ── 19. authority_transfer event (§4.6) ───────────────────────────
  console.log(`\n[19] authority_transfer`);
  // Append to the bootstrap actor's history. Resolvers need not implement
  // transfer mechanics for this to pass; they just need to accept the
  // event type into a chain.
  const bootHead = (await request("GET", RESOLVE(NAMESPACE, KEY_LOCAL_ID))).body.history_head;
  const xferEvt = signEvent({
    event_id: newEventId(), phip_id: KEY_PHIP_ID, type: "authority_transfer",
    timestamp: new Date().toISOString(), actor: KEY_PHIP_ID, previous_hash: bootHead,
    payload: {
      namespaces: [NAMESPACE],
      successor_authority: "newco.example",
      successor_root_key: "phip://newco.example/keys/root",
      effective_from: "2099-01-01T00:00:00Z",
      rationale: "conformance suite test",
    },
  }, KEY_PHIP_ID);
  const rXfer = await request("POST", PUSH(NAMESPACE, KEY_LOCAL_ID), xferEvt);
  test(
    "authority_transfer event appended to actor history",
    rXfer.status === 201,
    `got ${rXfer.status}`,
  );

  // ── 20. Federation mechanics (light, opt-in) ──────────────────────
  // Full federation conformance (cross-authority token verification,
  // redirect-chain following, mirror serving) requires standing up a
  // counterpart authority — out of scope for a single-URL conformance
  // run. Reference test scenarios live at
  // https://github.com/mfgs-us/phip/blob/main/reference/test/federation.js
  // and can be ported per-implementation.
  //
  // What we CAN test from a single URL: if the operator has configured
  // their resolver with delegations or a transferred-successor, probe
  // the redirect mechanics. Skipped if /meta does not advertise the
  // relevant federation state.
  console.log(`\n[20] federation mechanics (opt-in)`);
  if (!metaPublished) {
    console.log("  (skipped — /meta not published, can't detect federation config)");
  } else {
    if (Array.isArray(rMeta.body.delegations) && rMeta.body.delegations.length > 0) {
      const d = rMeta.body.delegations[0];
      const probeNs = d.namespace;
      const probeId = (d.prefix || "") + "probe-" + RUN_ID;
      const rDeleg = await request("GET", RESOLVE(probeNs, probeId));
      test(
        "delegation: GET to delegated slice returns 307",
        rDeleg.status === 307,
        `got ${rDeleg.status}`,
      );
      test(
        "delegation: Location header points at delegate_authority",
        rDeleg.headers && rDeleg.headers["location"]
          && rDeleg.headers["location"].includes(d.delegate_authority),
      );
      test(
        "delegation: PhIP-Delegation header carries the namespace",
        rDeleg.headers && rDeleg.headers["phip-delegation"] === probeNs,
      );
    } else {
      console.log("  (skipped delegation probe — /meta.delegations empty)");
    }

    if (rMeta.body.successor && rMeta.body.successor.authority) {
      const succ = rMeta.body.successor;
      const probeNs = (succ.namespaces && succ.namespaces[0]) || "any";
      if (probeNs === "*") {
        console.log("  (skipped successor probe — wildcard namespaces, no test target)");
      } else {
        const rXfer = await request("GET", RESOLVE(probeNs, "probe-" + RUN_ID));
        test(
          "successor: GET to transferred namespace returns 308",
          rXfer.status === 308,
          `got ${rXfer.status}`,
        );
        test(
          "successor: Location header points at successor authority",
          rXfer.headers && rXfer.headers["location"]
            && rXfer.headers["location"].includes(succ.authority),
        );
        test(
          "successor: PhIP-Transfer-Event header carries the event id",
          rXfer.headers && rXfer.headers["phip-transfer-event"] === succ.transfer_event_id,
        );
      }
    } else {
      console.log("  (skipped successor probe — /meta.successor absent)");
    }
  }

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
