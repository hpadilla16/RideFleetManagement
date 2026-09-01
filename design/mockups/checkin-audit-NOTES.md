# Post-Check-in AI Audit — design notes

Companion to `checkin-audit-mockup.html`. Design exploration only — no application code.
Visual family: same token block as `tolls-redesign-A.html` (flat, #8752FE, tabular-nums,
compact staff density), so the three modules read as one product.

## The owner's ask (translated)

> After a check-in completes, AI reviews: (a) the photos for anomalies vs check-out — possible
> damage; (b) audit mileage usage and gas usage; (c) make sure the agent's entries are in order.
> If it detects possible damage, notify; if it detects an entry error, notify. I want to see how
> it shows possible damage and how that converts DIRECTLY into a damage report from there.

The mockup answers all four: a review queue (mock 1), the photo-pair flag with the suspected
region (mock 2 left), the mileage/fuel/entry audit cards (mock 2 right), the one-click
"Create damage report" handoff pre-filled with the evidence (mock 2 right), and the
notification surface (mock 3).

---

## 1. The substrate this sits on (all real, all cited)

### Photos — the pairs already exist

- **8 standard angles per inspection**, keys `front`, `rear`, `left`, `right`, `frontSeat`,
  `rearSeat`, `dashboard`, `trunk` — `frontend/src/components/wizard/PhotoCapture.jsx:30-39`.
- **The check-in wizard already shows the checkout baseline beside the live camera** — the
  `comparePhoto`/`comparePhotos` props, added per Hector 2026-08-14 so "a scratch that wasn't
  there gets noticed while the customer is still standing there" —
  `PhotoCapture.jsx:47-55`. The audit is the safety net for when the human misses it.
- **Storage**: inspection photos live in Supabase Storage (bucket `inspection-photos`), slim
  `photoStorageRefs` rows, signed-URL read path — `backend/src/modules/rental-agreements/inspection-photos.js:1-17`
  (flagged via `INSPECTION_PHOTOS_STORAGE_ENABLED`, :90-92; bucket :94-96; signed URLs
  `materializeStorageRefs` :422-454). The audit worker downloads bytes the same way the
  citation OCR worker does (`downloadObject`).
- **Photos are keyed by angle slot** (`canonicalPhotoKey`), so pairing checkout↔checkin by
  angle is a dictionary join, not a matching problem — `inspection-photos.js:344-355`.
- **Humans compare pairs manually today**: the damage-dispute KB article instructs
  "Review checkout and checkin inspection photos side by side" / "Pon las fotos del check-out
  y las del check-in una al lado de la otra" —
  `backend/src/modules/knowledge-base/default-articles.js:148,164`.
- Prior art in-repo: the Pillar-2 wizard mockup already names "AI-validated damage detection"
  as Phase 2 — `design/mockups/pillar2-checkin-checkout/index.html:1509`.

### The AI precedent — citation OCR (follow it exactly)

- **Anthropic vision is already integrated**: `backend/src/modules/citations/citation-ocr.extract.js`
  — raw `fetch` to `https://api.anthropic.com/v1/messages` (:20, :88-113), image/PDF content
  blocks (:42-50), strict JSON-only prompt with confidence (:22-40), default model
  `claude-haiku-4-5-20251001` (:19), loose-JSON parse + normalize (:52-86). The extractor is
  deliberately credential-agnostic: "The CALLER supplies the credential" (:115-120).
- **The async worker pattern**: `citation-ocr.scheduler.js` — interval worker, atomic
  PENDING→EXTRACTING claim (:39-45), batch cap, confidence threshold env
  (`CITATION_OCR_CONFIDENCE_MIN`, :27), "PII: never logs OCR JSON — counts/ids only" (:15).
- **The credential rule (non-negotiable)**: `backend/src/lib/tenant-provider-credential.js:14-49`
  documents the 2026-08-27 incident — Corpusa's citations reached api.anthropic.com under the
  PLATFORM key because of a `cfg.apiKey || process.env.ANTHROPIC_API_KEY` fallback; it surfaced
  during UK GDPR due diligence. The rule now: **a tenant that has configured nothing makes NO
  external call**; platform key only via explicit per-tenant-per-feature opt-in
  (`allowPlatformKeyFallback`) or a deploy-reviewable env allowlist. Resolution is logged
  loudly, per tenant and feature.
- **The one credential read**: `settings.service.js:1121-1136` — `resolveCitationOcrCredential()`
  is "the ONE credential read for every Anthropic-backed, tenant-scoped feature that shares the
  citationOcrConfig block: citation mail OCR, kiosk ID photo…" — the check-in audit becomes the
  next caller with `feature: 'checkin-audit'`. Keys are encrypted at rest and masked in the UI
  (`getCitationOcrConfig`, :1050-1068).
