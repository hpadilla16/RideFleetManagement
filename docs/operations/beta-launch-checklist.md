# Beta Launch Checklist (Step-by-Step)

Use this as the execution runbook when returning to the machine.

## Phase 0 — Freeze + Safety (before any deploy)
- [ ] Confirm current app works locally for critical flows.
- [ ] Create release branch from current state:
  - `git checkout -b release/beta-YYYYMMDD`
- [ ] Tag baseline commit:
  - `git tag beta-baseline-YYYYMMDD-HHMM`
- [ ] Push branch + tag to remote:
  - `git push origin release/beta-YYYYMMDD --tags`
- [ ] DB backup now (pre-launch snapshot).
- [ ] Save `.env` and secrets in your secure store (not in git).

## Phase 1 — Repository Hygiene
- [ ] Archive temp scripts from repo root (`tmp_*`) into:
  - `backups/phased-rebuild/tmp-scripts-archive/YYYY-MM-DD/`
- [ ] Ensure `.gitignore` excludes local temp artifacts, logs, and dumps.
- [ ] Confirm no credentials or private keys are tracked.
- [ ] Commit cleanup separately (small, reversible commit).

## Phase 2 — Version Control Workflow (required)
- [ ] Adopt branch model:
  - `main` = stable production
  - `develop` = integration
  - `hotfix/*` = urgent live fixes
  - `feature/*` = normal work
- [ ] Require PRs for `main` merges (even if self-review).
- [ ] Require checks before merge:
  - Frontend build pass
  - Backend syntax/prisma generate pass
  - Smoke test checklist pass
- [ ] Use semantic tags for deploys:
  - `v0.9.0-beta.1`, `v0.9.0-beta.2`, etc.

## Phase 3 — Deployment Topology (live + updateable)
- [ ] Keep one stable environment for beta users.
- [ ] Add/update strategy that supports safe live fixes:
  - Preferred: **Blue/Green** (stand up new version, switch traffic)
  - Acceptable: **Rolling restart** with health checks
- [ ] Create production compose file (`docker-compose.prod.yml`) with:
  - immutable images / pinned tags
  - `npm start` (not dev mode)
  - restart policies
  - healthcheck blocks
- [ ] Configure reverse proxy (Nginx/Caddy) + TLS.
- [ ] Enable structured logs + log retention.

## Phase 4 — Security + Dependency Baseline
- [ ] Resolve/accept current advisories explicitly:
  - Next.js: currently upgraded to 14.2.35, still advisory path exists for later versions.
  - Nodemailer: evaluate upgrade path and compatibility test.
- [ ] Lock versions with package-lock and commit.
- [ ] Enable automated dependency scanning in CI.
- [ ] Add basic rate limiting and request size limits at backend/proxy.

## Phase 5 — Data + Migration Discipline
- [ ] Verify Prisma schema and migration state are consistent.
- [ ] Define migration rule:
  - never run destructive migration without backup
  - test migration on staging snapshot first
- [ ] Create rollback protocol:
  - app rollback to previous tag
  - DB rollback/restore decision tree

## Phase 6 — Beta Smoke Tests (must pass)
- [ ] Tenant isolation sanity check (tenant A/B + super admin).
- [ ] Reservation lifecycle:
  - create ? checkout ? checkin ? close
- [ ] Charges flow:
  - charges table reflects correct total
  - View Payments receives non-zero total when expected
  - OTC payment decreases unpaid balance correctly
- [ ] Inspection flow:
  - capture required photos
  - compare/report pages open and render
- [ ] Agreement/communications:
  - print agreement
  - email agreement/detail

## Phase 7 — Go-Live Execution
- [ ] Announce beta launch window and freeze non-critical changes.
- [ ] Deploy tagged release (`v0.9.0-beta.X`).
- [ ] Run post-deploy health checks:
  - app up
  - API reachable
  - login works
  - create reservation works
- [ ] Confirm monitoring/alerts active.
- [ ] Record launch notes + known issues list.

## Phase 8 — Live Update Process (hotfix + upgrades while live)
- [ ] For urgent fixes:
  1. branch from `main` ? `hotfix/<issue>`
  2. implement minimal fix
  3. run build + smoke subset
  4. tag `v0.9.0-beta.X+hotfix.N`
  5. deploy via blue/green or rolling
  6. verify + close incident note
- [ ] For normal improvements:
  - merge through `develop` and batch into scheduled beta drops
- [ ] Keep changelog per release tag.

## Phase 9 — Minimal CI/CD (recommended now)
- [ ] On each PR: run frontend build + backend checks.
- [ ] On tag push: build and publish deployable images.
- [ ] Manual approval gate before production deploy.
- [ ] Deploy script supports:
  - target tag input
  - preflight checks
  - healthcheck wait
  - auto-rollback on failed healthcheck

## Phase 10 — Operations Cadence During Beta
- [ ] Daily:
  - review errors/logs
  - review top user-reported issues
- [ ] Weekly:
  - dependency/security review
  - DB backup restore test
  - performance review on slow routes
- [ ] After each deploy:
  - write release note + rollback point

---

## Quick Start When You Return (exact order)
1. [ ] Create release branch + tag baseline
2. [ ] Archive `tmp_*` scripts
3. [ ] Set up `docker-compose.prod.yml`
4. [ ] Run full beta smoke checklist
5. [ ] Deploy first beta tag
6. [ ] Monitor 30–60 min
7. [ ] Open hotfix pipeline for live updates