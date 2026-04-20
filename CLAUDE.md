# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

RideFleet is a multi-tenant fleet-management + car-sharing platform aiming to compete with Turo on consumer surfaces while keeping operational depth (reservations, rental agreements, dealership loaners, inspections, payments, commissions). The platform is built around **one shared booking engine and one shared operations engine** serving multiple client surfaces — do not branch business logic per surface unless you have a strong reason.

## Monorepo layout

- `backend/` — Node + Express + Prisma API. Entry `src/main.js`, clustered entry `src/cluster.js`, modules under `src/modules/<domain>/`.
- `frontend/` — Next.js 14 (app router, React 18). Entry `src/app/`, shared UI in `src/components/`, fetch/auth helpers in `src/lib/`. Capacitor wrapper lives here too (`capacitor.config.js`, `android/`).
- `doc/` (singular) — product and sprint thinking (roadmaps, sprint plans, closeouts, discovery notes). Files are dated (`YYYY-MM-DD`) and additive.
- `docs/` (plural) — architecture + requirements + operations runbooks. Two different folders — **don't confuse them**.
- `ops/` — PowerShell scripts for daily dev loop and env templating.
- `scripts/` — automation and one-off migration/backfill helpers.
- `wordpress/` — marketing site companion content.

The Flutter **car-sharing guest app** is being built as a **separate repository** (not a folder in this monorepo). It talks to this backend as an external client via the public booking API. If you're updating backend endpoints that the Flutter app consumes (`/api/public/booking/*`), check with that repo — don't assume this repo is the only caller.

## Commands

### Backend (`cd backend`)

- `npm run dev` — start API on port 4000 (single process)
- `npm run start:cluster` — clustered production mode (tuned for 4-vCPU)
- `npm test` — runs the full suite. It's a chain of module-level test scripts
- Run one module's tests: `npm run test:carsharing`, `npm run test:vehicles`, `npm run test:planner`, `npm run test:portal`, `npm run test:issues`, `npm run test:tolls`, `npm run test:payments`, `npm run test:auth`, `npm run test:commissions`, `npm run test:rental-agreements`, `npm run test:rates`, `npm run test:sms`, `npm run test:cache`, `npm run test:puppeteer`
- Run one file: `node --test src/modules/<module>/<name>.test.mjs`
- Prisma: `npm run prisma:generate`, `npm run prisma:migrate`, `npm run prisma:studio`
- Seed: `npm run seed:bootstrap`, `npm run seed:booking-fixtures`
- `npm run verify` — alias for full tests (used in CI)

### Frontend (`cd frontend`)

- `npm run dev` — Next on port 3000
- `npm run build` / `npm start`
- `npm test` — planner node tests + vitest component tests
- `npm run test:components` — vitest only
- `npm run verify` — tests + build
- Capacitor: `npm run mobile:sync`, `npm run mobile:open:android`, `npm run mobile:open:ios`

### Daily ops (PowerShell, from repo root)

- `powershell -ExecutionPolicy Bypass -File .\ops\start-day.ps1` — local stack + health checks
- `... start-day.ps1 -Rebuild` — with rebuild
- `... start-day.ps1 -Env staging` or `-Env production` — use env templates
- `... stop-day.ps1` — stop everything
- `... set-env.ps1 -Target staging` — swap in env templates without starting

### Docker

- `docker compose up --build` from root. Frontend → `:3000`, Backend → `:4000`. `docker-compose.prod.yml` for prod-style stack.

## Architecture you must know before touching things

### Multi-tenant foundation

Core entities carry `tenantId`. JWT payload includes `tenantId` and `role` (SUPER_ADMIN, ADMIN, OPS, AGENT). Tenant isolation was validated for beta on 2026-02-26 (see `BETA_TENANT_ISOLATION_CHECKLIST.md`) — **do not add queries that bypass `req.user.tenantId`**. Guests are `Customer` records, not `User` rows; they authenticate via magic-link tokens exchanged for short-lived JWTs. SUPER_ADMIN can cross tenants; other roles cannot.

### Shared engines

- **Booking engine** (`src/modules/booking-engine`, `src/modules/public-booking`, `src/modules/car-sharing`) powers rental reservations, car-sharing trips, and dealership loaner contracts. Availability search, quotes, taxes/fees, deposits, confirmation, cancellation all flow through here.
- **Operations engine** (reservations, rental-agreements, inspections, payment-gateway, issue-center, tolls, commissions, planner) powers agreements, status transitions, timeline events, payment posting, audit.

