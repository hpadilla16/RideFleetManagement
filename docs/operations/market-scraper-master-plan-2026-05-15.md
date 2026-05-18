# Market Intelligence Scraper — Master Plan

> Updated 2026-05-15 after end-of-day testing session against Bright Data, ScrapingBee, and Apify. Captures the current state of the deployed pipeline, the data-source findings, and the path forward.

## 1. Status quo (already deployed)

Backend, frontend, and DB schema are all in production at `ridefleetmanager.com` (tag `v0.9.0-beta.34` plus hotfixes). The pipeline is data-source-agnostic — it accepts `MarketObservation` rows from anywhere and runs Comparison + Correction on them.

| Layer | Status | Lives in |
|---|---|---|
| Supabase tables (`MarketScrapeProfile`, `MarketScrapeRun`, `MarketObservation`) + 4 enums | ✅ Applied | Supabase prod |
| CRUD API (`/api/market-scraper/profiles/*`, `/runs/*`) | ✅ Deployed | RideFleet backend container |
| Runner service (`runProfile(profileId, {scraper, sippMap})`) | ✅ Built, untriggered in prod | `backend/src/modules/market-scraper/market-scrape-runner.service.js` |
| Comparison service (cheapest-per-(date,sipp) diff vs current `RateDailyPrice`) | ✅ Built + tested | `…/market-scrape-comparison.service.js` |
| Correction service (write back via `ratesService.importDailyPrices`) | ✅ Built + tested | `…/market-scrape-correction.service.js` |
| Market Intelligence dashboard UI (profiles CRUD, runs table, comparison diff, Apply button) | ✅ Live at `/market-intelligence` | `frontend/src/app/market-intelligence/page.js` |
| Standalone microservice scaffold (separate repo, for future droplet) | ✅ Scaffolded local | `~/Code/ridefleet-market-scraper-staging/` |
| CLI scrapers (3 variants — Bright Data, ScrapingBee, Apify) | ✅ Built, last is the live one | `backend/scripts/market-scraper/` |
| Real demo data (Bright Data 2026-05-13 morning, Apify 2026-05-15) | ✅ Excel on Hector's Desktop | `~/Desktop/sju-*.xlsx` |

**What's missing for production:** a reliable data source that survives Expedia's anti-bot consistently. Everything else is ready.

## 2. Data-source findings (2026-05-14 / 2026-05-15)

We tested three providers in earnest. All hit Expedia's anti-bot at different stages:

### Bright Data Browser API — DEAD END
- Worked on 2026-05-13 morning for ~9 days of SJU before session crash
- 2026-05-14: returned `Requested URL is restricted in accordance with robots.txt` on every request
- Confirmed by Bright Data support on 2026-05-14 that they enforce `robots.txt` at the proxy level for all zone types. Cannot whitelist Expedia.
- See `feedback_brightdata_expedia_dead_end.md` in memory.

### ScrapingBee — DEAD END
- HTTP API returned 200 with rendered HTML
- But every response was the Expedia *shell* (header/footer) without any `[data-stid="car-offer-card"]` elements
- Tested with `render_js=true`, `premium_proxy=true`, AND `stealth_proxy=true` — all returned 0 cards
- Expedia fingerprints ScrapingBee's IPs even with stealth mode

### Apify (`shahidirfan/Expedia-Car-Rental-Scraper`) — WORKING WITH CONSTRAINTS
- Returned 25 listings in 130s when it succeeds
- Output has clean structured fields including direct `vendor_brand`
- BUT: free-tier `RESIDENTIAL` proxy pool is shared across all Apify users; IPs get fingerprinted by Expedia after one successful SJU request and `429 Too Many Requests` for ~10-30 min after
- Apify `BUYPROXIES94952` datacenter pool gets `403/429` at the bootstrap page (even worse)
- Successful SJU runs today: **1** (the 13:43 diagnostic curl) out of ~5 attempts
- MCO works single-shot more reliably (higher organic traffic → higher pool turnover)

### Two technical wins worth keeping
1. **Canonical Expedia URLs evade the actor's auto-heal step.** Minimal URLs like `?locn=sju` get expanded internally, and that expansion is part of what Expedia rate-limits. Using the full URL (with `dpln`, long `locn`, `olat`/`olon`) skips that step. Committed in `scrape-expedia-apify.mjs` via the `AIRPORT_CONFIGS` table.
2. **`apifyProxyCountry: "US"`** forces US-based residential IPs. Required because Expedia treats foreign IPs more aggressively. Committed.

