// End-to-end smoke test for the reference resolver.
//
// Walks the full lifecycle for a tiny namespace:
//   1. Generate an Ed25519 keypair.
//   2. CREATE a self-signed bootstrap key (actor/active with phip:keys).
//   3. CREATE a system object in 'concept' state, signed with the bootstrap key.
//   4. PUSH a state_transition concept -> design.
//   5. PUSH an attribute_update (phip:software).
//   6. PUSH an invalid transition and assert it is rejected.
//   7. GET the object and verify the projected fields.
//   8. GET the history sub-resource and verify the hash chain links.
//   9. QUERY by object_type and assert the object appears.
//
// Runs against the in-memory store directly (no HTTP) so the test stays fast
// and hermetic. A second test exercises the HTTP surface with the same flow.

"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const { Store } = require("../src/store");
const { startServer } = require("../src/server");
const {
  generateEd25519KeyPair,
  signEvent,
  hashEvent,
} = require("../src/crypto");

const AUTHORITY = "example.com";
const NAMESPACE = "test";
const KEY_LOCAL_ID = "keys/bootstrap-2026";
const OBJ_LOCAL_ID = "units/001";

const KEY_PHIP_ID = "phip://" + AUTHORITY + "/" + NAMESPACE + "/" + KEY_LOCAL_ID;
const OBJ_PHIP_ID = "phip://" + AUTHORITY + "/" + NAMESPACE + "/" + OBJ_LOCAL_ID;

let failures = 0;
function assert(cond, name) {
  if (cond) {
    console.log("PASS - " + name);
  } else {
    failures++;
    console.log("FAIL - " + name);
  }
}
function assertEqual(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log("PASS - " + name);
  } else {
    failures++;
    console.log("FAIL - " + name);
    console.log("      expected:", JSON.stringify(expected));
    console.log("      actual:  ", JSON.stringify(actual));
  }
}
function assertThrows(fn, codeName, name) {
  try {
    fn();
  } catch (e) {
    if (e.code === codeName) {
      console.log("PASS - " + name + " (threw " + codeName + ")");
      return;
    }
    console.log("FAIL - " + name + " (threw " + e.code + " expected " + codeName + ")");
    failures++;
    return;
  }
  console.log("FAIL - " + name + " (did not throw)");
  failures++;
}

function buildEvent({ eventId, phipId, type, timestamp, actor, previousHash, payload }) {
  return {
    event_id: eventId,
    phip_id: phipId,
    type,
    timestamp,
    actor,
    previous_hash: previousHash,
    payload,
  };
}

