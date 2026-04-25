// Two-server federation smoke test.
//
// Exercises the cross-authority code paths:
//   1. Foreign-key capability token verification (Phase A / §11.3.4).
//      Authority A serves an `authenticated` object; a token signed by
//      Authority B's key authorizes reads. A fetches B's key over HTTP
//      and verifies cryptographically.
//   2. Authority delegation redirects (Phase B / §4.5).
//      A delegates `logistics/eu-*` to B; CREATE/PUSH/GET against the
//      delegated slice return 307 with PhIP-Delegation header.
//   3. Authority transfer redirects (Phase C / §4.6).
//      A is configured as transferred; all requests for the transferred
//      namespace return 308 with PhIP-Transfer-Event header.
//
// Authority names are spec-compliant (no port). The federation client
// uses a `urlBuilder` override to map names → localhost ports for test
// purposes.

"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const { Store } = require("../src/store");
const { startServer } = require("../src/server");
const { FederationClient } = require("../src/federation");
const {
  generateEd25519KeyPair,
  signEvent,
} = require("../src/crypto");

let failures = 0;
function assert(cond, name) {
  if (cond) console.log("PASS - " + name);
  else { failures++; console.log("FAIL - " + name); }
}
function assertEqual(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log("PASS - " + name);
  else {
    failures++;
    console.log("FAIL - " + name);
    console.log("      expected:", JSON.stringify(expected));
    console.log("      actual:  ", JSON.stringify(actual));
  }
}

