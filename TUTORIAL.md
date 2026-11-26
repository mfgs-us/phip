# PhIP — Tutorial

A guided tour of what PhIP is, what each piece in the ecosystem
does, and how to get from "I just heard about this" to "I'm running
a working PhIP stack" in 15 minutes.

> **Audience:** newcomers. If you know PhIP and want to integrate it,
> jump to the per-repo tutorials linked below.

## 1. What PhIP is, in one paragraph

The Physical Information Protocol is a federated wire format and
trust model for talking about physical objects across organizational
boundaries. Each object has a stable URI (`phip://authority/namespace/local-id`),
a hash-chained event log of everything that's happened to it (signed
by the parties making the claims), and a small, controlled vocabulary
of types and lifecycle states. It's to physical objects roughly what
HTTP+TLS+DNS is to documents — addressing, authenticity, and
exchange, not the application semantics themselves.

It is **not** an ERP, MES, file format, communication bus, or
blockchain. Read [`LIABILITY.md`](./LIABILITY.md) for how PhIP claims
relate to contracts, evidence, and statutory records.

## 2. The ecosystem at a glance

| Repo | Role | When you reach for it |
|---|---|---|
| **`phip`** (this repo) | Normative specification, JSON schemas, test vectors, HTTP conformance suite | Reading the spec; checking your implementation passes the vectors |
| [**`phip-py`**](https://github.com/mfgs-us/phip-py) | Python client library | Embedding PhIP in a Python codebase |
| [**`phip-server`**](https://github.com/mfgs-us/phip-server) | Reference + production server (FastAPI, Postgres or SQLite, Docker) | Running an authority — your own or for a project |
| [**`phip-cli`**](https://github.com/mfgs-us/phip-cli) | `phip` command-line tool | Driving everything from the shell |

The whole stack is Python end-to-end. The CLI and the server both
use `phip-py` for crypto, canonicalization, and chain logic — one
source of truth for the protocol primitives.

## 3. The 15-minute end-to-end

This goes from zero to "logged a signed measurement on a real
server, verified the chain end-to-end, packed a portable bundle":

### Step 1 — Server (3 min)

```bash
git clone https://github.com/mfgs-us/phip-server
cd phip-server
PHIP_AUTHORITY=tutorial.local docker compose up -d
curl -sf http://localhost:8080/healthz
```

### Step 2 — CLI (2 min)

```bash
pip install git+https://github.com/mfgs-us/phip-cli
phip --version
phip init --remote http://localhost:8080 --authority tutorial.local
phip key register
phip config set default_namespace elements
```

### Step 3 — Real workflow (5 min)

```bash
phip object new component transducer-047 --state prototype \
    --notes "PVDF-TrFE batch C"

cat > /tmp/sweep.csv <<EOF
freq_hz,mag_db
1000,-1.2
2500,-0.1
4000,-1.8
EOF

phip log transducer-047 /tmp/sweep.csv \
    --metric freq_response --value 2500 --unit Hz \
    --rig bench-2 --notes "first sweep"

phip show transducer-047 --table
```

### Step 4 — Trust + publish (5 min)

```bash
# Re-walk the entire chain client-side, check every signature.
phip verify transducer-047

# Pack the full provenance into a portable, verifiable bundle.
phip bundle pack transducer-047 --out /tmp/transducer-047.phip-bundle
phip bundle verify /tmp/transducer-047.phip-bundle

# That bundle file is self-contained. It's the "publish on GitHub
# Pages so anyone can verify your provenance offline" artifact.
```

That's the full loop. You now have a working PhIP stack on your
laptop with one signed object and a verifiable history.

## 4. What just happened, conceptually

Each command you ran in step 3 corresponds to one or more spec
operations:

| What you typed | Spec section | What happened on the wire |
|---|---|---|
| `phip key register` | §12.1, §11.2.4 | POST a self-signed `created` event for your actor — required so the server can resolve your future signatures |
| `phip object new` | §12.1 | POST a signed `created` event with `object_type` + `state` in the payload |
| `phip log ... <file>` | §12.3, §11.4.2 | PUT the file as a content-addressed blob; GET the object's current head; POST a signed `measurement` event referencing the blob's content_hash |
| `phip show` | §12.2 | GET the object's current state + history tail |
| `phip verify` | §11.1, §11.2 | GET the full history; re-walk the hash chain locally; re-verify every signature against the resolved actor JWK |
| `phip bundle pack` | §4.3.4 | Fetch the chain, sign a manifest, pack into a tar — same structure any other PhIP implementation will accept |

## 5. The mental model

PhIP rests on three primitives, all in the spec under §10–§11:

1. **Canonical JSON (RFC 8785 JCS).** Every event is signed over its
   JCS-canonicalized bytes, so signatures are reproducible regardless
   of which language produced the JSON.

2. **Ed25519 signatures.** Each event carries
   `{algorithm: "Ed25519", key_id, value}`. The `key_id` is itself a
   `phip://` URI that resolves to an actor object whose payload
   embeds a JWK. That's why you needed `phip key register` — without
   the actor object, no one can verify your signatures.

3. **Hash-chained history.** Every event's `previous_hash` is
   `"sha256:"` followed by the hex SHA-256 of the JCS-canonicalized
   previous event (signature included) — i.e.
   `"sha256:" + hex(sha256(JCS(prev_event_with_signature)))`. The
   `sha256:` prefix labels the hex digest; it is not part of the
   hashed bytes. Walking the chain proves nothing has been silently
   edited.

Everything else — federation, capability tokens, lifecycle states,
typed attributes, bundles — is built on these three.

## 6. Where to go from here

Pick the tutorial that matches your role:

- **I want to integrate PhIP in Python** →
  [`phip-py` tutorial](https://github.com/mfgs-us/phip-py/blob/main/TUTORIAL.md)
- **I want to run a server** →
  [`phip-server` tutorial](https://github.com/mfgs-us/phip-server/blob/main/TUTORIAL.md)
- **I want to drive everything from a shell** →
  [`phip-cli` tutorial](https://github.com/mfgs-us/phip-cli/blob/main/TUTORIAL.md)
- **I want to write a new client / server / SDK** →
  Start with [`spec/phip-core.md`](./spec/phip-core.md), then use
  [`tests/vectors/`](./tests/vectors/) (byte-for-byte JCS,
  Ed25519, chain, lifecycle, tokens, bundle vectors) and
  [`tests/conformance/`](./tests/conformance/) (black-box HTTP
  conformance suite) to verify correctness.
- **I want to understand the trust model and liability framing** →
  [`spec/phip-core.md`](./spec/phip-core.md) §11 and
  [`LIABILITY.md`](./LIABILITY.md).

## 7. What PhIP intentionally leaves out

Things that surface during integration but PhIP doesn't try to
solve:

- **Physical-to-digital binding.** PhIP transports claims about an
  object; it doesn't prove the object in your hand is the object the
  claim describes. RFID, secure elements, tamper-evident packaging,
  and third-party physical attestation remain responsible for that.
- **Analysis.** PhIP gives you queryable, signed records.
  Statistics, plots, anomaly detection, dashboards — those are
  client-side concerns. Pipe `phip history --json` to whatever you
  already use.
- **Legal effect.** Signatures prove who said what when, not whether
  the claim is true or contractually binding. The PO / MSA / statute
  does the legal work. See [`LIABILITY.md`](./LIABILITY.md).
- **Real-time streaming.** PhIP is a request/response protocol. For
  high-rate telemetry, summarize then push a `measurement` event
  pointing at the raw data via `external_ref`.

## 8. Getting help

- **Spec questions / ambiguities** → file an issue here, prefix
  `spec:`.
- **Implementation bugs** → file against the relevant repo
  (`phip-py`, `phip-server`, `phip-cli`).
- **General "should I use PhIP for X?"** → read this tutorial again,
  then read [`LIABILITY.md`](./LIABILITY.md). If the answer still
  isn't obvious, the protocol probably isn't the right shape for X
  yet — open an issue describing the use case.

Have fun.
