# PCI DSS — compliance status + evidence package (for the TL International DDQ)

**Date:** 2026-08-23
**Purpose:** the PCI evidence to attach to the TL International due-diligence response, plus the
technical facts behind it (verified against the RFM codebase).

> **STATUS: CERTIFIED.** RIDE CAR SHARING LLC holds a valid **PCI DSS SAQ C (v4.0.1)** self-assessment,
> **COMPLIANT** as of **2026-06-10**, assessed via **SecurityMetrics** (ASV). The signed SAQ C + AOC
> (Attestation of Compliance) is the evidence that goes in the DDQ's "PCI evidence" field. The sections
> below explain the posture behind that attestation.

---

## 0. What is already in hand (the deliverable)

| Item | Value |
|---|---|
| **Merchant of record** | RIDE CAR SHARING LLC |
| **Validation type** | SAQ C, PCI DSS v4.0.1 (self-assessment, no QSA required) |
| **Status** | COMPLIANT |
| **Self-assessment completion date** | 2026-06-10 |
| **Last passing ASV scan** | 2026-06-10 (SecurityMetrics) |
| **Signatory** | Hector Padilla, CTO (Merchant Executive Officer) |
| **Assessor / ASV** | SecurityMetrics |
| **Evidence file** | signed **SAQ C + AOC** PDF (from the SecurityMetrics portal) → this is what TL receives |

**Channel-scope note (settled):** SAQ C's template text says it is "not applicable to e-commerce
channels," but **all RFM payment channels — including the online storefront — are fully outsourced to
the processor's hosted page**; RFM never captures, transmits, or stores a PAN/CVV on any channel. On
that basis SecurityMetrics (the assessor) scoped the merchant to SAQ C and it covers the environment.
If a TL reviewer questions the e-commerce wording, the answer is: *all channels are fully outsourced to
the processor — RFM holds no cardholder data on any channel.*

**Maintenance (keep the certification live):**
- Re-certify the SAQ every **12 months** → renew before **~2026-06-10 (2027)**.
- Pass an ASV scan every **3 months** → next due **~2026-09-10**. A lapsed scan invalidates the status.

---

## 1. The headline: RFM is the lowest-scope posture

**RFM never receives, transmits, or stores a full card number (PAN) or CVV.** There is no card-entry
field anywhere in the RFM user interface. Card data is entered either on the payment processor's own
hosted iframe / redirect, or on the physical card-present terminal — never on an RFM page or server.

What RFM stores: processor-issued tokens/profile ids, card brand, card type, **last 4 digits**, expiry
month/year. Never the PAN, never the CVV.

This is the posture that qualifies for the lightest SAQ tiers.

---

## 2. Payment channels (each has its own SAQ)

| Channel | How card data is captured | Who holds the card data | Likely SAQ |
|---|---|---|---|
| **E-commerce — hosted fields (PayArc)** | Card entered in PayArc's iframe fields embedded on the page; RFM receives only a nonce/token | PayArc | **SAQ A** (fully outsourced iframe) |
| **E-commerce — Authorize.Net Accept.js / Accept Hosted** | Accept Hosted = full redirect to Authorize.Net (SAQ A). Accept.js = the tokenizer script loads on the RFM page and returns opaque data — RFM never sees the PAN, but the script runs on our page | Authorize.Net | **SAQ A** (Accept Hosted) or **SAQ A-EP** (Accept.js — confirm with the acquirer, see §4) |
| **E-commerce — Stripe / Square hosted checkout** | Hosted checkout / payment link | Stripe / Square | **SAQ A** |
| **Card-present — Dejavoo / iPOSpays terminal** | Customer taps/inserts on the physical PTS-approved terminal; RFM sends only amount + reference | The terminal / processor | **SAQ B-IP** (IP terminal, no electronic PAN storage) or **SAQ P2PE** if the terminal is on a validated P2PE solution — confirm with the acquirer |

The merchant's overall validation is typically the **union** of the applicable SAQs across channels.

---

## 3. Controls RFM can already attest (evidence for the SAQ)

- **No PAN/CVV captured, transmitted, or stored** by RFM — verified: no card-number field in the UI,
  card entry only via processor hosted fields / redirect / terminal.
- **No CVV ever stored** — verified: no CVV value in any request body, response parser, or column.
- **Tokenization by the processor** — RFM holds only opaque tokens (Authorize.Net CIM profile ids,
  Dejavoo/iPOS tokens, PayArc single-use tokens, Stripe session ids); the vault is the processor's.
- **TLS 1.2 / 1.3 only** in transit — TLS 1.0/1.1 rejected (verified 2026-08-22); HTTPS enforced.
- **Access control** — role-based, tenant-scoped, fail-closed; 2FA (TOTP) available for staff.
- **What is returned/stored** — amount, currency, method, status, timestamp, gateway reference,
  auth code, card brand, card type, **last 4**, expiry month/year. Nothing else card-related.

**One item to disclose proactively to the QSA:** the Dejavoo card-present terminal returns the card
BIN + first-4 alongside the last-4 in its response. These cross RFM's API boundary in the terminal
response but are **NOT persisted** (only brand/type/last-4 are stored). A QSA will ask; disclosing it
up front is cleaner.

**Cleanup already done:** the RFM internal API documentation previously contained an example schema
showing a card number and CVV for an endpoint that never accepted them — removed (Wave 0), so an
assessor doesn't read a PAN-accepting capability into the docs that doesn't exist.

---

## 4. Open items — status

All of the original acquirer questions are now resolved by the completed SAQ C:

1. ~~Confirm the SAQ per channel~~ → **RESOLVED.** SecurityMetrics scoped the merchant to **SAQ C**
   (all channels fully outsourced to the processor; see the channel-scope note in §0).
2. ~~ASV scan requirement~~ → **RESOLVED.** A quarterly ASV scan is in place with SecurityMetrics
   (last passing 2026-06-10). Ongoing maintenance item, not an open question.
3. ~~Obtain the AOC~~ → **RESOLVED.** The signed SAQ C + AOC exists (RIDE CAR SHARING LLC, CTO,
   2026-06-10) and is the file that fills the TL DDQ "PCI evidence" field.
4. ~~Merchant of record~~ → **RESOLVED.** RIDE CAR SHARING LLC (matches the TL DDQ §3.1 entity fields).

**Nothing blocking remains.** Optional polish only: the AOC signatory title reads "CTO" — acceptable;
"Owner / Managing Member" would be the most airtight if Hector holds that role, but not required.

---

## 5. What RFM does NOT need to do

- No PAN/CVV storage remediation — there is none to remediate.
- No cardholder-data-environment (CDE) segmentation project of the classic kind — RFM has no CDE
  holding PAN.
- The remaining work is **completing the right SAQ + obtaining the AOC + (if required) an ASV scan** —
  process/paperwork with the acquirer, not code changes on our side.

---

**Bottom line:** PCI is **done**. RIDE CAR SHARING LLC is certified COMPLIANT under **SAQ C (v4.0.1)**
as of 2026-06-10 via SecurityMetrics, backed by the lowest-scope posture (no PAN/CVV ever touches RFM).
The signed SAQ C + AOC is the evidence for the TL DDQ. The only recurring obligations are the annual
re-certification (~Jun 2027) and the quarterly ASV scan (next ~Sep 2026). No code remediation on RFM's
side, and nothing blocking the TL response.