- **Compliance history**: OCR/AI is per-tenant precisely because one tenant (TL, UK DPA) needed
  it governed; the audit must be tenant-flag + tenant-key from day one, not retrofitted.

### Mileage & fuel — what's already captured

- **Check-in close persists** `odometerIn`, `fuelIn` (0..1), `cleanlinessIn`, `smokingDetected`,
  `returnedAt`, then runs the fee engine — `backend/src/modules/rental-agreements/checkin-close.service.js:1-27`
  (payload shape :76-86). Checkout captured `odometerOut` / `fuelOut` on the agreement.
- **Fee engine** computes EXCESS_MILEAGE / FUEL_REFILL / CLEANING_* / SMOKING / LATE_RETURN from
  the same deltas — `backend/src/modules/fees/fee-engine.service.js:21-31` (usage), :43-52
  (rates). Vehicle-level history: `recordMileageEntrySafe` / `recordFuelReadingSafe`
  (`checkin-close.service.js:34-35`).
- **The wizard blocks the impossible case in its own UI** (`odometerIn >= odometerOut`,
  `frontend/src/app/reservations/[id]/checkin-wizard/page.js:354`) and hints on fuel deltas
  (:738) — but nothing audits after the fact, and manual/legacy close paths
  (`closeAgreement`) have no such guard. That gap is the entry-error tier.

### The damage-report flow the audit hands into

- **POST `/api/report-damage/:reservationId/report-damage`** — AGENT/OPS/ADMIN/SUPER_ADMIN,
  idempotent — `backend/src/modules/report-damage/report-damage.routes.js:58-71`.
- The orchestrator stitches: HARD_APPROVED VehicleDamageReport → DAMAGE_CHARGE on the contract →
  vehicle status → auto-created DRAFT DAMAGE incident with photos attached as evidence —
  `report-damage.service.js:1-27`. Inputs it needs: `responsibleParty`, `vehicleStatus`,
  `damagePhotos` (≥1 required, :105-107), `damageCostCents`/`ourDeductibleCents`, `description`,
  view label (FRONT/REAR/LEFT/RIGHT/INTERIOR, :39). $10k ceiling + 60s duplicate guard (:41-53).
- Incident create: `incident-report/incident-report.service.js:147`.

**Handoff = prefill, not a new flow.** The audit's "Create damage report" button opens the
existing Report Damage wizard with: `damagePhotos` = the checkout+checkin pair (already
signed URLs / re-uploaded as evidence), view mapped from the flagged angle
(`rear` → `REAR`; interior angles → `INTERIOR`), `description` prefilled from the model
verdict and editable, estimate/who-pays left for the agent. The wizard's own validation,
ceiling, acknowledgement, idempotency all apply unchanged — the audit adds evidence, never a
second money path.

---

## 2. Tiered architecture — rules first, AI second

### Tier 1 — Rules audit (ship first; zero AI, zero cost, every tenant)

Pure arithmetic over data check-in already persists. Runs in the same post-close moment the
fee engine already occupies (or a seconds-later worker tick); flags write an `AuditFinding`
row and a notification. Checks:

| Check | Rule | Severity |
|---|---|---|
| Impossible odometer | `odometerIn < odometerOut` | error — one entry is wrong |
| Mileage outlier | `(odometerIn−odometerOut)/rentalDays > band` (default 600 mi/day, tenant-tunable) | warn — probable digit typo |
| Fuel up, no record | `fuelIn − fuelOut > 0.25` with no refuel/receipt recorded | warn — probable mis-entry |
| Fuel down, no fee | `fuelOut − fuelIn > threshold` and no FUEL_REFILL charge landed | warn — FeeRate config gap |
| Entries incomplete | missing angle photos, missing signature | warn |
| Backdated return | `returnedAt` far from photo `uploadedAt` timestamps | info |

The mileage/gas/entry-error part of the owner's vision is **entirely** Tier 1. It needs no
key, no opt-in, no DPA conversation, and it works for tenants who never enable photo AI.

### Tier 2 — Photo AI (opt-in per tenant, async, suggestion-only)

Per angle with photos on both sides: checkout image + checkin image + a strict JSON prompt →
one structured verdict. Shape (mirrors the citation extractor's discipline —
JSON-only, confidence, "do not invent"):

