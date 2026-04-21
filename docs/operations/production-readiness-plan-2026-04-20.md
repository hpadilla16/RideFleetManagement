# Production Readiness Plan: 90-Day Roadmap for 200-User Scale
**Date:** 2026-04-20  
**Target:** 200 concurrent users by end of July 2026, sustain 100+ users/year growth thereafter  
**Owner:** solution-architect  
**Status:** Proposed

---

## 1. Executive Summary

Ride Fleet Management is at **v0.9.0-beta.3** with 24h soak in progress. Infra is a single $58/mo DO droplet (2GB RAM, 1 vCPU) at 1.34% CPU, 22.8% memory utilization; plenty of headroom for growth to 200 users. Checkout performance has improved from ~12s to ~7-8s via PR 1–3.2; PR 4 (Promise.all parallelization) is pending re-ship. **Top 3 risks at 200-user scale:** (1) no backup/restore process — data loss scenario exists; (2) slow reservation queries on 50K+ agreement rows without indexes; (3) cache inconsistency across cluster workers if we enable multi-process. **Top 3 wins ready to ship:** (1) checkout P95 target of ≤5s is achievable with PR 4 + selective query optimization; (2) tenant isolation is beta-validated and release-ready; (3) competitive differentiation (Issue Center claims workspace, Smart Planner, car-sharing tenant governance) is built and just needs polish. This plan deploys reliability + performance foundations (Wave 1–2), then closes competitive gaps at scale (Wave 3), with ops polish and sustain buffer in Wave 4. Total cost delta $50–100/mo to hit all SLOs.

---

## 2. Current State Inventory

| Component | Status | Health | Risk | Notes |
|-----------|--------|--------|------|-------|
| **Infra** | Single DO droplet ubuntu-s-1vcpu-2gb-nyc3 | Healthy | Low | $58/mo; 1.34% CPU, 22.8% mem. No HA, no failover. |
| **Database** | PostgreSQL 16 Alpine in Docker Compose | Running | Low | Local single-instance; no backups automated. No indexes beyond schema defaults. |
| **Backend** | Express/Node.js ES modules, v0.9.0-beta.3 | Healthy | Low | Cluster mode ready (CLUSTER_WORKERS=4 possible). In-memory cache per worker (staleness issue at scale). |
| **Frontend** | Next.js 14 App Router, v0.9.0-beta.3 | Healthy | Low | Deployed to same droplet via Nginx. Checkout flow ~7-8s P95 (target ≤5s). |
| **Tenant Isolation** | Multi-tenant RBAC + scope filters | Beta-validated | Low | Fail-closed deny-all sentinel in place. CI guards via tenant-isolation-suite. |
| **Auth** | JWT + RBAC + 30s session cache | Healthy | Low | isSuperAdmin() escape hatch present. Module-access enforcement in place. |
| **Cache** | In-memory Map per worker | Works | Med | Per-worker staleness if CLUSTER_WORKERS>1. Rate-limiter cooldown is per-worker (4× allowed rate on 4-worker cluster). |
| **Schedulers** | tolls.scheduler, car-sharing.scheduler | Running | Low | Only fire on cluster worker #1. Wired into SIGINT/SIGTERM cleanup. |
| **Email** | Async (PR 1) via fire-and-forget setImmediate | Healthy | Low | Puppeteer singleton pools browser. SMTP via Nodemailer. No queue/retry logic. |
| **Payments** | Stripe integration (routes + webhook) | Implemented | Med | Public webhook hardening pending (Phase 1 backlog). Rate limiting not implemented. |
| **Observability** | Sentry (error tracking), structured logs | Partial | Med | No Prometheus metrics, no distributed tracing, no request ID propagation. 24h soak in progress. |
| **CI/CD** | GitHub beta-ci.yml (frontend build + backend check + tenant-isolation-suite) | Running | Low | Tenant-isolation-suite is critical guard — do not break. |
| **Mobile** | Capacitor shell (Android/iOS buildout pending) | Stub | Med | iOS/Android shells exist; fully mapped app routes missing. Cross-platform sync untested. |
| **Backups** | Manual snapshots only (no automation) | Missing | **High** | No off-site replication. No recovery testing. Single-copy failure = total loss. |
| **Docs** | Architecture, operations, phase-1 backlog present | Current | Low | Agent role docs in `.claude/agents/`. PR workflow documented. |

---

## 3. Risks at 200-User Scale (If We Do Nothing)

| Risk | Likelihood | Blast Radius | Current Mitigation | Why It Matters at 200 Users |
|------|------------|--------------|-------------------|------------------------------|
| **No backup → catastrophic data loss** | Medium | Total | Manual DO snapshots only | At 10 users, data loss might be painful. At 200, you lose months of rental history, billing records, claims evidence — compliance + legal nightmare. |
| **Slow queries on 50K+ agreements** | High | UX degradation | Query counts not measured | Reservation list load is currently O(1) because data is sparse. At 200 users × ~10 agreements/user, ILIKE '%foo%' searches become 500ms–1s. Blocks staff workflows. |
| **Cache inconsistency on multi-worker cluster** | Medium (if we enable CLUSTER_WORKERS>1) | Auth/role staleness | 30s TTL bound | Running 4 workers locally? Each has its own Map. A role change on worker 1 doesn't reach worker 2 for 30s. At 200 users, that's visible — someone logs in, is promoted, but still sees old UI. |
| **Email queue overflow (fire-and-forget)** | Low | Email latency | Async via setImmediate | Currently ~100–200 emails/day. At 200 users × 5 emails/rental, peak could be 1K emails/day. setImmediate doesn't persist — process crash = lost emails. |
| **No rate limiting on public endpoints** | High | Abuse/DoS | None | Zubie webhook (vehicle telematics), public booking, issue submission endpoints have no per-IP limits. 1 attacker can spam with 1000 requests/sec and block legitimate traffic. |
| **Single host, no failover** | Low (uptime bias toward stability) | Downtime | None | The droplet dies, all 200 users are down. Recovery = rebuild + restore from backup (if backup exists). RTO/RPO undefined. SLA of 99.5% requires ≤3.5h/mo downtime; single host can't guarantee that. |
| **Planner queries on 500+ vehicles** | Low | Planner latency (not critical path) | Query simplification done in PR 3.2 | At 50 vehicles the board is snappy. At 200 vehicles (200 users ÷ average fleet size), getSnapshot might hit 2s. Not SLA-blocking but annoying. |
| **TLS certificate expires** | Very Low | Downtime | Auto-renewal via Certbot assumed | Real but handled by ops automation. |

