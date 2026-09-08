# Advantage reservation ingestion by EMAIL

**Built 2026-09-08. Ships DARK** — `ADVANTAGE_EMAIL_INTEGRATION_ENABLED` defaults to
false, so nothing polls anybody's mailbox until it is flipped on the droplet AND a
tenant's mailbox credential is saved in the panel.

---

## Why this exists

Every booking source RFM has today is a **portal scraper**: Economy (RezLight), NU,
Flexways (MobilityPS), MEX, TL International, and Advantage's own TSD RezCentral
worker. There was no inbound-mail path anywhere in the codebase — `lib/mailer.js` is
outbound only.

> **Ryan White, IT Manager, Advantage Car Rental (rwhite@advantage.com), 2026-09-08:**
> "Since there is no TSD integration, everything will need to be done VIA email
> delivery."

So this adds the one missing piece — a mail transport and a parser — and then hands
off to machinery that already exists.

## What was reused, not rebuilt

| Piece | Status |
| --- | --- |
| `ExternalReservation` / `ExternalSyncRun` staging | unchanged, used exactly as the scrapers use it |
| `booking-source/promote.js` (`createPromoter`) | unchanged — money posture preserved for free |
| `booking-source/promotion-matcher.service.js` | unchanged |
| `booking-source/customer-autocreate.js` | unchanged, gated by its own flag |
| `booking-source/import-franchise.js` | unchanged — franchise resolves off `sourceSystem` |
| `booking-source/scheduler-factory.js` | unchanged |
| `AdvantageLocationConfig` | unchanged — the SAME `(tsdNumber, branch)` mapping routes the email |
| `booking-source/http-common.js` `createCredentialStore` | **one additive change**: an optional `extraFields` list, default `[]`, so a mailbox can carry host/port/folder inside the same encrypted blob. With no extra fields the payload is byte-identical to what every existing source writes. |
| `modules/retention` | **one additive category** for the raw-message purge |

New tables: **one** (`AdvantageInboundEmail`). New npm dependencies: **zero**.

---

## Hector's four decisions (2026-09-08)

1. **Transport — IMAP mailbox we poll.** Fits the existing shape exactly: a BullMQ
   scheduled job, one `ExternalSyncRun` per poll, credentials in the shared encrypted
   store, no public endpoint, no DNS change, and an unhandled message stays in the
   mailbox so a bad parse can be re-run.
2. **Payload — parse everything, write only `estimatedTotal`.** The whole document
   (assigned unit, mileage/fuel out, counter extras with prices, authorizations, the
   card deposit, the activity trail) is structured into `rawJson`. Nothing but
   `estimatedTotal` reaches the Reservation.
3. **Retention — store the raw body, purge it at 90 days** through the existing
   retention sweep.
4. **Tenant — config-driven.** Routing resolves `(61302, MCO)` → `AdvantageLocationConfig`
   → `tenantId` + `locationId`. Nothing is hardcoded and nothing is seeded; an email
   for an unconfigured pair is quarantined.

---

## The document

One full sample was supplied. It is a fixed-column text report:

```
Advantage Orlando (61302)          ← brand + TSD account number
AMADEUS ***CONFIRMATION***         ← GDS channel + the DOCUMENT TYPE banner

Confirmation #    : AEXP141D54
Renter Name       : TRUITT, ANDYD
Home Phone        : 18125996155    ← the RENTER
Pickup/Return     : MCO - MCO
Confirmed Rate    : 14.72/Day  for 5 day(s) , 14.72/Extra Day  UNL
Booking Source    : 11617270
                  EXPEDIA.COM
Phone             : 1404728-8787   ← the TRAVEL AGENCY, not the renter

RESERVATION HISTORY / RENTAL AGREEMENT DETAILS /
RENTAL.NET CHARGE DETAILS / PAYMENT DETAILS / ACTIVITY
```

### Three things the design turns on

