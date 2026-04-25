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

    // /meta endpoint (§12.7).
    const rMeta = await jsonRequest("GET", "/.well-known/phip/meta");
    assertEqual(rMeta.status, 200, "HTTP /meta returns 200");
    assertEqual(rMeta.body.protocol_version, "0.1.0-draft", "/meta protocol_version");
    assertEqual(rMeta.body.authority, AUTHORITY, "/meta authority");
    assertEqual(rMeta.body.conformance_class, "full", "/meta conformance_class=full");
    assert(
      Array.isArray(rMeta.body.supported_operations) &&
        rMeta.body.supported_operations.includes("batch_create") &&
        rMeta.body.supported_operations.includes("batch_push"),
      "/meta advertises batch operations",
    );
    assert(
      Array.isArray(rMeta.body.schema_namespaces) &&
        rMeta.body.schema_namespaces.includes("phip:mechanical@1.0"),
      "/meta advertises schema_namespaces with versions",
    );

    // Batch CREATE — 3 events, one duplicate (expect 207 Multi-Status).
    const batchEvents = [
      signEvent(buildEvent({
        eventId: crypto.randomUUID(),
        phipId: "phip://" + AUTHORITY + "/" + NAMESPACE + "/units/batch-A",
        type: "created", timestamp: "2026-02-01T00:00:00Z", actor: KEY_PHIP_ID,
        previousHash: "genesis",
        payload: { object_type: "component", state: "concept" },
      }), kp.privateKey, KEY_PHIP_ID),
      signEvent(buildEvent({
        eventId: crypto.randomUUID(),
        phipId: "phip://" + AUTHORITY + "/" + NAMESPACE + "/units/batch-B",
        type: "created", timestamp: "2026-02-01T00:00:01Z", actor: KEY_PHIP_ID,
        previousHash: "genesis",
        payload: { object_type: "component", state: "concept" },
      }), kp.privateKey, KEY_PHIP_ID),
      // Duplicate of batch-A — should fail with OBJECT_EXISTS.
      signEvent(buildEvent({
        eventId: crypto.randomUUID(),
        phipId: "phip://" + AUTHORITY + "/" + NAMESPACE + "/units/batch-A",
        type: "created", timestamp: "2026-02-01T00:00:02Z", actor: KEY_PHIP_ID,
        previousHash: "genesis",
        payload: { object_type: "component", state: "concept" },
      }), kp.privateKey, KEY_PHIP_ID),
    ];
    const rBatch = await jsonRequest(
      "POST",
      "/.well-known/phip/objects/" + NAMESPACE + "/batch",
      { events: batchEvents },
    );
    assertEqual(rBatch.status, 207, "Batch CREATE with mixed outcomes returns 207");
    assertEqual(rBatch.body.summary.succeeded, 2, "Batch summary: 2 succeeded");
    assertEqual(rBatch.body.summary.failed, 1, "Batch summary: 1 failed");
    assertEqual(rBatch.body.results[0].status, "created", "Batch result[0] created");
    assertEqual(rBatch.body.results[2].status, "error", "Batch result[2] error");
    assertEqual(rBatch.body.results[2].error.code, "OBJECT_EXISTS", "Batch error code is OBJECT_EXISTS");

    // Design object + instance_of constraint (§6.3).
    const DESIGN_LOCAL = "designs/widget-r1";
    const DESIGN_PHIP = "phip://" + AUTHORITY + "/" + NAMESPACE + "/" + DESIGN_LOCAL;
    const designEvt = signEvent(buildEvent({
      eventId: crypto.randomUUID(),
      phipId: DESIGN_PHIP,
      type: "created", timestamp: "2026-03-01T00:00:00Z", actor: KEY_PHIP_ID,
      previousHash: "genesis",
      payload: {
        object_type: "design", state: "qualified",
        identity: { part_number: "WGT-001", revision: "A" },
      },
    }), kp.privateKey, KEY_PHIP_ID);
    const rDesign = await jsonRequest("POST", "/.well-known/phip/objects/" + NAMESPACE, designEvt);
    assertEqual(rDesign.status, 201, "design CREATE returns 201");

    // instance_of pointing at a non-design — must be rejected (INVALID_RELATION).
    const badInstanceEvt = signEvent(buildEvent({
      eventId: crypto.randomUUID(),
      phipId: "phip://" + AUTHORITY + "/" + NAMESPACE + "/units/bad-inst",
      type: "created", timestamp: "2026-03-02T00:00:00Z", actor: KEY_PHIP_ID,
      previousHash: "genesis",
      payload: {
        object_type: "component", state: "concept",
        relations: [{ type: "instance_of", phip_id: KEY_PHIP_ID }], // key is actor, not design
      },
    }), kp.privateKey, KEY_PHIP_ID);
    const rBadInst = await jsonRequest("POST", "/.well-known/phip/objects/" + NAMESPACE, badInstanceEvt);
    assertEqual(rBadInst.status, 422, "instance_of pointing at actor returns 422");
    assertEqual(rBadInst.body.error.code, "INVALID_RELATION", "instance_of must target design (INVALID_RELATION)");

    // DANGLING_RELATION on relation_added pointing at a missing same-authority object (§7.4).
    // First need an existing object to push to. Use units/batch-A (created in batch above).
    const existingHead = (await jsonRequest("GET", "/.well-known/phip/resolve/" + NAMESPACE + "/units/batch-A")).body.history_head;
    const danglingEvt = signEvent(buildEvent({
      eventId: crypto.randomUUID(),
      phipId: "phip://" + AUTHORITY + "/" + NAMESPACE + "/units/batch-A",
      type: "relation_added", timestamp: "2026-04-01T00:00:00Z", actor: KEY_PHIP_ID,
      previousHash: existingHead,
      payload: { relation: { type: "contains", phip_id: "phip://" + AUTHORITY + "/" + NAMESPACE + "/nope/missing" } },
    }), kp.privateKey, KEY_PHIP_ID);
    const rDangling = await jsonRequest(
      "POST",
      "/.well-known/phip/push/" + NAMESPACE + "/units/batch-A",
      danglingEvt,
    );
    assertEqual(rDangling.status, 422, "DANGLING_RELATION returns 422");
    assertEqual(rDangling.body.error.code, "DANGLING_RELATION", "Dangling same-authority relation rejected with DANGLING_RELATION");

    // phip:access enforcement — set policy=private and verify GET is denied.
    const restrictEvt = signEvent(buildEvent({
      eventId: crypto.randomUUID(),
      phipId: "phip://" + AUTHORITY + "/" + NAMESPACE + "/units/batch-B",
      type: "attribute_update", timestamp: "2026-05-01T00:00:00Z", actor: KEY_PHIP_ID,
      previousHash: (await jsonRequest("GET", "/.well-known/phip/resolve/" + NAMESPACE + "/units/batch-B")).body.history_head,
      payload: { namespace: "phip:access", updates: { policy: "private", rationale: "smoke test" } },
    }), kp.privateKey, KEY_PHIP_ID);
    const rRestrict = await jsonRequest(
      "POST",
      "/.well-known/phip/push/" + NAMESPACE + "/units/batch-B",
      restrictEvt,
    );
    assertEqual(rRestrict.status, 201, "Setting phip:access=private accepted");
    const rRestrictedGet = await jsonRequest("GET", "/.well-known/phip/resolve/" + NAMESPACE + "/units/batch-B");
    assertEqual(rRestrictedGet.status, 403, "Private object GET returns 403");
    assertEqual(rRestrictedGet.body.error.code, "ACCESS_DENIED", "Private GET surfaces ACCESS_DENIED");

    // Lot mass conservation (§10.5.1) — split with sum > source must be rejected.
    const LOT_LOCAL = "lots/grain-001";
    const LOT_PHIP = "phip://" + AUTHORITY + "/" + NAMESPACE + "/" + LOT_LOCAL;
    const lotEvt = signEvent(buildEvent({
      eventId: crypto.randomUUID(),
      phipId: LOT_PHIP,
      type: "created", timestamp: "2026-06-01T00:00:00Z", actor: KEY_PHIP_ID,
      previousHash: "genesis",
      payload: {
        object_type: "lot", state: "stock",
        identity: { fungible: true, quantity: { value: 1000, unit: "kg" } },
      },
    }), kp.privateKey, KEY_PHIP_ID);
    await jsonRequest("POST", "/.well-known/phip/objects/" + NAMESPACE, lotEvt);

    const lotHead = (await jsonRequest("GET", "/.well-known/phip/resolve/" + NAMESPACE + "/" + LOT_LOCAL)).body.history_head;
    const badSplitEvt = signEvent(buildEvent({
      eventId: crypto.randomUUID(),
      phipId: LOT_PHIP,
      type: "lot_split", timestamp: "2026-06-02T00:00:00Z", actor: KEY_PHIP_ID,
      previousHash: lotHead,
      payload: {
        reason: "test_overshoot",
        resulting_lots: [
          { phip_id: "phip://" + AUTHORITY + "/" + NAMESPACE + "/lots/grain-001-A", quantity_kg: 700 },
          { phip_id: "phip://" + AUTHORITY + "/" + NAMESPACE + "/lots/grain-001-B", quantity_kg: 500 },
        ],
      },
    }), kp.privateKey, KEY_PHIP_ID);
    const rBadSplit = await jsonRequest("POST", "/.well-known/phip/push/" + NAMESPACE + "/" + LOT_LOCAL, badSplitEvt);
    assertEqual(rBadSplit.status, 422, "Mass-violating lot_split returns 422");
    assertEqual(rBadSplit.body.error.code, "INVALID_EVENT", "Mass conservation violation surfaces INVALID_EVENT");
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