## 3. Path forward — Apify Starter + scheduled runner

### 3.1 Upgrade Apify to Starter plan ($39/mo)

This is the most cost-effective fix. Starter unlocks:
- **SHADER residential proxy group** — dedicated residential pool, not shared with other free-tier scrapers. Fingerprint isolation = no more "someone else burned my IP".
- Higher `maxMonthlyResidentialProxyGbytes` (50 GB vs 20 GB)
- Priority queue (faster cold-starts on actor runs)

Without Starter, the free tier residential pool is poisoned for SJU within minutes of starting. With SHADER, each tenant's scraping load is isolated.

**Cost:** $39/mo Apify base + per-result charges (~$0.56 per 15-day scrape × 30 days = $16.80/mo for daily SJU).

**Total Apify monthly:** ~$56/mo for one daily SJU scrape, or ~$200/mo if we run SJU 1-14 daily + 15-30 daily + a second airport.

### 3.2 Wire the runner to invoke the Apify actor (Phase B.3.5)

Today the runner expects a `scraper.scrapeOneSearch({airport, pickup, return}) → {listings, error}` interface. We have:
- `createExpediaSession()` for Playwright/CDP (Bright Data) — keep as historical reference, mark deprecated.
- An Apify HTTP client embedded in the CLI script — needs to be extracted into a reusable module.

**Work:**
- Add `backend/src/modules/market-scraper/apify-source.js` exporting `createApifyExpediaSession({token, actorId, proxyGroups})`. Same `scrapeOneSearch` interface as the existing Bright Data session. Internally calls `run-sync-get-dataset-items` and maps the dataset items into our listing shape.
- Update the runner CLI (`scripts/market-scraper/run-profile.mjs`) so `--source apify` selects the new session factory.
- Drop in the canonical URL builder (`AIRPORT_CONFIGS` table) so the runner uses the same URLs the CLI does.
- Tests: 4-6 subtests around the Apify session — mocked HTTP, error mapping, vendor extraction.

**Estimate:** 3-4 hours of work, no infra dependencies.

### 3.3 Per-airport `AIRPORT_CONFIGS` lookup table moves to DB

Currently the canonical-URL config lives in the CLI script. To support multiple tenants × multiple airports, this needs to be either:
- A reference table (`AirportSearchConfig` model) seeded by us as we onboard airports, OR
- An admin-managed table in the Market Intelligence UI

**Decision:** stage 1 = hardcoded JSON in the runner package (SJU, MCO, LAX, MIA preseeded). Stage 2 = if we get to 5+ airports, promote to DB table. Don't over-engineer yet.

### 3.4 Provision the dedicated scraper droplet (Phase 3 — pending)

Plan unchanged from `docs/operations/scraper-droplet-setup.md`. Once the Apify integration is module-level (3.2), the droplet only needs:
- Node 22
- Clone `ridefleet-market-scraper-staging` (push to GitHub first)
- `npm ci && npx prisma generate`
- `.env` with `APIFY_TOKEN` + Supabase `DATABASE_URL`

The droplet is overkill for "call Apify API by HTTP" — could even run on the production droplet as a sidecar. **Cost-saving suggestion:** skip the separate droplet for now and let the main RideFleet backend's cron call `runProfile(profileId, ...)` directly. The Apify proxy concern (IP isolation) is moot when we're just calling Apify's HTTP API, not driving a browser ourselves.

Revised plan: **no second droplet**. Add a cron entry to the existing prod droplet. Saves $6/mo + ops surface.

### 3.5 Schedule the cron (Phase 6 — pending)

```bash
# /etc/cron.d/ridefleet-market-scraper (on the prod droplet)
# Runs all active MarketScrapeProfile rows at 04:01 ET daily.
1 4 * * * root cd ~/RideFleetManagement && docker compose -f docker-compose.prod.yml exec -T backend node scripts/cron/run-all-market-scrape-profiles.mjs >> /var/log/market-scraper.log 2>&1
```

