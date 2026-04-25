// HTTP transport — Section 12.
//
// Implements the protocol operations over HTTPS. This reference uses plain
// HTTP for local development — operators MUST front it with TLS in
// production.
//
// Endpoints:
//   GET   /.well-known/phip/meta                                       — metadata (12.7)
//   POST  /.well-known/phip/objects/{namespace}                        — CREATE (12.1)
//   POST  /.well-known/phip/objects/{namespace}/batch                  — batch CREATE (12.5)
//   GET   /.well-known/phip/resolve/{namespace}/{local-id...}          — GET    (12.2)
//   GET   /.well-known/phip/history/{namespace}/{local-id...}          — GET history (12.2.1)
//   POST  /.well-known/phip/push/{namespace}/{local-id...}             — PUSH   (12.3)
//   POST  /.well-known/phip/push/{namespace}/batch                     — batch PUSH (12.5)
//   POST  /.well-known/phip/query/{namespace}                          — QUERY  (12.4)

"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const { PhipError } = require("./errors");
const { hashEvent } = require("./crypto");

const PROTOCOL_VERSION = "0.1.0-draft";
const SUPPORTED_OPERATIONS = [
  "create",
  "get",
  "push",
  "query",
  "history",
  "batch_create",
  "batch_push",
];
const SCHEMA_NAMESPACES = [
  "phip:mechanical@1.0",
  "phip:datacenter@1.0",
  "phip:software@1.0",
  "phip:compliance@1.0",
  "phip:geo@1.0",
  "phip:access@1.0",
  "phip:keys",
];
const BATCH_MAX_EVENTS = 1000;

function buildPhipId(authority, namespace, localId) {
  return "phip://" + authority + "/" + namespace + "/" + localId;
}

// Parse the Authorization: PhIP-Capability <base64url> header into a caller
// object. Returns null when no header is present. If the header is present
// but malformed, returns a caller with a deferred `parseError` — the access
// check only surfaces the error when the target object's policy actually
// requires a token. This avoids denying access to `public` objects when a
// client happens to send a stray/malformed Authorization header.
//
// v0.1 reference: structural parse + expiry check only. Cryptographic
// verification of the token's `signature` against the granting authority's
// key is intentionally NOT performed — it requires resolving foreign keys,
// which this single-authority reference does not do. Production resolvers
// MUST add full §11.3.4 verification.
function parseCapabilityHeader(req) {
  const auth = req.headers && req.headers.authorization;
  if (!auth || !auth.startsWith("PhIP-Capability ")) return null;
  const tokenB64 = auth.slice("PhIP-Capability ".length).trim();
  try {
    const buf = Buffer.from(tokenB64, "base64url");
    const token = JSON.parse(buf.toString("utf8"));
    if (!token || typeof token !== "object" || token.phip_capability !== "1.0") {
      return { parseError: new PhipError("INVALID_CAPABILITY", "Capability token has wrong shape or version") };
    }
    return { token, actor: token.granted_to || null };
  } catch (e) {
    return { parseError: new PhipError("INVALID_CAPABILITY", "Capability token is not valid base64url-encoded JSON") };
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    function settle(fn, val) {
      if (settled) return;
      settled = true;
      fn(val);
    }
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 8 * 1_048_576) {
        settle(reject, new PhipError("INVALID_EVENT", "Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (data.length === 0) return settle(resolve, {});
      try {
        settle(resolve, JSON.parse(data));
      } catch (e) {
        settle(reject, new PhipError("INVALID_EVENT", "Request body is not valid JSON"));
      }
    });
    req.on("error", (err) => settle(reject, err));
  });
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

function sendError(res, err) {
  if (err instanceof PhipError) {
    return sendJson(res, err.status, err.toEnvelope());
  }
  // Unexpected internal error — never leak implementation details.
  console.error("[phip] internal error:", err);
  return sendJson(res, 500, {
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal resolver error",
    },
  });
}

// Run a per-event handler over an array of events and aggregate the
// per-event outcomes into a §12.5.3-shaped response. Envelope-level
// errors (non-array `events`, oversized batch) are returned as a special
// `envelopeError` object with HTTP 400; they are NOT thrown via PhipError
// because PhipError("INVALID_EVENT") maps to 422, and §12.5.3 mandates
// 400 for envelope-malformed.
function runBatch(events, handler) {
  if (!Array.isArray(events)) {
    return {
      envelopeError: {
        status: 400,
        body: { error: { code: "INVALID_EVENT", message: "Batch body MUST contain an `events` array" } },
      },
    };
  }
  if (events.length > BATCH_MAX_EVENTS) {
    return {
      envelopeError: {
        status: 400,
        body: {
          error: {
            code: "INVALID_EVENT",
            message: "Batch exceeds maximum of " + BATCH_MAX_EVENTS + " events",
            details: { max: BATCH_MAX_EVENTS, supplied: events.length },
          },
        },
      },
    };
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const outcome = handler(event);
      results.push(outcome);
      succeeded++;
    } catch (err) {
      const env = err instanceof PhipError
        ? err.toEnvelope()
        : { error: { code: "INTERNAL_ERROR", message: String(err && err.message || err) } };
      results.push({
        status: "error",
        phip_id: event && event.phip_id,
        error: env.error,
      });
      failed++;
    }
  }

  let status;
  if (events.length === 0) status = 200;
  else if (failed === 0) status = 200;
  else if (succeeded === 0) status = 422;
  else status = 207; // mixed

  return {
    status,
    body: {
      results,
      summary: { total: events.length, succeeded, failed },
    },
  };
}

