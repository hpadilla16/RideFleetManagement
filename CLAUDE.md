# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Ride Fleet Management — a multi-tenant SaaS for vehicle rental operations, a car-sharing marketplace, and dealership loaner programs. Monorepo with a Node/Express backend, a Next.js frontend (with Capacitor mobile shell), and PostgreSQL via Prisma.

## Repository Layout

- `backend/` — Express API (ES modules). Entry: `src/main.js`. Cluster entry: `src/cluster.js`. Modules live under `src/modules/<domain>/` and each exposes `*.routes.js`, `*.service.js`, and `*.rules.js` (validators). Shared helpers in `src/lib/` (prisma, cache, tenant-scope, errors, logger, mailer, sentry).
- `backend/prisma/` — Prisma schema (`schema.prisma`, ~2k lines) + migration history under `migrations/`.
- `backend/scripts/` — Seed + verification CLIs (`seed-bootstrap`, `seed-booking-fixtures`, `tenant-seed-beta`, `tenant-seed-superadmin`, `tenant-tests/run-suite.mjs`, `backfill-legacy-metadata`).
- `frontend/` — Next.js 14 App Router app (`src/app/...`), shared UI in `src/components/`, client/i18n/sentry helpers in `src/lib/`, component tests in `test/` (Vitest + Testing Library), planner node-test files colocated as `*.test.mjs`.
- `frontend/mobile-shell/`, `android/`, `ios/`, `capacitor.config.js` — Capacitor wrapper for the mobile build.
- `docs/` — Product + architecture + ops docs. Start with `docs/architecture/overview.md`, `docs/architecture/SCALING_ROADMAP.md`, `docs/operations/*`.
- `ops/` — PowerShell automations for local/staging/prod (`start-day.ps1`, `stop-day.ps1`, `set-env.ps1`, `deploy-beta.ps1`, `rollback-beta.ps1`).
- `scripts/` — Python generators for marketing/training artifacts (docx/pdf/pptx). Not part of the runtime.
- Top-level `.docx`/`.md` files are business/legal deliverables, not code.

## Common Commands

### Full stack (Docker)

```bash
docker compose up --build              # dev: db + backend + frontend
docker compose -f docker-compose.prod.yml up -d --build   # production profile
```

Dev defaults: frontend `http://localhost:3000`, backend `http://localhost:4000`, Postgres on host port `5433`. The backend container runs `npm install && npx prisma generate && npx prisma db push && npm run dev` on start.

PowerShell one-shots (wrap `docker compose` + health checks):
```powershell
powershell -ExecutionPolicy Bypass -File .\ops\start-day.ps1 [-Rebuild] [-Env local|staging|production]
powershell -ExecutionPolicy Bypass -File .\ops\stop-day.ps1
powershell -ExecutionPolicy Bypass -File .\ops\set-env.ps1 -Target staging|production
```

### Backend (`cd backend`)

```bash
npm run dev                   # node src/main.js, PORT defaults to 4000
npm run start:cluster         # multi-worker (honors CLUSTER_WORKERS)
npm run prisma:generate       # after any schema change
npm run prisma:migrate        # prisma migrate dev --name init (dev flow)
npm run prisma:studio
npm run seed:bootstrap
npm run seed:booking-fixtures && npm run verify:booking-fixtures
npm run backfill:legacy-metadata
npm test                      # runs the full per-module test chain
npm run verify                # alias of npm test
# Run one suite (uses node --test):
npm run test:vehicles | test:planner | test:rates | test:portal | test:carsharing \
              | test:issues   | test:tolls   | test:sms   | test:payments | test:auth \
              | test:cache    | test:commissions
# Run a single file:
node --test backend/src/modules/<path>/<name>.test.mjs
```

Env: `backend/.env` must set at minimum `DATABASE_URL` and `JWT_SECRET` (boot calls `assertAuthConfig()` and will throw without it). Optional: `ALLOWED_ORIGINS` (comma-list, default localhost:3000), `SENTRY_DSN`, `CLUSTER_WORKERS`, `DATABASE_POOL_SIZE`, `DATABASE_POOL_TIMEOUT`, `REDIS_URL` (future — see Scaling Roadmap).

### Frontend (`cd frontend`)

```bash
npm run dev                  # next dev -p 3000
npm run build                # next build
npm run start                # next start -p 3000
npm test                     # planner node-tests + vitest components
npm run test:planner         # node --test src/app/planner/*.test.mjs
npm run test:components      # npx vitest run
npm run verify               # test + build
# Mobile (Capacitor):
npm run mobile:add:android | mobile:add:ios | mobile:copy | mobile:sync | mobile:open:android | mobile:open:ios
```

Frontend reads `NEXT_PUBLIC_API_BASE` (defaults to `http://localhost:4000` in compose). Sentry knobs: `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENV`, `NEXT_PUBLIC_SENTRY_RELEASE`, `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`.

