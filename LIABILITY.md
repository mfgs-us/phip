# Liability framing

> This document is not legal advice. It describes how PhIP is designed
> to interact with the legal layer that surrounds any commercial
> exchange of physical objects, so that adopters and their counsel can
> form their own view. Implementations and adopters are responsible for
> their own legal review.

## TL;DR

PhIP claims are **advisory metadata layered over existing contracts,
not legally constitutive instruments**. The purchase order, master
service agreement, regulatory filing, or statutory record continues to
do the legal work. PhIP makes the data attached to that legal work
verifiable and machine-readable. Adopting PhIP does not create new
evidentiary obligations beyond what the underlying transaction already
generates.

## What a PhIP signature attests to, and what it does not

A PhIP event signature proves three things, and only three things:

1. The named actor's key was used to sign this exact byte sequence.
2. The signed payload was not modified after signing.
3. The signed payload links into the named object's history at the
   stated `previous_hash`.

A PhIP signature does **not** attest to:

- The truth of any factual claim inside the payload. "Lot passed
  inspection" being signed does not make the lot good. Signing
  proves *who said it*, not *whether it is so*.
- The authority of the signer to bind their organization. That comes
  from the same agency, employment, or corporate-officer
  relationships that govern any other electronic communication
  (email, EDI message, signed PDF).
- The legal effect of the claim. Whether a signed claim becomes a
  warranty, a representation, an acknowledgement, a delivery
  notice, or hearsay is determined by the contract and the law of
  the relevant jurisdiction, not by the PhIP layer.

In legal terms: PhIP is closer to **signed email + a structured
attachment** than to a contract, certificate of conformance, or
statutory record. The signature gives integrity and authenticity; the
legal weight comes from the surrounding transaction.

## The legal stack PhIP fits into

PhIP is designed to sit beneath the contract layer, not replace it:

```
┌──────────────────────────────────────────────┐
│  Statute / Regulation                        │  e.g. UCC, DPP,
│                                              │  AS9100, IATF 16949,
│                                              │  UDI, ITAR/EAR
├──────────────────────────────────────────────┤
│  Contract                                    │  PO, MSA, NDA,
│                                              │  Quality Agreement,
│                                              │  Terms & Conditions
├──────────────────────────────────────────────┤
│  PhIP claims (signed attestations)           │  ← PhIP lives here
├──────────────────────────────────────────────┤
│  Underlying records (PDFs, scans, photos,    │
│  test data, ERP rows)                        │
└──────────────────────────────────────────────┘
```

A signed PhIP claim about an inspection result is the same kind of
representation as the inspection PDF it replaces or accompanies — but
machine-readable and integrity-checkable. The contract above it
already determines whether that representation is a warranty, a
condition of acceptance, an acknowledgement, or simply attached
documentation. Adopting PhIP does not change that determination.

## Common concerns, addressed directly

### "Are we creating an indelible record that can be used against us in litigation?"

PhIP does not create discoverable material that did not already
exist. A signed claim that "lot 47 passed dimensional inspection on
2026-05-10" is exactly as discoverable as the PDF inspection report,
the email forwarding it, and the ERP row it would otherwise be
recorded in. PhIP changes the *form* of the record (verifiable,
structured), not the *existence* of the record.

The hash-chain history is append-only at the protocol level, but PhIP
explicitly supports:

- **Correction events** — a later signed event in the same chain that
  revises, supersedes, or retracts an earlier claim. The original
  remains in history (because that is what makes the record
  trustworthy), but the current state reflects the correction.
- **Lifecycle transitions** that cleanly mark objects as
  decommissioned, disposed, or archived.
- **Mirror snapshots** for offline retention; PhIP does not require
  data to live in any specific party's infrastructure.

Indelibility is a property of the chain, not a legal commitment. The
underlying business records have whatever retention obligations the
governing law assigns, independent of PhIP.

### "Is signing a PhIP claim non-repudiation?"