That script (TBD) loops every profile where `active = true`, calls `runProfile(id)`, sleeps a randomized delay between calls (3-10 min to avoid hammering Apify), and exits when done.

### 3.6 Monitoring (Phase 6 — pending)

- Sentry alert on any `MarketScrapeRun` with `status = FAILED`
- Sentry alert on any profile where `lastSuccessAt < now - 3 days` (catch quiet failures)
- Grafana dashboard panel: runs/day, observations/day, $-spent on Apify

## 4. Phases + sequencing

| # | Phase | Owner | Blocker | ETA |
|---|---|---|---|---|
| 1 | Upgrade Apify to Starter plan | Hector | — | 5 min |
| 2 | Test Apify SHADER proxies with canonical URLs (validate fix) | Claude | After (1) | 30 min |
| 3 | Extract `apify-source.js` module in backend | Claude | After (2) verified | 3-4 hours |
| 4 | Wire `runProfile()` to use Apify source via env var (`MARKET_SCRAPER_SOURCE=apify`) | Claude | After (3) | 1 hour |
| 5 | Push `ridefleet-market-scraper-staging` to GitHub (optional, only if separate droplet) | Hector | — | 5 min |
| 6 | Skip separate droplet — host the cron on the prod droplet instead | — | After (4) | — |
| 7 | Write `scripts/cron/run-all-market-scrape-profiles.mjs` | Claude | After (4) | 1 hour |
| 8 | Set up cron entry + log rotation on prod droplet | Hector | After (7) | 15 min |
| 9 | Wire Sentry alerts on FAILED runs + stale `lastSuccessAt` | Claude | After (8) | 1 hour |
| 10 | Validate end-to-end: cron triggers daily, observations populate, Comparison + Correction work, prices applied | Both | After (9) | 1 week of soak |
| 11 | Frontend: add "Run now" button on UI that triggers runner via new POST route | Claude | After (10) green | 2 hours |

**Total dev time:** ~10-12 hours of work distributed across 2-3 sessions. **Total dollars:** $39/mo Apify + $0 marginal infra.

## 5. Risks + contingencies

### Risk A — Even SHADER residential gets fingerprinted by Expedia
- **Probability:** Medium. SHADER is better than shared free pool but Expedia's anti-bot is sophisticated.
- **Mitigation:** Build in retry-with-backoff at the runner level. If a profile fails 3 days in a row, page Hector via Sentry. Worst case we add a second provider (ZenRows, Oxylabs Web Scraper API) as failover.

### Risk B — Apify costs spiral
- **Probability:** Low at single-profile cadence (~$17/mo extra). Could climb if we scale to 4-6 profiles × 2-3 airports.
- **Mitigation:** `Usage limit` toggle on Apify account ($100/mo cap). Alert if monthly trend exceeds budget.

### Risk C — Apify actor `shahidirfan/Expedia-Car-Rental-Scraper` deprecates or breaks
- **Probability:** Medium — it's a community actor, last updated 2026-05-01, only 286 lifetime runs.
- **Mitigation:** Subscribe to actor issues, keep an eye on its run-success metric. If it dies, options: (a) fork it, (b) write our own actor on Apify (using their SDK + RESIDENTIAL proxies + got-scraping), (c) switch to a different actor if one appears.

### Risk D — Expedia changes the search API and breaks the actor
- **Probability:** Always present. They change selectors / GraphQL shape occasionally.
- **Mitigation:** Same as Risk C. The community actor's maintainer usually patches within days. We'd have to wait.

## 6. Definition of done

- [ ] One `MarketScrapeProfile` runs daily at 04:01 ET against SJU via Apify SHADER
- [ ] Daily observations populate `MarketObservation` table
- [ ] Comparison view in UI shows non-empty deltas vs current `RateDailyPrice`
- [ ] When `autoApply = true`, `RateDailyPrice` rows actually update with suggested values
- [ ] Sentry alerts fire on FAILED runs and 3-day-stale profiles
- [ ] At least 14 consecutive days of successful scrapes documented in the run history before declaring stable

## 7. What's NOT in scope of this plan

- Scraping any source other than Expedia (Kayak, Priceline, Booking)
- Multi-region rollout beyond US airports
- Real-time market intelligence (intraday refreshes) — we run daily windows by design
- Anything involving manually editing observations from the UI

These come later, once the daily Expedia path is stable.
