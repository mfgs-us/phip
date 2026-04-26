// Self-check for the committed test vectors.
//
// Loads each fixture from disk and verifies it passes the checks that any
// client-library implementation is expected to perform:
//
//   * JCS — canonicalize(input) === canonical, and its UTF-8 bytes == canonical_bytes_hex
//   * Hash — "sha256:" + SHA-256(canonical bytes) === hash
//   * Ed25519 — signing the message with the private key yields signature_b64url,
//     and verifying with the public key returns true
//   * Hash chain — each event's previous_hash equals hash(previous event)
//   * Bootstrap — the self-signed created event verifies against the public key
//     embedded in its own payload
//
// If this script passes, the committed fixtures are internally consistent and
// any other implementation that produces identical output is byte-compatible.
// Run `node vectors/self-check.js` from the tests/ directory.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const canonicalize = require("canonicalize");

const VEC = __dirname;

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

function load(rel) {
  return JSON.parse(fs.readFileSync(path.join(VEC, rel), "utf8"));
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hashEvent(event) {
  return "sha256:" + sha256Hex(Buffer.from(canonicalize(event), "utf8"));
}

function loadKey(kp) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(kp.private_pkcs8_b64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const raw = Buffer.from(kp.public_raw_b64url, "base64url");
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  const publicKey = crypto.createPublicKey({
    key: spki,
    format: "der",
    type: "spki",
  });
  return { privateKey, publicKey };
}

// ── JCS ─────────────────────────────────────────────────────────────
console.log("\n[jcs]");
{
  const { cases } = load("jcs/cases.json");
  for (const c of cases) {
    const canonical = canonicalize(c.input);
    assert(canonical === c.canonical, `${c.name} canonical matches`);
    const hex = Buffer.from(canonical, "utf8").toString("hex");
    assert(hex === c.canonical_bytes_hex, `${c.name} byte-hex matches`);
  }
}

// ── Hash ────────────────────────────────────────────────────────────
console.log("\n[hash]");
{
  const { cases } = load("hash/cases.json");
  for (const c of cases) {
    const got = "sha256:" + sha256Hex(Buffer.from(canonicalize(c.input), "utf8"));
    assert(got === c.hash, `${c.name} hash matches`);
  }
}

// ── Ed25519 ─────────────────────────────────────────────────────────
console.log("\n[ed25519]");
{
  const { keys } = load("ed25519/keypair.json");
  const keyMap = Object.fromEntries(keys.map((k) => [k.id, loadKey(k)]));
  const { raw, events } = load("ed25519/cases.json");

  for (const c of raw) {
    const key = keyMap[c.key_id];
    const msg = Buffer.from(c.message_hex, "hex");
    const sig = crypto.sign(null, msg, key.privateKey);
    assert(
      sig.toString("base64url") === c.signature_b64url,
      `raw ${c.name} signature reproduces`
    );
    assert(
      crypto.verify(null, msg, key.publicKey, Buffer.from(c.signature_b64url, "base64url")),
      `raw ${c.name} signature verifies`
    );
  }

  for (const c of events) {
    const key = keyMap[c.key_id];
    const canonical = canonicalize(c.event_unsigned);
    const hex = Buffer.from(canonical, "utf8").toString("hex");
    assert(hex === c.canonical_bytes_hex, `event ${c.name} canonical bytes match`);
    const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), key.privateKey);
    assert(
      sig.toString("base64url") === c.signature_b64url,
      `event ${c.name} signature reproduces`
    );
    const { signature, ...rest } = c.signed_event;
    const verified = crypto.verify(
      null,
      Buffer.from(canonicalize(rest), "utf8"),
      key.publicKey,
      Buffer.from(signature.value, "base64url")
    );
    assert(verified, `event ${c.name} signed_event verifies`);
  }
}

