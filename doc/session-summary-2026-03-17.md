# Session Summary 2026-03-17

## What We Changed

### Auth and Security
- Disabled public registration by default.
- Stopped accepting `role` from the public client payload.
- Required a real `JWT_SECRET`.
- Added real backend support for screen lock PIN flows.

### Prisma and Domain Model
- Added support for `lockPin` and security deposit persistence.
- Added structured reservation data models:
  - `ReservationPricingSnapshot`
  - `ReservationCharge`
  - `ReservationPayment`
  - `ReservationAdditionalDriver`
- Added structured agreement inspection persistence:
  - `RentalAgreementInspection`

### Reservation and Agreement Flows
- Added reservation pricing endpoints:
  - `GET /api/reservations/:id/pricing`
  - `PUT /api/reservations/:id/pricing`
- Added reservation payment endpoints:
  - `GET /api/reservations/:id/payments`
  - `POST /api/reservations/:id/payments`
- Added reservation additional driver endpoints:
  - `GET /api/reservations/:id/additional-drivers`
  - `PUT /api/reservations/:id/additional-drivers`
- Migrated agreement inspection flows to structured storage.
- Reduced runtime dependence on legacy metadata stored in `notes`.

### Legacy Metadata Migration
- Built and ran `backend/scripts/backfill-legacy-metadata.mjs`.
- Backfilled pricing snapshots, reservation charges, and agreement charges.
- Confirmed idempotency with a clean dry-run after write.

### Portal and Multi-Tenant Hardening
- Blocked public manual payment confirmation for non-Stripe gateways.
- Improved tenant scoping in reservations and customer portal flows.

### Frontend
- Unified token/session handling.
- Updated reservation detail, payments, additional drivers, inspection, and inspection report pages to use the new structured APIs.
- Removed key legacy `notes` parsing from primary runtime flows.
- Fixed production frontend API base handling for beta deploys.

## Planning and Documentation Created
- `doc/plan-auth-register-hardening.md`
- `doc/roadmap-90-days-competitive-gap.md`
- `doc/sprints-semanales-90-dias.md`
- `doc/sprint-1-backlog-metadata-migration.md`
- `doc/sprint-2-schema-proposal-charges-payments.md`
- `doc/backlog-tecnico-por-archivo-charges-payments.md`

## Git History From This Session
- `eafc7e2` `Harden auth and tenant-scoped customer flows`
- `154ddc5` `Migrate legacy reservation metadata to structured models`

## Deployment Work Completed
- Merged validated work into `main`.
- Pushed `main` to `origin`.
- Repaired beta deployment on DigitalOcean.
- Fixed backend exposure on port `4000`.
- Fixed frontend production API base usage.
- Reconnected beta to a clean database path and restored login.

## Final Outcome
- `beta.ridefleetmanager.com` is running.
- Backend and frontend are healthy.
- Live QA was completed successfully.

## Follow-Up Recommendations
- Rotate any secrets exposed during troubleshooting.
- Move from `docker-compose` v1 to `docker compose` v2.
- Add Swagger/OpenAPI documentation next from a non-`main` branch.