---

## 4. Improvement Plan — Four 3-Week Waves

### Wave 1: Weeks 1–3 — Reliability Foundations

**Theme:** Backups, observability, uptime, PR 4 re-ship, and public endpoint hardening.

---

#### Item 1.1: Automated Daily Backups + Off-Site Replication

**Problem:** No off-site copy of data. Disk failure = total loss. DigitalOcean snapshots exist but are on-droplet; ransomware or operator error deletes both.

**Solution:**  
1. Enable DigitalOcean Spaces (S3-compatible object storage, $5/mo for 250GB).
2. Create `backup/backup.sh` script that:
   - Runs daily at 02:00 UTC (off-peak).
   - Calls `pg_dump -Fc` (custom format, compressible).
   - Uploads `.dump` to Spaces with timestamp: `fleet-prod-2026-04-21.dump`.
   - Keeps last 30 days (rotate via script).
   - Writes log entry to Sentry on success/failure.
3. Create `backup/restore.sh` script (tested monthly on a staging snapshot).
4. Wire cron job into Docker Compose via a sidecar container or host crontab.

**Files/modules touched:**
- `ops/backup.sh` (new)
- `ops/restore.sh` (new)
- `docker-compose.prod.yml` (add backup sidecar or note cron instruction)
- `docs/operations/backup-runbook.md` (new — step-by-step restore)

**Agent owner:** digitalocean-infra-expert

**Effort:** M (3–5 days including testing, runbook, and one full restore validation)

**Deps:** None.

