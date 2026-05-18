# Version Control + Release Flow (Beta)

## Branches
- `main`: live beta
- `develop`: integration
- `feature/*`: planned work
- `hotfix/*`: urgent live fixes

## Release tagging
- Beta release: `v0.9.0-beta.N`
- Emergency patch: `v0.9.0-beta.N+hotfix.M`

### CRITICAL: stale local tags can poison a deploy
Surfaced four deploys in a row on 2026-05-12 (BUG-008 chain — PRs #65, #66, #67, #68). Symptom every time: `git checkout v0.9.0-beta.<N>` on the droplet ends up on a *different* old commit each deploy (PR #12, PR #24, PR #28, PR #31, ...), so the running container is missing the merged feature and prod silently regresses. Sometimes for two weeks of feature work.

Root cause: pre-existing local tags. At some point on 2026-04-29 (and likely earlier) `git tag -a v0.9.0-beta.<N> <some-HEAD>` was run on the Mac for several beta tags as advance staging (or as the side-effect of some script — never identified). Those tag files have been sitting in `.git/refs/tags/` for weeks, each pointing at whatever HEAD was at the time of pre-staging. Then on deploy day:

1. `git tag v0.9.0-beta.<N> origin/main` is run — **silently refused**: `git tag` without `-f` does NOT overwrite an existing tag. No error message in the obvious case (you have to look for one specific line, which scrolls offscreen behind the next command).
2. `git push origin v0.9.0-beta.<N>` pushes the *old* local tag.
3. Droplet `git fetch --tags --force && git checkout v0.9.0-beta.<N>` lands on the old commit.
4. Docker rebuilds happily with the stale source tree; smoke tests fail in confusing ways because the code on disk doesn't have the route / function / etc you just merged.

Each beta tag was preset to a different stale HEAD, which is why the "wrong commit" landed somewhere different every time, and why "I just deleted and re-pushed the tag last cycle" wasn't enough to fix the pattern — the *next* pre-staged tag (e.g. `.10` → `.11`) was already lurking with a different stale target.

### Mandatory tag-creation pattern
Use ONE of these, never `git tag NAME` alone:

```bash
git tag -f v0.9.0-beta.<N> origin/main
git push --force origin v0.9.0-beta.<N>
```

…or the delete-first pattern:

```bash
git tag -d v0.9.0-beta.<N>                          # remove any local copy
git push origin :refs/tags/v0.9.0-beta.<N>          # remove the remote one too
git tag v0.9.0-beta.<N> origin/main                 # now safe to create fresh
git push origin v0.9.0-beta.<N>
```

### Mandatory sanity check before deploy
Right after pushing the tag, **both** of these must print the same SHA, and it must equal `git rev-parse origin/main`:

```bash
git rev-parse v0.9.0-beta.<N>
git log -1 --format='%H %s' v0.9.0-beta.<N>
git rev-parse origin/main
```

If `git rev-parse v0.9.0-beta.<N>` prints a different SHA than `git log -1`, the tag is **annotated** (tag-object SHA ≠ commit SHA). That's also fine as long as `git log -1` matches origin/main — but it's a red flag that should trigger a manual verify of the commit subject.

If `git log -1 v0.9.0-beta.<N>` does NOT match origin/main, **stop**. Do not SSH to the droplet. Run the delete-first pattern above and re-verify before continuing.

### Periodic tag audit
Run this on the Mac to spot any other pre-staged tags pointing at stale commits before they bite:

```bash
git tag -l 'v0.9.0-beta.*' | xargs -I {} sh -c 'echo "{}: $(git log -1 --format=%h%x09%s {})"'
```

Anything whose commit isn't an actual deploy SHA or current `origin/main` is a leftover; delete it locally and on origin.

## Hotfix flow
1. `git checkout main && git pull`
2. `git checkout -b hotfix/<issue>`
3. Implement minimal fix
4. Validate (`frontend build`, key smoke checks)
5. Merge to `main`
6. Tag + push (always **merge → pull → tag**, never **tag → merge** — annotated tag SHAs are not commit SHAs, dereference with `^{commit}`). **Use the mandatory tag-creation pattern in the "Release tagging" section above** — plain `git tag NAME` silently fails when a stale local tag exists, which poisoned four deploys in a row in May 2026.
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