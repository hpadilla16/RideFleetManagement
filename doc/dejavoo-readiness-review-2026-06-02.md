# Dejavoo IPOSpays deploy — readiness review after beta.60–63 (2026-06-02)

Hector's instinct was right: shipping the override panel (beta.60), the bug #44
vehicle-status sync (beta.61), and the incident module (beta.62/63) changed the
ground the pending Dejavoo work stands on. This is what to update **before** we
pick the Dejavoo tokenized-preauth deploy back up.

## Where Dejavoo stands on `release/v0.9.0-beta.58` today

- `backend/src/modules/payment-gateway/` has a working SPIn REST client
  (`spin-client.js`): `sale / auth / capture / void / refund / getCard (tokenize)
  / status / settle / terminalStatus`, plus `payment-gateway.service.js` and
  `/api/payment-gateway/*` routes. Tenant SPIn config (`spinTpn`, `spinAuthKey`,
  `spinSandbox`, …) is read from `Tenant.settingsJson`.
- **No `DejavooTransaction` row-level model on this branch.** Payments are
  recorded on `ReservationPayment` (`gateway`, `reference`, `method`, `status`)
  and `RentalAgreementPayment`. `AUTH_HOLD` is a payment method meaning "auth code
  on file, funds NOT captured" (security deposit).
- The SPIn **callback webhook is a stub** — `payment-gateway.routes.js` `POST
  /callback` has `TODO: process callback → update reservation payment status`.
- The terminal-checkout path is gated behind tenant feature flags
  `dejavooCounter` + `interactiveTC` (flipped for IRC during round 26, then rolled
  back). Those flags are NOT referenced in `backend/src` here — the gating + the
  actual counter-orchestrator live on the older `dejavoo-spin-checkout-redesign` /
  `proxy-on-beta56` branches, which **predate beta.59–63**.
- `rental-agreements.service.js` `finalize()` on this branch does **not** call the
  payment gateway directly. The Dejavoo-driven checkout is the redesign branch's
  orchestrator, not this finalize path.
- No `authWithToken()` exists (the handoff's name was aspirational). The tokenized
  path is `getCard()` (tokenize) + `auth()` (hold) wired together by the redesign
  branch's orchestrator.

## What our recent work changes — action items

### 1. (BLOCKER) Any Dejavoo checkout path MUST call the vehicle-status sync
beta.61 made `vehicle-status-sync.js` the single source of truth: `Vehicle.status`
is synced wherever `Reservation.status` changes (checkout finalize, check-in close,
agreement lifecycle, admin PATCH). The Dejavoo redesign branch sets
`Reservation.status = CHECKED_OUT` through its **own** orchestrator, which was
written before this helper existed. **If that path doesn't call
`syncVehicleStatusForReservation(tx, { reservationId, vehicleId, toStatus:
'CHECKED_OUT' })`, every Dejavoo checkout will re-introduce bug #44** (vehicle stays
AVAILABLE while rented). When porting the Dejavoo orchestrator onto release, add the
sync at its status-set point. This is the most important update.

### 2. Override route's `paymentsForManualRefund` is a known stub to revisit
The adapted override route returns `paymentsForManualRefund: []` because there is no
`DejavooTransaction` model here. Two consequences once Dejavoo tracking lands:
- The override **rewind deletes `RentalAgreementPayment` rows** when going
  pre-checkout. If a Dejavoo **auth hold / preauth** is recorded as an
  `AUTH_HOLD` payment, rewinding will delete that record **without voiding the hold
  on the terminal** — money stays held on the customer's card. Before enabling
  Dejavoo widely, either (a) wire the override to enumerate approved
  transactions/holds into `paymentsForManualRefund` so the agent voids them on the
  terminal, or (b) have the override call `paymentGatewayService.voidTransaction()`
  for open holds during rewind. Until then, treat "override rewind on a
  Dejavoo-paid reservation" as a manual-void situation.
- The frontend panel already renders the refund list only when non-empty, so wiring
  it later is additive (no UI change required).

### 3. Port Dejavoo onto release by cherry-pick, NOT merge
Same lesson as the override panel and incident module: the Dejavoo branches are far
behind release (they're missing the TL fixes, bug #44, override panel, incident
module). Do not merge them. Cherry-pick / extract the orchestrator + flag-gating
files onto `release/v0.9.0-beta.58`, then reconcile against this branch's schema
(no `DejavooTransaction` here — decide whether to add it or keep using
`ReservationPayment.gateway/reference`).

### 4. New safety net: the override panel now de-risks Dejavoo smoke testing
During round 26, stuck terminals / aborted transactions left reservations in
half-checked-out states that were painful to clean up by hand. The SUPER_ADMIN
override panel (beta.60) now rewinds a reservation cleanly (deletes the orphan
agreement, clears signature, syncs the vehicle, writes an audit row). Use it as the
recovery tool when re-running tokenized-preauth tests — it didn't exist last time.

### 5. Implement the callback stub if preauth confirmation is async
If the tokenized-preauth flow relies on SPIn async callbacks to confirm
approval/capture, `POST /api/payment-gateway/callback` must actually update
`ReservationPayment.status` (currently it just logs). Decide this when wiring the
orchestrator.

### 6. Unrelated-but-adjacent carry-overs still open
- `#27` Configure the iPOSpays merchant-portal disclaimer for the IRC terminal
  (done by Hector in the Dejavoo portal UI).
- `#34` `counter.routes` preflight + start-checkin SUPER_ADMIN scoping
  (SUPER_ADMIN with `tenantId=null` gets 403; workaround is logging in as Erick Bou
  IRC ADMIN). This will bite Dejavoo counter testing — fix or use the workaround.

## Suggested order when we resume Dejavoo

1. Confirm the IP whitelist: retry one tokenized preauth manually against the IRC
   terminal (should no longer 2201 / proxy-error).
2. Locate the Dejavoo orchestrator + flag-gating on `dejavoo-spin-checkout-redesign`;
   diff it against release; plan the cherry-pick.
3. Add the `syncVehicleStatusForReservation` call at its CHECKED_OUT status-set
   (item 1) and decide the transaction-storage model (item 3).
4. Decide override-rewind handling for open holds (item 2).
5. Implement callback processing if needed (item 5); fix `#34` scoping.
6. Ship behind `dejavooCounter` + `interactiveTC` for IRC only; e2e test with the
   override panel as the recovery tool; then widen.
