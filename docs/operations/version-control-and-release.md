# Version Control + Release Flow (Beta)

## Branches
- `main`: live beta
- `develop`: integration
- `feature/*`: planned work
- `hotfix/*`: urgent live fixes

## Release tagging
- Beta release: `v0.9.0-beta.N`
- Emergency patch: `v0.9.0-beta.N+hotfix.M`

## Hotfix flow
1. `git checkout main && git pull`
2. `git checkout -b hotfix/<issue>`
3. Implement minimal fix
4. Validate (`frontend build`, key smoke checks)
5. Merge to `main`
6. Tag + push (always **merge → pull → tag**, never **tag → merge** — annotated tag SHAs are not commit SHAs, dereference with `^{commit}`)
7. Deploy to production droplet (see [Droplet deploy workflow](#droplet-deploy-workflow) below).
   `ops/deploy-beta.ps1` is a **local-staging** wrapper only — it does not touch the production droplet.

## Droplet deploy workflow

**Production architecture (as of 2026-04-25):**
- Host: DigitalOcean droplet `ubuntu-s-1vcpu-2gb-nyc3-01-ridefleetmanagement` at `ridefleetmanager.com`
- Repo: `~/RideFleetManagement` on the droplet
- DB: Supabase Postgres via pooler `aws-1-us-east-1.pooler.supabase.com:6543` (transaction-mode pgbouncer). The droplet's `.env` has the prod `DATABASE_URL` set; never edit it from a deploy script.
- Compose file: `docker-compose.prod.yml`

**Window:** off-hours only — ~22:00 EDT typical, midnight is the late edge. Don't deploy mid-business-hours unless it's a P0.

**Pre-flight (locally):**
- Confirm tag exists on `origin` and dereferences to the right commit:
  `git rev-parse <tag>^{commit}` should match `git rev-parse main`.
- CI on the merge commit is green (especially `tenant-isolation-suite`, since `backend-check` alone misses transitive import bugs — see BUG-003 closure note in `doc/known-bugs-2026-04-23.md`).

**Deploy steps (on droplet):**

```bash
ssh root@ridefleetmanager.com
cd ~/RideFleetManagement

# 1. Pull tags + checkout the release tag (detached HEAD is expected and fine).
git fetch --tags
git checkout <tag>                         # e.g. v0.9.0-beta.6
git rev-parse HEAD                          # confirm matches the local pre-flight SHA

# 2. Apply schema changes against the Supabase pooler.
#    NOTE: prisma's success message may be truncated in the terminal output —
#    always verify with a follow-up count query rather than trusting the message.
docker compose -f docker-compose.prod.yml run --rm backend \
  npx prisma db push --skip-generate

# 3. Rebuild + recreate both app containers. Always use --build and --force-recreate
#    together: a prior version of deploy-beta.ps1 declared "deploy complete" while
#    a frontend container quietly kept running the previous image; manual
#    --build --force-recreate bypasses that footgun.
docker compose -f docker-compose.prod.yml up -d --build --force-recreate
```

**Verification (still on droplet):**

```bash
# 4a. Containers up and CreatedAt is newer than the previous deploy.
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}' | grep fleet

# 4b. Backend health.
curl -fsS http://localhost:4000/health
# Expect: {"ok":true,..."checks":{"database":true},...}

# 4c. New routes mounted (auth/validation 401/400 expected for protected endpoints
#     when called without credentials — confirms route is registered).
curl -i http://localhost:4000/api/<new-route>

# 4d. Schema applied — verify each new model can be counted.
docker compose -f docker-compose.prod.yml run --rm backend node -e \
  "import('./src/lib/prisma.js').then(({prisma}) => prisma.<NewModel>.count().then(n => console.log('count =', n)))"
```

**Verification (from anywhere, validates customer-facing surface):**

```bash
# 5a. Homepage (frontend container is serving and nginx is up).
curl -sI https://ridefleetmanager.com/ | head -3
# Expect: HTTP/1.1 200 OK + nginx Server header

# 5b. Public /api/* routing reaches the new backend.
#     Hit any auth-protected endpoint without a token; expect 401 from
#     Express (NOT 404 from nginx). 401 confirms the proxy forwards /api
#     correctly AND that the new code's routes are mounted.
curl -is https://ridefleetmanager.com/api/rental-agreements/test-id/addendums | head -6
# Expect: HTTP/1.1 401 Unauthorized + Content-Type: application/json
#
# Note: There is no public /health endpoint exposed through nginx —
# /health on the backend container is internal-only on localhost:4000
# (verified inside the docker network in step 4b above). If you want a
# public health probe, add a dedicated route + nginx rule first; do not
# assume `curl https://...com/health` or `/api/health` returns 200.

# 5c. Manual DOM probe — open https://ridefleetmanager.com/, log in, and
#     confirm any new UI surface for this release renders (e.g. a new
#     settings tab, a new column on a list page, or — for v0.9.0-beta.7
#     — the "Addendums" card at the bottom of the reservation detail page
#     for any reservation with a rental agreement).
```

**Rollback:** check out the previous release tag and re-run steps 2–4. If the schema migration is non-destructive (additive columns/tables only), no DB rollback is needed — the previous code ignores the new columns.

**Logging the deploy:** add an entry to the next session handoff (`/RideFleet/Claude-Sessions/SESSION_HANDOFF.md` on Drive) noting tag, time, and verification results. If anything anomalous, also add a brief note to `doc/known-bugs-2026-04-23.md`.

## Merge policy
- Keep commits small and topic-specific.
- One concern per PR.
- Every deploy must map to a git tag.

## Release note template
- Tag:
- Date/time:
- Scope:
- Risks:
- Rollback tag:
- Validation done:
- Known issues: