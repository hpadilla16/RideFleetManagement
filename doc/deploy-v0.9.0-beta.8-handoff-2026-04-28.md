# Deploy v0.9.0-beta.8 — scheduled-task handoff

**Date:** 2026-04-28
**Scheduled task:** `deploy-v090-beta8`
**Status:** Pre-flight verified locally. **SSH portion not executed** — needs Hector at the keyboard.

---

## Why the scheduled task stopped at pre-flight

The deploy script in the task file requires SSH access to `root@ridefleetmanager.com`. Hector's SSH keys live on his Mac and aren't available to the scheduled-task runner. The droplet steps (Step 2 onward) cannot be executed autonomously, so this run did the parts it could verify and produced this report instead.

## What was verified autonomously

### Step 1 — local repo pre-flight ✅

```
git rev-parse main                         → 55400ab4eccd29fb9fa8fa2045608f43792e1ca1
git rev-parse v0.9.0-beta.8^{commit}       → 55400ab4eccd29fb9fa8fa2045608f43792e1ca1
```

Both match the expected commit. The `v0.9.0-beta.8` tag points to the head of `main`. **Safe to deploy.**

(Hector's working tree was on branch `feat/cluster-mode-rollout-doc` — irrelevant for the deploy because the droplet checks out the tag directly.)

### Tag contents — all expected artifacts present ✅

The three PR merges between `v0.9.0-beta.7..v0.9.0-beta.8`:

```
55400ab Merge pull request #12 from hpadilla16/feature/customer-addendum-signing
3a3407d Merge pull request #10 from hpadilla16/chore/post-beta7-doc-cleanup
c99dcd1 Merge pull request #11 from hpadilla16/feature/addendum-admin-email
```

Files shipped in the tag:

- `backend/prisma/migrations/20260428_add_addendum_signature_token/migration.sql` (new)
- `backend/src/modules/rental-agreements/addendum-signature-public.routes.js` (new)
- `backend/src/modules/rental-agreements/addendum-signature-public.service.js` (new)
- `backend/src/modules/rental-agreements/addendum-notification.service.js` (modified — admin email)
- `frontend/src/app/customer/sign-addendum/page.js` (new)
- `doc/known-bugs-2026-04-23.md` (BUG-001/002/004 closures)
- `docs/operations/version-control-and-release.md` (corrected `/api/health` step)

Route is mounted in `backend/src/main.js:91`:

```js
app.use('/api/public/addendum-signature', addendumSignaturePublicRouter);
```

### Migration is additive — no data-loss risk ✅

`backend/prisma/migrations/20260428_add_addendum_signature_token/migration.sql`:

```sql
ALTER TABLE "RentalAgreementAddendum"
  ADD COLUMN "signatureToken"          TEXT,
  ADD COLUMN "signatureTokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "RentalAgreementAddendum_signatureToken_key"
  ON "RentalAgreementAddendum"("signatureToken");
```

Two nullable columns + one unique index on the nullable token. Existing rows get `signatureToken = NULL` and the notification helper skips the customer email rather than sending an unsignable link, as documented in the task brief.

### Step 4 — public surface, captured *before* deploy ✅

Baseline captured to make post-deploy comparison unambiguous:

| Probe | Pre-deploy result | Post-deploy expectation |
|---|---|---|
| `GET https://ridefleetmanager.com/` | `HTTP 200` (login page renders, `Ride Fleet` title) | `HTTP 200` (unchanged — frontend rebuild keeps the marketing/login surface) |
| `GET /api/public/addendum-signature/no-such-token` | `HTTP 404` with HTML body `Cannot GET /api/public/addendum-signature/no-such-token` (Express's default — route NOT mounted on beta.7) | `HTTP 404` with **JSON** body `{"error":"Signature token is invalid or expired"}` (route IS mounted — validates) |
| `GET /customer/sign-addendum` | `HTTP 404` Next.js not-found page (page does not exist on beta.7) | `HTTP 200` rendering "Review and Sign Your Addendum" |

The substantive sanity check post-deploy is **the response *body* on the addendum-signature probe** — it must flip from Express's plaintext 404 to the JSON error. Both are status 404, so don't trust status alone.

---

## What's still required from Hector — SSH deploy

Open a terminal on your Mac and paste each block.

### Step 1 — pre-flight (Mac)

Already verified by this run; rerun for sanity:

```bash
cd ~/Code/RideFleetManagement
git fetch --all --tags
git checkout main
git pull
git rev-parse main
git rev-parse v0.9.0-beta.8^{commit}
```

Both `rev-parse` outputs MUST be `55400ab4eccd29fb9fa8fa2045608f43792e1ca1`. They were when this report was written; if they aren't now, STOP — something has drifted in the last few hours.

### Step 2 — SSH to droplet

```bash
ssh root@ridefleetmanager.com
```

### Step 3 — deploy block (paste on droplet)

```bash
cd ~/RideFleetManagement
git fetch --tags --prune
git checkout v0.9.0-beta.8
git rev-parse HEAD

echo "=== applying schema migration (signatureToken on RentalAgreementAddendum) ==="
docker compose -f docker-compose.prod.yml run --rm -T backend npx prisma db push --skip-generate 2>&1 | tee /tmp/prisma-push-beta8.log

echo
echo "=== rebuild + recreate prod containers ==="
docker compose -f docker-compose.prod.yml up -d --build --force-recreate

echo
echo "=== wait 90s for backend to settle ==="
sleep 90

echo "=== container status (CreatedAt should be ~minutes ago) ==="
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}' | grep fleet

echo
echo "=== /health internal probe ==="
curl -fsS http://localhost:4000/health
echo

echo "=== new public addendum-signature endpoint mounted? ==="
curl -is http://localhost:4000/api/public/addendum-signature/no-such-token 2>&1 | head -4

echo
echo "=== schema applied — query the new column ==="
docker exec -t fleet-backend-prod node -e "import('./src/lib/prisma.js').then(({prisma}) => prisma.\$queryRawUnsafe('SELECT COUNT(*) AS total FROM \"RentalAgreementAddendum\"').then(r => { console.log('addendum count =', r); process.exit(0); }).catch(e => { console.error('SQL ERROR:', e.message); process.exit(1); }))"

echo
echo "=== schema migration log tail ==="
tail -20 /tmp/prisma-push-beta8.log
```

**Two gotchas worth re-flagging from prior runs:**

- `-T` on `docker compose run` is mandatory — without it, the `prisma db push` step hung indefinitely on the v0.9.0-beta.7 deploy (TTY flush issue).
- `/health` is internal-only on `localhost:4000`. `https://ridefleetmanager.com/health` and `/api/health` both return 404 through nginx. The deploy doc was corrected for this in PR #10 (shipping in this tag).

### Expected outcomes

- `git rev-parse HEAD` on droplet = `55400ab4eccd29fb9fa8fa2045608f43792e1ca1`
- `docker ps`: `fleet-backend-prod`, `fleet-frontend-prod`, `fleet-db-prod` all `Up`, `CreatedAt` from minutes ago
- `/health`: `{"ok":true,"checks":{"database":true,...}}`
- `/api/public/addendum-signature/no-such-token`: `HTTP/1.1 404 Not Found` with body `{"error":"Signature token is invalid or expired"}` (NOT the Express plaintext 404 we saw pre-deploy — that's the diagnostic flip that proves the new route mounted)
- `addendum count = [{ total: <some number> }]`

### Step 4 — public-surface verification (Mac or droplet)

```bash
curl -sI https://ridefleetmanager.com/ | head -3
curl -is https://ridefleetmanager.com/api/public/addendum-signature/no-such-token 2>&1 | head -8
```

Compare the second probe's body to the pre-deploy baseline above. **Body must be JSON** post-deploy.

### Step 5 — manual DOM probe (optional)

1. `https://ridefleetmanager.com/` → log in.
2. Open any reservation past `start-rental` (i.e. with a rental agreement).
3. Confirm the Addendums card still renders (regression check from beta.7).
4. (Optional but recommended) Create a test addendum, look for the customer email link `https://ridefleetmanager.com/customer/sign-addendum?token=...`, open it, confirm the new page renders.

### Rollback (if needed)

```bash
# On droplet
git checkout v0.9.0-beta.7
docker compose -f docker-compose.prod.yml up -d --build --force-recreate
```

The schema is additive (nullable columns), so reverting the code without rolling back the schema is safe.

---

## Closeout — once green

1. Sanity message to self: "Deploy complete — `v0.9.0-beta.8` live as of `<timestamp>` EDT."
2. Update `SESSION_HANDOFF.md` on Drive (`/RideFleet/Claude-Sessions/SESSION_HANDOFF.md`, folder ID `1pYqL4pawAHC5slG2fu2uVJHt_CVs3-GM`) with the deploy timestamp + tag.
3. Carry-forwards already in handoff: addendum service unit tests (DI refactor); v9 tenant-isolation suite case for the public token flow. (BUG-004 closure was already shipped in this tag's chore PR.)

---

## Reference

- `docs/operations/version-control-and-release.md` — canonical deploy workflow (just-corrected version is what shipped in this tag).
- `doc/known-bugs-2026-04-23.md` — BUG closure history.
- `docs/operations/rental-agreement-addendum-plan.md` — full addendum plan.