// ── Hash chain ──────────────────────────────────────────────────────
console.log("\n[hashchain]");
{
  const { events, expected_hashes } = load("hashchain/sequence.json");
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (i === 0) {
      assert(ev.previous_hash === "genesis", `event[0] previous_hash is "genesis"`);
    } else {
      const expected = hashEvent(events[i - 1]);
      assert(
        ev.previous_hash === expected,
        `event[${i}].previous_hash equals hash(event[${i - 1}])`
      );
    }
    const got = hashEvent(ev);
    assert(got === expected_hashes[i], `event[${i}] hash matches expected_hashes[${i}]`);
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────
console.log("\n[bootstrap]");
{
  const { created_event, bootstrap_actor_id } = load("bootstrap/example.json");
  const embeddedJwk = created_event.payload.attributes["phip:keys"];
  assert(embeddedJwk.kty === "OKP" && embeddedJwk.crv === "Ed25519", "JWK kty+crv");
  const raw = Buffer.from(embeddedJwk.x, "base64url");
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  const publicKey = crypto.createPublicKey({
    key: spki,
    format: "der",
    type: "spki",
  });
  const { signature, ...rest } = created_event;
  const verified = crypto.verify(
    null,
    Buffer.from(canonicalize(rest), "utf8"),
    publicKey,
    Buffer.from(signature.value, "base64url")
  );
  assert(verified, "bootstrap event verifies against its own embedded public key");
  assert(
    created_event.actor === bootstrap_actor_id &&
      created_event.phip_id === bootstrap_actor_id,
    "bootstrap actor equals phip_id (self-signed)"
  );
}

// ── Lifecycle sanity ────────────────────────────────────────────────
console.log("\n[lifecycle]");
{
  for (const file of ["lifecycle/manufacturing.json", "lifecycle/operational.json"]) {
    const v = load(file);
    for (const t of v.valid) {
      assert(
        (v.transitions[t.from] || []).includes(t.to),
        `${file} valid[${t.from}→${t.to}] present in transitions table`
      );
    }
    for (const t of v.invalid) {
      assert(
        !(v.transitions[t.from] || []).includes(t.to),
        `${file} invalid[${t.from}→${t.to}] absent from transitions table`
      );
    }
  }
}

// ── Capability tokens ──────────────────────────────────────────────
console.log("\n[token]");
{
  const { keys } = load("ed25519/keypair.json");
  const keyMap = Object.fromEntries(keys.map((k) => [k.id, loadKey(k)]));
  const { cases } = load("token/cases.json");
  for (const c of cases) {
    // Verify signature reproducibility against the named verifying key.
    const verifyingKey = keyMap[c.verifying_key_id];
    const { signature, ...rest } = c.signed_token;
    const verified = crypto.verify(
      null,
      Buffer.from(canonicalize(rest), "utf8"),
      verifyingKey.publicKey,
      Buffer.from(signature.value, "base64url"),
    );
    // Cases with expected = invalid_signature MUST NOT verify.
    // Cases with any other expected value MUST verify (the rejection
    // happens at higher-level checks: expiry, scope, filter, etc.)
    const sigShouldVerify = c.expected !== "invalid_signature";
    assert(
      verified === sigShouldVerify,
      `token ${c.name} signature ${sigShouldVerify ? "verifies" : "does not verify"}`,
    );

    // Transport round-trip: base64url-decoded transport form MUST parse
    // back to the same JSON.
    const decoded = JSON.parse(Buffer.from(c.transport_b64url, "base64url").toString("utf8"));
    assert(
      JSON.stringify(decoded) === JSON.stringify(c.signed_token),
      `token ${c.name} transport_b64url round-trips to signed_token`,
    );

    // Time-window checks: assert the case's `verification_time` matches
    // the expected outcome by spec rule.
    if (c.expected === "expired") {
      assert(
        Date.parse(c.verification_time) > Date.parse(c.signed_token.expires),
        `token ${c.name} verification_time is after expires`,
      );
    } else if (c.expected === "not_yet_valid") {
      assert(
        Date.parse(c.verification_time) < Date.parse(c.signed_token.not_before),
        `token ${c.name} verification_time is before not_before`,
      );
    }
  }
}

// ── Bundles ────────────────────────────────────────────────────────
console.log("\n[bundle]");
{
  const { keys: testKeys } = load("ed25519/keypair.json");
  const keyMap = Object.fromEntries(testKeys.map((k) => [k.id, loadKey(k)]));
  const aliceJwkX = testKeys.find((k) => k.id === "test-key-alice").public_raw_b64url;
  const alicePub = (() => {
    const raw = Buffer.from(aliceJwkX, "base64url");
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      raw,
    ]);
    return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  })();
  void keyMap;

  const { bundles } = load("bundle/cases.json");
  for (const b of bundles) {
    // Step 1: manifest signature MUST verify in all cases (the tampered
    // case mutates events, not the manifest).
    const { signature, ...manifestRest } = b.manifest;
    const manifestVerified = crypto.verify(
      null,
      Buffer.from(canonicalize(manifestRest), "utf8"),
      alicePub,
      Buffer.from(signature.value, "base64url"),
    );
    assert(manifestVerified, `bundle ${b.name} manifest signature verifies`);

    // Step 2: each declared object's history MUST hash-chain to the
    // manifest's claimed history_head.
    let chainOk = true;
    for (const objEntry of b.manifest.objects) {
      const events = b.history[objEntry.phip_id];
      if (!events || !events.length) {
        chainOk = false;
        break;
      }
      // Walk the chain forward, verifying each event signature and
      // each previous_hash linkage.
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const prevHash = i === 0 ? "genesis" : hashEvent(events[i - 1]);
        if (ev.previous_hash !== prevHash) {
          chainOk = false;
          break;
        }
        const { signature: evSig, ...evRest } = ev;
        const sigOk = crypto.verify(
          null,
          Buffer.from(canonicalize(evRest), "utf8"),
          alicePub,
          Buffer.from(evSig.value, "base64url"),
        );
        if (!sigOk) {
          chainOk = false;
          break;
        }
      }
      // Final head matches the manifest's claim.
      const finalHead = hashEvent(events[events.length - 1]);
      if (finalHead !== objEntry.history_head) {
        chainOk = false;
      }
      if (!chainOk) break;
    }

    if (b.name === "tampered-event") {
      assert(!chainOk, `bundle ${b.name} chain verification REJECTS (tampered event)`);
    } else {
      assert(chainOk, `bundle ${b.name} chain verification accepts`);
    }

    // Step 3: embedded keys MUST contain the producer's key actor.
    const producerKeyUri = b.manifest.created_by;
    const producerKey = b.keys[producerKeyUri];
    assert(
      producerKey && producerKey.attributes && producerKey.attributes["phip:keys"],
      `bundle ${b.name} embeds producer's key actor`,
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