```
[image: checkout <angle>] [image: checkin <angle>]
Prompt: You are comparing two photos of the SAME vehicle angle: photo 1 at rental
checkout (baseline), photo 2 at return. Return ONLY minified JSON:
{"verdict":"NO_CHANGE|POSSIBLE_DAMAGE|UNREADABLE","confidence":0-100,
 "description":string|null,"region":{"x":0-1,"y":0-1,"w":0-1,"h":0-1}|null,
 "kind":"scratch|dent|scuff|crack|glass|missing_part|stain|other"|null}
Rules: lighting, angle, rain, dirt, reflections and shadows differ between handheld
sessions — do NOT report those as damage. Report POSSIBLE_DAMAGE only for a mark
visible in photo 2 and absent in photo 1. If either photo is too poor to compare,
verdict UNREADABLE. Never invent.
```

`region` renders as the dashed suspect box (a pointer, not a measurement — the UI says so).
Findings below the tenant-configurable confidence threshold (default 70, same idea as
`CITATION_OCR_CONFIDENCE_MIN`) are stored but not surfaced as flags.

### Honest capability assessment (design around this, not against it)

What pair-comparison vision does well: obvious new dents/scratches/scuffs on body panels,
missing parts (hubcap, mirror), broken glass, gross interior damage/mess — when both photos
are reasonably framed.

What it cannot do reliably, ever, with two handheld photo sessions days apart:
- **Lighting/exposure variance** — a shadow line or sun glare reads as a mark.
- **Angle drift** — "Front" at checkout vs "Front" at return are never the same camera pose;
  reflections move across curved panels.
- **Rain, dirt, water spots** — visually identical to scuffs at phone resolution.
- **Small damage** (<2–3 cm chips) — below what compressed wizard photos resolve
  (`image-compressor.js` compresses before upload).
- **Severity/cost estimation** — do not ask the model for a dollar figure. Ever.

Consequences baked into the UX: verdict language is "possible", confidence is always shown,
the disclaimer sits inside the verdict card, the region box is styled as a hint (dashed, warm,
labeled "suspected"), dismiss is a first-class button that feeds a training/false-positive log,
and **auto-charge is deliberately not designed** — the only path to money remains the existing
Report Damage wizard with a human filling estimate + who-pays. Expect and communicate a real
false-positive rate; the queue's Dismissed lane makes it measurable per tenant. If precision
disappoints in practice, the fallback posture is still valuable: "review these 2 pairs" beats
"review all 8 angles of all 23 returns".

### Cost order-of-magnitude (Tier 2)

8 pairs = 16 images per check-in. Wizard photos are compressed (~1–1.6 MP) ≈ ~1,100–1,600
tokens per image → ~20–28K input tokens + prompt per check-in; output is tiny (~1K total).

- `claude-haiku-4-5` ($1/M in, $5/M out): **≈ $0.03 per check-in** — ~$0.90/mo per 1,000
  monthly check-ins ≈ $27. Realistic single-location volume (20–30 returns/day) ≈ **$20–30/mo**.
- `claude-sonnet-4-6` ($3/M in, $15/M out): ≈ $0.09 per check-in — use only if Haiku's
  false-positive rate disappoints.
- The pipeline is async and latency-insensitive → the **Batch API halves this** if volume ever
  matters. Start with Haiku, model configurable per tenant like `CITATION_OCR_MODEL`.

The mockup surfaces live spend as a module KPI ("Photo AI · month $6.90") — cost transparency
is part of the tenant opt-in story.

### Async pipeline (never blocks the close)

```
checkin-close.service (unchanged, +enqueue only)
      │  writes CheckinAudit(PENDING) — never throws into the close path
      ▼
T1 rules pass ── <1s, same worker family as fee engine ──► findings persisted
      ▼
T2 photo worker (interval scheduler, citation-ocr.scheduler.js pattern):
   - gate: tenant flag checkinAuditConfig.photoAiEnabled AND
     resolveCitationOcrCredential(scope, {feature:'checkin-audit'}) ≠ NONE
   - atomic PENDING→ANALYZING claim, batch cap, per-pair calls
   - skips angles missing on either side (recorded as "skipped · N angles missing")
   - failure → audit row FAILED with reason; check-in is already closed and unaffected
      ▼
findings → review queue + bell notification (+ optional daily digest email/SMS)
      ▼
human: dismiss | snooze | Create damage report (existing POST /api/report-damage/...)
```

PII posture copied from the OCR worker: never log verdict JSON or image bytes — counts/ids
only (`citation-ocr.scheduler.js:15`).

### Per-tenant opt-in + key handling (the OCR precedent, verbatim)

- Settings block `checkinAuditConfig` (AppSetting, per tenant): `rulesEnabled` (default ON —
  it's arithmetic), `photoAiEnabled` (default OFF), thresholds (miles/day band, fuel delta,
  confidence min), notification prefs.
