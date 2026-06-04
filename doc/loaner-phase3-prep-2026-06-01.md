# Loaner Phase 3 — DMS + OEM Warranty Integration Prep

**Date:** 2026-06-01
**Status:** Prep only — implementation gated on Triangle's DMS + franchise brand
**Companion to:** `doc/loaner-reimagining-plan-2026-05-31.md`

Phases 1 & 2 are built (Command Center, in-bay wizards, DL barcode, signing, SMS reminders, customer portal). Phase 3 connects the loaner program to the dealer's DMS and the OEM warranty/courtesy programs. It can't be built on spec — the adapter and the warranty forms depend on what Triangle actually runs. This doc captures (1) exactly what to learn from Triangle, (2) how their answers pick the path, and (3) the integration skeleton so coding starts immediately once we know.

---

## 1. Triangle discovery questionnaire

Bring this to the conversation. The three starred items alone unblock the build.

### A. DMS (the critical path)
- ⭐ **Which DMS, and what version/edition?** (CDK Drive, Reynolds & Reynolds ERA, Dealertrack/Arkona, **Tekion**, Auto/Mate, DealerBuilt/LightYear)
- **Is API/integration access enabled on their contract?** Who's the DMS admin or account rep we'd coordinate with?
- **What do they want synced, and which direction?** Repair orders, customer records, vehicle inventory — one-way pull into RideFleet, or two-way?
- **RO structure:** how are repair-order numbers formatted, and is there a stable RO id we can key on to link a loaner to a repair?
- Do they already pay for / use any DMS integration middleware (e.g. a Fortellis app, an existing vendor pulling data)?

### B. Franchise brand + OEM program
- ⭐ **Which franchise brand(s), and how many rooftops?** (determines the courtesy program: GM, Ford/Lincoln, Toyota/Lexus, Stellantis, etc.)
- ⭐ **Which manufacturer courtesy/loaner program(s) do they bill?** (GM CTP, Ford/Lincoln FCTP/LCTP, Toyota, …)
- Do they submit warranty loaner reimbursement **today**, and how — manual, through the DMS, or an OEM portal?
- Can they share their current **OEM loaner agreement form(s)** (state-specific)? Get a sample PDF — we match it exactly.
- (Ford only) Do they in-fleet **new** units via the RDR process, with time/mileage caps to track?

### C. Operations & money
- What do they use for loaners today (TSD? Bluebird? spreadsheet?) and top 3 pain points.
- Loaner fleet size/mix; rough loaners-out per day; number of advisors who'll use it.
- Customer-pay loaner **rates**; how they bill **insurance** loaners.
- State(s) of operation (PR? form/tax compliance differs).
- Accounting system (QuickBooks / Sage / DMS-native) and how loaner charges post to the GL.
- SMS: do they have a sending number + customer-consent practice? (drives our Phase-2 SMS config per tenant)

---

## 2. Decision matrix — their answer → our path

| Triangle says… | We do… |
|---|---|
| **DMS = Tekion** | Build the Tekion adapter first. Modern REST API + partner program; lowest friction; matches our "cloud-native" positioning. |
| **DMS = CDK Drive** | CDK via Fortellis — requires partner app registration + fees + cert. Longer lead time; start the partner paperwork in parallel with coding the adapter against their sandbox. |
| **DMS = Reynolds** | Reynolds Certified Interface program. Known to be the highest-friction (Bluebird had trouble) — budget extra integration time; confirm Triangle can authorize the interface. |
| **DMS = Dealertrack / Auto/Mate / DealerBuilt** | Web-services adapter; generally lighter than CDK/Reynolds. Build after the first one ships. |
| **Brand = GM** | OEM path = **GM Courtesy Transportation Program (CTP)**. Best-documented; pre-approval dropped Oct 2024; eligibility = current/recent MY + segment match. We already stubbed these eligibility checks in the billing mockup. |
| **Brand = Ford/Lincoln** | OEM path = **FCTP/LCTP** — state-correct official forms + time/mileage in-fleeting flags + (later) FordPass telematics. |
| **Brand = Toyota / Stellantis / other** | Support via official-form printing + split billing + warranty report until we confirm that OEM's exact reimbursement rules from their dealer portal. |
| **No API access / not willing** | Fall back to CSV import/export bridge for RO + customer data, and manual warranty submission with our claim-packet generator. Still a big upgrade over their status quo. |

---

## 3. Integration architecture (stack-agnostic)

Keep the loaner module unchanged; add an integrations layer behind a stable interface so the concrete DMS/OEM specifics are swappable.

### 3.1 DMS adapter interface

One interface, one concrete adapter per DMS. The loaner module talks only to the interface.