In a cryptographic sense, yes: a valid signature is strong evidence
that the holder of the private key produced the signed bytes. In a
legal sense, "non-repudiation" is a contractual or statutory concept
that varies by jurisdiction and by the contract. ESIGN, eIDAS, the UCC,
and equivalent regimes elsewhere already address when an electronic
signature binds a party. PhIP signatures inherit whatever treatment
those regimes give to other electronic signatures of comparable
strength.

A PhIP signature is **not** designed to be a qualified electronic
signature under eIDAS, a notarized instrument, or a substitute for a
wet signature where one is statutorily required.

### "What if our key is compromised?"

PhIP defines key validity windows (`not_before` / `not_after`) and
supports key rotation. A compromised key is revoked by publishing a
new key with non-overlapping validity, and any new claims signed by
the compromised key after revocation can be rejected by verifiers. The
contractual framework continues to govern liability for claims signed
under a compromised key, just as it does for compromised email
accounts or stolen letterheads today.

### "Does PhIP impose recordkeeping obligations?"

No. PhIP is a transport and verification layer. Whether a record must
be kept, for how long, in what jurisdiction, and under what access
rules is determined by the law and contracts that already apply to
the transaction. PhIP can be the *form* the record takes (and can
make compliance easier by making records machine-readable and
integrity-checkable), but it does not add or remove any obligation.

### "What about cross-border transfers, export control, or privacy law?"

PhIP claims that traverse borders are subject to the same export,
data-protection, and disclosure regimes as any other cross-border
business communication. Sensitive technical data (ITAR/EAR-controlled
specifications, personal data under GDPR, health data, etc.) should
not be embedded in PhIP claims unless the surrounding legal framework
permits it; PhIP's selective-disclosure facilities (capability tokens,
opaque references) are designed to let parties hold sensitive data
behind authorization rather than embed it in widely-distributed
claims.

## What PhIP intentionally does **not** do

- **Constitute the contract.** The PO, MSA, quality agreement, and
  applicable statutes do that.
- **Replace certifications of conformance.** A PhIP claim can carry a
  CoC's content and its issuer's signature, but the certification's
  legal validity flows from the certifying body's accreditation and
  the regulatory regime, not from PhIP.
- **Bind a party who has not signed.** PhIP signatures are
  pull-only — only events signed by an actor speak for that actor.
- **Provide qualified or notarized electronic signatures.** PhIP
  produces ordinary electronic signatures of high cryptographic
  strength. Where a higher tier is required (eIDAS QES, notarization,
  wet signature), it must be obtained separately.
- **Attest to physical-to-digital binding.** PhIP transports claims
  about an object; it does not, by itself, prove that the object in
  someone's hand is the object the claim describes. RFID, secure
  elements, surface fingerprinting, tamper-evident packaging, and
  third-party physical attestation continue to be the mechanisms
  responsible for that binding.

## For implementations

Implementations of PhIP servers and client libraries should:

- Surface the legal framing prominently in their own documentation,
  cross-linking to this document.
- Expose key validity windows and revocation in a way that operators
  can audit and counsel can understand.
- Avoid framing language that implies legal effect beyond what the
  cryptographic primitives provide. "Verified", "signed", and
  "integrity-checked" are accurate; "notarized", "legally binding",
  and "authoritative" are not.

## For adopters

Before deploying PhIP for any commercial exchange, in-house or
external counsel should review:

- The contractual framework that will sit above the PhIP layer (PO
  terms, MSA, quality agreement, NDA).
- The signing-authority model: which keys speak for which legal
  entities, who controls them, and how revocation is handled.
- Retention and disclosure obligations for the underlying records,
  independent of PhIP.
- Jurisdiction-specific treatment of electronic signatures and
  electronic records (ESIGN, eIDAS, UNCITRAL Model Law, local
  equivalents).

PhIP is designed to slot into existing legal structures, not to
require new ones. If a particular adoption requires a new legal
structure, that is a signal that PhIP is being asked to do work it
was not designed for.

## Disclaimer

This document is provided for informational purposes only. It is not
legal advice and does not create an attorney-client relationship.
Laws and regulations vary by jurisdiction and change over time;
adopters and implementations are responsible for obtaining their own
legal review.
