> **OBSOLETO (2026-08-15).** Este documento describe un scraper Node contra
> Bright Data que YA NO EXISTE. El scraper real es un repo Python/Scrapfly en
> su propio droplet (138.197.27.209, /root/ridefleet-kayak-scraper). No sigas
> estas instrucciones; se conservan solo como historia.

# Market Scraper Droplet Setup

One-time provisioning + setup guide for the market intelligence scraper. The
scraper runs as a standalone Node process invoking `scripts/market-scraper/
run-profile.mjs` per `MarketScrapeProfile`. It connects to Expedia via the
Bright Data Browser API (CDP) and writes observations directly to the Supabase
DB used by production.

## Architecture decision: separate droplet vs production droplet

Two options:

1. **Separate droplet (recommended for production).** Isolates scraper traffic
   so an IP ban from Expedia/Bright Data doesn't take down `ridefleetmanager.com`.
   ~$6/mo extra. This is the path originally agreed on 2026-05-05.
2. **Same droplet as production.** Faster to validate end-to-end. Acceptable
   for testing or low-volume tenants. Migrate to separate when traffic ramps.

This doc covers option 1 (the harder path). For option 2, skip the "Provision"
section and run the "Setup" section against `root@ridefleetmanager.com`.

## Provision a new droplet on DigitalOcean

1. DO console → Create → Droplets
2. Choose:
   - **OS**: Ubuntu 22.04 LTS
   - **Plan**: Basic / Regular / `s-1vcpu-1gb` ($6/mo). Scraper is light:
     one Playwright session at a time, no DB locally, no incoming requests.
   - **Region**: same region as `ridefleetmanager.com` (NYC3) to keep
     Supabase round-trip low. Cross-region adds ~30ms per write × ~150 obs
     per profile = noticeable.
   - **Authentication**: SSH key (same one Hector uses for the prod droplet).
   - **Hostname**: `ridefleet-scraper-prod` (or pick anything; the deploy
     scripts don't read the hostname).
3. Wait ~60s for provisioning. SSH from your Mac: `ssh root@<droplet-ip>`.

## One-time setup on the droplet

Run these as `root`. Single paste block:

```
apt-get update && apt-get install -y curl git ca-certificates && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && node --version && npm --version && cd ~ && git clone https://github.com/hpadilla16/RideFleetManagement.git && cd RideFleetManagement/backend && npm ci && npx prisma generate && echo '--- setup OK ---'
```

The `npm ci` here installs **both** regular deps and devDependencies (we
don't pass `--omit=dev` like the Docker prod build does), because
`playwright-core` is a devDependency and the scraper needs it.

## Environment configuration

Create `backend/.env` on the droplet with these vars (Hector fills the
secrets from his Bright Data + Supabase dashboards):

```
DATABASE_URL='postgresql://...@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true'
BRIGHTDATA_SB_URL='wss://brd-customer-hl_a0030ce5-zone-expedia_scraping_browser:<PASSWORD>@brd.superproxy.io:9222'
NODE_ENV=production
```

Notes:
- `DATABASE_URL` must point at the same Supabase pooler that production
  uses — the scraper writes observations the main app reads, so they share
  the DB.
- `BRIGHTDATA_SB_URL` is the Bright Data Browser API CDP endpoint. **The
  password leaked in a screenshot on 2026-05-05.** Per Hector's 2026-05-11
  call, rotate after the end-to-end pipeline is validated, not before.
- Do NOT add JWT_SECRET, REDIS_URL, etc. — the scraper doesn't run the API
  server, just the script.

## Smoke test: manual run against an existing profile

Pick a profile ID from the main app's Market Intelligence page (URL or the
network panel after clicking the profile), then on the droplet:

```
cd ~/RideFleetManagement/backend && set -a && . ./.env && set +a && node scripts/market-scraper/run-profile.mjs --profile-id <PROFILE_ID>
```

Expected output:
```
[run-profile] profileId=<id>
[run-profile] connecting to Bright Data Browser API...
=== Done in <N>s — <ok> ok, <err> err, <N> pricing rows ===
[run-profile] done: { "runId": "...", "status": "SUCCESS", ... }
```

If `status: SUCCESS` or `PARTIAL`, refresh the Market Intelligence UI in
production — the Run should appear in the profile's "Recent runs" table,
and clicking it should show the Comparison diff.

If `status: FAILED` with `nav: timeout`, check that `BRIGHTDATA_SB_URL`
has the right password and that the Bright Data zone is active.

If the script hangs after "Prisma schema loaded" — that's the same
Supabase pgbouncer hang we hit during the main droplet deploy. Re-run; if
persistent, fall back to a direct (non-pooler) connection by replacing
the pooler hostname with the direct one from the Supabase dashboard.

## Schedule (Phase 6 — pending)

Once smoke tests pass, add a cron entry. For now keep it manual so we can
observe a few runs end-to-end before automating. The Phase 6 doc (TBD) will
cover the systemd timer template + Sentry alerting.

## Security checklist (post-validation)

Before declaring production-ready:

- [ ] Rotate the Bright Data zone password (Bright Data dashboard → zone
      settings → Rotate password) and update `BRIGHTDATA_SB_URL` on the
      droplet.
- [ ] Confirm the droplet's `~/RideFleetManagement/backend/.env` is mode
      `600` (`chmod 600 ~/RideFleetManagement/backend/.env`).
- [ ] Confirm UFW (or DO's firewall) only allows SSH inbound — the scraper
      doesn't need any inbound ports.
- [ ] Disable password SSH (`PasswordAuthentication no` in
      `/etc/ssh/sshd_config` + `systemctl restart ssh`).
