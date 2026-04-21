# Backup + Restore Runbook

**Owner:** digitalocean-infra-expert
**Status:** Active (Wave 1, Item 1.1 of the 90-day production-readiness plan)
**Last updated:** 2026-04-20

This runbook covers daily Postgres backups of the Ride Fleet production database to DigitalOcean Spaces, and the operator procedure for restoring from a backup. Scripts referenced live in `ops/backup.sh` and `ops/restore.sh`.

**Source of truth for production data:** Supabase managed Postgres (project ref in `backend/.env` DATABASE_URL, pooler in AWS us-east-1). The `fleet-db-prod` Docker container on the droplet is *not* the production DB — it exists but is empty; the backend connects to Supabase over the network. `ops/backup.sh` reads DATABASE_URL, rewrites the pooler port from 6543 (transaction mode, incompatible with pg_dump) to 5432 (session mode), and runs `pg_dump` from the droplet against Supabase directly.

---

## What runs when

| Event | Actor | Trigger | Action |
|---|---|---|---|
| Daily at 02:00 UTC | `root` crontab on droplet | cron | `ops/backup.sh` → `pg_dump` → upload to DO Spaces → rotate >30 days old |
| Monthly (first Monday) | Operator | manual | Restore-rehearsal: run `ops/restore.sh` into scratch DB, verify row counts, destroy scratch DB |
| On incident | Operator | manual | Production restore using the safety procedure at the bottom of this doc |

---

## Prerequisites (one-time setup on the droplet)

### 1. Install `awscli` and `postgresql-client`

On Ubuntu 24.04, `awscli` is not in the default apt repositories — use snap:

```bash
snap install aws-cli --classic
aws --version   # verify; expect aws-cli/1.x or 2.x
```

Install `postgresql-client-17` from the official PostgreSQL APT repo (`pgdg`). Ubuntu 24.04's default `postgresql-client` is version 16, which **refuses** to dump from Supabase's PG 17 server (version mismatch is a hard error, not a warning). pgdg provides current versions:

```bash
# Add the pgdg repo
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt update

# Install pg-client-17 and drop pg-client-16 so `pg_dump` on PATH points to 17
apt install -y postgresql-client-17
apt remove -y postgresql-client-16 postgresql-client 2>/dev/null || true

# Verify — should report PostgreSQL 17.x
pg_dump --version
```

Note: `ops/backup.sh` auto-discovers the newest `pg_dump` under `/usr/lib/postgresql/*/bin/`, so as long as pg-client-17 is installed, the script picks it up regardless of what `pg_dump` on PATH points to. When Supabase moves to PG 18 eventually, just `apt install postgresql-client-18` and the script adapts.

### 2. Configure the `digitalocean` profile

Generate Spaces access keys in the DO UI:
- Cloud → API → **Spaces Keys** → Generate New Key → name it `ridefleet-droplet-backup`
- Copy the Access Key + Secret (secret only shown once)

Then on the droplet:

```bash
aws configure --profile digitalocean
# AWS Access Key ID:     <DO Spaces access key>
# AWS Secret Access Key: <DO Spaces secret>
# Default region name:   us-east-1   (DO Spaces accepts this; endpoint URL overrides routing)
# Default output format: json
```

Verify the profile can reach the bucket:

```bash
aws --profile digitalocean --endpoint-url https://nyc3.digitaloceanspaces.com \
    s3 ls s3://ridefleet-backup/
```

If this lists without error (may be empty on first setup), you're good.

### 3. Make the scripts executable

```bash
chmod +x /root/RideFleetManagement/ops/backup.sh /root/RideFleetManagement/ops/restore.sh
```

### 4. Wire the cron entry

```bash
crontab -e
```

