# Notifications — innovation review & mockup notes

Reviewer: graphic-design + innovation pass, 2026-08-31.
Deliverables: `maintenance-checkin-mockup.html` (Feature A — maintenance detection at check-in), `notification-center-mockup.html` (Feature B — notification center). Both self-contained, flat (no glass), brand #8752FE, tabular-nums, 40px targets / 11px floor, same token block as `tolls-redesign-A.html` so the family reads as one system.

Scope discipline: design only. No application code touched. Everything below cites real code so the build phase doesn't re-derive it.

---

# Feature A — Maintenance detection at check-in

## 1. The real machinery (file:line)

**The rules engine already exists and is exactly what the owner asked for.**

- `ServiceSchedule` — one row per vehicle × service type, `@@unique([vehicleId, serviceType])`, fields `intervalMiles / intervalDays / lastServiceMiles / lastServiceAt / active` (`backend/prisma/schema.prisma:1768-1789`).
- Service types: `LOF` (oil change), `TIRE_ROTATION`, `BRAKES`, `INSPECTION`, `OTHER` (`backend/src/modules/maintenance/maintenance.service.js:12`).
- `evalSchedule(s, vehicleMileage, now)` — the pure due/soon evaluator (`maintenance.service.js:34-55`). **Mileage-driven by Hector's 2026-07-13 decision** (comment at 27-33): when the schedule has a miles basis, only the odometer decides ok/soon/overdue; days decide only when there is no mileage basis. Thresholds: "soon" = within 500 mi (`MILE_SOON`, line 10) or 14 days (`DAY_SOON`, line 11).
- Per-vehicle read endpoint already shipped: `GET /api/maintenance/vehicles/:vehicleId/schedules` → schedules + evalSchedule against current `Vehicle.mileage` (`backend/src/modules/maintenance/maintenance.routes.js:38`, service `maintenance.service.js:146-174`).

**"Active pool" vs "maintenance pool" in code = `VehicleStatus`.**

- Enum: `AVAILABLE / RESERVED / ON_RENT / IN_MAINTENANCE / OUT_OF_SERVICE / SOLD` (`backend/prisma/schema.prisma:10-23`).
- The rentable pool is everything **not in** `IN_MAINTENANCE / OUT_OF_SERVICE / SOLD`: booking-engine availability excludes them (`backend/src/modules/booking-engine/booking-engine.service.js:933`), the planner excludes them (`backend/src/modules/planner/planner.service.js:493, 526`; `planner.actions.service.js:59`), loaner search excludes them (`backend/src/modules/dealership-loaner/public-loaner.service.js:33`).
- `IN_MAINTENANCE` is a **locked status**: `LOCKED_VEHICLE_STATUSES` in `backend/src/modules/vehicles/vehicle-status-sync.js:27` — reservation-driven status sync never clobbers it. So once the car is sent to maintenance, later reservation churn can't silently pull it back into the pool.

**"Put car in maintenance" already has a canonical verb: open a Repair Order.**

- `POST /api/repair-orders` (`maintenance.routes.js:24`), `source: 'SCHEDULED'` exists precisely for "from a service interval coming due" (`schema.prisma:67-72`).
- On RO open, `setVehicleInMaintenance()` flips the vehicle to `IN_MAINTENANCE` — but **only from `AVAILABLE`/`RESERVED`** ("never yank a car off an active rental", `backend/src/modules/maintenance/repair-orders.service.js:14-22`). On last open RO closing it drops back to `AVAILABLE` (`repair-orders.service.js:23-30`).
- Closing the loop after the shop: "Log service" rolls the schedule baseline to the vehicle's current odometer (`maintenance.service.js:228-270`, route `maintenance.routes.js:41`).

**The check-in wizard and why the banner goes in Step 3.**