function createApp(store, { authority }) {
  function buildMeta() {
    return {
      protocol_version: PROTOCOL_VERSION,
      authority,
      namespaces: store.namespaces ? store.namespaces() : [],
      schema_namespaces: SCHEMA_NAMESPACES,
      supported_operations: SUPPORTED_OPERATIONS,
      conformance_class: "full",
      batch_max_events: BATCH_MAX_EVENTS,
      // Optional v0.1 fields (root_key, mirror_urls, successor, delegations)
      // are absent — this reference does not yet implement transfer or
      // delegation. See spec §4.5, §4.6.
    };
  }

  function appendBatchPath(parts) {
    return parts[parts.length - 1] === "batch";
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
      const parts = url.pathname.split("/").filter(Boolean);

      // All routes live under /.well-known/phip/...
      if (parts[0] !== ".well-known" || parts[1] !== "phip") {
        throw new PhipError("OBJECT_NOT_FOUND", "Unknown endpoint");
      }
      const op = parts[2];

      // ------------------------------------------------------------------
      // GET /.well-known/phip/meta — Section 12.7
      // ------------------------------------------------------------------
      if (op === "meta" && req.method === "GET") {
        res.setHeader("Cache-Control", "public, max-age=3600");
        return sendJson(res, 200, buildMeta());
      }

      if (op === "objects" && req.method === "POST") {
        const namespace = parts[3];
        if (!namespace) {
          throw new PhipError("INVALID_EVENT", "Missing namespace in CREATE path");
        }

        // Batch CREATE: /.well-known/phip/objects/{namespace}/batch
        if (appendBatchPath(parts) && parts.length === 5) {
          const body = await readJsonBody(req);
          const result = runBatch(body.events, (event) => {
            if (!event || !event.phip_id || !event.phip_id.startsWith("phip://" + authority + "/" + namespace + "/")) {
              throw new PhipError(
                "FOREIGN_NAMESPACE",
                "CREATE is only valid within the caller's own authority/namespace",
              );
            }
            const obj = store.create(event);
            return {
              status: "created",
              phip_id: obj.phip_id,
              history_head: obj.history_head,
            };
          });
          if (result.envelopeError) {
            return sendJson(res, result.envelopeError.status, result.envelopeError.body);
          }
          return sendJson(res, result.status, result.body);
        }

        // Single CREATE.
        const event = await readJsonBody(req);
        if (!event.phip_id || !event.phip_id.startsWith("phip://" + authority + "/" + namespace + "/")) {
          throw new PhipError(
            "FOREIGN_NAMESPACE",
            "CREATE is only valid within the caller's own authority/namespace",
          );
        }
        const obj = store.create(event);
        return sendJson(res, 201, obj);
      }

      if (op === "resolve" && req.method === "GET") {
        const namespace = parts[3];
        const localId = parts.slice(4).join("/");
        if (!namespace || !localId) {
          throw new PhipError("OBJECT_NOT_FOUND", "Missing namespace or local-id");
        }
        const phipId = buildPhipId(authority, namespace, localId);
        const caller = parseCapabilityHeader(req);
        const obj = store.get(phipId, caller);
        return sendJson(res, 200, obj);
      }

      if (op === "history" && req.method === "GET") {
        const namespace = parts[3];
        const localId = parts.slice(4).join("/");
        if (!namespace || !localId) {
          throw new PhipError("OBJECT_NOT_FOUND", "Missing namespace or local-id");
        }
        const phipId = buildPhipId(authority, namespace, localId);
        const limit = parseInt(url.searchParams.get("limit"), 10) || 100;
        const cursor = url.searchParams.get("cursor") || null;
        const order = url.searchParams.get("order") || "asc";
        const caller = parseCapabilityHeader(req);
        const history = store.history(phipId, { limit, cursor, order }, caller);
        return sendJson(res, 200, history);
      }

      if (op === "push" && req.method === "POST") {
        const namespace = parts[3];

        // Batch PUSH: /.well-known/phip/push/{namespace}/batch
        if (appendBatchPath(parts) && parts.length === 5) {
          const body = await readJsonBody(req);
          const result = runBatch(body.events, (event) => {
            if (!event || !event.phip_id) {
              throw new PhipError("INVALID_EVENT", "Event missing phip_id");
            }
            const appended = store.push(event.phip_id, event);
            // Refresh the chain head from the store so callers can chain
            // subsequent pushes within the same batch.
            const slot = store.objects.get(event.phip_id);
            const head = slot && slot.history.length
              ? hashEvent(slot.history[slot.history.length - 1])
              : null;
            return {
              status: "appended",
              phip_id: event.phip_id,
              history_head: head,
              event_id: appended.event_id,
            };
          });
          if (result.envelopeError) {
            return sendJson(res, result.envelopeError.status, result.envelopeError.body);
          }
          return sendJson(res, result.status, result.body);
        }

        const localId = parts.slice(4).join("/");
        if (!namespace || !localId) {
          throw new PhipError("OBJECT_NOT_FOUND", "Missing namespace or local-id");
        }
        const phipId = buildPhipId(authority, namespace, localId);
        const event = await readJsonBody(req);
        const appended = store.push(phipId, event);
        return sendJson(res, 201, appended);
      }

      if (op === "query" && req.method === "POST") {
        const query = await readJsonBody(req);
        const caller = parseCapabilityHeader(req);
        const result = store.query(query, caller);
        return sendJson(res, 200, result);
      }

      throw new PhipError("OBJECT_NOT_FOUND", "Unknown endpoint");
    } catch (err) {
      return sendError(res, err);
    }
  };
}

function startServer(store, { authority, port = 0 } = {}) {
  const app = createApp(store, { authority });
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

module.exports = { createApp, startServer };
