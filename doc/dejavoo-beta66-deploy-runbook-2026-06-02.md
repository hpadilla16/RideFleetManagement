# Dejavoo checkout redesign — beta.66 deploy runbook (2026-06-02)

**FULL CUTOVER.** After this deploys, every "Start Check-out" (all tenants) uses
`checkout-wizard-v2` + the Dejavoo terminal flow. There is no feature flag. Test on
the IRC terminal immediately after deploy, before real customers.

Validated in an isolated clone: schema merges to a valid union, all backend JS
compiles, 52 existing tests pass, frontend parses. The spin-charge unit tests only
fail locally because the release-generated Prisma client lacks the new models — the
Docker build regenerates the client, so they pass on deploy.

## Order matters: migration BEFORE the image
The beta.66 backend expects the new tables/columns. Apply both migrations to Supabase
FIRST, then rebuild the droplet. The migrations are plain `CREATE`/`ALTER` (NOT
idempotent) — run each EXACTLY ONCE.

---

## Phase 1 — merge + push (Mac)
```bash
cd ~/Code/RideFleetManagement
bash .deploy-notes/2026-06-02-merge-dejavoo-beta66.sh
```
It merges `origin/dejavoo-spin-checkout-redesign`, auto-resolves the one schema
conflict (union of incident + checkout-session blocks), `prisma validate`s, then on
your `y` commits + tags `v0.9.0-beta.66` + pushes. If it reports conflicts beyond
`schema.prisma`, stop and ping me (`git merge --abort` backs it out).

## Phase 2 — back up prod (droplet)
```bash
cd ~/RideFleetManagement && bash ops/backup.sh
```

## Phase 3 — apply migrations to Supabase (SQL editor), IN ORDER, ONCE EACH
1. Paste **MIGRATION-1-dejavoo_checkout_session.sql** (creates `CheckoutSession`,
   `HandoffToken`, `AgreementSectionInitial`, `VehicleInspectionAnnotation`, the
   `CheckoutStep`/`HandoffTokenKind` enums, and the `RentalAgreement` card-on-file /
   deposit-hold / T&C columns + `Vehicle.lastOdometerSource`). Run.
2. Paste **MIGRATION-2-checkout_session_auto_emailed_at.sql** (adds
   `CheckoutSession.autoEmailedAt`). Run.
3. Verify:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('CheckoutSession','HandoffToken','AgreementSectionInitial','VehicleInspectionAnnotation');
SELECT column_name FROM information_schema.columns
WHERE table_name='RentalAgreement' AND column_name LIKE 'cardOnFile%';
```
Expect 4 tables + the cardOnFile columns.

## Phase 4 — deploy the image (droplet)
```bash
cd ~/RideFleetManagement
git fetch --tags --force
git checkout v0.9.0-beta.66
docker compose -f docker-compose.prod.yml up -d --build
sleep 60
docker compose -f docker-compose.prod.yml ps
docker logs fleet-backend-prod --tail 40
```
Watch for: all 4 containers healthy; clean boot; NO Prisma errors about
`checkoutSession` / `cardOnFile` (would mean client/DB out of step → migration not
applied or image not rebuilt).

## Phase 5 — TERMINAL TEST on the IRC terminal (before real customers)
Confirm SPIn creds are set for IRC (TPN `816026739983`). On a throwaway/known IRC
reservation:
1. Open the reservation → **Start Check-out** → confirm it loads `checkout-wizard-v2`.
2. Step through to the payment step → tap/insert a card on the terminal.
   - Expect: SPIn **sale** approves (auth code), card **tokenizes** (no second tap),
     **preauth** deposit hold places against the token.
   - Backend log should show `SPIN_SALE_APPROVED` then `SPIN_PREAUTH_APPROVED`.
3. Verify on the reservation: `RentalAgreement.cardOnFileToken` populated, a sale
   `RentalAgreementPayment`, and the View Payments ledger shows sale + deposit hold.
4. Continue the wizard (T&C handoff, inspection handoff, finalize) end to end.
5. **Tokenized re-charge (the priority-#3 goal):** trigger a card-on-file charge
   (e.g. a small manual charge in View Payments) and confirm it runs **without a
   re-swipe** via the stored token.

## Rollback (if checkout breaks)
```bash
cd ~/RideFleetManagement
git checkout v0.9.0-beta.65
docker compose -f docker-compose.prod.yml up -d --build
```
The migrations are additive — leaving the new tables/columns in place is harmless on
beta.65 (it just ignores them). Roll the image back; data stays.

## Known caveats
- The dejavoo branch's last commit is `wip: dejavoo` — treat the first live checkout
  as the real test; have the override panel ready to rewind a stuck reservation.
- Full cutover: other tenants now use this flow too. If a non-IRC tenant has no SPIn
  terminal configured, their checkout payment step will fail — gate to IRC later if
  that's a problem (follow-up, not in this deploy).
- `autocharge` provider-awareness (check-in fees via Dejavoo token vs Authorize.Net)
  is still the separate follow-up in `doc/checkin-fee-collection-dejavoo-alignment-2026-06-02.md`.