- 6 steps (`frontend/src/app/reservations/[id]/checkin-wizard/page.js:341-347`); Step 3 "Return metrics · live fee preview" is where the agent types `odometerIn` (`page.js:61`, `Step3Metrics` at `page.js:707-805`, `OdometerInput` at 727-733).
- Step 3 already gates Continue on a valid odometer (`page.js:354`: `odometerIn > 0 && >= odometerOut`) — so the field the banner reacts to is guaranteed present before the agent can advance.
- On submit, check-in close mirrors `odometerIn` onto `Vehicle.mileage` + history (`backend/src/modules/rental-agreements/checkin-close.service.js:188-201` via `recordMileageEntrySafe`, `backend/src/modules/vehicles/mileage-history.service.js:91`). **This is the moment the new mileage can flip a schedule to OVERDUE** — which is why the banner must evaluate the *typed* odometer during the wizard rather than wait for the write.
- Reservation status sync at check-in sets the vehicle `AVAILABLE` (`vehicle-status-sync.js` mapping: `CHECKED_IN → AVAILABLE`), which is exactly the state `setVehicleInMaintenance` can flip. Hence the mockup's sequencing: **the decision is armed in Step 3 and fired after close** (close → sync AVAILABLE → open RO → IN_MAINTENANCE).

## 2. Design decisions (mirrors the three states in the mockup)

1. **Banner directly under the odometer field, re-evaluated per keystroke.** Cause above effect; zero new navigation. Client-side re-implementation of `evalSchedule` is ~20 lines of arithmetic on data the page can fetch once (`GET /maintenance/vehicles/:id/schedules`).
2. **Concrete language**: "Oil change — 1,230 mi overdue", with baseline → due → now shown per row and a small gauge. Never "maintenance required" in the abstract; the owner's ask was *which* maintenance.
3. **One primary action + explicit consequence sentence** ("moves out of the rentable pool… won't appear in availability or the planner until the RO is completed"). Same one-primary-action rule as the tolls redesign.
4. **Decline is a SNOOZE until the next rental event** (owner refinement 2026-09-01): one confirm — "Continue — remind me at {unit}'s next check-out or check-in" — with the re-prompt rule as the consequence line and an *optional*, collapsed note. No mandatory reason. Semantics: no re-prompt for the rest of *this* check-in; the banner re-surfaces at the vehicle's next check-out **or** check-in wizard (whichever comes first), **recomputed at that event** against the then-current odometer — an event marker, not a timer. The stamp (agent, reservation, odometer, timestamp) is recorded **silently** — audit value kept at zero clicks. The Maintenance Due list never snoozes. Continue stays gated until the agent either arms Send-to-maintenance or snoozes — that's what makes "the agent saw it" true.
5. **Armed, not fired**: the status change happens at check-in close, with Undo available until signature. Success step states the outcome in pool language, names the RO (RO-0007) and deep-links it.
6. **Due-soon items ride along**: they don't gate, but are pre-checked into the same RO so the shop does one visit (oil change + tire rotation).
7. **Failure isolation**: if the RO-open fails at close, the check-in still completes (money first) and the wizard offers a manual retry — never block the customer at the counter on a fleet-ops write.

## 3. Backend gaps — flagged NEW (Feature A)

| # | Gap | Notes |
|---|-----|-------|
| A1 | **NEW — Snooze stamp + per-vehicle snooze marker.** Two pieces: (a) the silent stamp (agentId, reservationId, odometer, decision SEND/SNOOZE, optional note, timestamp) — the "agent saw it" trail, queryable from the Maintenance hub; (b) a per-vehicle snooze marker (e.g. `maintenanceSnoozedAt`/`snoozedByUserId` on Vehicle, or a row in the stamp table flagged active) that the check-out AND check-in wizards read on open: marker present → clear it and re-evaluate the banner against the current odometer (re-prompt); marker absent → prompt normally. No reasonCode enum needed. Nothing stores any of this today. | Marker is cleared by the next wizard open, whichever comes first |
| A2 | **NEW — checkin-close hook** to execute the armed decision post-close: create RO (`source: SCHEDULED`) with pre-selected service types + `odometerAtOpen`, relying on existing `setVehicleInMaintenance`. | Small addition to `checkin-close.service.js` |
| A3 | **NEW (optional) — hypothetical-mileage eval**: `GET /maintenance/vehicles/:id/schedules?atMileage=48730`. Not strictly needed — the client can run the arithmetic — but keeps one evaluator. `evalSchedule` is already exported for tests. | Nice-to-have |
| A4 | **Existing but worth knowing**: RO create does not accept multiple service types as structured data — service lines are free-text `RepairOrderLine`s. The "oil change + tire rotation in one visit" concept needs the line descriptions written by the hook (fine), or a `serviceType` tag on lines (better, NEW). | Decide at build |

## 4. EN/ES copy (Feature A) — designed with ~30% slack