function inMemoryRoundTrip() {
  console.log("\n=== In-memory round trip ===");
  const store = new Store();
  const kp = generateEd25519KeyPair();

  // Step 1 + 2: self-signed bootstrap key.
  const bootstrapUnsigned = buildEvent({
    eventId: crypto.randomUUID(),
    phipId: KEY_PHIP_ID,
    type: "created",
    timestamp: "2026-01-01T00:00:00Z",
    actor: KEY_PHIP_ID,
    previousHash: "genesis",
    payload: {
      object_type: "actor",
      state: "active",
      identity: { label: "Bootstrap key" },
      attributes: {
        "phip:keys": {
          kty: "OKP",
          crv: "Ed25519",
          x: kp.publicKeyBase64Url,
          not_before: "2026-01-01T00:00:00Z",
          not_after: "2030-01-01T00:00:00Z",
        },
      },
    },
  });
  const bootstrap = signEvent(bootstrapUnsigned, kp.privateKey, KEY_PHIP_ID);
  const keyObj = store.create(bootstrap);
  assertEqual(keyObj.phip_id, KEY_PHIP_ID, "key object created with correct id");
  assertEqual(keyObj.state, "active", "key object is active");
  assertEqual(keyObj.history_length, 1, "key object has 1 event in history");

  // Step 3: system object.
  const createUnsigned = buildEvent({
    eventId: crypto.randomUUID(),
    phipId: OBJ_PHIP_ID,
    type: "created",
    timestamp: "2026-01-02T10:00:00Z",
    actor: KEY_PHIP_ID,
    previousHash: "genesis",
    payload: {
      object_type: "system",
      state: "concept",
      identity: { serial: "TST-001" },
    },
  });
  const createEvent = signEvent(createUnsigned, kp.privateKey, KEY_PHIP_ID);
  const obj = store.create(createEvent);
  assertEqual(obj.state, "concept", "new object in concept state");
  assertEqual(obj.history_length, 1, "new object has 1 event");
  assert(obj.history_head && obj.history_head.startsWith("sha256:"), "history_head is sha256");

  // Step 4: state_transition concept -> design.
  const transitionUnsigned = buildEvent({
    eventId: crypto.randomUUID(),
    phipId: OBJ_PHIP_ID,
    type: "state_transition",
    timestamp: "2026-01-03T10:00:00Z",
    actor: KEY_PHIP_ID,
    previousHash: obj.history_head,
    payload: { from: "concept", to: "design" },
  });
  const transitionEvent = signEvent(transitionUnsigned, kp.privateKey, KEY_PHIP_ID);
  store.push(OBJ_PHIP_ID, transitionEvent);
  const afterTransition = store.get(OBJ_PHIP_ID);
  assertEqual(afterTransition.state, "design", "state is 'design' after transition");
  assertEqual(afterTransition.history_length, 2, "history length is 2");

  // Step 5: attribute_update adding phip:software.
  const attrUnsigned = buildEvent({
    eventId: crypto.randomUUID(),
    phipId: OBJ_PHIP_ID,
    type: "attribute_update",
    timestamp: "2026-01-03T11:00:00Z",
    actor: KEY_PHIP_ID,
    previousHash: afterTransition.history_head,
    payload: {
      namespace: "phip:software",
      updates: { firmware: "test-fw-0.1" },
    },
  });
  const attrEvent = signEvent(attrUnsigned, kp.privateKey, KEY_PHIP_ID);
  store.push(OBJ_PHIP_ID, attrEvent);
  const afterAttr = store.get(OBJ_PHIP_ID);
  assertEqual(
    afterAttr.attributes["phip:software"].firmware,
    "test-fw-0.1",
    "phip:software firmware attribute was applied",
  );

  // Step 6: illegal transition design -> stock (not allowed).
  const badUnsigned = buildEvent({
    eventId: crypto.randomUUID(),
    phipId: OBJ_PHIP_ID,
    type: "state_transition",
    timestamp: "2026-01-03T12:00:00Z",
    actor: KEY_PHIP_ID,
    previousHash: afterAttr.history_head,
    payload: { from: "design", to: "stock" },
  });
  const badEvent = signEvent(badUnsigned, kp.privateKey, KEY_PHIP_ID);
  assertThrows(() => store.push(OBJ_PHIP_ID, badEvent), "INVALID_TRANSITION", "illegal transition rejected");

  // Step 6b: stale previous_hash -> CHAIN_CONFLICT.
  const staleUnsigned = buildEvent({
    eventId: crypto.randomUUID(),
    phipId: OBJ_PHIP_ID,
    type: "state_transition",
    timestamp: "2026-01-03T13:00:00Z",
    actor: KEY_PHIP_ID,
    previousHash: "sha256:" + "0".repeat(64),
    payload: { from: "design", to: "qualified" },
  });
  const staleEvent = signEvent(staleUnsigned, kp.privateKey, KEY_PHIP_ID);
  assertThrows(() => store.push(OBJ_PHIP_ID, staleEvent), "CHAIN_CONFLICT", "stale previous_hash rejected");

  // Step 7: GET (already covered above).
  // Step 8: history sub-resource + chain walk.
  const histPage = store.history(OBJ_PHIP_ID, { limit: 100 });
  assertEqual(histPage.history_length, 3, "history page reports 3 events");
  assertEqual(histPage.events.length, 3, "history page returns 3 events");
  // Verify chain continuity.
  for (let i = 1; i < histPage.events.length; i++) {
    const expected = hashEvent(histPage.events[i - 1]);
    assertEqual(histPage.events[i].previous_hash, expected, "chain link " + i + " correct");
  }

  // Step 9: QUERY.
  const q1 = store.query({ filters: { object_type: "system" } });
  assert(q1.matches.includes(OBJ_PHIP_ID), "query by object_type=system returns object");

  const q2 = store.query({ filters: { state: "design" } });
  assertEqual(q2.matches, [OBJ_PHIP_ID], "query by state=design returns only the object");

  const q3 = store.query({
    attributes: { "phip:software": { firmware: "test-fw-*" } },
  });
  assertEqual(q3.matches, [OBJ_PHIP_ID], "query by glob on attributes returns object");

  const q4 = store.query({
    filters: { object_type: "component" },
  });
  assertEqual(q4.matches, [], "query for object_type=component returns empty");

  // Duplicate event rejection.
  assertThrows(() => store.create(createEvent), "OBJECT_EXISTS", "duplicate CREATE rejected");
}

