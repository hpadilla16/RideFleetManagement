# Market scraper (Expedia → suggestion report XLSX)

Standalone Node CLI that drives a Bright Data Browser API (Playwright over CDP),
scrapes Expedia car rental search pages for the next N days, computes the
cheapest market price per ACRISS/SIPP category per day, applies a pricing
strategy, and emits an `.xlsx` in the same format that the existing
`/api/rates/:id/daily-prices/import` endpoint accepts.

## Prerequisites

- Bright Data Browser API zone with TLS endpoint (see `project_redis_upstash` and `project_market_scraper` memory for the auth pattern).
- Env var `BRIGHTDATA_SB_URL` set to the CDP wss URL with credentials.
- `playwright-core` and `exceljs` already exist as backend deps.

## Run

Smoke run (3 days look-ahead, 3-day LOR, $1-off-cheapest strategy):

```bash
export BRIGHTDATA_SB_URL='wss://brd-customer-...@brd.superproxy.io:9222'
node scripts/market-scraper/scrape-expedia.mjs \
  --airport sju \
  --look-ahead 3 \
  --lor 3 \
  --strategy cheapest_minus \
  --strategy-amount 1 \
  --output /tmp/sju-test.xlsx
```

Full run (15 days):

```bash
node scripts/market-scraper/scrape-expedia.mjs \
  --airport sju \
  --look-ahead 15 \
  --lor 3 \
  --strategy cheapest_minus \
  --strategy-amount 1 \
  --output /tmp/sju-full.xlsx
```

## Strategies

| `--strategy` value      | Effect                                                  | Params                                  |
|-------------------------|---------------------------------------------------------|-----------------------------------------|
| `cheapest_minus`        | Recommend cheapest competitor price minus `$X`          | `--strategy-amount` (default 1)         |
| `match_cheapest`        | Match cheapest competitor exactly                       | —                                       |
| `cheapest_plus_pct`     | Cheapest + Y% (price-up strategy)                       | `--strategy-pct` (default 5)            |
| `static_floor`          | Use `MAX(cheapest, floor)` — never go below floor       | `--strategy-floor` (required)           |

`--strategy-floor` is always respected as a hard floor (set to your cost-plus-margin).

## Anti-detection knobs

| Flag             | Default      | Notes                                                              |
|------------------|--------------|--------------------------------------------------------------------|
| `--delay-min`    | 5000 (ms)    | Min sleep between searches                                         |
| `--delay-max`    | 15000 (ms)   | Max sleep between searches                                         |
| `--nav-timeout`  | 90000 (ms)   | Per-page navigation timeout                                        |
| `--price-timeout`| 60000 (ms)   | Wait for prices to render after DOMContentLoaded                   |
| `--debug`        | off          | Log unmapped category names so you can extend `category-sipp-map`  |

Times are RANDOMIZED within business hours (8 AM–6 PM) with non-`:00` minutes
on every request — `:00` minutes return inflated decoy prices Expedia uses as
an anti-scraping tripwire.

## Output

XLSX with two sheets:

1. **Suggestion Report** — rows of `Sipp / Location / PickUpDate / SuggestedAmount / CheapestSeen / CheapestVendor / ListingsSampled / Strategy`. The first four columns match the headers the backend importer recognizes; the rest are diagnostic for review before applying.

2. **Run Metadata** — when the run was, parameters used, OK/err counts.

## Import to RideFleet after a run

```bash
# Pick the target rate from /api/rates/lookup-by-location/SJU
# Then upload the XLSX via the existing UI (Settings → Rates → edit rate
# → "Upload Excel (Suggestion Report)") which gives you the diff preview
# before applying. The unknown-SIPP filtering handles categories your
# tenant doesn't have.
```

## Phase 2 (not yet implemented)

- Schedule (daily cron at 4 AM ET) on a dedicated DO droplet — see
  `project_market_scraper` memory.
- Auto-POST the XLSX to `/api/rates/:id/daily-prices/import` with
  `silentSkipUnknownTypes: true` — no human review step.
- Per-rate `pricingStrategy` config on the `Rate` model so the loop iterates
  across active rates instead of being CLI-driven.