| Key | EN | ES |
|---|---|---|
| banner.title | Maintenance due at this odometer | Mantenimiento pendiente con este odómetro |
| banner.sub | Recomputed from the reading you just entered | Recalculado con la lectura que acabas de entrar |
| chip.overdue | {n} mi overdue | {n} mi vencido |
| chip.dueSoon | due in {n} mi | vence en {n} mi |
| chip.dueSoonDays | due in {n} days | vence en {n} días |
| svc.LOF | Oil change | Cambio de aceite |
| svc.TIRE_ROTATION | Tire rotation | Rotación de gomas |
| svc.BRAKES | Brakes | Frenos |
| svc.INSPECTION | Inspection | Marbete / inspección |
| action.send | Send to maintenance | Enviar a mantenimiento |
| action.snooze | Continue without action… | Continuar sin acción… |
| consequence | When this return completes, {unit} moves out of the rentable pool (status → Maintenance) and a repair order opens for the checked items. | Al completar esta devolución, {unit} sale del pool rentable (estatus → Mantenimiento) y se abre una orden de reparación con los renglones marcados. |
| snooze.title | Snooze until {unit}'s next rental event | Posponer hasta el próximo evento de renta de {unit} |
| snooze.body | This reminder re-surfaces automatically at the vehicle's next check-out or check-in — whichever comes first — recomputed against the odometer at that moment. The Maintenance Due list is untouched; it never snoozes. | Este recordatorio reaparece automáticamente en el próximo check-out o check-in del vehículo — lo que ocurra primero — recalculado con el odómetro de ese momento. La lista de Mantenimiento Pendiente no cambia; nunca se pospone. |
| snooze.confirm | Continue — remind me at next check-out or check-in | Continuar — recuérdame en el próximo check-out o check-in |
| snooze.note | Add a note for the maintenance board (optional) | Añade una nota para el taller (opcional) |
| snooze.stamp | Snooze is stamped automatically — {who} · {res} · {odo} · {when} — no extra clicks. | El posponer se registra automáticamente — {who} · {res} · {odo} · {when} — sin clics extra. |
| armed.msg | Will send to maintenance when the return completes. | Se enviará a mantenimiento al completar la devolución. |
| success.handoff | {unit} is out of the rentable pool. {ro} opened. | {unit} salió del pool rentable. Se abrió {ro}. |

---

# Feature B — Notification center

## 5. The inventory — every notification-like surface that exists today

Shell context first: the sidebar is five sections in `frontend/src/components/AppShell.jsx:20-73` (dailyOps / fleet / money / growth / admin). The topbar (`AppShell.jsx:684-866`) holds search (`:699`), the location picker (`:703-716`) and the profile menu — **there is no bell and no notification surface anywhere in the staff shell.** The only badge mechanism is the sidebar `nav-badge` (`:596`, open shuttle-request count); the only cross-screen banner slot is `<ShuttleBanner />` at `AppShell.jsx:672`.