**1. `Phone` is not the renter's phone.** It sits under `Booking Source` and belongs to
EXPEDIA.COM in Atlanta; the renter's is `Home Phone`. Staging the wrong one would hand
the shared matcher a key shared by every booking that agency ever sold — the same class
of failure the phone-placeholder work already fought on the Advantage portal path. The
parser keys strictly on labels, never on position, and the agency block is kept in its
own `bookingSource` object. Locked by a test.

**2. The document is a snapshot, not an event.** The sample is banner-dated at booking
time (2026/08/07 13:52) yet already carries a `RENTAL AGREEMENT DETAILS` block for a
pickup that happened 2026/09/03, with the unit assigned, the fuel read and a 381.80
deposit taken. The same confirmation number therefore arrives repeatedly with more
filled in each time. Everything upserts; a later copy enriches the row.

**3. `estimatedTotal` is 73.60, and it is labelled.** The portal scraper reads a
`Total Bill` (rate + tax). This document gives a daily rate and a day count, so
14.72 × 5 = 73.60 — base rate, **before tax, before the counter extras** (PSP prepaid
SunPass 16.99/day, DW deposit waiver 39.99/day) that took the real card deposit to
381.80. The basis travels into `rawJson.estimatedTotalBasis` **and** into the
reservation's notes line:

> `Imported from Advantage (email) — AEXP141D54 (pay-at-destination) — estimate is the daily rate x days, BEFORE tax and any counter extras`

An unlabelled 73.60 gets read as the price of the rental by the next person who opens
it. When the rate is not per-day (a weekly rate cannot be multiplied by a day count) the
estimate is refused — `null` — rather than invented.

---

## How a message becomes a reservation

```
IMAP UNSEEN → BODY.PEEK[]  (the message stays unread)
  ↓  mime-text.js       → headers + the text/plain part, at any nesting depth
  ↓  sender allowlist   → quarantine: sender_not_allowed
  ↓  message ledger     → identical re-delivery? stop. changed body? re-parse.
  ↓  parser             → quarantine: layout        (names EVERY missing field at once)
  ↓  banner vocabulary  → quarantine: unknown_doc_type
  ↓  (tsdNumber, branch)→ quarantine: location_not_configured
  ↓  ExternalReservation upsert on (sourceSystem='ADVANTAGE', externalRef)
  ↓  CANCELLATION?  → REJECTED source_cancelled   (or: already promoted → DO NOTHING, loudly)
  ↓  evaluatePromotion → AUTO → promoteAutomatically   |   else MANUAL_REVIEW
  ↓  record the ledger row
  ↓  UID STORE +FLAGS (\Seen)      ← only now
```

**Flagging is last on purpose.** A message that fails mid-way is left unread and comes
back on the next run. A duplicate import is free (the upsert is keyed on the confirmation
number); a lost reservation is not.

### Two `sourceSystem` values

- `ADVANTAGE` for **staged rows**. A booking is a booking however it reached us; the
  review tray, the franchise resolver and the `(sourceSystem, externalRef)` unique all
  key on this. If the portal worker ever becomes available for this account, both paths
  converge on one row for `AEXP141D54` instead of racing to create two.
- `ADVANTAGE_EMAIL` for the **credential** and the **run history**.
  `IntegrationCredential` is unique on `(tenantId, sourceSystem)` and the portal worker
  already owns `ADVANTAGE` there with the TSD login — a mailbox password must not evict
  it. Separate runs are what make "the mailbox has been quiet for two days" legible
  instead of averaged into a scraper's history.

### Nothing is inferred about cancellation

The banner (`***CONFIRMATION***`) is treated as a **closed vocabulary**. A token we know
maps to a decision; a token we do not know quarantines the message, counts it, names it
in the run notes, and turns the run `ATTENTION`. Reading an unfamiliar banner as a
confirmation resurrects cancelled bookings; reading one as a cancellation kills live
ones.

A cancellation for a row we **already promoted** does **not** touch the live Reservation
— cancelling a live rental is an ops/money decision, not an importer's. It increments
`cancelledAfterPromote` and says so in the run notes, exactly as the portal worker does.