- Credential: reuse the shared Anthropic block via `resolveCitationOcrCredential(scope,
  {feature:'checkin-audit'})` — tenant key (encrypted at rest, masked reads), platform key only
  through the explicit `allowPlatformKeyFallback` / `PLATFORM_KEY_ALLOW_*` doors, loud logs.
  No `||` fallback, ever (`tenant-provider-credential.js:24-31`).
- DPA note: customer-identifying content in these photos is minimal (vehicle exterior/interior),
  but plates, faces in reflections and location context can appear — treat as PII, same
  per-tenant governance as OCR. For a UK-GDPR tenant, photo AI stays off until their DPA
  paperwork covers it; Tier 1 rules have no external calls and are always safe.

---

## 3. EN/ES copy (key strings)

| Key | EN | ES |
|---|---|---|
| module.title | Check-in Audit | Auditoría de check-in |
| lane.damage | Possible damage | Posible daño |
| lane.entry | Entry errors | Errores de captura |
| lane.mileageFuel | Mileage / fuel | Millaje / gasolina |
| lane.passed | Passed clean | Sin hallazgos |
| chip.pass | Pass | OK |
| chip.possibleDamage | Possible damage | Posible daño |
| chip.noMarks | No new marks | Sin marcas nuevas |
| chip.skipped | Skipped · angles missing | Omitido · faltan ángulos |
| verdict.title | Possible new damage | Posible daño nuevo |
| verdict.disclaimer | AI suggestion — a staff member confirms. Nothing is charged automatically. | Sugerencia de IA — el personal confirma. Nada se cobra en automático. |
| region.label | Suspected | Sospecha |
| audit.mileageFuel | Mileage & fuel audit | Auditoría de millaje y gasolina |
| audit.entries | Agent entry checks | Verificación de capturas del agente |
| flag.odoImpossible | Odometer below checkout reading | Odómetro menor al de salida |
| flag.milesOutlier | {n} mi/day — outside the normal band | {n} mi/día — fuera del rango normal |
| flag.fuelUpNoPurchase | Fuel higher at return with no refuel recorded | Más gasolina al regreso sin recarga registrada |
| flag.fuelNoFee | Fuel dropped but no refill fee was billed | Bajó la gasolina y no se cobró el fee de recarga |
| handoff.cta | Create damage report | Crear reporte de daño |
| handoff.sub | Opens the Report Damage wizard with the evidence already loaded. | Abre el asistente de Reporte de daño con la evidencia ya cargada. |
| handoff.descPrefill | AI-flagged, agent-verified | Detectado por IA, verificado por el agente |
| action.dismiss | Not damage — dismiss | No es daño — descartar |
| action.snooze | Snooze · verify on lot | Posponer · verificar en el lote |
| notif.damage | Possible damage — {res}. New mark suspected on the {angle} ({conf}%). | Posible daño — {res}. Se sospecha una marca nueva en {angle} ({conf}%). |
| notif.entry | Entry error — {res}. Odometer entered below checkout reading. | Error de captura — {res}. El odómetro quedó por debajo del de salida. |
| pipeline.neverBlocks | A check-in is never held by the audit. | El check-in nunca espera por la auditoría. |

(i18n via the existing namespace files; remember the namespace-merge gotcha from the
storefront audit — new namespaces must be merged into every locale.)

---

## 4. Recommendation

**Build it as two releases, in this order:**

1. **T1 rules audit + review queue + notifications** — smallest shippable tier. No AI, no
   keys, no opt-in friction, no DPA exposure; immediately catches the entry errors and
   mileage/fuel anomalies the owner listed, for every tenant. The queue/lanes/chips UI ships
   here and is the same UI T2 later fills. Roughly: one `CheckinAudit` model, ~6 pure
   functions, an enqueue call in `closeAgreementWithCheckinFees`, one screen.
2. **T2 photo AI** — opt-in per tenant behind `checkinAuditConfig.photoAiEnabled` +
   `resolveCitationOcrCredential(..., {feature:'checkin-audit'})`, async worker cloned from
   the citation-ocr scheduler, Haiku default (~$0.03/check-in), confidence-gated flags,
   suggestion-only UX, one-click handoff into the existing Report Damage wizard.

The handoff (the part the owner most wanted to see) costs almost nothing to build because
`POST /api/report-damage/:reservationId/report-damage` already accepts everything the audit
wants to prefill — photos, view, description — and already creates the charge + incident +
vehicle-status chain with its own guardrails.

**What not to build:** auto-charging from an AI verdict, dollar estimation by the model, or a
platform-key fallback. The first two break trust the day a shadow gets billed as a dent; the
third is the exact bug `tenant-provider-credential.js` exists to kill.