async function httpRoundTrip() {
  console.log("\n=== HTTP round trip ===");
  const store = new Store();
  const kp = generateEd25519KeyPair();
  const { server, port } = await startServer(store, { authority: AUTHORITY, port: 0 });
  const base = "http://localhost:" + port;

  try {
    async function jsonRequest(method, path, body) {
      return new Promise((resolve, reject) => {
        const url = new URL(base + path);
        const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: payload
              ? { "Content-Type": "application/json", "Content-Length": payload.length }
              : {},
          },
          (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    }

    // Bootstrap key.
    const bootstrap = signEvent(
      buildEvent({
        eventId: crypto.randomUUID(),
        phipId: KEY_PHIP_ID,
        type: "created",
        timestamp: "2026-01-01T00:00:00Z",
        actor: KEY_PHIP_ID,
        previousHash: "genesis",
        payload: {
          object_type: "actor",
          state: "active",
          attributes: {
            "phip:keys": {
              kty: "OKP",
              crv: "Ed25519",
              x: kp.publicKeyBase64Url,
              not_before: "2026-01-01T00:00:00Z",
              not_after: "2030-01-01T00:00:00Z",
            },
          },
        },
      }),
      kp.privateKey,
      KEY_PHIP_ID,
    );
    const r1 = await jsonRequest("POST", "/.well-known/phip/objects/" + NAMESPACE, bootstrap);
    assertEqual(r1.status, 201, "HTTP CREATE bootstrap key returns 201");

    // Create the system object.
    const createEvt = signEvent(
      buildEvent({
        eventId: crypto.randomUUID(),
        phipId: OBJ_PHIP_ID,
        type: "created",
        timestamp: "2026-01-02T10:00:00Z",
        actor: KEY_PHIP_ID,
        previousHash: "genesis",
        payload: { object_type: "system", state: "concept", identity: { serial: "TST-002" } },
      }),
      kp.privateKey,
      KEY_PHIP_ID,
    );
    const r2 = await jsonRequest("POST", "/.well-known/phip/objects/" + NAMESPACE, createEvt);
    assertEqual(r2.status, 201, "HTTP CREATE system returns 201");
    assertEqual(r2.body.state, "concept", "HTTP CREATE body has state=concept");

    // GET the object.
    const r3 = await jsonRequest("GET", "/.well-known/phip/resolve/" + NAMESPACE + "/" + OBJ_LOCAL_ID);
    assertEqual(r3.status, 200, "HTTP GET returns 200");
    assertEqual(r3.body.phip_id, OBJ_PHIP_ID, "HTTP GET phip_id matches");
    assert(r3.body.history_head && r3.body.history_head.startsWith("sha256:"), "HTTP GET includes history_head");

    // PUSH a transition.
    const pushEvt = signEvent(
      buildEvent({
        eventId: crypto.randomUUID(),
        phipId: OBJ_PHIP_ID,
        type: "state_transition",
        timestamp: "2026-01-03T10:00:00Z",
        actor: KEY_PHIP_ID,
        previousHash: r3.body.history_head,
        payload: { from: "concept", to: "design" },
      }),
      kp.privateKey,
      KEY_PHIP_ID,
    );
    const r4 = await jsonRequest("POST", "/.well-known/phip/push/" + NAMESPACE + "/" + OBJ_LOCAL_ID, pushEvt);
    assertEqual(r4.status, 201, "HTTP PUSH returns 201");

    // GET history.
    const r5 = await jsonRequest("GET", "/.well-known/phip/history/" + NAMESPACE + "/" + OBJ_LOCAL_ID + "?limit=100");
    assertEqual(r5.status, 200, "HTTP history returns 200");
    assertEqual(r5.body.history_length, 2, "HTTP history length is 2");

    // QUERY.
    const r6 = await jsonRequest("POST", "/.well-known/phip/query/" + NAMESPACE, {
      filters: { object_type: "system" },
    });
    assertEqual(r6.status, 200, "HTTP QUERY returns 200");
    assert(
      Array.isArray(r6.body.matches) && r6.body.matches.includes(OBJ_PHIP_ID),
      "HTTP QUERY result contains object",
    );

    // Error envelope — GET non-existent.
    const r7 = await jsonRequest("GET", "/.well-known/phip/resolve/" + NAMESPACE + "/does/not/exist");
    assertEqual(r7.status, 404, "HTTP GET missing object returns 404");
    assertEqual(r7.body.error.code, "OBJECT_NOT_FOUND", "HTTP GET missing object has OBJECT_NOT_FOUND code");
  } finally {
    server.close();
  }
}

async function main() {
  inMemoryRoundTrip();
  await httpRoundTrip();
  console.log("\n" + (failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
