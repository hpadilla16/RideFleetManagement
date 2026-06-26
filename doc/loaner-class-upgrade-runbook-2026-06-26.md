# Loaner class-upgrade — verification runbook (2026-06-26)

Feature: per-class loaner upgrade pricing + checked-out lock for the Rent & Go self-service flow.
Ship script: `.deploy-notes/2026-06-26-ship-loaner-class-upgrade-beta231.sh` (v0.9.0-beta.231).
Plan: `doc/loaner-selfservice-class-upgrade-plan-2026-06-25.md`.

## Already verified locally (sandbox, real Postgres 16) — QA sign-off: GO
- `prisma validate` ✅; migration applies from a pre-change state + idempotent on re-run ✅ (strictly additive: new enum, `Rate.purpose` default RENTAL, nullable `Reservation.serviceVehicleTypeId` FK ON DELETE SET NULL — no drops/renames, no NOT NULL without default).
- Loaner↔rental **isolation** proven: a `purpose=LOANER` rate is never returned/honored by `resolveForRental`, `list`, or `findRatesByLocationCode`.
- **Gateway-safe**: the differential path imports/calls no payment gateway (SPIn/Authorize.Net/Payarc); it only sets the reservation's loaner billing fields for advisor collection.
- Full backend suite: all groups pass. The single `test:public-booking` failure (`getWebsiteMandatoryFees`) is **pre-existing on beta.230**, not from this change.
- Acceptance criteria AC1–AC4: PASS. Unit (loaner-pricing 6/6), integration (20/20), test:loaner 16/16, test:rates 3/3.

## What YOU still need to run (real env)
### 1. Build + deploy
```
git fetch --tags && git checkout v0.9.0-beta.231
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
```
Frontend (Vercel/host): build includes the new Settings → **Loaner Rates** tab. **Run `next build` once** — this is the one piece not buildable in the sandbox (additive: a new tab + a new `LoanerRatesTab.js` component).

### 2. Migration (SESSION port 5432, not 6543)
```
docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
```
(Or apply `backend/prisma/migrations/20260625_rate_purpose_and_service_type/migration.sql` directly — it is idempotent.)

### 3. Set loaner rates
Admin → Settings → **Loaner Rates**, or API:
```
curl -s -X PUT -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"rates":[{"vehicleTypeId":"<econ>","dailyRate":30},{"vehicleTypeId":"<mini>","dailyRate":55}]}' \
  https://ridefleetmanager.com/api/settings/loaner-rates | jq .
```

### 4. Smoke (the storefront deliverable) — TOKEN = the rent-by-vphmotors website token
```
# AC1: lookup on a NEW/CONFIRMED loaner RO → serviceVehicle + entitledClassLabel + loaners[].upgradeDeltaPerDay + agreement + status
curl -s -X POST -H "X-Tenant-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"repairOrderNumber":"<RO>"}' https://ridefleetmanager.com/api/public/loaner/lookup | jq .

# AC4: reserve an upgrade class → { upgradeDeltaPerDay, estimatedUpgradeTotal } and reservation flagged CUSTOMER_PAY/PENDING_APPROVAL (no online charge)
curl -s -X POST -H "X-Tenant-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"appointmentId":"<id>","loanerId":"<upgradeVehicleId>","signature":"data:image/png;base64,iVBORw0KGgo="}' \
  https://ridefleetmanager.com/api/public/loaner/reserve | jq .

# AC3: reserve on a CHECKED_OUT RO → HTTP 409
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "X-Tenant-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"appointmentId":"<checkedOutId>","loanerId":"<id>","signature":"data:image/png;base64,iVBORw0KGgo="}' \
  https://ridefleetmanager.com/api/public/loaner/reserve

# fail-closed (no token) → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{}' \
  https://ridefleetmanager.com/api/public/loaner/lookup
```
Expected: lookup returns the enriched shape; upgrade reserve returns a positive `upgradeDeltaPerDay`; same/lower class returns `0`; checked-out → 409; no token → 401.

### 5. Money review (house rule)
Review the diff of `public-loaner.service.js` reserve() (the billing-field writes) before tag/push — it sets `estimatedTotal`/`loanerBillingMode`/`loanerBillingStatus` only; it calls no gateway.
