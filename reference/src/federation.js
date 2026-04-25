// Federation: outbound HTTPS to other PhIP authorities.
//
// The single-authority resolver still owns its own namespace, but it now
// reaches out to OTHER authorities to fetch:
//   - /meta documents (to discover root keys, mirrors, delegations,
//     successor authorities) — Section 12.7
//   - Key resources (to verify capability tokens whose signing key lives
//     at a foreign authority) — Section 11.3.4
//
// Caching: foreign documents are cached by URL with an expiry derived
// from `Cache-Control: max-age` when supplied, otherwise a default TTL.
// The cache is process-local (lost on restart) — durable caching is a
// production concern.
//
// Trust: foreign keys are accepted on first use (TOFU) and pinned by
// fingerprint for the cache lifetime. Operators wanting stricter
// trust SHOULD pre-populate the cache with known-good roots; this
// reference resolver does not implement that today.

"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min for /meta and key resources
const REQUEST_TIMEOUT_MS = 10_000;

class FederationClient {
  constructor({ allowHttp = false, urlBuilder = null } = {}) {
    // Allow plain HTTP for dev/test (localhost). Production MUST use HTTPS.
    this.allowHttp = allowHttp;
    // Optional override for URL construction. Default: https://{authority}{path}.
    // Tests inject a builder that maps spec-compliant authority names
    // (e.g. "alice.local") to a localhost port the server is bound to.
    this.urlBuilder = urlBuilder;
    // Cache: URL -> { value, expiresAt }
    this._cache = new Map();
  }

  _buildUrl(authority, path) {
    if (this.urlBuilder) return this.urlBuilder({ authority, path });
    return `${this._scheme()}://${authority}${path}`;
  }

  // Fetch a foreign /meta document. Returns the parsed JSON or throws.
  async fetchMeta(authority) {
    const url = this._buildUrl(authority, "/.well-known/phip/meta");
    return this._cachedJsonGet(url);
  }

  // Fetch a foreign key resource (a PhIP `actor` object whose record holds
  // `phip:keys`). Returns the resolved JSON or throws. The keyId is a PhIP
  // URI — its authority component drives where we fetch from.
  async fetchKeyResource(keyId) {
    const m = /^phip:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(keyId);
    if (!m) {
      throw new Error(`Invalid PhIP key URI: ${keyId}`);
    }
    const [, authority, namespace, localId] = m;
    const url = this._buildUrl(authority, `/.well-known/phip/resolve/${namespace}/${localId}`);
    return this._cachedJsonGet(url);
  }

  // Resolve a key URI to the JWK material. Returns the JWK ({kty, crv, x,
  // not_before, not_after}) or throws if the key cannot be resolved or is
  // not active.
  async resolveKey(keyId) {
    const obj = await this.fetchKeyResource(keyId);
    if (!obj || obj.object_type !== "actor") {
      throw new Error(`Foreign key ${keyId} did not resolve to an actor`);
    }
    if (obj.state !== "active") {
      throw new Error(`Foreign key ${keyId} is not active (state=${obj.state})`);
    }
    const jwk = obj.attributes && obj.attributes["phip:keys"];
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
      throw new Error(`Foreign key ${keyId} is missing phip:keys material`);
    }
    return jwk;
  }

  // Fetch and parse an arbitrary URL with cache. The cache key is the URL
  // string. Cache TTL: response Cache-Control max-age if present, else
  // DEFAULT_TTL_MS.
  async _cachedJsonGet(url) {
    const cached = this._cache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const { body, headers } = await this._jsonGet(url);
    const ttl = parseMaxAge(headers) || DEFAULT_TTL_MS;
    this._cache.set(url, { value: body, expiresAt: Date.now() + ttl });
    return body;
  }

  // Single GET, parse JSON, no cache.
  _jsonGet(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      if (u.protocol !== "https:" && !this.allowHttp) {
        return reject(new Error(`Refusing to fetch over HTTP: ${url}`));
      }
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          method: "GET",
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              return reject(new Error(`Federation GET ${url} -> ${res.statusCode}: ${data.slice(0, 200)}`));
            }
            try {
              resolve({ body: JSON.parse(data), headers: res.headers });
            } catch (e) {
              reject(new Error(`Federation GET ${url} returned non-JSON: ${e.message}`));
            }
          });
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error(`Federation GET ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      });
      req.on("error", reject);
      req.end();
    });
  }

  // Override-able for tests: which scheme to use for outbound calls.
  _scheme() {
    return this.allowHttp ? "http" : "https";
  }

  // Test hook: clear all cached entries. Production code should not call
  // this — the cache is sized by TTL and process lifetime.
  _clearCache() {
    this._cache.clear();
  }
}

function parseMaxAge(headers) {
  const cc = headers && headers["cache-control"];
  if (!cc || typeof cc !== "string") return 0;
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  return m ? parseInt(m[1], 10) * 1000 : 0;
}

module.exports = { FederationClient };
