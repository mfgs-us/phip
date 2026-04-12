// HTTP transport — Section 12.
//
// Implements the four core protocol operations over HTTPS. This reference
// uses plain HTTP for local development — operators MUST front it with TLS
// in production.
//
// Endpoints:
//   POST  /.well-known/phip/objects/{namespace}                     — CREATE (12.1)
//   GET   /.well-known/phip/resolve/{namespace}/{local-id...}       — GET  (12.2)
//   GET   /.well-known/phip/history/{namespace}/{local-id...}       — GET history (12.2.1)
//   POST  /.well-known/phip/push/{namespace}/{local-id...}          — PUSH (12.3)
//   POST  /.well-known/phip/query/{namespace}                       — QUERY (12.4)

"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const { PhipError } = require("./errors");

function buildPhipId(authority, namespace, localId) {
  return "phip://" + authority + "/" + namespace + "/" + localId;
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
      if (data.length > 1_048_576) {
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
  // Unexpected internal error — surface as INVALID_OBJECT (422) rather than
  // leaking implementation details.
  console.error("[phip] internal error:", err);
  return sendJson(res, 500, {
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal resolver error",
    },
  });
}

function createApp(store, { authority }) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
      const parts = url.pathname.split("/").filter(Boolean);

      // All routes live under /.well-known/phip/...
      if (parts[0] !== ".well-known" || parts[1] !== "phip") {
        throw new PhipError("OBJECT_NOT_FOUND", "Unknown endpoint");
      }
      const op = parts[2];

      if (op === "objects" && req.method === "POST") {
        // CREATE: /.well-known/phip/objects/{namespace}
        const namespace = parts[3];
        if (!namespace) {
          throw new PhipError("INVALID_EVENT", "Missing namespace in CREATE path");
        }
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
        // GET: /.well-known/phip/resolve/{namespace}/{local-id...}
        const namespace = parts[3];
        const localId = parts.slice(4).join("/");
        if (!namespace || !localId) {
          throw new PhipError("OBJECT_NOT_FOUND", "Missing namespace or local-id");
        }
        const phipId = buildPhipId(authority, namespace, localId);
        const obj = store.get(phipId);
        return sendJson(res, 200, obj);
      }

      if (op === "history" && req.method === "GET") {
        // GET: /.well-known/phip/history/{namespace}/{local-id...}
        const namespace = parts[3];
        const localId = parts.slice(4).join("/");
        if (!namespace || !localId) {
          throw new PhipError("OBJECT_NOT_FOUND", "Missing namespace or local-id");
        }
        const phipId = buildPhipId(authority, namespace, localId);
        const limit = parseInt(url.searchParams.get("limit"), 10) || 100;
        const cursor = url.searchParams.get("cursor") || null;
        const order = url.searchParams.get("order") || "asc";
        const history = store.history(phipId, { limit, cursor, order });
        return sendJson(res, 200, history);
      }

      if (op === "push" && req.method === "POST") {
        // PUSH: /.well-known/phip/push/{namespace}/{local-id...}
        const namespace = parts[3];
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
        // QUERY: /.well-known/phip/query/{namespace}
        // Namespace path segment is accepted but v0 searches across all
        // objects in the store — this resolver owns a single namespace.
        const query = await readJsonBody(req);
        const result = store.query(query);
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
