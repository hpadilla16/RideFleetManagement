# Per-Vehicle Damage Baseline — design notes

Companion to `damage-baseline-mockup.html`. Design exploration only — no application code.
Extends the approved check-in audit design (`checkin-audit-mockup.html` +
`checkin-audit-NOTES.md`, branch `design/checkin-audit-mockups`, b7f562b0).
Visual family: same token block as `tolls-redesign-A.html` / `checkin-audit-mockup.html`.

## The owner's ask (translated)

> For damages: what can we do to create a BASELINE of a car, so it doesn't flag existing
> damage and wrongly charge it to the customer?

## What the audit already handles — and what it can't

The T2 photo audit compares checkout↔checkin pairs per angle. Damage visible in THIS
rental's checkout photo is by construction pre-existing for THIS rental — the pair model
covers that case for free. The baseline exists for everything the pair misses:

1. **Checkout photos that fail to capture existing damage** — angle, lighting, distance.
   A scuff invisible at checkout but visible at return gets flagged as "new" and billed
   to the wrong customer. This is the exact injustice the owner is asking about.
2. **Damage documented in a PREVIOUS rental but never repaired** — with only pair
   comparison it re-appears "new-ish" forever, one flag per rental, until someone fixes it.
3. **Audit flags dismissed as "pre-existing" have nowhere durable to go** — the prior
   design's dismiss button feeds a false-positive log, but "real damage, just old" is not
   a false positive; it's baseline knowledge being thrown away.
4. **Repaired damage must LEAVE the baseline** — or the car looks damaged forever and the
   next genuinely-new dent in the same spot gets excused.

---

## 1. The substrate — the ledger already exists (all cited)

The single most important research finding: **RFM already has a per-vehicle damage
ledger.** The design is not "invent a baseline store"; it is "promote the existing one to
be the audit's source of truth, give it the missing inflows/outflows, and show it to the
customer."

### `VehicleDamageReport` — the ledger table

- `backend/prisma/schema.prisma:5636-5712` — per-vehicle damage record: `vehicleId`,
  `phase` (CHECKOUT/CHECKIN), `view` (`VehicleView` FRONT/REAR/LEFT/RIGHT/INTERIOR,
  :5582-5588), **dot position `xPct`/`yPct` on the vehicle diagram** (:5666-5668),
  `description`, `photoJson` (standard photo envelope, :5670-5672), `status`, `source`
  (:5674-5675), `repairOrderId` (:5645-5647), `fixedAt`/`fixedByUserId`/`fixedPhotoJson`
  (:5697-5699).