Add this line (daily at 02:00 UTC; that's 22:00 ET during EDT):

```
0 2 * * *  /root/RideFleetManagement/ops/backup.sh >> /var/log/ridefleet-backup.log 2>&1
```

Save and exit. Verify:

```bash
crontab -l | grep backup
```

### 5. Test with a manual run

```bash
/root/RideFleetManagement/ops/backup.sh
```

Expected output ends with `[backup] YYYY-MM-DDTHH:MM:SSZ Done (size=<N>B, key=daily/fleet-prod-<timestamp>.dump)`. Check DO Spaces UI to confirm the file appears under `daily/`.

---

## Daily backup flow (what happens at 02:00 UTC)

1. `cron` fires `ops/backup.sh` as `root`.
2. Script reads `DATABASE_URL` from `/root/RideFleetManagement/backend/.env`, rewrites the pooler port (`:6543` → `:5432`) and strips `?pgbouncer=true`, then masks the password in its logs.
3. Runs `pg_dump -Fc --no-owner --no-privileges` from the host against Supabase over the network (~5-30 seconds depending on DB size).
4. Output is written to `/var/backups/ridefleet/fleet-prod-<timestamp>.dump` (compressed custom format).
5. File is uploaded to `s3://ridefleet-backup/daily/fleet-prod-<timestamp>.dump`.
6. Remote objects older than 30 days (by `LastModified`) are deleted.
7. Local files older than the last 3 are removed (keeps 3 days of local recoveries for fast rollback).
8. Non-zero exit on any failure — cron captures stderr to `/var/log/ridefleet-backup.log` so a failed run leaves a trail.

### Monitoring the log

```bash
tail -f /var/log/ridefleet-backup.log
# or look at the last run
tail -20 /var/log/ridefleet-backup.log
```

You want a tail that looks like:

```
[backup] 2026-04-21T02:00:03Z Starting pg_dump → /var/backups/ridefleet/fleet-prod-2026-04-21-020003.dump
[backup] 2026-04-21T02:00:09Z pg_dump OK — 4718592 bytes
[backup] 2026-04-21T02:00:09Z Uploading → s3://ridefleet-backups/daily/fleet-prod-2026-04-21-020003.dump
[backup] 2026-04-21T02:00:12Z Upload OK
[backup] 2026-04-21T02:00:12Z Rotating remote backups older than 2026-03-22 (retention: 30 days)
[backup] 2026-04-21T02:00:13Z No old remote backups to rotate
[backup] 2026-04-21T02:00:13Z Done (size=4718592B, key=daily/fleet-prod-2026-04-21-020003.dump)
```

---

## List available backups

```bash
aws --profile digitalocean --endpoint-url https://nyc3.digitaloceanspaces.com \
    s3 ls s3://ridefleet-backup/daily/ --human-readable
```

Output is sorted chronologically; pick the key you want.

---

## Restore procedure — SCRATCH CONTAINER (for monthly rehearsal)

Use this to prove the backup is actually restorable. A backup you've never tested is not a backup.

```bash
cd /root/RideFleetManagement
./ops/restore.sh daily/fleet-prod-2026-04-21-171949.dump
```

Script will:
1. Download the dump from DO Spaces to `/var/backups/ridefleet/restore/`.
2. Start a throwaway `fleet-db-scratch` container (`postgres:17-alpine`).
3. Run `pg_restore` into the `fleet_scratch` database inside it.
4. Print table count + row counts for key tables (Tenant, Reservation, RentalAgreement, Vehicle, Customer) as sanity check.
5. Leave the container running for you to inspect.

Inspect the restored DB:

```bash
docker exec -it fleet-db-scratch psql -U postgres -d fleet_scratch
# (\dt to list tables, \q to exit)

docker exec fleet-db-scratch psql -U postgres -d fleet_scratch \
    -c 'SELECT MAX("createdAt") FROM "Reservation";'
# ↑ should be close to the backup's timestamp
```

When done, clean up the scratch container:

```bash
docker rm -f fleet-db-scratch
rm -f /var/backups/ridefleet/restore/*.dump
```

**Note on versions:** the scratch container runs PG 17 (matches Supabase's production version) regardless of what's in the local `fleet-db-prod` container. That container remains untouched by this script — it's just sitting there empty, as before. We may retire it in a future Wave once we confirm it has no purpose.

---

## Restore procedure — PRODUCTION DATABASE (EMERGENCY)

**Do not use this procedure without reading it through twice first.** In our topology, the production database is on Supabase. `ops/restore.sh` as currently written restores into a scratch container, not into Supabase — that's intentional (an automated script that can overwrite the live DB is too dangerous). Production restore is a manual procedure coordinating with Supabase.

### If Supabase data is intact but corrupted / wrong

Use Supabase's built-in Point-in-Time Recovery (Pro plan feature, $25/mo). In the Supabase dashboard → Database → Backups → PITR, roll back to the exact moment before the incident. This is always faster and safer than restoring from our off-site `.dump`.

### If Supabase is lost / project deleted (disaster)

1. **Stop application writes** — scale backend containers to 0 so nothing writes to a partially-restored DB:
   ```bash
   cd /root/RideFleetManagement
   docker compose -f docker-compose.prod.yml stop backend
   ```
2. **Provision a new Supabase project** (or new PG instance of your choice). Get its direct connection URL (session mode, port 5432).
3. **Download the latest dump** to the droplet:
   ```bash
   aws --profile digitalocean --endpoint-url https://nyc3.digitaloceanspaces.com \
       s3 ls s3://ridefleet-backup/daily/ --human-readable
   # pick the latest; then:
   aws --profile digitalocean --endpoint-url https://nyc3.digitaloceanspaces.com \
       s3 cp s3://ridefleet-backup/daily/<latest-key> /tmp/recovery.dump
   ```
4. **pg_restore into the new Postgres**:
   ```bash
   pg_restore -d "postgresql://postgres:<new-password>@<new-host>:5432/postgres" \
     --no-owner --no-privileges --clean --if-exists /tmp/recovery.dump
   ```
5. **Update `backend/.env`** with the new DATABASE_URL, restart backend:
   ```bash
   docker compose -f docker-compose.prod.yml up -d backend
   curl -sS http://localhost:4000/health  # verify database:true
   ```
6. **Announce completion** in team channel. Include backup timestamp used; anything written after that timestamp is lost.

### If you're unsure which scenario you're in

Contact Supabase support first (check the status page, open a ticket). Most incidents don't require a full restore — PITR fixes them.

### Pre-flight (5 minutes, cannot be skipped)

1. **Stop application writes.** Scale the backend down so nothing can write during the restore:
   ```bash
   cd /root/RideFleetManagement
   docker compose -f docker-compose.prod.yml stop backend
   ```
2. **Take a fresh dump of the current (even corrupt) state** — this is your last line of defense if the restore itself goes bad:
   ```bash
   ops/backup.sh
   ```
   Note the key from the output (e.g., `daily/fleet-prod-2026-04-21-143022.dump`). Save it in your incident log.
3. **Pick the target dump to restore from.** List backups, confirm the timestamp matches the pre-incident state you want:
   ```bash
   aws --profile digitalocean --endpoint-url https://nyc3.digitaloceanspaces.com \
       s3 ls s3://ridefleet-backup/daily/
   ```
4. **Post in the team channel** with: "Restoring prod DB from `<key>`. Expected downtime: ~15 min. Will update."

### Execute the restore

```bash
cd /root/RideFleetManagement
FORCE_RESTORE_PROD=yes ops/restore.sh daily/fleet-prod-<your-chosen-timestamp>.dump fleet_management
```

Watch the output. Expect:
- Download step: ~10 seconds for a few MB, ~1-2 min for hundreds of MB
- DROP + CREATE DATABASE: instantaneous
- `pg_restore`: takes roughly 1 minute per 100 MB of dump on this droplet
- Table count sanity check at the end — compare to your pre-incident expectation

### Post-restore

1. **Spot check with `psql`:**
   ```bash
   docker compose -f docker-compose.prod.yml exec db \
       psql -U postgres -d fleet_management \
       -c 'SELECT count(*) FROM "Tenant";'
   docker compose -f docker-compose.prod.yml exec db \
       psql -U postgres -d fleet_management \
       -c 'SELECT max("createdAt") FROM "Reservation";'
   ```
   The max `createdAt` should be close to the backup timestamp you restored from (within a day, depending on how old the dump was).

2. **Bring the backend back up:**
   ```bash
   docker compose -f docker-compose.prod.yml start backend
   ```

3. **Verify `/health`:**
   ```bash
   curl -sS http://localhost:4000/health
   ```

4. **Post in the team channel:** "Restore complete. DB at state from `<backup timestamp>`. Everything after that timestamp is lost unless WAL archiving is in place (it is not, as of Wave 1)."

---

## Troubleshooting

### `awscli not installed`

```bash
apt install -y awscli
```

### `pg_dump failed`

Check that the prod stack is up:

```bash
docker compose -f docker-compose.prod.yml ps
```

If `fleet-db-prod` is not `healthy`, that's the first problem — investigate before trying a backup.

### `S3 upload failed`

Verify credentials and bucket reachability:

```bash
aws --profile digitalocean --endpoint-url https://nyc3.digitaloceanspaces.com s3 ls s3://ridefleet-backup/
```

Common causes:
- Spaces key was revoked in DO UI — regenerate and re-run `aws configure --profile digitalocean`.
- Bucket name typo — confirm exactly what's in DO UI matches `S3_BUCKET` in the script (default `ridefleet-backup`).
- Network outage from the droplet to DO Spaces — rare; retry in 5 min.

### Cron ran but nothing in Spaces

Look at `/var/log/ridefleet-backup.log` — the failing exit code + log line tells you what went wrong. If empty, the cron entry may not be firing; verify `crontab -l` and `systemctl status cron`.

### Dump looks suspiciously small

The script aborts if the dump is under 1024 bytes. If that triggers, the DB is likely empty or `pg_dump` dumped only the schema without data — check with:

```bash
docker compose -f docker-compose.prod.yml exec db \
    psql -U postgres -d fleet_management -c 'SELECT count(*) FROM "Reservation";'
```

---

## What this runbook does NOT cover (and what's planned)

- **Point-in-time recovery (PITR):** requires WAL archiving + base backups (continuous streaming). Out of scope at 200-user scale; revisit in Wave 4 or when user count grows to the point where "we can lose up to 24h of data" is unacceptable.
- **Cross-region replication:** DO Spaces is single-region (NYC3). For disaster recovery against datacenter failure, a second copy to another DO region (SFO3) or AWS S3 would be Wave 4 work. $5/mo extra. Documented in the production-readiness plan under "Out of scope."
- **Encryption at rest:** DO Spaces encrypts by default. pg_dump output itself is not encrypted; if that matters for compliance, add `gpg --encrypt` to the script before upload — we can do this as a Wave 2 hardening if legal asks.
- **Backup verification bot:** a cron job that every week pulls the latest backup, restores it to a scratch DB, runs sanity queries, reports result to Sentry. Queued for Wave 2 or 3.

---

## Related

- Production-readiness plan: [`docs/operations/production-readiness-plan-2026-04-20.md`](./production-readiness-plan-2026-04-20.md)
- PR workflow: [`docs/operations/agent-driven-pr-workflow.md`](./agent-driven-pr-workflow.md)
- Version-control and release: [`docs/operations/version-control-and-release.md`](./version-control-and-release.md)