```js
// backend/src/modules/integrations/dms/dms-adapter.js  (proposed)
//
// Every DMS adapter implements this shape. The loaner module calls these;
// it never knows which DMS is behind them.
export class DmsAdapter {
  // identity
  get name() { return 'abstract'; }            // 'tekion' | 'cdk' | 'reynolds' | ...

  // pull a repair order by number (to auto-fill loaner intake / link the loaner)
  async getRepairOrder({ tenantId, roNumber }) { /* -> { roNumber, status, openedAt, advisor, customer, serviceVehicle, warranty } */ }

  // pull / upsert customer (so DL scan + DMS data reconcile)
  async getCustomer({ tenantId, dmsCustomerId }) { /* -> { firstName, lastName, phone, email, address } */ }

  // optional: push loaner status back to the DMS RO (two-way)
  async pushLoanerStatus({ tenantId, roNumber, loaner }) { /* no-op if one-way */ }

  // health/auth check for the tenant's credentials
  async verifyConnection({ tenantId }) { /* -> { ok, message } */ }
}

// registry — resolves the right adapter from tenant settings
// backend/src/modules/integrations/dms/registry.js
//   getDmsAdapter(tenant) -> DmsAdapter   (reads tenant.settingsJson.dmsProvider)
//   credentials live in tenant settingsJson (mirrors the SMS config pattern)
```

Where it plugs in:
- **Check-out wizard Step 0:** "Pull from RO" button → `adapter.getRepairOrder` pre-fills customer + service vehicle (complements the DL barcode scan).
- **Loaner agreement create:** stash the `roNumber` link (already on the Reservation as `repairOrderNumber`).
- **Return / close:** optional `adapter.pushLoanerStatus` so the advisor sees loaner status on the RO.

### 3.2 OEM warranty / courtesy program

A second small interface for claim eligibility + packet generation, keyed by program.

```js
// backend/src/modules/integrations/oem/oem-program.js  (proposed)
export class OemProgram {
  get code() { return 'GM_CTP'; }              // 'GM_CTP' | 'FORD_FCTP' | ...
  // is this loaner eligible for reimbursement? (MY window, segment match, repair type)
  checkEligibility({ loanerVehicle, serviceVehicle, repairType, state }) { /* -> { eligible, reasons[] } */ }
  // produce the state-correct claim packet (PDF) + the report row for submission
  buildClaimPacket({ agreement, reservation }) { /* -> { pdfBuffer, formVersion, reimbursable } */ }
}
```

Schema fields to add when Phase 3 starts (additive, one migration):
`oemProgram`, `oemEligibilityFlag`, `oemFormVersion`, `oemClaimRef`, plus (Ford) `unitInServiceAt`, `unitMileageCap`.

### 3.3 Credentials & config
- DMS + OEM config lives per-tenant in `tenant.settingsJson` (same pattern as the SMS config we already use) — `dmsProvider`, `dmsCredentials`, `oemPrograms[]`.
- Never hard-code Triangle specifics; everything resolves from tenant settings so the next dealer is just config.

---

## 4. Task breakdown (once unblocked)

| # | Task | Depends on | Est. |
|---|------|-----------|------|
| 3-1 | DMS adapter interface + registry + tenant config UI | — | M |
| 3-2 | First concrete DMS adapter (Tekion / CDK / Reynolds per Triangle) | partner API access | L |
| 3-3 | "Pull from RO" in check-out wizard Step 0 | 3-1, 3-2 | S-M |
| 3-4 | OEM program interface + eligibility checks | brand confirmed | M |
| 3-5 | Claim-packet PDF (state-correct form) + warranty report | OEM form sample | M-L |
| 3-6 | Schema: oem + unit-in-fleet fields (1 migration) | 3-4 | S |
| 3-7 | QuickBooks export (replace raw CSV) | accounting answer | M |

**Sequencing:** 3-1 → 3-2 (the one DMS) → 3-3, in parallel start 3-4/3-6 once the brand is known, then 3-5 once we have the form sample. Don't start a second DMS until the first is in production with Triangle.

---

## 5. Pre-work to start now (no Triangle dependency)
- Begin **DMS partner registration** for the likely DMS as soon as Triangle names it — CDK Fortellis and Reynolds certification have lead times measured in weeks.
- Request the **OEM loaner agreement form sample** in the same conversation.
- Confirm Triangle can grant **API credentials / interface authorization** (often a separate dealer-principal sign-off).

---

## 6. What to send me after the Triangle call
Just three things unblock implementation: **(1) DMS + version, (2) franchise brand, (3) which OEM program they bill.** Paste those and I'll turn this skeleton into the concrete adapter + a scoped, sequenced build.