// HTTP client used by the test code itself (not the resolver). Talks
// directly to localhost:port since we're calling the bound port.
function jsonRequest(port, method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const headers = Object.assign(
      payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
      extraHeaders || {},
    );
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          if (data.length) {
            try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Build a urlBuilder that maps authority names → localhost:port URLs.
// `mapping` is { authorityName: port }. Authorities not in the mapping
// are still built as http://{authority}{path} so we can exercise the
// "unreachable foreign authority" path with a name that doesn't resolve.
function makeUrlBuilder(mapping) {
  return ({ authority, path }) => {
    const port = mapping[authority];
    if (port) return `http://127.0.0.1:${port}${path}`;
    return `http://${authority}${path}`;
  };
}

function bootstrapKeyEvent(authority, namespace, localId, kp) {
  const phipId = `phip://${authority}/${namespace}/${localId}`;
  return signEvent(
    {
      event_id: crypto.randomUUID(),
      phip_id: phipId,
      type: "created",
      timestamp: "2026-01-01T00:00:00Z",
      actor: phipId,
      previous_hash: "genesis",
      payload: {
        object_type: "actor",
        state: "active",
        attributes: {
          "phip:keys": {
            kty: "OKP",
            crv: "Ed25519",
            x: kp.publicKeyBase64Url,
            not_before: "2020-01-01T00:00:00Z",
            not_after: "2030-01-01T00:00:00Z",
          },
        },
      },
    },
    kp.privateKey,
    phipId,
  );
}

// ──────────────────────────────────────────────────────────────────
// Test 1: cross-authority token verification
// ──────────────────────────────────────────────────────────────────

async function testCrossAuthorityToken() {
  console.log("\n=== Test 1: cross-authority token verification ===");

  // Bind both servers to ephemeral ports first so we know the mapping.
  const portMap = {};
  // Spin up two stub servers to grab ports, then close and rebind.
  const stub1 = await startServer(new Store(), { authority: "tmp", port: 0, federation: new FederationClient() });
  const stub2 = await startServer(new Store(), { authority: "tmp", port: 0, federation: new FederationClient() });
  const portA = stub1.port;
  const portB = stub2.port;
  stub1.server.close();
  stub2.server.close();

  const authorityA = "alice.local";
  const authorityB = "bob.local";
  portMap[authorityA] = portA;
  portMap[authorityB] = portB;
  const urlBuilder = makeUrlBuilder(portMap);

  const fedA = new FederationClient({ allowHttp: true, urlBuilder });
  const fedB = new FederationClient({ allowHttp: true, urlBuilder });

  const { server: serverA } = await startServer(new Store(), {
    authority: authorityA, port: portA, federation: fedA,
  });
  const { server: serverB } = await startServer(new Store(), {
    authority: authorityB, port: portB, federation: fedB,
  });

  try {
    // Bootstrap each authority's signing key.
    const kpB = generateEd25519KeyPair();
    const keyPhipB = `phip://${authorityB}/keys/root`;
    const bootB = bootstrapKeyEvent(authorityB, "keys", "root", kpB);
    const rBootB = await jsonRequest(portB, "POST", "/.well-known/phip/objects/keys", bootB);
    assertEqual(rBootB.status, 201, "bootstrap key on B accepted");

    const kpA = generateEd25519KeyPair();
    const keyPhipA = `phip://${authorityA}/keys/root`;
    const bootA = bootstrapKeyEvent(authorityA, "keys", "root", kpA);
    const rBootA = await jsonRequest(portA, "POST", "/.well-known/phip/objects/keys", bootA);
    assertEqual(rBootA.status, 201, "bootstrap key on A accepted");

    // Create a `phip:access=authenticated` component on A.
    const objLocal = "units/restricted-001";
    const objPhip = `phip://${authorityA}/${objLocal}`;
    const objEvt = signEvent(
      {
        event_id: crypto.randomUUID(),
        phip_id: objPhip,
        type: "created",
        timestamp: "2026-02-01T00:00:00Z",
        actor: keyPhipA,
        previous_hash: "genesis",
        payload: {
          object_type: "component",
          state: "stock",
          attributes: { "phip:access": { policy: "authenticated" } },
        },
      },
      kpA.privateKey,
      keyPhipA,
    );
    const rObj = await jsonRequest(portA, "POST", "/.well-known/phip/objects/units", objEvt);
    assertEqual(rObj.status, 201, "restricted object created on A");

    const restrictedPath = "/.well-known/phip/resolve/" + objLocal;

    // GET without a token → MISSING_CAPABILITY.
    const rNoTok = await jsonRequest(portA, "GET", restrictedPath);
    assertEqual(rNoTok.status, 403, "restricted GET without token returns 403");

    // Token signed on B's key, valid for A's objects.
    const tokenUnsigned = {
      phip_capability: "1.0",
      token_id: crypto.randomUUID(),
      granted_by: keyPhipB,
      granted_to: keyPhipB,
      scope: "read_state",
      object_filter: `phip://${authorityA}/*`,
      not_before: "2020-01-01T00:00:00Z",
      expires: "2099-01-01T00:00:00Z",
    };
    const tokenSigned = signEvent(tokenUnsigned, kpB.privateKey, keyPhipB);
    const tokenB64 = Buffer.from(JSON.stringify(tokenSigned), "utf8").toString("base64url");

    const rWithTok = await jsonRequest(
      portA, "GET", restrictedPath, null,
      { Authorization: "PhIP-Capability " + tokenB64 },
    );
    assertEqual(rWithTok.status, 200, "GET with foreign-signed token verifies and returns 200");
    assertEqual(rWithTok.body.phip_id, objPhip, "Returned object phip_id matches");

    // Forged signature → INVALID_SIGNATURE.
    const forged = {
      ...tokenSigned,
      token_id: crypto.randomUUID(),
      signature: { ...tokenSigned.signature, value: Buffer.alloc(64, 0).toString("base64url") },
    };
    const forgedB64 = Buffer.from(JSON.stringify(forged), "utf8").toString("base64url");
    const rForged = await jsonRequest(
      portA, "GET", restrictedPath, null,
      { Authorization: "PhIP-Capability " + forgedB64 },
    );
    assertEqual(rForged.status, 401, "forged foreign-signed token returns 401");
    assertEqual(
      rForged.body.error.code, "INVALID_SIGNATURE",
      "forged foreign token surfaces INVALID_SIGNATURE",
    );

    // Token signed by an authority that doesn't resolve → INVALID_CAPABILITY.
    const ghostToken = {
      ...tokenSigned,
      token_id: crypto.randomUUID(),
      signature: { ...tokenSigned.signature, key_id: "phip://nonexistent.invalid/keys/anything" },
    };
    const ghostB64 = Buffer.from(JSON.stringify(ghostToken), "utf8").toString("base64url");
    const rGhost = await jsonRequest(
      portA, "GET", restrictedPath, null,
      { Authorization: "PhIP-Capability " + ghostB64 },
    );
    assertEqual(rGhost.status, 403, "unreachable foreign authority → 403");
    assertEqual(
      rGhost.body.error.code, "INVALID_CAPABILITY",
      "unreachable foreign authority surfaces INVALID_CAPABILITY",
    );
    // SSRF defense (S1): error envelope MUST NOT leak the underlying
    // network error details (URL, hostname, etc.).
    assert(
      rGhost.body.error.message && !/nonexistent\.invalid/.test(rGhost.body.error.message),
      "ghost-authority error envelope does not leak target hostname",
    );

    // SSRF defense: a token whose key_id points at a private IP
    // (127.0.0.1) MUST be refused — and yet our test federation client
    // is configured with allowPrivateAddresses=true (because allowHttp
    // is on). To exercise the *production* path, build a fresh client
    // with allowHttp:true but allowPrivateAddresses:false explicitly.
    {
      const strictFed = new FederationClient({
        allowHttp: true,
        allowPrivateAddresses: false,
        urlBuilder, // reuse the test url builder
      });
      // Stand up a one-off resolver that uses the strict federation
      // client, on a fresh authority. Reuse store A's content via its
      // own server — actually simpler: spin a third server on a fresh
      // port with the strict client and authority, bootstrap a key
      // there, set up a restricted object, then probe with a token
      // whose signing key is at "alice.local" (which strictly resolves
      // to 127.0.0.1 — should be refused).
      const tmp = await startServer(new Store(), { authority: "tmp", port: 0, federation: new FederationClient() });
      const portC = tmp.port;
      tmp.server.close();
      const authorityC = "carol.local";
      portMap[authorityC] = portC;
      const { server: serverC, store: storeC } = await (async () => {
        const s = new Store();
        const r = await startServer(s, {
          authority: authorityC, port: portC, federation: strictFed,
        });
        return { server: r.server, store: s };
      })();
      try {
        const kpC = generateEd25519KeyPair();
        const bootC = bootstrapKeyEvent(authorityC, "keys", "root", kpC);
        await jsonRequest(portC, "POST", "/.well-known/phip/objects/keys", bootC);
        const objC = signEvent(
          {
            event_id: crypto.randomUUID(),
            phip_id: `phip://${authorityC}/units/x`,
            type: "created",
            timestamp: "2026-02-01T00:00:00Z",
            actor: `phip://${authorityC}/keys/root`,
            previous_hash: "genesis",
            payload: {
              object_type: "component", state: "stock",
              attributes: { "phip:access": { policy: "authenticated" } },
            },
          },
          kpC.privateKey,
          `phip://${authorityC}/keys/root`,
        );
        await jsonRequest(portC, "POST", "/.well-known/phip/objects/units", objC);
        // Probe with a token whose signing authority is "alice.local"
        // (mapped to 127.0.0.1 via urlBuilder) — strict client refuses.
        const ssrfToken = signEvent(
          {
            phip_capability: "1.0",
            token_id: crypto.randomUUID(),
            granted_by: keyPhipB,
            granted_to: keyPhipB,
            scope: "read_state",
            object_filter: `phip://${authorityC}/*`,
            not_before: "2020-01-01T00:00:00Z",
            expires: "2099-01-01T00:00:00Z",
          },
          kpB.privateKey,
          keyPhipB,
        );
        const ssrfB64 = Buffer.from(JSON.stringify(ssrfToken), "utf8").toString("base64url");
        const rSsrf = await jsonRequest(
          portC, "GET", "/.well-known/phip/resolve/units/x", null,
          { Authorization: "PhIP-Capability " + ssrfB64 },
        );
        assertEqual(rSsrf.status, 403, "SSRF probe to private address → 403");
        assertEqual(
          rSsrf.body.error.code, "INVALID_CAPABILITY",
          "SSRF probe surfaces INVALID_CAPABILITY",
        );
      } finally {
        serverC.close();
      }
    }
  } finally {
    serverA.close();
    serverB.close();
  }
}

// ──────────────────────────────────────────────────────────────────
// Test 2: delegation redirects
// ──────────────────────────────────────────────────────────────────

async function testDelegation() {
  console.log("\n=== Test 2: delegation redirects ===");

  const stub = await startServer(new Store(), { authority: "tmp", port: 0, federation: new FederationClient() });
  const portA = stub.port;
  stub.server.close();

  const authorityA = "acme.local";
  const delegateAuthority = "logistics-eu.partner.local";

  const delegations = [
    {
      namespace: "logistics",
      prefix: "eu-",
      delegate_authority: delegateAuthority,
      delegate_root_key: `phip://${delegateAuthority}/keys/root`,
      scope: ["create", "push", "get", "history", "query"],
      effective_from: "2020-01-01T00:00:00Z",
    },
  ];

  const { server: serverA } = await startServer(new Store(), {
    authority: authorityA, port: portA,
    federation: new FederationClient({ allowHttp: true }),
    delegations,
  });

  try {
    const rMeta = await jsonRequest(portA, "GET", "/.well-known/phip/meta");
    assertEqual(rMeta.status, 200, "delegated /meta returns 200");
    assert(
      Array.isArray(rMeta.body.delegations) &&
        rMeta.body.delegations.length === 1 &&
        rMeta.body.delegations[0].namespace === "logistics",
      "/meta.delegations populated",
    );

    // Bootstrap a key so we can sign events.
    const kp = generateEd25519KeyPair();
    const bootEvt = bootstrapKeyEvent(authorityA, "keys", "root", kp);
    await jsonRequest(portA, "POST", "/.well-known/phip/objects/keys", bootEvt);
    const keyPhip = `phip://${authorityA}/keys/root`;

    // CREATE on the delegated slice → 307.
    const objPhip = `phip://${authorityA}/logistics/eu-shipment-42`;
    const evt = signEvent(
      {
        event_id: crypto.randomUUID(),
        phip_id: objPhip,
        type: "created",
        timestamp: "2026-03-01T00:00:00Z",
        actor: keyPhip,
        previous_hash: "genesis",
        payload: { object_type: "lot", state: "stock", identity: { fungible: true } },
      },
      kp.privateKey,
      keyPhip,
    );
    const rCreate = await jsonRequest(portA, "POST", "/.well-known/phip/objects/logistics", evt);
    assertEqual(rCreate.status, 307, "delegated CREATE returns 307");
    assert(
      rCreate.headers && rCreate.headers["location"] &&
        rCreate.headers["location"].includes(delegateAuthority),
      "delegated CREATE Location header points at delegate",
    );
    assertEqual(
      rCreate.headers["phip-delegation"], "logistics",
      "delegated CREATE PhIP-Delegation header set",
    );

    // GET on the delegated slice → 307.
    const rGet = await jsonRequest(portA, "GET", "/.well-known/phip/resolve/logistics/eu-shipment-42");
    assertEqual(rGet.status, 307, "delegated GET returns 307");

    // Non-delegated namespace passes through.
    const rOther = await jsonRequest(portA, "GET", "/.well-known/phip/resolve/parts/anything");
    assertEqual(rOther.status, 404, "non-delegated GET passes through to OBJECT_NOT_FOUND");
  } finally {
    serverA.close();
  }
}

// ──────────────────────────────────────────────────────────────────
// Test 3: transfer redirects
// ──────────────────────────────────────────────────────────────────

async function testTransfer() {
  console.log("\n=== Test 3: transfer redirects ===");

  const stub = await startServer(new Store(), { authority: "tmp", port: 0, federation: new FederationClient() });
  const portA = stub.port;
  stub.server.close();

  const authorityA = "oldco.local";
  const successorAuthority = "newco.local";
  const successor = {
    authority: successorAuthority,
    namespaces: ["parts"],
    transfer_event_id: "txfr-" + crypto.randomUUID(),
    effective_from: "2020-01-01T00:00:00Z",
  };

  const { server: serverA } = await startServer(new Store(), {
    authority: authorityA, port: portA,
    federation: new FederationClient({ allowHttp: true }),
    successor,
    rootKey: `phip://${authorityA}/keys/root`,
    mirrorUrls: ["https://mirror.example/phip-archive"],
  });

  try {
    const rMeta = await jsonRequest(portA, "GET", "/.well-known/phip/meta");
    assertEqual(rMeta.body.successor.authority, successorAuthority, "/meta.successor authority");
    assert(
      Array.isArray(rMeta.body.mirror_urls) && rMeta.body.mirror_urls.length === 1,
      "/meta.mirror_urls populated",
    );
    assert(typeof rMeta.body.root_key === "string", "/meta.root_key populated");

    const rGet = await jsonRequest(portA, "GET", "/.well-known/phip/resolve/parts/anything");
    assertEqual(rGet.status, 308, "transferred GET returns 308");
    assert(
      rGet.headers && rGet.headers["location"] &&
        rGet.headers["location"].includes(successorAuthority),
      "transferred GET Location header points at successor",
    );
    assertEqual(
      rGet.headers["phip-transfer-event"], successor.transfer_event_id,
      "transferred GET PhIP-Transfer-Event header set",
    );

    // Empty body POST is fine — transfer redirect fires before body parse.
    const rCreate = await jsonRequest(portA, "POST", "/.well-known/phip/objects/parts", {});
    assertEqual(rCreate.status, 308, "transferred CREATE returns 308");

    // Non-transferred namespace passes through.
    const rOther = await jsonRequest(portA, "GET", "/.well-known/phip/resolve/lots/anything");
    assertEqual(rOther.status, 404, "non-transferred namespace passes through");
  } finally {
    serverA.close();
  }
}

// ──────────────────────────────────────────────────────────────────
// Test 4: PHIP_SUCCESSOR validation refuses malformed configs
// ──────────────────────────────────────────────────────────────────

async function testSuccessorValidation() {
  console.log("\n=== Test 4: successor config validation ===");

  // Missing transfer_event_id — must throw at server start.
  let threw = false;
  try {
    const r = await startServer(new Store(), {
      authority: "victim.local",
      port: 0,
      federation: new FederationClient({ allowHttp: true }),
      successor: {
        authority: "newco.example",
        namespaces: ["parts"],
        // transfer_event_id deliberately missing
      },
    });
    r.server.close();
  } catch (e) {
    threw = e.message.includes("transfer_event_id");
  }
  assert(threw, "missing transfer_event_id refuses startup");

  // Missing namespaces — must throw at server start.
  threw = false;
  try {
    const r = await startServer(new Store(), {
      authority: "victim.local",
      port: 0,
      federation: new FederationClient({ allowHttp: true }),
      successor: {
        authority: "newco.example",
        transfer_event_id: "txfr-x",
        // namespaces deliberately missing — should NOT default to ["*"]
      },
    });
    r.server.close();
  } catch (e) {
    threw = e.message.includes("namespaces");
  }
  assert(threw, "missing namespaces refuses startup (no fail-open default)");
}

async function main() {
  await testCrossAuthorityToken();
  await testDelegation();
  await testTransfer();
  await testSuccessorValidation();
  console.log("\n" + (failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("federation test crashed:", err);
  process.exit(1);
});
