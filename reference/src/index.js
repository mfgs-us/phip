// Entry point for the reference PhIP resolver.
//
// Starts an HTTP server bound to a single authority/namespace, with an empty
// in-memory store. The authority is configured via the PHIP_AUTHORITY env
// variable (defaults to "example.com"); port via PHIP_PORT (default 8080).
//
// This is a reference implementation — intended for reading, testing, and
// conformance checks. Production use requires TLS termination, durable
// storage, and cross-authority key resolution. See the package.json
// description for the v0 scope.

"use strict";

const { Store } = require("./store");
const { startServer } = require("./server");

async function main() {
  const authority = process.env.PHIP_AUTHORITY || "example.com";
  const port = parseInt(process.env.PHIP_PORT || "8080", 10);

  const store = new Store();
  const { port: boundPort } = await startServer(store, { authority, port });
  console.log(
    "[phip] reference resolver listening on http://localhost:" +
      boundPort +
      " (authority=" +
      authority +
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