| # | Surface | Backend (file:line) | Frontend home (file:line) | Trigger | Severity | Audience |
|---|---------|--------------------|---------------------------|---------|----------|----------|
| 1 | Overdue + geofence alerts (VoltSwitch) | rule `vehicles/overdue-geofence.js:20,61`; sweep `vehicles/overdue-locate.service.js:51,131-160`; API `vehicles.routes.js:193` (list) `:241` (dismiss); model `schema.prisma:1280` `OverdueVehicleAlert` | dashboard `app/page.js:294,363,950-985` — red-bordered card below tiles, per-alert Dismiss | cron 60s (`telematics-voltswitch.scheduler.js:32`, started `worker.js:320`) | highest (danger border) | tenant, any authed staff; NOT location-scoped |
| 2 | TollBridge staff alerts tray | `tolls/tolls.service.js:2919` list (closed contracts first `:2964`), ack `:2972`; email fan-out `:1515-1584`; API `tolls.routes.js:162,175` | tolls page `app/tolls/page.js:1324-1336` — collapsed `<details>` tray above the queue, cap 8 | cron writes (tolls.scheduler.js:129-159; tollbridge.scheduler.js), read on page load | low-key by design | tenant+location, tolls module; email → sede `alertEmail` |
| 3 | Shuttle zone / no-show alerts | rules `shuttle/shuttle-zone-alerts.js:106-327`; read `shuttle-monitor.service.js:211`; model `schema.prisma:3517` `ShuttleAlert` | shuttles page `app/shuttles/page.js:102-152,511-537` (12s poll + 8s toast); feed `AlertFeed.jsx:32-99`; tones `lib/shuttle-alert-feed.js:13-24` | cron 60s (`shuttle-alerts.scheduler.js:52`, started `worker.js:308`) | ENTER ok / EXIT neutral / OFF_ROUTE warn / NO_SHOW warn | staff w/ reservations module, own sedes; SMS to rider, email/SMS to per-location recipients |
| 3b | Shuttle request banner | (same request data) | `components/ShuttleBanner.jsx` mounted `AppShell.jsx:672` — above content on EVERY staff screen, 20s poll, only "View" clears | poll | urgent (guest physically waiting) | all staff |
| 3c | Driver PWA bell+inbox+toast — the only real bell in the codebase | `shuttle/shuttle-driver.routes.js:112` | `app/driver/[token]/DriverClient.jsx:851-864,977-985` — bell, unread badge, toast; read-marks in localStorage `:371` | ~30s poll | info | token-authed shuttle driver (public), NOT staff |
| 4 | Fee advisories | **REMOVED** — replaced by registrations-expiring tile (`reports/reports.service.js:447-448`; `app/page.js:517,625`) | stale copy only in `knowledge-base/page.js:30,142,544` | — | — | — |
| 5 | Check-in reminders | `customer-inspection/checkin-reminders.scheduler.js:23` (6h sweep); pre-check-in invite `reservations/precheckin-invite.scheduler.js:205` | none (outbound email only) | cron | info | CUSTOMER, not staff |
| 6 | Stale-preauth alerts | **DO NOT EXIST** — `depositHoldExpiresAt` is written (`checkout-session/spin-charge.service.js:586,1071`) and never read by any alert code | none | — | — | — |
| 7 | Turn-ready | `lib/turn-ready-rules.js:35-36` (ATTENTION/BLOCKED), API `vehicles.routes.js:259` | `app/dashboard-v2/page.js:218-238,411-467` ring + worst-first table; chip on `issues/page.js:1106` | computed on page load | score-derived | tenant staff |
| 8 | Incident / Issue Center | `modules/issue-center/*` (30 files), mounted `main.js:320` | `app/issues/page.js:906-915` pill strip, `:947-956` attention cards, `:152-156` 48h due-soon | page load | priority enum incl. URGENT + derived DUE_SOON | staff w/ issueCenter module |
| 9 | Billing dunning (tenant subs) | `billing/billing-dunning.service.js:13-18,101-197` (Day 0 notice → Day 6 suspend); owner emails `billing-notify.js:80-130` | `components/BillingNoticeBanner.jsx` on dashboard (`app/page.js:720`), dismiss render-only `:99-107`; hard stop `TenantSuspendedHold.jsx` via `AuthGate.jsx:505` | cron daily (`billing-reconcile.scheduler.js:114`) + webhooks | warn banner → full lockout | ADMIN only (`BillingNoticeBanner.jsx:24-26`); owner emails go to RIDE |
| 9b | Long-term plan dunning | `long-term/long-term-billing.scheduler.js:661`; templates `long-term-emails.js:38-89` | none (email only) | cron hourly | info→overdue | customer + location staff email |
| 10 | Maintenance due/overdue | `maintenance/maintenance.service.js:58-90` due(), `:94-132` summary() | dashboard tile `app/page.js:838-855` (big number = OVERDUE, danger tint); v2 `dashboard-v2/page.js:542-548` | page load | danger when overdue>0 | tenant/location staff |
| 11 | Registration / document expiry | `reports/reports.service.js:449-454,640`; locations documents API | `app/page.js:649-656` attention card + `:799-828` docs tile (danger when expired); v2 `:535-541,663-668` | page load | warn/danger | tenant/location staff |
| 12 | Kiosk escalation (guest waiting) | `reports.service.js:476-480,650` (`KioskSession.outcome='ESCALATED'`) | `app/page.js:537-541,627-636` Ops-Hub item → `/kiosks?outcome=ESCALATED` | page load | urgent | staff w/ kiosk module |
| 13 | Ops-Hub attention list (aggregate) | `reports.service.js:434-481,610-659` | `app/page.js:625-712` — kiosk escalations, inspections to review, registrations, rotate-ready, loaner requests | page load | mixed | tenant staff |
| 14 | Idle-vehicle alert (owner backlog #5) | **CONFIRMED ABSENT** — only planner idle-gap scoring (`planner.recommendation.service.js:156`) and a "Days Idle" report column (`reports.service.js:1707`) | none | — | — | — |
| 15 | Stale build / load-error / suspension banners | — | `StaleBuildWatcher.jsx:25` (global, `layout.js:148`); `LoadErrorBanner.jsx:24`; `TenantSuspendedHold.jsx` | client poll / fetch failure | system | all users |
| 16 | Outbound email/SMS senders (context) | ~60 files; automated: loaner reminders, check-in links, long-term dunning, toll staff email, shuttle SMS/email, billing notify, confirmation/review/addendum emails; catalog `sms/sms-templates.js:8-53` (manual-send only, `sms.routes.js:29`) | — | cron/event | — | mostly customers |

(All backend paths relative to `backend/src/modules/`, frontend to `frontend/src/`.)

**Cross-cutting findings** (why the center is worth building):

1. **No substrate.** No `Notification` model, no per-user read state, no fan-out, no bell. Nine surfaces, each with its own polling loop and dedupe (Redis TTL, DB column, localStorage, in-memory ref).
2. **Dismissal semantics all differ**: geofence → server `status='DISMISSED'`; toll → server `staffAckAt`; billing banner → deliberately unpersisted; shuttle banner → cleared only by navigating; driver inbox → localStorage; dashboard items → self-clearing. The center's read/acknowledge model unifies exactly this.
3. **Nothing is per-user.** Everything is tenant- or location-scoped; no individual addressing anywhere.
4. **Severity is only CSS.** The sole structured severities are shuttle tones, turn-ready ATTENTION/BLOCKED, and issue-center priority. The envelope makes severity data.
5. **Two dashboards** (`app/page.js`, `app/dashboard-v2/page.js`) show overlapping tiles; the bell serves both without taking sides.

## 6. Design model (mirrors the two mocks)

- **Placement**: bell in the topbar between search (`AppShell.jsx:699`) and the location picker (`:703`) — the one slot every staff screen shares; plus a `Notifications` nav entry (dailyOps section, under Dashboard) hosting the full center. The ShuttleBanner keeps its interrupt slot — a bell must never be the only path to a guest standing at a counter.
- **Envelope** (NEW `NotificationEvent`): `{id, tenantId, locationId?, severity: CRITICAL|ACTION|INFO, category, title, body, deepLink, sourceType, sourceRefId, dedupeKey, audienceRoles?, createdAt, resolvedAt?, ackByUserId?, ackAt?}` + per-user `NotificationRead {userId, notificationId, readAt}` (or a per-user high-water mark + exceptions, cheaper).
- **Events vs standing conditions**: the feed shows **events** (something happened at a time). Page-load-computed *conditions* (turn-ready ranking, registration counts, ops-hub) stay on dashboards; only their **edge transitions** may emit events (e.g. "registration entered 30-day window" — one event, deduped by `dedupeKey`).
- **Severity contract**: CRITICAL = human/asset exposed now (badges the bell, unmutable): geofence-outside, kiosk escalation, suspension. ACTION = owned work with a deadline: unacked billable toll, maintenance overdue, no-show, doc expired, issue due-soon, Feature A snoozes. INFO = awareness: due-soon, back-on-route, receipts. Never badge INFO.
- **Read ≠ acknowledge**: read is per-user; acknowledge is per-tenant, shows who and when, and **delegates to the source endpoint** where one exists (`POST /vehicles/overdue-alerts/:id/dismiss`, `POST /tolls/transactions/:id/acknowledge`) so the center never forks state.
- **Scoping**: feed filtered by the caller's `effectiveLocationIds` (`backend/src/lib/tenant-scope.js`) like every module; role-gated categories (billing → ADMIN) filtered at the API.
- **Muted rules**: per-user, category × location, never for CRITICAL.

## 7. Backend gaps — flagged NEW (Feature B)

| # | Gap | Notes |
|---|-----|-------|
| B1 | **NEW — `NotificationEvent` + `NotificationRead` tables** and `GET /api/notifications` (+ unread-count endpoint for the bell, poll ~30s reusing the ShuttleBanner backoff pattern) | The substrate |
| B2 | **NEW — emitters at existing choke points** (v1: 5): overdue-locate upsert (`overdue-locate.service.js:131`), toll staff-alert fan-out (`tolls.service.js:1871-1878`), shuttle alert fan-out (`shuttle-alerts.scheduler.js:338`), kiosk escalation write, dunning sweep (`billing-dunning.service.js:159-183`) | Each ~10 lines; dedupe via `dedupeKey` |
| B3 | **NEW — maintenance overdue emitter**: no cron watches `due()` today; a daily sweep emits "entered overdue" edge events (+ Feature A's decision events from gap A1) | Reuses `maintenanceService.due()` |
| B4 | **NEW — ack delegation map** sourceType → existing endpoint; sources without one (kiosk, docs) get center-local ack | |
| B5 | **NEW — idle-vehicle rule** (owner backlog #5): no detection exists at all — needs definition (AVAILABLE + no reservation in N days; the "Days Idle" report column at `reports.service.js:1707` is the seed) before it can notify | Flag: rule design first |
| B6 | **Stale-preauth** (`depositHoldExpiresAt` never read back): a natural second-wave emitter | Confirmed absent today |

## 8. EN/ES copy (Feature B) — ~30% slack

| Key | EN | ES |
|---|---|---|
| nav.title | Notifications | Notificaciones |
| bell.aria | Notifications, {n} unread | Notificaciones, {n} sin leer |
| panel.markAll | Mark all read | Marcar todo leído |
| panel.viewAll | View all in Notification Center | Ver todo en el Centro de Notificaciones |
| scope.all / critical / action / mySede | All · Critical · Needs action · My sede | Todo · Crítico · Requiere acción · Mi sede |
| tabs | Inbox · Acknowledged · Muted rules · Delivery settings | Bandeja · Atendidas · Reglas silenciadas · Entrega |
| lane.critical | Critical | Crítico |
| lane.needsAction | Needs action | Requiere acción |
| lane.info | Informational | Informativo |
| evt.geofence | Overdue & outside geofence — {unit} | Vencido y fuera de geocerca — {unit} |
| evt.kiosk | Guest waiting — kiosk session escalated | Cliente esperando — sesión de kiosco escalada |
| evt.tollClosed | New billable toll on a closed contract — {amt} | Peaje facturable en contrato cerrado — {amt} |
| evt.maintSnoozed | Maintenance snoozed at check-in — {unit} | Mantenimiento pospuesto en el check-in — {unit} |
| evt.noShow | Shuttle request no-show — {stop} | No-show de shuttle — {stop} |
| evt.regExpiring | Registration expires in {n} days — {unit} | Marbete vence en {n} días — {unit} |
| ack.by | Acknowledged by {name} · {time} | Atendida por {name} · {time} |
| ack.self | Self-resolved | Resuelta sola |
| foot.showing | Showing {a} of {b} in your location scope | Mostrando {a} de {b} en tus sedes |
| foot.archive | older items auto-archive after 30 days | lo antiguo se archiva a los 30 días |

## 9. MVP recommendation

**MVP (one milestone):**
1. `NotificationEvent` + per-user read state + `GET /api/notifications` + unread count (B1).
2. Bell + dropdown panel in AppShell (Mock 1) — badge = per-user unread, CRITICAL+ACTION only.
3. Center page (Mock 2) with the three severity lanes and source filter — no Muted rules, no Delivery settings tabs yet.
4. Five emitters that are pure add-ons at existing choke points (B2) + the maintenance overdue sweep (B3). All existing surfaces stay untouched — the center aggregates.
5. Ack delegation for the two sources that already have endpoints (geofence dismiss, toll ack); center-local ack for the rest (B4).

**Explicitly out of MVP:** muted rules, email/SMS delivery preferences (the per-surface fan-outs keep working as-is), idle-vehicle rule (needs rule definition first — B5), stale-preauth (B6), turn-ready/condition-edge events, migrating any existing surface into the center, real-time push (poll is fine at 30s; every existing surface already polls).

**Sequencing note:** Feature A lands independently of B; its decision record (A1) simply emits into B's envelope when B exists. Build order A → B-substrate → B-emitters keeps every step shippable.

**Innovation flags for Hector:**
- The driver PWA already proved the bell pattern in this codebase (`DriverClient.jsx:851`) — the staff bell is its grown-up sibling, with server-side read state instead of localStorage.
- The center is also the natural future home for the surfaces that today only email (loaner reminders, long-term dunning staff copies) — cheap wins post-MVP.
- Two dashboards both render maintenance/registration tiles; the bell finally gives those alarms a home that doesn't depend on which dashboard a user opens.
