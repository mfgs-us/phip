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
const { FederationClient } = require("./federation");

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
// Cryptographic verification of the token's signature is performed by
// store._verifyCapabilityToken once the access check decides the token is
// needed. Intra-authority tokens are verified against the local key store.
// Tokens whose signing key lives at a foreign authority are pre-resolved
// in `prepareCapability` (next function) via outbound HTTPS to the foreign
// authority's `/.well-known/phip/resolve/...` endpoint.
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

// Async pre-step before any access check: if the parsed token's signing
// key lives at a foreign authority, fetch the key via the federation
// client. Errors are stashed on the caller as `foreignKeyError` and
// surfaced only if the policy requires the token. Intra-authority
// signing keys are left to the store's local resolution path.
async function prepareCapability(caller, federation, ourAuthority) {
  if (!caller || caller.parseError || !caller.token) return caller;
  const keyId = caller.token.signature && caller.token.signature.key_id;
  if (!keyId) return caller;
  const m = /^phip:\/\/([^/]+)\//.exec(keyId);
  if (!m) return caller;
  const keyAuthority = m[1];
  if (keyAuthority === ourAuthority) return caller; // local — store handles
  try {
    caller.resolvedForeignKey = await federation.resolveKey(keyId);
  } catch (err) {
    caller.foreignKeyError = err;
  }
  return caller;
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

function createApp(store, {
  authority,
  federation,
  delegations = [],
  rootKey,
  successor,
  mirrorUrls = [],
} = {}) {
  // Federation client may be injected (tests pass an instance configured
  // for HTTP localhost calls). Default: HTTPS-only client.
  if (!federation) federation = new FederationClient();
  function buildMeta() {
    const meta = {
      protocol_version: PROTOCOL_VERSION,
      authority,
      namespaces: store.namespaces ? store.namespaces() : [],
      schema_namespaces: SCHEMA_NAMESPACES,
      supported_operations: SUPPORTED_OPERATIONS,
      conformance_class: "full",
      batch_max_events: BATCH_MAX_EVENTS,
    };
    if (rootKey) meta.root_key = rootKey;
    if (delegations && delegations.length) meta.delegations = delegations;
    if (successor) meta.successor = successor;
    if (mirrorUrls && mirrorUrls.length) meta.mirror_urls = mirrorUrls;
    return meta;
  }

  // §4.6.4: a transferred namespace redirects to the successor authority.
  // Returns the successor entry (not just a boolean) so the redirect can
  // emit `PhIP-Transfer-Event` with the originating event id.
  function matchTransferred(namespace) {
    if (!successor) return null;
    const namespaces = successor.namespaces || ["*"];
    if (!namespaces.includes(namespace) && !namespaces.includes("*")) return null;
    // Effective-from gate.
    if (successor.effective_from && Date.parse(successor.effective_from) > Date.now()) {
      return null;
    }
    return successor;
  }

  function transferRedirect(res, succ, originalPath) {
    const target = `https://${succ.authority}${originalPath}`;
    const headers = {
      Location: target,
      "Content-Length": "0",
    };
    if (succ.transfer_event_id) {
      headers["PhIP-Transfer-Event"] = succ.transfer_event_id;
    }
    // 308 Permanent Redirect — preserves method and body for POST.
    res.writeHead(308, headers);
    res.end();
  }

  // Find a delegation entry that covers the given phip_id, namespace
  // (and optional local-id prefix). Returns the entry, or null.
  function matchDelegation(namespace, localId) {
    for (const d of delegations || []) {
      if (d.namespace !== namespace && d.namespace !== "*") continue;
      if (d.prefix && !(localId || "").startsWith(d.prefix)) continue;
      // Effective-from / expires window check.
      const now = Date.now();
      if (d.effective_from && Date.parse(d.effective_from) > now) continue;
      if (d.expires && Date.parse(d.expires) < now) continue;
      return d;
    }
    return null;
  }

  // Build a 307 redirect response pointing at the delegate's resolver,
  // with the PhIP-Delegation header naming the namespace whose delegation
  // justifies the cross-authority hop. (§4.5.2 mechanics.)
  function delegateRedirect(res, delegation, originalPath) {
    const target = `https://${delegation.delegate_authority}${originalPath}`;
    res.writeHead(307, {
      Location: target,
      "PhIP-Delegation": delegation.namespace,
      "Content-Length": "0",
    });
    res.end();
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
        // §4.6: transferred namespace → permanent redirect to successor.
        const xferC = matchTransferred(namespace);
        if (xferC) {
          return transferRedirect(res, xferC, req.url);
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
        // §4.5.3: forward CREATEs targeting a delegated slice.
        const cLocalId = event.phip_id.slice(("phip://" + authority + "/" + namespace + "/").length);
        const cDelegation = matchDelegation(namespace, cLocalId);
        if (cDelegation) {
          return delegateRedirect(res, cDelegation, req.url);
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
        const xferR = matchTransferred(namespace);
        if (xferR) {
          return transferRedirect(res, xferR, req.url);
        }
        const dRes = matchDelegation(namespace, localId);
        if (dRes) {
          return delegateRedirect(res, dRes, req.url);
        }
        const phipId = buildPhipId(authority, namespace, localId);
        const caller = await prepareCapability(parseCapabilityHeader(req), federation, authority);
        const obj = store.get(phipId, caller);
        return sendJson(res, 200, obj);
      }

      if (op === "history" && req.method === "GET") {
        const namespace = parts[3];
        const localId = parts.slice(4).join("/");
        if (!namespace || !localId) {
          throw new PhipError("OBJECT_NOT_FOUND", "Missing namespace or local-id");
        }
        const xferH = matchTransferred(namespace);
        if (xferH) {
          return transferRedirect(res, xferH, req.url);
        }
        const dHist = matchDelegation(namespace, localId);
        if (dHist) {
          return delegateRedirect(res, dHist, req.url);
        }
        const phipId = buildPhipId(authority, namespace, localId);
        const limit = parseInt(url.searchParams.get("limit"), 10) || 100;
        const cursor = url.searchParams.get("cursor") || null;
        const order = url.searchParams.get("order") || "asc";
        const caller = await prepareCapability(parseCapabilityHeader(req), federation, authority);
        const history = store.history(phipId, { limit, cursor, order }, caller);
        return sendJson(res, 200, history);
      }

      if (op === "push" && req.method === "POST") {
        const namespace = parts[3];
        const xferP = matchTransferred(namespace);
        if (xferP) {
          return transferRedirect(res, xferP, req.url);
        }

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
        const dPush = matchDelegation(namespace, localId);
        if (dPush) {
          return delegateRedirect(res, dPush, req.url);
        }
        const phipId = buildPhipId(authority, namespace, localId);
        const event = await readJsonBody(req);
        const appended = store.push(phipId, event);
        return sendJson(res, 201, appended);
      }

      if (op === "query" && req.method === "POST") {
        const namespace = parts[3];
        const xferQ = matchTransferred(namespace);
        if (xferQ) {
          return transferRedirect(res, xferQ, req.url);
        }
        const query = await readJsonBody(req);
        const caller = await prepareCapability(parseCapabilityHeader(req), federation, authority);
        const result = store.query(query, caller);
        return sendJson(res, 200, result);
      }

      throw new PhipError("OBJECT_NOT_FOUND", "Unknown endpoint");
    } catch (err) {
      return sendError(res, err);
    }
  };
}

function startServer(store, opts = {}) {
  const { port = 0 } = opts;
  const app = createApp(store, opts);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

module.exports = { createApp, startServer };
