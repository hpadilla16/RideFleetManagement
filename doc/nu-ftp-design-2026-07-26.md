# NU via FTP — design + open questions (2026-07-26)

Prepared while Hector sleeps, from a full read of the current integration.
Nothing built yet — the decisive unknowns below need NU's answers first.

## Where we are

Today NU is an **HTML scrape** of their ASP.NET/Telerik portal (plain fetch +
regex RadGrid parser, `nu.service.js`). The scheduler → worker → upsert →
promotion chain is solid and mostly transport-agnostic:

- Scheduler needs **no change**: it enqueues `nu.sync`; the worker's single
  call to `fetchReservationList` (`nu.worker.js:207-209`) is the whole seam.
- Idempotency at row level already works: `(sourceSystem, externalRef)` upsert,
  promoted-status skip, in-tx re-check, duplicate-detector LINK. Re-downloading
  the same file is harmless.
- `isPrepaidFromCode` (PP/OP → isPrepaid), ACRISS mapping, date/TZ/money
  helpers, window filter, scheduler flags, and ALL of `nu.routes.test.mjs`
  survive an FTP swap unchanged. The RadGrid/WebForms/login halves of
  `nu.test.mjs` become obsolete and get replaced by file-parser tests.

## The plan (when answers arrive)

1. **Transport**: add `basic-ftp` explicitly (already in the lockfile at 5.3.0
   transitively via puppeteer → zero new download; FTPS via `secure:true`).
   Only if NU turns out to be SSH: `ssh2-sftp-client` instead. New
   `booking-source/ftp-common.js` factory (mirrors `http-common.js`) exposing
   `listFiles` / `downloadFile → Buffer` + an AuthExpired-equivalent for 530,
   connect-once/retry-once posture copied from `authedFetch`.
2. **Parser**: header-NAME-keyed with a required-header drift guard — copy the
   Advantage model (`advantage.constants.js:348`), NOT NU's positional
   HEADER_ANCHORS. If `.xlsx`: `exceljs` is already a dep and
   `rates.service.js:485` is the load template. If CSV: tiny in-repo parser
   (quoted commas handled), no new dep.
3. **Credentials**: keep `{username,password}` encrypted in
   IntegrationCredential (contract + tests untouched); non-secret connection
   details as env `NU_FTP_HOST/PORT/DIR/SECURE` matching the existing
   `NU_BASE` style. `testAuth` becomes connect+list; keep the
   EXPIRED/ERROR write-back verbatim so the admin panel works unchanged.
4. **Processed-file ledger** (new, small): `IntegrationFileIngest(tenantId,
   sourceSystem, filename, contentHash, sizeBytes, ingestedAt)` unique on
   (tenantId, sourceSystem, filename, contentHash) — a poll with no new file
   becomes a cheap no-op instead of re-upserting the snapshot every 15 min.
5. **Cadence**: lengthen `NU_SYNC_INTERVAL_MINUTES` to match the drop cadence,
   or rely on the ledger no-op.
6. **Shadow period**: `NU_TRANSPORT=ftp|http` flag; run FTP alongside the
   scrape and diff outputs for a few days before cutover — cheap insurance on
   the money fields (estimatedTotal, isPrepaid).
7. **Optional same ship**: wire NU onto the shared `createPromoter(NU_SPEC)` /
   `createSyncScheduler` (the parity suite already proves byte-identical
   writes) — halves the module while we're in there.

## Questions for NU (Hector: forward these)

1. FTP, FTPS, or SFTP? Host, port, credentials, directory path.
2. File format: `.xlsx` / `.csv` / fixed-width / XML? (Their portal's own
   export button emits `.xlsx` — suggestive, not confirmed.)
3. Full snapshot per file, or delta? If delta: how do CANCELLATIONS appear?
   (The current mapper hardcodes status CONFIRMED — a delta feed with dead
   bookings needs the Advantage-style derived status.)
4. Filename convention + drop cadence + retention/rotation.
5. Are the columns the same 20 as the portal grid? Specifically: is the
   **PP/OP prepaid token present**? (If not, the prepaid badge loses its
   input — money-adjacent.)
6. Is there a customer EMAIL column? (The grid has none; its absence is what
   forces most rows to manual review / auto-create today.)

## Risks

- "FTP" from an ASP.NET/IIS shop is probably plain FTP or FTPS, not SFTP —
  don't buy the SSH dependency until confirmed.
- A slow FTP download holds the single BullMQ slot (concurrency 1) — fine at
  daily cadence, worth a timeout.
- If the file lacks PP/OP, isPrepaid semantics need a NEW answer from NU
  before cutover, not a silent null.