- Status lifecycle is already baseline-shaped — `schema.prisma:5596-5601`:
  `REPORTED` (customer submitted, pending agent action) → `SOFT_APPROVED` ("acknowledged
  only — never hits the vehicle record") → `HARD_APPROVED` ("**on the vehicle's damage
  history until repaired**") → `FIXED` ("repaired (photo on file); off the diagram, kept
  in history"). **The open baseline = `status: HARD_APPROVED` for a vehicle. Nothing new
  to invent.**
- The vehicle profile already renders it: damage tab with per-view diagram dots, active
  vs fixed lists — `frontend/src/app/vehicles/[id]/page.js:313-316` ("Fase C (2026-06-11)
  — damage history (hard-approved customer reports)"), diagram components
  `frontend/src/components/vehicleDiagrams.js` (imported at `vehicles/[id]/page.js:10`,
  `diagramType` per vehicle :432).
- Staff can already append manually from the profile — "agent records an EXISTING damage
  from the vehicle profile (diagram dot + photo)":
  `POST /api/customer-inspections/vehicle/:vehicleId/manual-damage` —
  `backend/src/modules/customer-inspection/customer-inspection.routes.js:123-131`, service
  `customer-inspection.service.js:630-666` (validates view + 0..100 dot, **requires a
  photo**, creates `HARD_APPROVED` directly).
- Admin failsafe: edit/delete with audit log, delete voids any linked charge —
  `vehicles/[id]/page.js:441-463`.

### Repair orders — the natural "shrink" event, already wired

- `RepairOrder.damageReports` — "damages grouped into this RO; **FIXED on complete**" —
  `schema.prisma:1741`.
- `repair-orders.service.js:256-268` — `complete()` marks every grouped damage
  `FIXED` + `fixedAt` + `fixedByUserId` in the same transaction as the RO status flip.
- Manual per-damage fix (no RO): `fixDamageReport` — `customer-inspection.service.js:911-926`
  — HARD_APPROVED-only guard, **requires a repair photo**, sets FIXED.
- So "repaired damage leaves the baseline" is ALREADY TRUE for anything in the ledger.
  The gap was only that the audit didn't read the ledger.

### The photo timeline per vehicle — implicit but real

- Every checkout and check-in persists a `RentalAgreementInspection` row — `@@unique
  ([rentalAgreementId, phase])`, `photosJson` legacy + `photoStorageRefs` (Supabase
  Storage refs) — `schema.prisma:2901-2936`.
- `RentalAgreement.vehicleId` (`schema.prisma:2277-2278`) means *all inspections of a
  vehicle across all past reservations* is one join:
  `RentalAgreementInspection ⨝ RentalAgreement WHERE vehicleId = ?` ordered by
  `capturedAt` (indexed, :2935). Photos are keyed by the 8 canonical angle slots
  (`canonicalPhotoKey`, `backend/src/modules/rental-agreements/inspection-photos.js:344-355`;
  the 8 angles: `frontend/src/components/wizard/PhotoCapture.jsx:30-39`).
  **A per-angle photo history of every vehicle already exists in storage** — it just has
  no UI and no consumer beyond the single-rental pair.
- Free-form condition text also persists per inspection (`exterior`, `damages`, `notes` —
  `schema.prisma:2912-2919`) and is what the incident report today calls the pre-rental
  condition: `preRentalCondition: payload.preRentalCondition || checkoutInsp?.notes` —
  `backend/src/modules/incident-report/incident-report.service.js:168-180`, printed on the
  incident PDF (`incident-report-pdf.js:144`) and pushed into the demand-letter narrative
  ("Pre-rental condition on record: …", `incident-report.service.js:701-702`). Structured
  ledger entries make that line *evidence* instead of free text.

### The dismiss moment — where the fork goes

- The approved audit design has one dismiss verb: "Not damage — dismiss"
  (`design/mockups/checkin-audit-mockup.html:788-790`, copy key `action.dismiss` in
  `checkin-audit-NOTES.md`) feeding a false-positive log. That conflates two different
  truths: **"the AI saw a shadow" (model was wrong)** vs **"the AI saw real damage that
  is old" (model was RIGHT — the baseline was incomplete)**. Two verbs, two destinations:
  not-damage → false-positive log (model quality signal); pre-existing → **ledger append**
  (baseline grows, and this flag can never fire again).

### Customer-facing machinery already present

- `CustomerInspection` — per-reservation inspection link emailed to the customer
  (SENT → SUBMITTED → review), phase CHECKOUT/CHECKIN, producing `VehicleDamageReport`
  rows — `schema.prisma:5590-5633`; per-vehicle check-in QR fail-safe printed and left in
  the car — `customer-inspection.routes.js:133-141`.
- In-person damage acknowledgement signature (optional, snapshot wording) already on the
  ledger row: `customerAckSignatureDataUrl/SignerName/SignedAt/Ip/StatementText` —
  `schema.prisma:5681-5691`.
- Checkout wizard v2 step chain the disclosure card slots into: `TC_PENDING →
  PAYMENT_PENDING → INSPECTION_HANDOFF → INSPECTION_IN_PROGRESS → CUSTOMER_SIGN_PENDING →
  FINALIZING` — `frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js:180`.

---

## 2. Design decisions

### D1 — Representation: hybrid, ledger-as-truth, photos-as-evidence

Three candidates weighed:

| Model | What it is | Why not / why |
|---|---|---|
| **Latest-photos-as-truth** | Baseline = most recent checkout photo set per angle (what T2 implicitly uses today) | Zero new writes — but it's exactly the model that FAILS the four cases above: unexplainable ("the AI decided"), un-clearable (repair ≠ new photo), and inherits every capture defect. Also can't be shown to a customer as a list. |
| **Ledger-as-truth (pure)** | Structured entries only; photos ignored | Explainable and clearable, but an entry without photo evidence decays into an unfalsifiable claim ("trust us, that scuff was always there") — weak in a dispute. |
| **Hybrid (recommended)** | `VehicleDamageReport HARD_APPROVED` rows are the authoritative known-damage list; each entry carries photo refs (`photoJson` — already required by every append path); the per-angle photo timeline is the evidence archive behind it | Explainable (a customer/judge sees entry + dated photo), clearable (RO/fix paths already flip FIXED), auditable (source + reviewer on every entry), and it feeds the AI as structured context, not pixels. |

**Recommended entry shape** = the existing row + three additive nullable columns:

- `source` (exists, default `"CUSTOMER"`) gains values: `MANUAL` (profile), `ONBOARDING`
  (walk-around), `AUDIT_PREEXISTING` (dismiss fork), alongside customer-inspection and
  report-damage rows. Pure data — no migration beyond the string convention.
- `sourceAuditFindingId String?` — which audit flag birthed an AUDIT_PREEXISTING entry
  (traceability: "who decided this was old, from which photo pair").
- `lastVerifiedAt DateTime?` + `lastVerifiedPhotoRef Json?` — last time a human or the
  audit confirmed the mark is still visible (drives aging, D3).
- `clearedReason String?` — for the manual clear that is NOT a repair ("was dirt",
  "double entry") so FIXED isn't a lie; `fixDamageReport` keeps requiring a photo for
  real repairs.

### D2 — How the AI consumes it: prompt-context to see better, post-annotation to never lie

Two mechanisms, and the answer is **both, with different jobs**:

**(a) Prompt-context (primary).** For each angle pair, inject the open ledger entries for
that angle's `view` (angle→view map from the audit design: `rear`→REAR, `frontSeat`/
`rearSeat`/`dashboard`/`trunk`→INTERIOR) into the T2 prompt:

```
Known pre-existing damage on this vehicle, this view — do NOT report these:
- [KD-1] 15 cm scuff, lower-left rear bumper, on record since 2026-06-12 (scuff)
- [KD-2] door-edge chip, rear right, on record since 2026-04-03 (chip)
Report POSSIBLE_DAMAGE only for a mark visible in photo 2 that is neither in
photo 1 nor in the known list. If a mark matches a known entry, return
verdict "KNOWN_DAMAGE" with matchedKnownId.
```

Why primary: the model comparing pixels WITH the description genuinely disambiguates
"same scuff, different lighting" better than any geometric filter — it's the same reason
the check-in wizard shows the human the checkout photo beside the camera
(`PhotoCapture.jsx:47-55`). Failure mode: prompt adherence is probabilistic — the model
may over-anchor (excuse a NEW dent near a known scuff) or ignore the list. Mitigation:
verdict schema gains `KNOWN_DAMAGE + matchedKnownId`, so its reasoning is inspectable
per flag, and the known list is capped/short (open entries for one view — typically 0-3).

**(b) Post-filter (never suppresses — annotates and routes).** Deterministic layer after
the verdict: a POSSIBLE_DAMAGE whose region/kind plausibly overlaps a ledger dot for that
view is NOT dropped — it's downgraded into a "Matches baseline?" chip on the flag with
the candidate entry shown beside it, one-tap confirm. Why not hard suppression: the
region box is a pointer, not a measurement (prior design's own words), and dots are
diagram-relative while regions are photo-relative — geometric matching across those
spaces WILL false-suppress a new dent next to an old scuff, which is the one error worse
than a false flag (it silently eats real customer damage). The rule from the audit design
carries over: **the machine suggests, a human confirms, and nothing is ever silently
dropped** — "excused by baseline" flags land in a visible lane with a count, exactly like
Dismissed, so over-excusal is measurable per tenant.

### D3 — Lifecycle: born → grows → shrinks → ages

- **Born** — fleet onboarding walk-around (mock 4): guided 8-angle capture (reuse
  `PhotoCapture` slots) + per-angle "mark existing damage" (reuse the manual-damage dot +
  photo flow, `customer-inspection.service.js:630`). Writes `HARD_APPROVED` entries with
  `source: ONBOARDING` and stores the photo set as the vehicle's reference set. Also runs
  whenever a vehicle enters the fleet.
- **Grows** — three inflows, two of which already exist:
  1. Report Damage wizard → HARD_APPROVED (existing, `report-damage` module) — a billed
     damage IS baseline until repaired.
  2. Customer inspection approvals → HARD_APPROVED (existing).
  3. **NEW: the dismiss fork** — audit flag dismissed as "pre-existing" appends an entry
     with `source: AUDIT_PREEXISTING`, `sourceAuditFindingId`, the reviewer's user id,
     and the CHECKIN photo as evidence. Reviewer name displayed on the entry forever —
     accountability is the anti-abuse control (an agent can't quietly baseline-away real
     damage without signing it).
- **Shrinks** — RO completion flips grouped entries FIXED (existing,
  `repair-orders.service.js:256-268`); manual fix with repair photo (existing,
  `fixDamageReport`); NEW: clear-with-reason (no photo, `clearedReason` required, audit-
  logged) for not-actually-damage entries; admin delete stays the failsafe.
- **Ages** — an entry whose `lastVerifiedAt` (or `createdAt`) is older than N months
  (default 6, tenant-tunable) with no fresh photo evidence shows a "re-verify" chip on
  the profile and in the audit review pane. Verification is cheap: any check-in photo of
  that view where the mark is visible → one tap "still there" stamps `lastVerifiedAt` +
  ref. The T2 worker can pre-suggest it (KNOWN_DAMAGE verdicts with matchedKnownId are
  free verification events). Entries never auto-expire — aging only prompts a human.

### D4 — The customer-facing win: known-damage disclosure at checkout

Mock 3. In checkout wizard v2, the customer-facing inspection step
(`INSPECTION_HANDOFF/IN_PROGRESS`, before `CUSTOMER_SIGN_PENDING`) gains a **known-damage
disclosure card**: "This vehicle has 3 documented marks — you're not responsible for
them", with thumbnail + dot-on-diagram + date-on-record per entry, EN/ES. One tap
acknowledges (stored like the existing `customerAck*` snapshot pattern —
`schema.prisma:5681-5691`: wording snapshot, timestamp, IP); "See something we missed?
Add it" drops into the existing customer-inspection add-damage flow → `REPORTED` →
agent review → the customer's own find becomes baseline before they drive off.

What it changes:
- **Disputes**: today's demand letter cites free-text `preRentalCondition`
  (`incident-report.service.js:701-702`). After this, the incident PDF can print "at
  checkout the renter was shown and acknowledged N pre-existing marks (list, photos,
  dates); the billed damage is not among them" — the strongest possible answer to
  "that dent was already there."
- **Trust at the counter**: the disclosure reads as consumer-protective ("you're NOT
  responsible") while doing the company's evidentiary work. It's the same move as the
  wizard's side-by-side compare photos, pointed at the customer.
- **Data quality**: customers become a free verification source — every acknowledgement
  is a `lastVerifiedAt` event for the entries shown.

### D5 — Cold start: seed from history, verify on the next return

IRC, ~100 cars, day 1. Two paths, mock 4 shows both:

- **Path A — full walk-around**: 8 angles + annotation ≈ 5-7 min/vehicle ≈ 2 staff-days
  for 100 cars. Highest-quality reference set; unrealistic to demand before enabling
  anything.
- **Path B — seed from what exists (recommended default)**, zero photography:
  1. Open `HARD_APPROVED` rows — already baseline, nothing to do.
  2. Most recent CHECKOUT `RentalAgreementInspection` per vehicle → its
     `photoStorageRefs` become the provisional reference photo set per angle (query in
     §1; it's the newest photo of every angle the system owns).
  3. Open DAMAGE incidents / inspection `damages` free text → a triage list of
     "probable entries" a staffer converts to dots in minutes per vehicle, from a desk.
  Every vehicle starts at coverage "Seeded"; the first post-launch check-in's photos +
  audit run upgrade it to "Verified" (agent confirms/annotates while the audit's
  KNOWN_DAMAGE matches auto-stamp `lastVerifiedAt`). Cars the audit flags in month 1 get
  a real walk-around; the rest converge organically as the fleet turns over.
- The mock's fleet coverage bar (Verified / Seeded / No baseline) gives ops one number to
  drive to 100% — same mechanic as the audit queue lanes.

---

## 3. EN/ES copy (key strings)

| Key | EN | ES |
|---|---|---|
| ledger.title | Damage baseline | Historial base de daños |
| ledger.sub | Documented marks on this vehicle. The check-in audit never flags these. | Marcas documentadas de este vehículo. La auditoría de check-in nunca las señala. |
| ledger.open | On record | Registradas |
| ledger.fixed | Repaired | Reparadas |
| ledger.entry.since | On record since {date} | Registrada desde {date} |
| ledger.entry.verified | Last seen {date} | Vista por última vez {date} |
| ledger.entry.reverify | Re-verify — not seen in {n} months | Re-verificar — sin evidencia hace {n} meses |
| ledger.source.onboarding | Onboarding walk-around | Recorrido de alta |
| ledger.source.audit | Check-in audit · marked pre-existing by {user} | Auditoría de check-in · marcada como preexistente por {user} |
| ledger.source.report | Damage report · {res} | Reporte de daño · {res} |
| ledger.source.customer | Customer inspection | Inspección del cliente |
| ledger.clearedBy | Repaired · RO {ro} | Reparado · orden {ro} |
| ledger.clearReason | Cleared: {reason} | Eliminada: {reason} |
| dismiss.title | Dismiss this flag | Descartar esta alerta |
| dismiss.q | What is it? | ¿Qué es? |
| dismiss.notDamage | Not damage — glare, dirt or shadow | No es daño — reflejo, suciedad o sombra |
| dismiss.notDamage.sub | Logged to improve the AI. Nothing else happens. | Se registra para mejorar la IA. No pasa nada más. |
| dismiss.preexisting | Real damage — but pre-existing | Daño real — pero preexistente |
| dismiss.preexisting.sub | Adds it to this vehicle's baseline so it is never flagged again — and never charged to a customer. | Se agrega al historial base del vehículo para que no se señale otra vez — y nunca se cobre a un cliente. |
| dismiss.preexisting.confirm | Add to baseline | Agregar al historial base |
| dismiss.signed | Recorded by {user} | Registrado por {user} |
| flag.matchesBaseline | Matches known damage? | ¿Coincide con daño registrado? |
| flag.knownExcused | Matches baseline — not flagged | Coincide con el historial — no se señala |
| checkout.known.title | Documented marks on this vehicle | Marcas documentadas de este vehículo |
| checkout.known.sub | This car has {n} marks on record. You are not responsible for them. | Este auto tiene {n} marcas registradas. Usted no es responsable de ellas. |
| checkout.known.ack | I've seen the documented marks | Vi las marcas documentadas |
| checkout.known.add | See something we missed? Add it | ¿Ve algo que no registramos? Agréguelo |
| checkout.known.none | No damage on record for this vehicle | Este vehículo no tiene daños registrados |
| onboard.title | Baseline walk-around | Recorrido base |
| onboard.step | Angle {i} of 8 | Ángulo {i} de 8 |
| onboard.mark | Mark existing damage on this angle | Marque daños existentes en este ángulo |
| onboard.done | Baseline created · {n} marks documented | Historial base creado · {n} marcas documentadas |
| seed.title | Seed from history | Sembrar desde el historial |
| seed.sub | Uses each vehicle's latest checkout photos and open damage records. Verified at its next return. | Usa las últimas fotos de salida y los daños abiertos de cada vehículo. Se verifica en su próximo regreso. |
| coverage.verified | Verified | Verificado |
| coverage.seeded | Seeded | Sembrado |
| coverage.none | No baseline | Sin historial base |

(i18n via the existing namespace files; remember the namespace-merge gotcha — new
namespaces must be merged into every locale.)

---

## 4. What's NEW backend (small, additive)

1. **Schema**: 4 nullable columns on `VehicleDamageReport` (`sourceAuditFindingId`,
   `lastVerifiedAt`, `lastVerifiedPhotoRef`, `clearedReason`) + `source` string
   conventions (`ONBOARDING`, `AUDIT_PREEXISTING`, `MANUAL`). No new tables.
2. **Dismiss fork endpoint**: audit dismiss gains `classification: NOT_DAMAGE |
   PREEXISTING`; PREEXISTING path calls the existing manual-damage create internally
   (view from the flagged angle, dot defaulted to region center → agent adjusts,
   CHECKIN photo attached, reviewer stamped).
3. **T2 prompt injection + verdict schema**: known-entries lookup per (vehicleId, view),
   `KNOWN_DAMAGE`/`matchedKnownId` verdict; matches stamp `lastVerifiedAt`.
4. **Checkout disclosure read + ack write**: open-entries read already exists for the
   profile; ack is a small snapshot row following the `customerAck*` pattern.
5. **Clear-with-reason** mutation (audit-logged) beside the existing `fixDamageReport`.
6. **Onboarding walk-around screen** (frontend) + **seed job** (one script over
   inspections, D5) — the only genuinely new surface, composed of two existing pieces
   (`PhotoCapture` + manual-damage).

Explicitly NOT new: the ledger table, the profile diagram UI, RO→FIXED wiring, the
photo archive, the customer inspection flow, the ack signature pattern.

---

## 5. Recommendation

**Smallest shippable slice — "the dismiss fork + prompt context" (one short release):**
add the two-verb dismiss to the audit review pane, write PREEXISTING dismissals into the
existing ledger, and inject open entries into the T2 prompt. That alone breaks the
"flagged every rental forever" loop and starts growing the baseline from real review
work, with ~2 columns and ~3 endpoints touched. Then, in order: checkout disclosure card
(the customer-trust win, mostly frontend), seed-from-history job (cold start), onboarding
walk-around screen, aging/re-verify chips.

**What not to build**: auto-suppression of flags by geometric matching (silently eats
real damage — D2), auto-expiry of baseline entries (aging prompts, never deletes), or a
separate baseline table (the ledger exists; a second source of truth is how "wrongly
charged" happens).