### Tenant-isolation suite (matches CI)

```bash
docker compose up -d --build
docker exec fleet-backend sh -lc "cd /app && node scripts/tenant-seed-beta.mjs && node scripts/tenant-seed-superadmin.mjs"
docker exec fleet-backend sh -lc "cd /app && node scripts/tenant-tests/run-suite.mjs"
```

## Architecture — Big Picture

### Backend request pipeline

Every API route is mounted in `backend/src/main.js` and passes through a consistent chain:

1. `compression` → `requestLogger` → `cors` (`ALLOWED_ORIGINS`) → `express.json({ limit: '50mb' })` that also captures `req.rawBody` / `req.rawBodyBuffer` (needed for webhook signature checks).
2. `requireAuth` (Bearer JWT) — verifies with `getJwtSecret()`, then `authService.getSessionUser()` re-hydrates the user from DB so role/module-access/tenant changes take effect within the 30s auth cache TTL (see Scaling Roadmap for the staleness trade-off).
3. `requireModuleAccess('<moduleKey>')` — per-user module flags; `SUPER_ADMIN` bypasses.
4. `requireRole(...roles)` — RBAC check; `SUPER_ADMIN` bypasses.
5. Module router (e.g. `/api/reservations`, `/api/car-sharing`, …).
6. `appErrorHandler` maps `AppError` subclasses (`ValidationError`, `NotFoundError`, …) to status codes; a terminal handler sends everything else to Sentry and returns 500.

Public surfaces that do NOT require auth are mounted under `/api/public/*` (customer portal, public booking, public issue submission, public telematics) and `/api/auth`. `/health` returns DB check + Sentry status. `/api/docs/openapi.json` + `/api/docs` serve a Swagger UI from `backend/src/docs/openapi.js`.

### Module convention

Each `backend/src/modules/<domain>/` follows this pattern:

- `*.routes.js` — Express `Router`, handler-per-endpoint. Handlers call `scopeFor(req)` (or `crossTenantScopeFor`/`carSharingScopeFor` from `lib/tenant-scope.js`) to get the tenant filter, then delegate to the service.
- `*.service.js` — Prisma calls + business logic. Always takes an explicit `scope`/`tenantId` argument; never reaches into `req`.
- `*.rules.js` — Pure validators (`validate<Entity>Create`, `validate<Entity>Patch`) used by routes.
- `*.test.mjs` — `node --test` suites that exercise service logic against fakes (no live DB).
- Optional `*.scheduler.js` — cron-like workers. Only started on the first cluster worker (`cluster.worker.id === 1`) to avoid double-runs. Currently: `tolls.scheduler` and `car-sharing.scheduler`. They must export `start…Scheduler`/`stop…Scheduler` and be wired into SIGINT/SIGTERM cleanup in `main.js`.

### Multi-tenancy — read this before touching any service

Tenant isolation is a beta-validated invariant (see `BETA_TENANT_ISOLATION_CHECKLIST.md`). Rules:

- Every tenant-scoped Prisma query MUST be filtered through one of the helpers in `backend/src/lib/tenant-scope.js`:
  - `scopeFor(req)` — default; returns `{ tenantId }` for normal users, `{}` or `{ tenantId: <query> }` for `SUPER_ADMIN`.
  - `crossTenantScopeFor(req)` — used by reservations/vehicles; adds `allowCrossTenant` for super-admins.
  - `carSharingScopeFor(req)` — includes `allowUnassigned` for marketplace listings.
- Non-super-admins missing a `tenantId` are served a **deny-all sentinel** (`tenantId: '__no_tenant__'`) — fail-closed, never return all tenants' data.
- `isSuperAdmin(user)` is the only sanctioned escape hatch; it short-circuits both `requireRole` and `requireModuleAccess`.
- When you add a new entity, add `tenantId` on the Prisma model, a matching scope filter in the service, and a migration (follow the existing `YYYYMMDD_<purpose>` naming under `backend/prisma/migrations/`).

### Roles and module access

- Roles (`UserRole` enum): `SUPER_ADMIN`, `ADMIN`, `OPS`, `AGENT`. `TRAINING_GUIDE.md` documents de-facto additional labels (Customer Service, Host) that are expressed via module-access flags, not the enum.
- Module keys used in `requireModuleAccess(...)` include: `hostApp`, `employeeApp`, `loaner`, `issueCenter`, `tolls`, `planner`, `reservations`, `customers`, `vehicles`, `settings`, `reports`, `carSharing`, `people`, `tenants`. Keep this list in sync if you add a module.

### Frontend architecture