---

## Security posture, stated plainly

An inbound mailbox is a **write path into the reservation system** that anyone who
learns the address can post to, and a `From` header is forgeable. What actually stops a
forged message becoming a rental:

1. the `(tsdNumber, branch)` pair must match an **enabled** `AdvantageLocationConfig`
   row for that tenant;
2. the row lands in **staging** and still has to pass every promotion gate;
3. it can only ever write `estimatedTotal` — no card, no charge, no vehicle.

`ADVANTAGE_EMAIL_ALLOWED_SENDERS` adds a speed bump on top. It defaults to **empty =
accept any sender**, and that is deliberately not silent: the run notes say
`senders UNRESTRICTED` and `GET /status` reports `senderAllowlist: "unrestricted"`.
Set it once the real sending domain is known.

---

## PII and retention

`AdvantageInboundEmail.rawBody` is the verbatim message and carries the renter's name,
phone and personal email address. It is kept **only** so a mis-parse can be diagnosed
and replayed. The existing retention sweep NULLs it at `RETENTION_INBOUND_EMAIL_DAYS`
(default **90**) and stamps `rawPurgedAt`; the ledger row itself survives, because it is
what stops a re-delivered message importing twice and what makes a quarantine
explainable. `GET /messages` never selects `rawBody`.

This sits under the two-clock model decided 2026-08-22 as a third, shorter clock for
transport data — it is not customer-record retention.

The committed test fixture is the real sample **with the renter scrubbed** (name, phone,
email). Booking references are kept so it stays recognisably the document in the thread.

---

## Files

```
backend/src/modules/integrations/advantage-email/
  advantage-email.constants.js      identity, banner vocabulary, mailbox config, allowlist
  mime-text.js                      PURE. RFC 822 → headers + text/plain
  imap-client.js                    minimal IMAP4rev1 over node:tls (6 verbs, no EXPUNGE)
  advantage-email.parser.js         PURE. the document → a structured object
  advantage-email.service.js        credentials + a one-message-at-a-time mailbox session
  advantage-email.worker.js         the job: poll → parse → route → stage → promote
  advantage-email.scheduler.js      shared scheduler factory wrapper
  advantage-email.routes.js         the panel
  advantage-email-parse.test.mjs        37 tests
  advantage-email-worker.test.mjs       21 tests  (full handler, no DB, no socket)
  advantage-email-transport.test.mjs    16 tests  (MIME + IMAP literals)
backend/prisma/migrations/20260918_advantage_inbound_email/migration.sql
```

Wired into `main.js` (router), `worker.js` (worker + scheduler + shutdown),
`package.json` (`test:advantage-email`, in the `npm test` chain) and `beta-ci.yml`.

### Why no `imapflow` / `mailparser`

This needs six IMAP verbs against one folder and the text/plain part of a
machine-generated report, feeding a PCI-scoped production system. A mail library brings
a dependency tree and a licence to audit for a surface that narrow. Both hand-written
pieces are pure and directly unit-tested — the IMAP literal reader hardest of all,
because its failure mode is a silently truncated confirmation rather than an error.

Writing them found two real bugs the tests caught before they shipped: a header line
still carrying its CR vanished entirely (JS `.` does not match `\r`), and a MIME
boundary containing a semicolon was truncated to a prefix, which finds no parts and
quarantines as "no text/plain" with nothing pointing at the cause.

---

## Ops runbook

### 1. Droplet env (Hector sets these; they are not secrets except where noted)

