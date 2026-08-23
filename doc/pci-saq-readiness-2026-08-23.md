# PCI DSS — SAQ readiness package (to take to the acquirer)

**Date:** 2026-08-23
**Purpose:** what to hand the acquirer / QSA to determine and complete the right Self-Assessment
Questionnaire (SAQ). Everything technical below was verified against the RFM codebase.

> This is preparation material, not a PCI attestation. The **acquirer (merchant bank) and/or a QSA
> determine which SAQ applies**; this document gives them the facts they need and states what RFM can
> already attest.

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

## 4. What to ask / obtain from the acquirer (the open items)

1. **Confirm the SAQ per channel** — specifically:
   - Is the Authorize.Net integration **Accept Hosted (redirect → SAQ A)** or **Accept.js (script on
     our page → possibly SAQ A-EP)**? This is the one nuance that can push e-commerce from A to A-EP.
   - For the **Dejavoo terminal**: is it on a **validated P2PE** solution (→ SAQ P2PE) or a standard
     IP-connected terminal (→ SAQ B-IP)?
2. **ASV scan requirement** — under PCI DSS 4.0, some SAQ A merchants now need a **quarterly external
   vulnerability scan by an Approved Scanning Vendor**. Ask whether it applies to our channels; if so,
   it is an inexpensive ASV service.
3. **The merchant Attestation of Compliance (AOC)** — the acquirer's template and where to submit.
   (This is the "PCI evidence" field left blank in the TL due-diligence response.)
4. **Merchant of record** — confirm which legal entity is the merchant of record for each processor,
   since the SAQ/AOC is filed under it. (Ties to the entity fields in the TL DDQ §3.1.)

---

## 5. What RFM does NOT need to do

- No PAN/CVV storage remediation — there is none to remediate.
- No cardholder-data-environment (CDE) segmentation project of the classic kind — RFM has no CDE
  holding PAN.
- The remaining work is **completing the right SAQ + obtaining the AOC + (if required) an ASV scan** —
  process/paperwork with the acquirer, not code changes on our side.

---

**Bottom line:** RFM is already at the lowest-scope PCI posture (no PAN/CVV). The path to "PCI compliant"
is: acquirer confirms the per-channel SAQ (watch the Accept.js A-vs-A-EP and terminal B-IP-vs-P2PE
nuances), we complete the SAQ using the attested controls in §3, obtain the AOC, and run a quarterly
ASV scan if the SAQ requires it. No code remediation remains on RFM's side.