- Next.js 14 App Router. Top-level routes in `frontend/src/app/*` correspond to product areas (dashboard, reservations, vehicles, planner, car-sharing, host, employee, customer-display kiosk, loaner, knowledge-base, tenants, …).
- Shared shell: `components/AppShell.jsx` (web) and `components/MobileAppShell.jsx` (Capacitor). `AuthGate.jsx` guards authenticated routes. `I18nBoot.jsx` + `src/locales/*` drive i18next. `SentryBoot.jsx` wires browser Sentry.
- API client and module-access helpers: `src/lib/client.js`, `src/lib/moduleAccess.js`. Don't hand-roll `fetch` calls in pages — go through the client so headers/base URL stay consistent.
- Planner business logic has the deepest logic concentration and the most tests (`src/app/planner/planner-*.test.mjs`). Component tests run under Vitest + jsdom (`vitest.config.js`, setup in `test/setup.js`).

### Caching and scaling caveats

`backend/src/lib/cache.js` is a per-process in-memory `Map`. In cluster mode each worker has its own copy — invalidations only reach the worker that wrote. Consequences:

- Auth session cache TTL is intentionally short (30s) to bound staleness after role/module-access edits.
- The 30s reservation token-issuance cooldown in `reservations.routes.js` is per-worker; a 4-worker cluster currently allows 4× the issuance rate.
- Before enabling multi-host deployment, follow the migration plan in `docs/architecture/SCALING_ROADMAP.md` (Redis-backed cache with the same `get/set/del/invalidate/getOrSet/stats` interface; set `REDIS_URL` to activate).

## CI / Release

`.github/workflows/beta-ci.yml` runs on PRs to `main`/`develop` and on `v*` tags:

1. `frontend-build` — `npm ci && npm run build` (Node 22).
2. `backend-check` — `npm ci && npm run prisma:generate && node --check src/main.js` (syntax check; no live DB tests yet).
3. `tenant-isolation-suite` — `docker compose up`, seeds two tenants + super-admin, runs `scripts/tenant-tests/run-suite.mjs`, dumps logs on failure. **Do not break this job**; it guards the beta tenant-isolation invariant.

Release flow (see `docs/operations/version-control-and-release.md`):

- Branches: `main` (live beta), `develop` (integration), `feature/*`, `hotfix/*`.
- Beta tag pattern: `v0.9.0-beta.N`; emergency patch: `v0.9.0-beta.N+hotfix.M`. Every deploy must map to a tag.
- Ship via `ops/deploy-beta.ps1 -Tag <tag>`; roll back via `ops/rollback-beta.ps1`.
- Keep commits/PRs narrow — one concern per PR.

## Local Gotchas

- Postgres container exposes port **5433** on the host (not 5432); `DATABASE_URL` in `backend/.env` should match.
- `express.json` limit is **50 MB** because inspection packets/attachments are embedded base64 in some payloads. Don't lower it without auditing issue-center/rental-agreements first.
- `puppeteer` is a backend dep (used for PDF generation); the prod image sets `PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome`. Locally, install system Chrome or rely on the bundled Chromium — but expect the first install to be large.
- Schedulers only run on cluster worker #1. If you add one, wire both `start…` into `app.listen` (inside `isFirstWorker`) and `stop…` into the SIGINT/SIGTERM handlers in `backend/src/main.js`.
- Timestamped seed/verify scripts assume a freshly booted stack; run `tenant-seed-*` before `tenant-tests/run-suite.mjs`.

## Cross-machine session continuity (Hector's Windows + MacBook)

Hector works on this repo from two machines (Windows desktop and MacBook) and expects Claude to pick up where the previous session left off regardless of which machine is active. Cowork's local memory does NOT sync between machines, so we use a Google-Drive-hosted handoff file.

**Canonical location:** `Google Drive → /RideFleet/Claude-Sessions/SESSION_HANDOFF.md`

The file at the repo root (`SESSION_HANDOFF.md`) is only a stub pointing to Drive. Do not treat it as the source of truth — it is intentionally a redirect.

**At the START of every session, before anything else, Claude must:**

1. Read the canonical `SESSION_HANDOFF.md` from Google Drive at `/RideFleet/Claude-Sessions/SESSION_HANDOFF.md`. Prefer the Google Drive MCP connector (tools named `mcp__*__read_file_content` or `search_files`); fall back to asking Hector to paste the contents if the connector is not available.
2. Use the handoff as the source of truth for "what were we doing last time?" — not Cowork's local memory (which diverges between the two machines) and not the stub in the repo.
3. If the handoff says the last session was on a different machine than the current one, remind Hector to `git pull` before editing anything.

**At the END of every session, Claude must:**

1. Update the canonical handoff in Drive (`/RideFleet/Claude-Sessions/SESSION_HANDOFF.md`) following the rules at the bottom of that file (last session date, machine used, active branch, last commit, what we were doing, pending items, files touched). Move the prior "Last session" block into the "Previous sessions" archive at the bottom.
2. Upload via the Drive MCP `create_file` / equivalent replace call. If the MCP is unavailable, write the updated content to a local scratch file and tell Hector explicitly so he can upload it manually — never silently skip the update.
3. Do NOT update the repo stub. The stub content is static; updating it creates divergence with Drive.