**Risk:** Low. Backup jobs are isolate and can fail gracefully (log + alert, don't break app).

---

#### Item 1.2: Structured Observability + Request Tracing

**Problem:** Errors go to Sentry but we have no request-level traces, no latency percentiles by endpoint, no distributed tracing for cross-service calls (none exist yet, but planner → vehicle queries would benefit).

**Solution:**  
1. Add request ID middleware to `backend/src/main.js`: on every request, generate/propagate UUID via `x-request-id` header.
2. Emit structured logs to stderr with JSON format (timestamp, level, msg, request_id, duration_ms, user_id, module).
3. Add basic Prometheus metrics collection (`npm install prom-client`):
   - `http_requests_total` (labeled by endpoint, method, status).
   - `http_request_duration_seconds_bucket` (P50, P95, P99 for each endpoint).
   - `database_query_duration_seconds_bucket` (per Prisma query type).
   - `cache_hits_total`, `cache_misses_total`.
4. Expose `/metrics` endpoint (not authenticated, must be internal-only or IP-restricted in nginx).
5. Optional: wire Sentry transaction tracing to sampler at 10% for performance visibility.

**Files/modules touched:**
- `backend/src/main.js` (add request ID middleware, prom-client setup)
- `backend/src/lib/logger.js` (enhance JSON output)
- `backend/src/lib/cache.js` (add hit/miss counters)
- New file: `backend/src/lib/metrics.js` (Prometheus collectors)
- `docker-compose.prod.yml` (add Prometheus scrape note if using external Prometheus)

**Agent owner:** performance-engineer

**Effort:** M (4–6 days; Prometheus integration, testing, alerts setup)

**Deps:** None (Sentry already in place).

**Risk:** Low. Metrics collection is additive and won't block requests on failure.

---

#### Item 1.3: PR 4 Re-ship — Promise.all for Checkout Parallelization

**Problem:** PR 4 was merged then reverted because the frontend page.js was truncated (failed atomic write from sandbox). Branch `feature/checkout-perf-pr4` at `7b406ca` has the bad version. Re-implement and test carefully.

**Solution:**  
1. Create new branch `feature/checkout-perf-pr4-reship` from current `main`.
2. Reimplement the Promise.all parallelization from design intent (not from broken code):
   - `PUT /rental-agreements/:id/rental` + `GET /rental-agreements/:id/inspection-report` in parallel before `POST /rental-agreements/:id/signature`.
   - Frontend `reservations/[id]/checkout/page.js` calls both via Promise.all instead of sequential awaits (lines ~150–165).
3. Measure P95 latency before/after: target ~7-8s → ~5-7s (additional 1-2s saved).
4. Run full test suite + 24h soak on staging before prod deploy.

**Files/modules touched:**
- `frontend/src/app/reservations/[id]/checkout/page.js` (lines ~150–165 refactor)
- `frontend/src/lib/client.js` (no changes; already supports parallel requests)
- No backend changes (endpoints already fast enough).

**Agent owner:** senior-react-developer + performance-engineer (parallel)

**Effort:** S (2–3 days; careful code review, measurement, soak)

**Deps:** Item 1.2 (observability) helps measure impact.

**Risk:** Med. This is a regression risk if not tested thoroughly. Must run tenant-isolation-suite + full checkout flow before merge.

---

#### Item 1.4: Public Endpoint Hardening + Basic Rate Limiting

**Problem:** Zubie webhook, public booking, public issue submission endpoints are wide open. No per-IP rate limit, no idempotency key validation, no abuse detection.

**Solution:**  
1. Create `backend/src/middleware/rate-limiter.js` (in-memory token bucket per IP):
   - Default: 100 req/min per IP.
   - Public endpoints: 1000 req/hour per IP.
   - Webhook endpoints: 1000 req/hour per IP (Zubie pushes every 5s, so 720/day is safe).
2. Create `backend/src/middleware/idempotency.js`:
   - Accept optional `Idempotency-Key: <uuid>` header.
   - Cache response for 24h (store in Redis once Redis lands; use in-memory for now).
   - Return cached response if duplicate key seen (prevents Zubie retries from double-applying).
3. Wire both into `backend/src/main.js` before route handlers.
4. Update Swagger docs to document headers.

**Files/modules touched:**
- `backend/src/main.js` (wire middleware)
- New files: `backend/src/middleware/rate-limiter.js`, `backend/src/middleware/idempotency.js`
- `backend/src/docs/openapi.js` (document headers)

**Agent owner:** security-engineer

**Effort:** M (3–5 days; testing edge cases, header validation)

**Deps:** None.

**Risk:** Low. Rate limiter can be logged-only (warn, don't block) for first week, then enforced.

---

#### Item 1.5: Sentry Error Budget + Alert Thresholds

**Problem:** Sentry exists but we have no alerting rules, no error budget, no "when to page ops" definition.

**Solution:**  
1. Define error budget: max 0.5% error rate (5 errors per 1000 requests).
2. Configure Sentry alerts:
   - Alert if error rate >1% in 5 min window.
   - Alert if any new error type appears (not seen in last 7 days).
   - Alert on 5xx responses (error count >10 in 1 min).
   - Slack/email notifications to ops channel.
3. Weekly review of Sentry top-10 errors; triage for bug vs. config.

**Files/modules touched:**
- `docs/operations/monitoring-and-alerts.md` (new)
- Sentry UI configuration (not in code repo)

**Agent owner:** digitalocean-infra-expert + qa-engineer

**Effort:** S (2 days; config + runbook)

**Deps:** Item 1.2 (observability).

**Risk:** Low.

---

### Wave 2: Weeks 4–6 — Performance Polish + Query Optimization

**Theme:** Database indexes, slow-path hunts, load testing, cache readiness for multi-worker.

---

#### Item 2.1: Database Indexes for Hot Paths

**Problem:** Schema has basic indexes (PK, FK, unique constraints) but no compound indexes on filter-heavy queries. Reservation list search on `tenantId + createdAt`, rental agreement search on `tenantId + status`, vehicle availability checks on `tenantId + location` are all table scans once data grows.

**Solution:**  
1. Audit slow queries from Sentry + local profiling:
   - `reservations.service.js::list()` — filter by tenantId, dateRange, status.
   - `rental-agreements.service.js::list()` — filter by tenantId, status, dueAt.
   - `vehicles.service.js::listAvailable()` — filter by tenantId, location, maintenanceStatus.
   - `planner.service.js::getSnapshot()` — multiple vehicle queries by tenantId + status.
2. Add indexes:
   ```sql
   CREATE INDEX idx_reservations_tenant_created ON Reservation(tenantId, createdAt DESC);
   CREATE INDEX idx_rental_agreements_tenant_status ON RentalAgreement(tenantId, status);
   CREATE INDEX idx_vehicles_tenant_location ON Vehicle(tenantId, location, maintenanceStatus);
   CREATE INDEX idx_charges_agreement_status ON Charge(rentalAgreementId, status);
   ```
3. Migration naming: `20260421_add_composite_indexes_hot_paths.sql`
4. Run `EXPLAIN ANALYZE` before/after to confirm improvement.

**Files/modules touched:**
- `backend/prisma/migrations/20260421_add_composite_indexes_hot_paths/migration.sql` (new)
- `backend/prisma/schema.prisma` (if using Prisma native indexes, add `@@index` directives)

**Agent owner:** supabase-db-expert

**Effort:** M (3–5 days; profiling, testing, validation)

**Deps:** Item 1.2 (observability helps identify slow queries).

**Risk:** Low. Index creation online doesn't block writes.

---

#### Item 2.2: Query Count Reduction — Planner + Vehicle Services

**Problem:** Planner's `getSnapshot()` and Vehicle's `listAvailable()` fire multiple sequential Prisma queries to gather state (assignments, inspections, charges, telematics). Each query is small but adds up to 50–100ms latency per API call.

**Solution:**  
1. Refactor `planner.service.js::getSnapshot()` to batch Prisma `$transaction()` calls:
   - Load all vehicles in one query with `include: { assignments, inspections, ... }`.
   - Load all reservations in one query.
   - Load all charges/fees in one query.
   - Process results in memory (no N+1 queries).
2. Refactor `vehicle.service.js::listAvailable()` similarly.
3. Measure latency before/after (target: reduce from 8–10 queries to 3–4).

**Files/modules touched:**
- `backend/src/modules/planner/planner.service.js` (refactor getSnapshot)
- `backend/src/modules/vehicles/vehicles.service.js` (refactor listAvailable)

**Agent owner:** senior-backend-developer

**Effort:** M (5–7 days; careful refactoring, testing)

**Deps:** Item 2.1 (indexes help).

**Risk:** Med. This touches critical paths; must run full test suite.

---

#### Item 2.3: Load Testing + Baseline Latency Profile

**Problem:** We have no load test. Don't know if P95 checkout latency holds at 50 concurrent users.

**Solution:**  
1. Create `backend/load-test/checkout-flow.k6.js` (k6/Grafana tool, standard in industry):
   - Simulate 10 → 50 → 100 concurrent users.
   - Each user: login → create reservation → checkout → finalize.
   - Measure P50, P95, P99 latency per endpoint.
   - Baseline for before/after of Wave 2 optimizations.
2. Run on staging (separate DO droplet, temporary).
3. Record baseline CSV; commit to repo for future comparisons.
4. Alert if P95 degradation >10% in CI.

**Files/modules touched:**
- New directory: `backend/load-test/` with k6 scripts
- `docs/operations/load-testing-runbook.md` (new)

**Agent owner:** performance-engineer

**Effort:** M (3–5 days; script setup, staging infra, baseline run)

**Deps:** Item 1.2 (observability).

**Risk:** Low. Load test is read-only if run against a snapshot.

---

#### Item 2.4: Redis Cache Migration (Conditional)

**Problem:** If CLUSTER_WORKERS>1 is enabled locally or in staging, per-worker cache causes 30s staleness on role changes. At 200 users, invisible but operationally risky.

**Solution:**  
1. Create `backend/src/lib/cache-redis.js` (implements same interface as `cache.js`):
   - `get(key)` → Redis GET.
   - `set(key, value, ttl)` → Redis SET EX.
   - `del(key)` → Redis DEL.
   - `invalidate(prefix)` → Redis SCAN + DEL batching.
   - Fallback to in-memory on Redis outage (log warn, don't crash).
2. Update `backend/src/lib/cache.js` to be a facade:
   - If `REDIS_URL` set, return Redis impl.
   - Else return in-memory Map.
3. Update `docker-compose.yml` and `docker-compose.prod.yml` to include `redis:7-alpine` container.
4. Set `REDIS_URL` in prod compose.

**Files/modules touched:**
- New file: `backend/src/lib/cache-redis.js`
- Edit: `backend/src/lib/cache.js` (facade pattern)
- Edit: `docker-compose.yml`, `docker-compose.prod.yml` (add redis service)

**Agent owner:** senior-backend-developer + digitalocean-infra-expert

**Effort:** L (7–10 days; implementation, testing, monitoring)

**Deps:** None, but low priority if CLUSTER_WORKERS=1 in prod (it is for now).

**Risk:** Low. Interface is stable; fallback path preserves behavior.

**Note:** Conditional on Wave 2 decision. If uptime is solid through Wave 2 with single worker, defer to Wave 3.

---

### Wave 3: Weeks 7–9 — Competitive Differentiation at Scale

**Theme:** Feature polish, mobile app readiness, webhook/API maturity, telematics foundation.

---

#### Item 3.1: Mobile App Skeleton + Cross-Platform Sync

**Problem:** Capacitor shells (iOS/Android) exist but app routes are not fully mapped. Staff need PWA + mobile app for field checkout/checkin (rental operations), host app for handoff confirmation.

**Solution:**  
1. Map all core flows to mobile:
   - Checkout: camera → inspection → signature → finalize.
   - Checkin: location confirmation → damage photos → finalize.
   - Host handoff: guest confirmation → key exchange → trip complete.
2. Create `frontend/mobile-shell/src/App.jsx` (replaces default Capacitor template):
   - Routes to `/app/reservations/:id/checkout` (web) → reuse same Next.js route.
   - Plugins for camera, location, NFC (key reader future).
3. Build + deploy to iOS TestFlight + Android beta track (Firebase App Distribution).
4. Test: iOS 15+, Android 10+ (match market baseline).

**Files/modules touched:**
- `capacitor.config.ts` (update allowedUrls, plugins)
- `frontend/mobile-shell/src/App.jsx` (new)
- `frontend/src/app/reservations/[id]/checkout/page.js` (ensure responsive; already is)
- `docs/operations/mobile-deployment-runbook.md` (new)

**Agent owner:** senior-mobile-developer + senior-react-developer

**Effort:** L (8–12 days; platform setup, testing on devices, TestFlight submission)

**Deps:** PR 4 (checkout flow must be solid).

**Risk:** Med. iOS App Store / Google Play review can delay release by 2–3 days. Use TestFlight/beta track for early testing.

---

#### Item 3.2: Webhook Delivery + Event Schema

**Problem:** Webhooks were proposed in roadmap but not implemented. Payment module has some event hooks but no formal delivery, no signature verification, no retry logic.

**Solution:**  
1. Create `backend/src/lib/webhook-dispatcher.js`:
   - Enum: RESERVATION_CREATED, RESERVATION_UPDATED, AGREEMENT_FINALIZED, PAYMENT_POSTED, ISSUE_CREATED, ISSUE_UPDATED.
   - Queue system using Bull on Redis (once Redis lands) or simple database table `WebhookEvent` + polling (interim).
   - Signed payload: HMAC-SHA256 using tenant's webhook secret.
   - Retry logic: exponential backoff, 3 retries.
2. Create `backend/src/modules/integrations/webhook-config.routes.js`:
   - POST /webhook-config (register webhook URL + secret).
   - GET /webhook-config (list registered).
   - DELETE /webhook-config/:id (deregister).
3. Emit events from relevant services:
   - `reservations.service.js` → RESERVATION_CREATED/UPDATED.
   - `rental-agreements.service.js` → AGREEMENT_FINALIZED.
   - `payments.routes.js` → PAYMENT_POSTED.
4. Document webhook schema in Swagger (`backend/src/docs/openapi.js`).

**Files/modules touched:**
- New files: `backend/src/lib/webhook-dispatcher.js`, `backend/src/modules/integrations/webhook-config.routes.js`, `backend/src/modules/integrations/webhook-config.service.js`
- Edits: `backend/src/modules/reservations/reservations.service.js` (emit events)
- Edits: `backend/src/modules/rental-agreements/rental-agreements.service.js` (emit events)
- Edit: `backend/prisma/schema.prisma` (add WebhookConfig, WebhookEvent models)
- New migration: `20260428_add_webhook_models.sql`

**Agent owner:** integrations-specialist

**Effort:** L (8–12 days; schema design, retries, testing, documentation)

**Deps:** Redis migration (Wave 2.4) optional but nice for job queue.

**Risk:** Med. Webhook calls are network-dependent; must test failure scenarios carefully.

---

#### Item 3.3: Issue Center Hardening — Evidence Attachment + Claims Packet Polish

**Problem:** Issue Center stores evidence inline (JSON blobs). Claims packet is generated but lacks visual inspection compare and structured evidence types.

**Solution:**  
1. Create `backend/src/lib/object-storage.js` (S3-compatible abstraction):
   - Wrapper around DigitalOcean Spaces (or AWS S3).
   - Methods: `upload(filename, buffer)` → URL, `delete(url)`.
2. Migrate issue evidence to object storage:
   - Refactor `IssueEvidence` model to store {type, sourceModule, s3Url, uploadedAt}.
   - Create migration to export existing blobs to S3.
3. Enhance claims packet:
   - Include inspection compare side-by-side (checkout photo vs checkin photo).
   - Add evidence checklist with icons (damage type, severity, location on vehicle).
   - Add damage triage score (if AI signal available).
4. PDF generation via Puppeteer (already async).

**Files/modules touched:**
- New file: `backend/src/lib/object-storage.js`
- Edit: `backend/prisma/schema.prisma` (add IssueEvidence model with s3Url)
- Edits: `backend/src/modules/issue-center/issue-center.service.js` (use object storage)
- Edits: `backend/src/modules/issue-center/issue-center.routes.js` (upload endpoint)
- New migration: `20260430_issue_evidence_s3.sql`

**Agent owner:** senior-backend-developer + supabase-db-expert

**Effort:** L (8–12 days; S3 integration, migration, testing, packet redesign)

**Deps:** Item 2.1 (data should be stable).

**Risk:** Med. Data migration is delicate; must test on staging with production snapshot.

---

#### Item 3.4: Telematics Foundation + Zubie Hardening

**Problem:** Zubie webhook is a stub. No validation of payload schema, no handling of missing fields, no metadata tracking.

**Solution:**  
1. Harden `backend/src/modules/vehicles/telematics-zubie.routes.js`:
   - Validate payload schema (odometer, fuel, gps, timestamp are required).
   - Idempotency key validation (already added in Wave 1.4).
   - Store raw payload in `VehicleTelemetryEvent` table for audit + replay.
2. Create `backend/src/modules/vehicles/vehicle-telematics.service.js`:
   - Parse Zubie payload → normalize to internal schema.
   - Update vehicle record: odometer, fuel, lastGpsLocation, lastTelemSyncAt.
   - Trigger geofence alerts if vehicle left service area (stored procedure or query-based).
3. Create vehicle telematics dashboard view (frontend):
   - Show last odometer reading per vehicle.
   - Show trips (if Zubie provides; otherwise stub).
   - Alert on low fuel.
4. Document Zubie API contract in `docs/integrations/zubie-api.md`.

**Files/modules touched:**
- Edits: `backend/src/modules/vehicles/telematics-zubie.routes.js` (validation)
- New files: `backend/src/modules/vehicles/vehicle-telematics.service.js`, `backend/src/modules/vehicles/telematics-zubie.test.mjs` (expanded coverage)
- Edit: `backend/prisma/schema.prisma` (add VehicleTelemetryEvent model)
- New migration: `20260424_add_telematics_models.sql`
- Frontend: `src/app/vehicles/[id]/telematics/page.js` (new)

**Agent owner:** integrations-specialist + senior-backend-developer

**Effort:** L (8–12 days; schema, validation, dashboard, testing)

**Deps:** Item 1.2 (observability helps debug webhook issues).

**Risk:** Med. Zubie API contract must be locked down with them; payload changes require migration.

---

#### Item 3.5: Smart Planner — Public Rules Engine + Autopilot Foundation

**Problem:** Planner exists but is purely internal. Competitive gap: competitors expose "why did system recommend this?" and allow tenants to author rules. Foundation for AI autopilot is not modular.

**Solution:**  
1. Refactor `backend/src/modules/planner/planner.service.js` to separate:
   - `planner-query.service.js` — fetch state (vehicles, reservations, assignments).
   - `planner-occupancy.service.js` — compute shortage/overbook.
   - `planner-shortage.service.js` — recommend assignments.
   - `planner-copilot.service.js` — AI integration (refactored per Phase 1 backlog).
2. Create `backend/src/modules/planner/planner-rules.service.js`:
   - Model `PlannerRule`: { tenantId, name, condition (LISP-like DSL or structured JSON), action }.
   - Examples: "if vehicle is low-fuel, don't assign", "if short-term rental, prefer fuel-efficient car".
   - Apply rules as filters before scoring assignments.
3. Frontend: `src/app/settings/PlannerRulesPanel.jsx` (new):
   - CRUD for rules.
   - Rule builder UI (not full LISP; simple conditions).
   - Test rule on sample snapshot.

**Files/modules touched:**
- Refactor: `backend/src/modules/planner/planner.service.js` → split into 4 files (per Phase 1 backlog).
- New files: `backend/src/modules/planner/planner-rules.service.js`, `backend/src/modules/planner/planner-rules.routes.js`
- Edit: `backend/prisma/schema.prisma` (add PlannerRule model)
- New migration: `20260425_add_planner_rules.sql`
- Frontend refactor: `src/app/settings/page.js` → split into PlannerRulesPanel + others (per Phase 1 backlog).

**Agent owner:** senior-backend-developer + senior-react-developer

**Effort:** L (10–14 days; refactoring, rules DSL, frontend builder)

**Deps:** Item 2.2 (planner refactoring).

**Risk:** High. Planner is core logic; must maintain backward compatibility and test thoroughly.

---

### Wave 4: Weeks 10–12 — Polish + Sustain-100/yr Buffer

**Theme:** Tech debt paydown, DX improvements, docs, mobile cross-platform parity, cost optimization.

---

#### Item 4.1: Frontend Refactoring — Break Up Giant Pages

**Problem:** `frontend/src/app/settings/page.js` and `frontend/src/app/planner/page.js` are 500–1000+ lines. Hard to maintain, slow to load, prone to state collisions.

**Solution:**  
1. Refactor `frontend/src/app/settings/page.js` into domain-specific panels (per Phase 1 backlog):
   - `SettingsCompanyPanel.jsx`, `SettingsPaymentsPanel.jsx`, `SettingsPlannerCopilotPanel.jsx`, `SettingsTelematicsPanel.jsx`, etc.
   - Each panel: own state, own loader, own error handling.
   - Main page: route + tab switcher.
2. Refactor `frontend/src/app/planner/page.js` into components:
   - `PlannerBoard.jsx`, `PlannerHeader.jsx`, `PlannerFilters.jsx`, `PlannerSidebar.jsx`, `PlannerCopilotPanel.jsx`.
3. Extract helpers to `src/app/planner/planner-utils.mjs` (already exists; keep it pure UI).

**Files/modules touched:**
- Refactor: `frontend/src/app/settings/page.js` (split into components under `settings/components/`)
- Refactor: `frontend/src/app/planner/page.js` (split into components under `planner/components/`)
- Maintain: `frontend/src/app/planner/planner-utils.mjs` (no change, just ensure it's pure)

**Agent owner:** senior-react-developer

**Effort:** L (10–12 days; careful refactoring, testing each component, Vitest updates)

**Deps:** None (refactoring work, not feature).

**Risk:** Med. Risk of regression if component split breaks state management. Must run full component test suite.

---

#### Item 4.2: Backend Test Coverage — Critical Paths

**Problem:** Backend has per-module tests but some hot paths lack coverage (checkout flow, planner apply, agreement finalize).

**Solution:**  
1. Add new test files (per Phase 1 backlog):
   - `backend/src/modules/planner/planner.snapshot.test.mjs` (rrange validation, shortage, overbook).
   - `backend/src/modules/planner/planner.apply-plan.test.mjs` (apply assignment, conflict detection).
   - `backend/src/modules/rental-agreements/rental-agreements-finalize.test.mjs` (finalize logic, charge calc).
2. Each file: 20–30 test cases covering happy path + error cases.
3. Target: 80%+ line coverage on critical modules.

**Files/modules touched:**
- New files: `backend/src/modules/planner/planner.snapshot.test.mjs`, `backend/src/modules/planner/planner.apply-plan.test.mjs`, `backend/src/modules/rental-agreements/rental-agreements-finalize.test.mjs`

**Agent owner:** qa-engineer

**Effort:** M (5–7 days; test design, implementation, iteration)

**Deps:** Item 2.2 (refactored planner code).

**Risk:** Low (tests are isolated).

---

#### Item 4.3: Documentation — Runbooks + API Contract

**Problem:** Docs exist but are scattered. New ops team member needs: how to onboard a tenant, how to handle payment failure, how to rollback a deploy, how to scale to 500 users.

**Solution:**  
1. Create `docs/operations/runbooks/`:
   - `onboard-tenant.md` (step-by-step).
   - `payment-failure-recovery.md` (detection + fix).
   - `deployment-rollback.md` (git + docker commands).
   - `scaling-decision-tree.md` (when to upgrade infra, Redis, read replicas).
2. Enhance `docs/architecture/api-contract.md`:
   - Per-module endpoint list with request/response schema (auto-generated from Swagger if possible).
   - Rate limit per endpoint.
   - Auth requirements.
3. Update `CLAUDE.md` to reflect all new architectural decisions (Redis, webhooks, etc.).

**Files/modules touched:**
- New directory: `docs/operations/runbooks/` with `.md` files.
- New/edit: `docs/architecture/api-contract.md`
- Edit: `CLAUDE.md` (note cache migration, webhook schema, telematics contract)

**Agent owner:** docs-content-engineer

**Effort:** M (4–6 days; content creation, review, formatting)

**Deps:** Wave 2–3 complete so docs reflect final state.

**Risk:** Low.

---

#### Item 4.4: Cost Optimization + Scaling Decision Tree

**Problem:** Infra costs will grow. Need clear decision points: when to upgrade droplet, when to add managed Postgres, when to use CDN, etc.

**Solution:**  
1. Document current cost baseline ($58/mo droplet + $5/mo Spaces + $26/mo Sentry Team = ~$90/mo).
2. Define scaling decision tree:
   - **At 200 users (now):** single droplet, in-memory cache, managed backup. Cost: $90/mo.
   - **At 400 users (month 6?):** consider 2-vCPU droplet ($80/mo) or split backend onto separate droplet ($116/mo total). Enable Redis cache.
   - **At 800 users (month 12?):** managed Postgres ($35/mo basic) + 2× backend droplets ($232/mo) + Redis ($50/mo). Total: ~$320/mo.
   - **At 2000+ users:** k8s or managed container service (out of scope for now).
3. Create `docs/operations/cost-roadmap-2026.md` with scenarios.

**Files/modules touched:**
- New file: `docs/operations/cost-roadmap-2026.md`
- Edit: `docs/operations/scaling-decision-tree.md` (reference cost roadmap)

**Agent owner:** digitalocean-infra-expert

**Effort:** S (2–3 days; cost analysis, decision tree)

**Deps:** None.

**Risk:** Low.

---

#### Item 4.5: Cross-Platform Mobile Parity + QA Sign-Off

**Problem:** iOS + Android apps built in Wave 3, but UX may differ. Need full cross-platform testing + QA checklist.

**Solution:**  
1. QA test matrix:
   - iOS 15, 16, 17 on iPhone 12, 14 (simulator + real device if available).
   - Android 10, 12, 14 on Pixel 5, Samsung S21 (simulator + real device).
   - Web (Chrome, Safari, Firefox) for baseline.
   - Scenarios: checkout, checkin, host handoff, login.
2. Create `frontend/qa-checklist-mobile.md`:
   - Camera permissions (iOS vs Android differ).
   - Location permission (background vs foreground).
   - NFC (if supported; Android more mature than iOS).
   - Offline resilience (queue requests, sync on reconnect).
3. File bugs against deviations; prioritize by impact.

**Files/modules touched:**
- New file: `frontend/qa-checklist-mobile.md`
- Potential fixes: `frontend/src/components/CameraCapture.jsx`, `frontend/src/lib/permissions.js`

**Agent owner:** qa-engineer + senior-mobile-developer

**Effort:** M (4–6 days; testing, bug filing, triage)

**Deps:** Wave 3.1 (mobile app).

**Risk:** Low (testing, not development).

---

---

## 5. Competitive Gap Summary

| Competitor | Their Strength | Our Current State | Recommended Action (200-user scale) | Wave | Impact |
|---|---|---|---|---|---|
| **Record360** | Guided inspection + damage capture workflow | Inspection flow exists; evidence still JSON-ish | Polish evidence capture UI; move to S3 (Item 3.3) | 3 | High — claims evidence is proof; visual UX matters. |
| **RentHub** | Dispute/claims workflow messaging | Issue Center has lanes + decisions but no messaging | Add messaging inbox to Issue Center (defer to post-90d; not SLA-blocking at 200 users). | 4+ | Medium — can win with better decisions first. |
| **Rent Centric** | Mobile checkout/checkin + GPS tracking | Web ops exists; mobile app skeleton pending | Ship mobile app (Item 3.1) + telematics (Item 3.4) | 3 | High — field staff want mobile. |
| **Turo** | Public marketplace UX + airport discovery | Car-sharing booking works but UX polish needed | Public booking refactor + airport search (defer; focus on operations not consumer UX at 200 users). | 4+ | Low — at 200 users, we're selling to operators, not guests. |
| **TSD (enterprise)** | Enterprise multi-location + deep integrations | Single-tenant-primary; API stubs exist | Webhooks (Item 3.2) + integrations roadmap; scale to multi-tenant ops elegantly (focus on IT, not parity). | 3 | High — TSD bundles many modules; we differentiate on flexibility. |
| **Generic RMS** | Reporting + export | Reports module exists (placeholder) | Reporting not in this plan — defer (not SLA-blocking, not ops-limiting at 200 users). | 4+ | Medium — will become critical at 400+ users. |

**Honest assessment:** At 200-user scale, the gap that matters most is **field operations + issue resolution**. Rent Centric + Record360 are strong there. We win by shipping mobile (Wave 3.1) + claims evidence polish (Wave 3.3) + telematics (Item 3.4). Reporting and advanced pricing can wait; they matter at 400+ users when analytics drive growth.

---

## 6. Cost Projection

| Wave | Item | Cost Delta | Total | Notes |
|------|------|-----------|-------|-------|
| **Current** | DO $58/mo + Sentry $26/mo | +$0 | $84/mo | Baseline. |
| **Wave 1** | Spaces storage ($5/mo) + backup script (free) | +$5 | $89/mo | Mandatory safety. |
| **Wave 2** | No cost (Redis conditional, deferred) | +$0 | $89/mo | Indexes + optimizations are free. Load testing is temporary staging ($30 one-time, not recurring). |
| **Wave 3** | Redis (if needed; $10/mo basic), Spaces egress overage (~$5/mo) | +$15 | $104/mo | Telematics + webhooks are free. Mobile TestFlight/Firebase free tier. |
| **Wave 4** | No new recurring costs | +$0 | $104/mo | Refactoring/docs are free. |
| **Future (400+ users, if chosen)** | Managed Postgres ($35/mo) OR second droplet ($80/mo) | +$35–80 | $139–184/mo | Decision point at month 6. |

**Cost envelope:** $200–500/mo approved; we hit $104/mo with all Waves (well under budget). Future scaling to 1000+ users might hit $300/mo (managed services). **No Kubernetes, no multi-region at this scale.**

---

## 7. Out of Scope (Explicitly)

- **Kubernetes** — not needed until 1000+ users. Stick with Docker Compose + managed services (Supabase, Render, etc.) for HA if needed post-July.
- **Multi-region replication** — single region (NYC3) is fine for 200 users. If global presence required, 2026 Q4+.
- **DB sharding** — not needed until 10K+ users. Postgres on a single managed instance (Supabase) can handle 10K+ users easily.
- **SSO/SAML for enterprise** — out of scope. Basic multi-tenant + RBAC sufficient at 200 users.
- **White-label theming** — defer; not asked for at this scale.
- **Advanced reporting / BI** — defer to Wave 4+. Basic export is enough for 200 users.
- **Turo-level public marketplace UX** — not the focus at 200 users. Optimize operations, not consumer discovery.
- **Real-time collaboration** (e.g., two staff picking a car simultaneously) — not asked for. Can be added if needed.
- **AI/ML autopilot beyond heuristics** — foundation laid (Item 3.5); full autopilot training is post-90d.
- **Custom landing pages per tenant** — defer.
- **Advanced payment financing** — defer; OTC payments sufficient.

---

## 8. How to Execute

### PR Workflow

Refer to `docs/operations/agent-driven-pr-workflow.md`. Summary:
1. solution-architect writes 1-page design doc → review by 2 agents → approved → branch created.
2. Assignee writes code + tests on feature branch.
3. QA agent runs integration tests + tenant-isolation-suite before merge.
4. Merge to `develop` (integration branch); tag `v0.9.0-beta.N` on `main` only.
5. Deploy via `ops/deploy-beta.ps1 -Tag <tag>`.
6. 24h soak in prod; monitor Sentry.

### Agent Parallelization by Wave

**Wave 1 (weeks 1–3):**
- `digitalocean-infra-expert` (Items 1.1, 1.5) + `performance-engineer` (Item 1.2 metrics, 1.3 measurement) + `security-engineer` (Item 1.4 rate limiting) can run in parallel.
- ~3 developers can work independently (backup, observability, hardening, PR 4).

**Wave 2 (weeks 4–6):**
- `supabase-db-expert` (Item 2.1 indexes) + `senior-backend-developer` (Item 2.2 query batching, 2.4 Redis) + `performance-engineer` (Item 2.3 load test) in parallel.
- Optional: Item 2.4 (Redis) can be deferred if single-worker stability confirmed.

**Wave 3 (weeks 7–9):**
- `senior-mobile-developer` + `senior-react-developer` (Item 3.1 mobile app).
- `integrations-specialist` (Items 3.2 webhooks, 3.4 telematics) in parallel.
- `senior-backend-developer` (Item 3.3 evidence S3, 3.5 planner refactor) in parallel.
- ~4–5 developers; some coordination needed on planner refactor (Item 3.5 depends on Item 2.2).

**Wave 4 (weeks 10–12):**
- `senior-react-developer` (Item 4.1 frontend refactor).
- `qa-engineer` (Items 4.2 tests, 4.5 mobile QA) in parallel.
- `docs-content-engineer` (Item 4.3 docs).
- `digitalocean-infra-expert` (Item 4.4 cost roadmap).
- ~3–4 developers; mostly independent.

### Release Cadence

- **Every 2 weeks:** tag `v0.9.0-beta.N`, deploy to prod (off-hours per Hector's preference).
- **Within 24h of deploy:** Sentry soak. Zero new error types = proceed. New type = hotfix branch, tag `v0.9.0-beta.N+hotfix.1`, redeploy.
- **End of Wave 1 (week 3):** tag `v0.9.0-beta.5` (assuming we're at beta.3 now + 2 PRs in flight = beta.4, beta.5).
- **End of Wave 2 (week 6):** tag `v0.9.0-beta.7`.
- **End of Wave 3 (week 9):** tag `v0.9.0-beta.10`.
- **End of Wave 4 (week 12):** tag `v0.9.0` (production release).

### Deploy Window

Per auto-memory: **never deploy during business hours**. Ops staff are using the system. Deploy in US evenings (21:00–23:00 ET = 02:00–04:00 UTC next day).

---

## 9. Success Criteria (End of Wave 4, ~July 31, 2026)

| Metric | Target | Current | Gap |
|--------|--------|---------|-----|
| **Concurrent users supported** | 200 | ~10 (beta) | Yes |
| **Checkout P95 latency** | ≤5s | ~7-8s | PR 4 + Item 2.2 closes it |
| **Reservation list P95** | ≤1s | ~0.5s (assumed) | Item 2.1 ensures it stays there |
| **Login P95** | ≤500ms | ~200ms (assumed) | No change needed |
| **Error rate** | <0.5% | TBD (Sentry soak ongoing) | Item 1.2 + 1.5 establish baselines |
| **Uptime** | 99.5%+ | TBD | Item 1.1 (backups) + 1.5 (alerts) critical |
| **Data backup** | Daily, off-site | Manual only | Item 1.1 mandatory |
| **Mobile app** | iOS + Android beta | None | Item 3.1 |
| **Webhooks** | 2+ tenants live | None | Item 3.2 |
| **Evidence in S3** | 100% of new issues | Inline JSON | Item 3.3 |
| **Telematics live** | Zubie data flowing | Stub only | Item 3.4 |
| **Planner rules** | 10+ customers authoring | Hardcoded only | Item 3.5 |
| **Frontend refactored** | Settings + Planner split | Monolithic | Item 4.1 |
| **Docs complete** | Runbooks + API contract | Partial | Item 4.3 |

---

## 10. Risks + Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|-----------|
| **PR 4 re-implementation takes longer than 3 days** | Medium | Medium | Measure Promise.all on staging first; if regression, fall back to sequential (7-8s is acceptable). |
| **Database indexes slow down writes** | Low | Medium | Test with production snapshot; indexes are additive (no rewrites). Run during low-traffic window. |
| **Mobile app review delayed (App Store)** | Medium | Low | Use TestFlight + Android beta track; official release can slip week or two without blocking. |
| **Zubie payload schema changes; breaks webhook** | Low | Medium | Capture raw payload; migration script to normalize. Zubie API contract must be locked. |
| **Redis outage → cache misses cascade** | Low | High | Fallback to in-memory (Item 2.4 design includes this). Monitoring for cache hit/miss ratio. |
| **Wave 3 planner refactor breaks existing logic** | Medium | High | Item 2.2 + extensive testing (Item 4.2 adds coverage). Staging soak before prod. Rollback plan: revert merge. |
| **Sentry cost overages** | Low | Medium | Monitor Sentry event count; set alerts at $30/mo (current $26/mo baseline + 15% buffer). |
| **Migration from inline JSON to S3 data loss** | Low | Critical | Test migration on staging snapshot. Backup before migration. Dual-write during transition (read from both, write to S3). |

---

## 11. Known Unknowns

- **Zubie API finalized?** Spec currently a stub. Integrate deeply with them Q2 2026 to lock contract.
- **Cluster worker count at production deploy?** Currently CLUSTER_WORKERS=1 (safe). If we enable 4, Item 2.4 (Redis) becomes mandatory. Decision point: end of Wave 2.
- **Mobile NFC support on Android/iOS?** Research in Item 3.1; implementation deferred if platform gaps exist.
- **Tenant growth curve?** Assume linear 100/year. If exponential (e.g., sudden customer win), scaling decisions accelerate.

---

## Appendix: File Structure After Execution

```
backend/
├── src/
│   ├── lib/
│   │   ├── cache.js (facade pattern, supports Redis)
│   │   ├── cache-redis.js (new, Wave 2.4)
│   │   ├── metrics.js (new, Wave 1.2)
│   │   ├── object-storage.js (new, Wave 3.3)
│   │   ├── webhook-dispatcher.js (new, Wave 3.2)
│   │   ├── puppeteer-browser.js (updated, Wave 1.1)
│   ├── middleware/
│   │   ├── rate-limiter.js (new, Wave 1.4)
│   │   ├── idempotency.js (new, Wave 1.4)
│   ├── modules/
│   │   ├── planner/ (refactored, Wave 2.2 + 3.5)
│   │   │   ├── planner-query.service.js (new)
│   │   │   ├── planner-occupancy.service.js (new)
│   │   │   ├── planner-rules.service.js (new, Wave 3.5)
│   │   ├── vehicles/ (hardened, Wave 3.4)
│   │   │   ├── vehicle-telematics.service.js (new)
│   │   ├── issue-center/ (enhanced, Wave 3.3)
│   │   ├── integrations/ (new, Wave 3.2)
│   │   │   ├── webhook-config.routes.js
│   │   │   ├── webhook-config.service.js
│   ├── prisma/
│   │   ├── schema.prisma (updated: WebhookConfig, VehicleTelemetryEvent, PlannerRule, etc.)
│   │   ├── migrations/
│   │   │   ├── 20260421_add_composite_indexes_hot_paths/
│   │   │   ├── 20260424_add_telematics_models/
│   │   │   ├── 20260425_add_planner_rules/
│   │   │   ├── 20260428_add_webhook_models/
│   │   │   ├── 20260430_issue_evidence_s3/
│   ├── load-test/ (new, Wave 2.3)
│   │   ├── checkout-flow.k6.js
├── ops/ (updated)
│   ├── backup.sh (new, Wave 1.1)
│   ├── restore.sh (new, Wave 1.1)

frontend/
├── src/
│   ├── app/
│   │   ├── planner/
│   │   │   ├── components/ (new, Wave 4.1)
│   │   │   │   ├── PlannerBoard.jsx
│   │   │   │   ├── PlannerHeader.jsx
│   │   │   │   ├── PlannerFilters.jsx
│   │   │   │   ├── PlannerSidebar.jsx
│   │   │   │   ├── PlannerRulesPanel.jsx (new, Wave 3.5)
│   │   ├── settings/
│   │   │   ├── components/ (new, Wave 4.1)
│   │   │   │   ├── SettingsCompanyPanel.jsx
│   │   │   │   ├── SettingsPaymentsPanel.jsx
│   │   │   │   ├── SettingsPlannerCopilotPanel.jsx
│   │   │   │   ├── SettingsTelematicsPanel.jsx
│   │   ├── vehicles/
│   │   │   ├── [id]/
│   │   │   │   ├── telematics/
│   │   │   │   │   ├── page.js (new, Wave 3.4)
│   ├── mobile-shell/
│   │   ├── src/
│   │   │   ├── App.jsx (updated, Wave 3.1)
├── qa-checklist-mobile.md (new, Wave 4.5)

docs/
├── operations/
│   ├── production-readiness-plan-2026-04-20.md (this file)
│   ├── checkout-perf-plan.md (existing; for reference)
│   ├── backup-runbook.md (new, Wave 1.1)
│   ├── monitoring-and-alerts.md (new, Wave 1.5)
│   ├── load-testing-runbook.md (new, Wave 2.3)
│   ├── mobile-deployment-runbook.md (new, Wave 3.1)
│   ├── cost-roadmap-2026.md (new, Wave 4.4)
│   ├── runbooks/ (new, Wave 4.3)
│   │   ├── onboard-tenant.md
│   │   ├── payment-failure-recovery.md
│   │   ├── deployment-rollback.md
│   │   ├── scaling-decision-tree.md
├── architecture/
│   ├── api-contract.md (new/enhanced, Wave 4.3)
├── integrations/ (new)
│   ├── zubie-api.md (new, Wave 3.4)

CLAUDE.md (updated with cache migration, webhook schema, telematics, Redis)
```

---

## Conclusion

This 90-day plan is **achievable with 3–5 developers** working in parallel. It prioritizes:
1. **Safety first** (backups, alerts, rate limiting).
2. **Performance to SLO** (checkout ≤5s via PR 4 + index optimization).
3. **Competitive wins** (mobile, claims evidence, webhooks, telematics).
4. **Operational readiness** (docs, mobile QA, cost roadmap).

By end of July 2026, Ride Fleet will be **production-ready for 200 users** with headroom to 400 before major architectural changes. Cost stays under budget ($104/mo at 90 days; $139–184/mo at 400 users with optional managed Postgres). The platform is differentiated on **operational control + flexibility**, not on feature parity with consumer-first competitors like Turo.

**Next steps:**
1. Hector approves plan / suggests changes (before coding starts).
2. solution-architect writes design docs for each Wave item.
3. Agents pick up work in parallel per parallelization schedule.
4. Release cadence: v0.9.0-beta.N every 2 weeks; v0.9.0 release at end of Wave 4.