```
ADVANTAGE_EMAIL_INTEGRATION_ENABLED=true      # the master gate. LAST thing you flip.
ADVANTAGE_EMAIL_SYNC_INTERVAL_MINUTES=15      # default 15
ADVANTAGE_EMAIL_ALLOWED_SENDERS=advantage.com # STRONGLY recommended once known
ADVANTAGE_EMAIL_MAX_PER_RUN=200               # default 200
RETENTION_INBOUND_EMAIL_DAYS=90               # default 90
# Optional fleet-wide defaults, overridden per tenant in the panel:
ADVANTAGE_EMAIL_IMAP_HOST=
ADVANTAGE_EMAIL_IMAP_PORT=993
ADVANTAGE_EMAIL_MAILBOX=INBOX
ADVANTAGE_EMAIL_PROCESSED_MAILBOX=            # empty = flag \Seen only, do not move
ADVANTAGE_EMAIL_AUTO_CREATE_CUSTOMERS=false   # leave OFF for now, see below
```

`ADVANTAGE_EMAIL_AUTO_CREATE_CUSTOMERS` has its own flag rather than sharing the portal
worker's. `ADVANTAGE_AUTO_CREATE_CUSTOMERS` is false in production because the T&M
report has no phone and no email on ~50% of rows, so auto-creating from it manufactures
contactless customer records. **This source is the opposite case** — the email carries a
name, a `Home Phone` and usually an email address — so turning it on here is a much
smaller decision than turning it on there. Still yours to make.

### 2. Deploy

```bash
ops/deploy.sh
```

Blue-green, per the 2026-08-22 rehearsal. **Not** plain `docker compose up -d` (502s the
counter), and any manual compose command must use `-f docker-compose.prod.yml`.
The migration is additive and re-runnable; it touches no existing table.

### 3. Panel, per tenant

1. Confirm the `(tsdNumber, branch)` mapping exists and is **enabled** on the existing
   **Advantage** panel — `61302` / `MCO` → the Ride MCO location. Without it every
   message quarantines. (Edited there, read-only here, so the two screens cannot drift.)
2. On **Advantage (email)** → *Credentials*: mailbox user, password, host, port, folder.
   Encrypted at rest (AES-256-GCM). Never paste these into a chat.
3. *Test connection* — logs in, opens the folder, counts unread. Reads nothing.
4. Toggle the tenant master switch on.
5. *Check mailbox now* for the first poll, then read *Runs* and *Messages*.

### 4. What "working" looks like

`GET /status` → `health: healthy`, a recent run with `status: OK`, `quarantinedOpen: 0`.
Any quarantine turns the run `ATTENTION` and the pill amber, with the reason in
`/messages`.

---

## Questions still open with Ryan White

These do not block the build — the pipeline is safe under every answer — but each one
turns a refusal into an import.

1. **Does the same confirmation arrive again on a modification or a cancellation?**
   The sample argues yes (it is a regenerated snapshot), and re-sends are handled either
   way. What we need is a **sample of a cancellation and of a modification** so their
   banner tokens can be added to the vocabulary. Until then those messages quarantine
   rather than being guessed at.
2. **What are all the banner values TSD emits** between the asterisks, besides
   `***CONFIRMATION***`? A list closes this permanently.
3. **What address will the mail be sent from** (envelope and `From`), so the sender
   allowlist can stop being `unrestricted`?
4. **One email per branch, or one stream for the whole account?** If Advantage adds
   branches beyond MCO they route automatically, provided each `(tsdNumber, branch)`
   pair is mapped.
5. **Is any of this ever prepaid?** Everything on the sample says pay-on-arrival
   (`TOTAL CHARGES: 0.00`, the only money a counter-taken deposit), matching what
   Advantage confirmed for the portal account on 2026-07-14. `isPrepaid=false` is
   hardcoded on that basis; if it ever varies it becomes per-rate-code config, and
   `rateCode` is already in `rawJson`.

## Not built, on purpose

- **No frontend screen.** The endpoints exist and are shaped like the other integration
  panels; the React page is a separate piece of work.
- **Nothing is seeded.** No `AdvantageLocationConfig` row, no tenant, no credential.
- **No inbound webhook.** The parser and staging sit behind the service's session
  interface, so a webhook adapter can be added later without touching either.
- **The unit is not assigned, the extras are not charged, the deposit is not recorded as
  a payment.** All three are parsed and visible in `rawJson`. Making any of them move is
  a deliberate decision, not a follow-up.