A trip (car-sharing) always has a backing `Reservation` with `workflowMode = CAR_SHARING` so the operations engine can drive the same lifecycle as rental. When editing a flow that touches both, check both modules.

### Surfaces (UI contracts, not separate backends)

- Fleet Manager back office (internal console)
- Public booking web (`/book`, `/book/confirmation`) — marketplace-facing; no tenant visible to the customer
- Guest portal (`/guest`, `/customer/*`) — magic-link based
- Host app (`/host`, `/host-profile/[id]`) — uses `/api/host-app/*`
- Employee app + Loaner + Issue + Planner hubs (mobile-first web) — all consume shared APIs
- Flutter car-sharing app (`mobile-car-sharing/`) — dedicated native guest experience

### API conventions

- Public (no auth) routes for guest flows live under `/api/public/booking/*`. They are **stateless, JSON-only, token-based** — safe to hit from native apps.
- Authenticated internal routes use `Authorization: Bearer <jwt>`; tenant is derived from the token (except SUPER_ADMIN ops routes).
- Tenant selection on public endpoints is `?tenantSlug=xxx` or `?tenantId=xxx` — no subdomain routing.
- Real-time: **SSE, not WebSocket** (see `/api/public/booking/trip-chat/:token/stream`, 30s heartbeat). Design reconnect-friendly consumers.
- **No API versioning** — breaking changes hit all clients simultaneously. When in doubt, add new endpoints instead of breaking existing ones.
- OpenAPI spec auto-generated at `GET /api/docs/openapi.json`; HTML viewer at `/api/docs`. Prefer codegen for clients.

### Frontend conventions

- Next.js 14 app directory. No React Query / SWR — plain `fetch` via `src/lib/client.js` (`api()` wrapper), `useEffect` + `useState`.
- JWT stored in `localStorage` under key `fleet_jwt` (with legacy fallbacks `token`, `authToken`, `accessToken`, `jwt`). Read via helper; don't duplicate logic.
- `NEXT_PUBLIC_API_BASE` sets the API URL (defaults to `http://localhost:4000`); set in `docker-compose.yml` for docker runs.
- Design tokens in `src/app/globals.css`: primary purple `#8752FE`, mint accent `#1fc7aa`, ink `#211a38`, radius 16 default / 20 large, iOS-inspired glass surfaces. Mirror these when adding mobile surfaces.
- Shared shells: `AppShell.jsx` (authenticated desktop), `MobileAppShell.jsx` (mobile-first with hash-based tab persistence), `AuthGate.jsx` (login/session restore).

### Mobile strategy

Two parallel tracks, each owned by a different repo — both are valid:

1. **Capacitor wrapper** lives here in `frontend/` (`frontend/capacitor.config.js`, app id `com.ridefleet.mobile`). Wraps the Next.js app in a WebView and ships to Play / App Store internal testing. Covers employee, host, loaner, issue, planner surfaces.
2. **Flutter car-sharing guest app** lives in a **separate repository** — it's a fully native client for the car-sharing guest flow where marketplace-grade UX matters (camera, deep links, signature capture, push). It consumes this backend via the public booking + trip-chat endpoints (`/api/public/booking/*`) — treat it as an external API consumer.

Don't delete or replace Capacitor artifacts when working on Flutter changes; they ship to different audiences. Backend API changes that affect `/api/public/booking/*` are now multi-client — coordinate with the Flutter repo before breaking the contract.

## Sprint discipline

Work is organized in sprints; plans and closeouts are dated Markdown files in `doc/` (e.g., `sprint-8-closeout-and-sprint-9-mobile-plan-2026-03-24.md`). When starting a new sprint, add a new dated plan rather than editing the previous one. Branches follow `dev/sprint-<N>-<slug>` for feature work and `hotfix/<slug>` for in-flight fixes. Tags follow `v0.9.0-beta.<N>` + `+hotfix.<M>` for beta pushes.

## CI

`.github/workflows/beta-ci.yml` runs on pushes. For local parity, `npm run verify` in each of `backend/` and `frontend/` is the closest thing to the CI command set.

## Two gotchas worth repeating

- `doc/` and `docs/` are **different folders**. Product/sprint thinking in `doc/`; architecture/requirements/ops runbooks in `docs/`.
- Rate limiting is enabled on public endpoints. Tests that hit auth in a loop need `RATE_LIMIT_DISABLED=1` (see commit `4f8a447`).
