// Entry point for the reference PhIP resolver.
//
// Starts an HTTP server bound to a single authority/namespace, with an empty
// in-memory store. Configurable via env:
//
//   PHIP_AUTHORITY      DNS name this resolver represents (default: example.com)
//   PHIP_PORT           Listen port (default: 8080)
//   PHIP_DELEGATIONS    JSON array of delegation entries; advertised in /meta
//                       and used to redirect writes/reads to delegate resolvers
//                       (§4.5)
//   PHIP_ROOT_KEY       Optional PhIP URI of this authority's root key
//                       (advertised in /meta; §4.6.1)
//   PHIP_SUCCESSOR      Optional JSON object describing a completed authority
//                       transfer; advertised in /meta.successor (§4.6.2)
//                       Shape: { "authority": "newco.example",
//                                "namespaces": ["parts","lots"],
//                                "transfer_event_id": "...",
//                                "effective_from": "..." }
//   PHIP_MIRROR_URLS    Optional JSON array of read-only mirror URLs hosting
//                       this authority's records; advertised in /meta (§4.6.5)
//   PHIP_FED_ALLOW_HTTP If "1", allow outbound federation requests over plain
//                       HTTP (for tests / dev). Default off (HTTPS-only).
//
// This is a reference implementation — intended for reading, testing, and
// conformance checks. Production use requires TLS termination, durable
// storage, and operator-grade key management.

"use strict";

const { Store } = require("./store");
const { startServer } = require("./server");
const { FederationClient } = require("./federation");

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[phip] ignoring malformed ${name}: ${e.message}`);
    return undefined;
  }
}

async function main() {
  const authority = process.env.PHIP_AUTHORITY || "example.com";
  const port = parseInt(process.env.PHIP_PORT || "8080", 10);
  const delegations = parseJsonEnv("PHIP_DELEGATIONS") || [];
  const rootKey = process.env.PHIP_ROOT_KEY || undefined;
  const successor = parseJsonEnv("PHIP_SUCCESSOR");
  const mirrorUrls = parseJsonEnv("PHIP_MIRROR_URLS") || [];
  const allowHttp = process.env.PHIP_FED_ALLOW_HTTP === "1";

  const store = new Store();
  const federation = new FederationClient({ allowHttp });
  const { port: boundPort } = await startServer(store, {
    authority,
    port,
    federation,
    delegations,
    rootKey,
    successor,
    mirrorUrls,
  });
  console.log(
    "[phip] reference resolver listening on http://localhost:" +
      boundPort +
      " (authority=" +
      authority +
      (delegations.length ? `, ${delegations.length} delegation(s)` : "") +
      (successor ? ", transferred" : "") +
      ")",
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[phip] failed to start:", err);
    process.exit(1);
  });
}

module.exports = { main };
