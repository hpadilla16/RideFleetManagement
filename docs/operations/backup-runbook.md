# Backup + Restore Runbook

**Owner:** digitalocean-infra-expert
**Status:** Active (Wave 1, Item 1.1 of the 90-day production-readiness plan)
**Last updated:** 2026-04-20

This runbook covers daily Postgres backups of the Ride Fleet production database to DigitalOcean Spaces, and the operator procedure for restoring from a backup. Scripts referenced live in `ops/backup.sh` and `ops/restore.sh`.

---

## What runs when

| Event | Actor | Trigger | Action |
|---|---|---|---|
| Daily at 02:00 UTC | `root` crontab on droplet | cron | `ops/backup.sh` → `pg_dump` → upload to DO Spaces → rotate >30 days old |
| Monthly (first Monday) | Operator | manual | Restore-rehearsal: run `ops/restore.sh` into scratch DB, verify row counts, destroy scratch DB |
| On incident | Operator | manual | Production restore using the safety procedure at the bottom of this doc |

---

## Prerequisites (one-time setup on the droplet)

### 1. Install `awscli`

```bash
apt update && apt install -y awscli
aws --version   # verify; expect aws-cli/1.x or 2.x
```

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
2. Script runs `pg_dump -Fc` inside the `fleet-db-prod` container via `docker compose exec`.
3. Output is streamed to `/var/backups/ridefleet/fleet-prod-<timestamp>.dump` (compressed custom format).
4. File is uploaded to `s3://ridefleet-backups/daily/fleet-prod-<timestamp>.dump`.
5. Remote objects older than 30 days (by `LastModified`) are deleted.
6. Local files older than the last 3 are removed (keeps 3 days of local recoveries for fast rollback).
7. Non-zero exit on any failure — cron captures stderr to `/var/log/ridefleet-backup.log` so a failed run leaves a trail.

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

## Restore procedure — SCRATCH DATABASE (for rehearsal or testing)

Use this for the monthly rehearsal or for investigating historical data without touching production.

```bash
cd /root/RideFleetManagement
ops/restore.sh daily/fleet-prod-2026-04-21-020003.dump fleet_scratch
```

Script will:
1. Download the dump from Spaces to `/var/backups/ridefleet/restore/`.
2. DROP and recreate the `fleet_scratch` database inside `fleet-db-prod`.
3. Run `pg_restore` to populate it.
4. Print the table count as a sanity check.

Verify the restored DB:

```bash
docker compose -f docker-compose.prod.yml exec db \
    psql -U postgres -d fleet_scratch -c '\dt'

docker compose -f docker-compose.prod.yml exec db \
    psql -U postgres -d fleet_scratch \
    -c 'SELECT count(*) FROM "Reservation";'
```

When done, clean up:

```bash
docker compose -f docker-compose.prod.yml exec db \
    psql -U postgres -d postgres -c 'DROP DATABASE fleet_scratch;'
```

---

## Restore procedure — PRODUCTION DATABASE (EMERGENCY)

**Do not use this procedure without reading it through twice first.** This will drop the live DB.

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
