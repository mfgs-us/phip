// Federation: outbound HTTPS to other PhIP authorities.
//
// The single-authority resolver still owns its own namespace, but it now
// reaches out to OTHER authorities to fetch:
//   - /meta documents (to discover root keys, mirrors, delegations,
//     successor authorities) — Section 12.7
//   - Key resources (to verify capability tokens whose signing key lives
//     at a foreign authority) — Section 11.3.4
//
// **Security stance.** Outbound requests are triggered by user-supplied
// data (a `key_id` in a capability token). Without defenses this would
// be a textbook SSRF: an attacker mints a token whose `key_id` points
// at an internal-network address, and the resolver dutifully probes it.
//
// Defenses implemented here:
//   1. HTTPS by default. Plain HTTP requires explicit `allowHttp: true`.
//   2. Private/loopback/link-local target blocking. After DNS resolution,
//      reject any address in the RFC1918/loopback/link-local/special-use
//      ranges. Default off in tests with `allowHttp: true`.
//   3. DNS rebinding pinning. Resolve once, verify the address, then
//      connect to that address (passing `host` literally, with `Host`
//      header set to the original name).
//   4. Cache TTL clamp. `Cache-Control: max-age` from a foreign response
//      is bounded by MAX_TTL_MS so a malicious authority can't pin a
//      forged key for years.
//   5. Trust on first use is *not* implemented as fingerprint pinning;
//      the comment in PR #8 was misleading. We rely on TLS certificate
//      validation (when allowHttp is false) plus the cache TTL clamp.

"use strict";

const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");
const { URL } = require("node:url");

const DEFAULT_TTL_MS = 5 * 60 * 1000;       // 5 min
const MAX_TTL_MS = 24 * 60 * 60 * 1000;     // 24 h ceiling on foreign-set max-age
const REQUEST_TIMEOUT_MS = 10_000;

class FederationClient {
  constructor({
    allowHttp = false,
    urlBuilder = null,
    // Allow connection to private/loopback/link-local addresses.
    // Default tracks `allowHttp` so test setups using localhost work
    // out of the box. Production deployments running with HTTPS should
    // leave both off.
    allowPrivateAddresses = null,
  } = {}) {
    this.allowHttp = allowHttp;
    this.allowPrivateAddresses =
      allowPrivateAddresses === null ? allowHttp : allowPrivateAddresses;
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
  // `phip:keys`). The keyId is a PhIP URI — its authority component drives
  // where we fetch from.
  async fetchKeyResource(keyId) {
    const m = /^phip:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(keyId);
    if (!m) {
      throw new Error("Invalid PhIP key URI shape");
    }
    const [, authority, namespace, localId] = m;
    const url = this._buildUrl(authority, `/.well-known/phip/resolve/${namespace}/${localId}`);
    return this._cachedJsonGet(url);
  }

  // Resolve a key URI to its JWK material. Throws if unresolvable or
  // the actor is not active.
  async resolveKey(keyId) {
    const obj = await this.fetchKeyResource(keyId);
    if (!obj || obj.object_type !== "actor") {
      throw new Error("Foreign key target is not an actor");
    }
    if (obj.state !== "active") {
      throw new Error("Foreign key actor is not active");
    }
    const jwk = obj.attributes && obj.attributes["phip:keys"];
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
      throw new Error("Foreign key actor is missing phip:keys material");
    }
    return jwk;
  }

  async _cachedJsonGet(url) {
    const cached = this._cache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const { body, headers } = await this._jsonGet(url);
    const ttl = clampTtl(parseMaxAge(headers) || DEFAULT_TTL_MS);
    this._cache.set(url, { value: body, expiresAt: Date.now() + ttl });
    return body;
  }

  // Single GET → parse JSON. No cache. Does DNS resolution + private-IP
  // check before establishing the connection (SSRF defense + DNS-rebinding
  // pin).
  async _jsonGet(url) {
    const u = new URL(url);
    if (u.protocol !== "https:" && !this.allowHttp) {
      throw new Error("Refusing to fetch over HTTP");
    }

    // Resolve hostname → IP. If hostname is already an IP, dns.lookup
    // returns it as-is. Reject IPs in private ranges unless allowed.
    const port = parseInt(u.port, 10) || (u.protocol === "https:" ? 443 : 80);
    let resolvedAddress;
    try {
      const lookup = await dns.lookup(u.hostname, { all: false });
      resolvedAddress = lookup.address;
    } catch (e) {
      throw new Error("DNS resolution failed for federation target");
    }
    if (!this.allowPrivateAddresses && isPrivateAddress(resolvedAddress)) {
      throw new Error("Refusing to connect to private/loopback/link-local address");
    }

    return new Promise((resolve, reject) => {
      const lib = u.protocol === "https:" ? https : http;
      // Pin the resolved address (defeats DNS rebinding), but keep the
      // original hostname as the SNI / Host header so TLS cert validation
      // and HTTP routing still work.
      const req = lib.request(
        {
          host: resolvedAddress,
          port,
          path: u.pathname + u.search,
          method: "GET",
          timeout: REQUEST_TIMEOUT_MS,
          headers: { Host: u.host },
          servername: u.hostname,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              return reject(new Error(`Federation GET returned status ${res.statusCode}`));
            }
            try {
              resolve({ body: JSON.parse(data), headers: res.headers });
            } catch (e) {
              reject(new Error("Federation response was not valid JSON"));
            }
          });
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error("Federation GET timed out"));
      });
      req.on("error", () => reject(new Error("Federation request failed")));
      req.end();
    });
  }

  _scheme() {
    return this.allowHttp ? "http" : "https";
  }

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

function clampTtl(ttlMs) {
  if (ttlMs <= 0) return DEFAULT_TTL_MS;
  return Math.min(ttlMs, MAX_TTL_MS);
}

// Check whether an IPv4 or IPv6 address is in a private/loopback/link-local/
// special-use range. Conservative — when in doubt, treat as private.
function isPrivateAddress(addr) {
  if (typeof addr !== "string" || !addr) return true;
  const family = net.isIP(addr);
  if (family === 4) return isPrivateIPv4(addr);
  if (family === 6) return isPrivateIPv6(addr);
  return true; // not parseable as an IP — treat as private (fail closed)
}

function isPrivateIPv4(addr) {
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  // 0.0.0.0/8 (this network), 127.0.0.0/8 (loopback)
  if (a === 0 || a === 127) return true;
  // 10.0.0.0/8 (RFC1918)
  if (a === 10) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved), 255.255.255.255 (broadcast)
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(addr) {
  const a = addr.toLowerCase();
  // Loopback ::1
  if (a === "::1") return true;
  // Unspecified ::
  if (a === "::") return true;
  // Link-local fe80::/10
  if (a.startsWith("fe80:") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return true;
  // Unique local fc00::/7
  if (a.startsWith("fc") || a.startsWith("fd")) return true;
  // IPv4-mapped IPv6 — extract and recheck
  const v4mapped = /^::ffff:([0-9.]+)$/i.exec(a);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);
  // Multicast ff00::/8
  if (a.startsWith("ff")) return true;
  return false;
}

module.exports = { FederationClient, isPrivateAddress, parseMaxAge, clampTtl, MAX_TTL_MS };
