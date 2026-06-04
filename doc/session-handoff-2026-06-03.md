# Session handoff — 2026-06-03

## DEPLOYMENT MARKED SUCCESSFUL — 2026-06-03 (Hector)
Live tag: **v0.9.0-beta.110**. Full Dejavoo checkout verified end-to-end by Hector:
step-3 amounts correct on first load (beta.108), agreement ledger honest —
paid = payments, balance = non-deposit charges − paid, holds never count as
paid (beta.109/110 + repair SQL applied). Deposit default is per-location
config (Settings → Locations → Require Security Deposit / Mode / Amount).
Next focus: (1) loaner program reimagine completion, (2) car-sharing app
(separate repo). Still open: debit CNP (Dejavoo), report sweep, forecast
cold-cache, tank capacities, overdue triage (13), TL-ZE40788406BA vehicle type.

## TL;DR (earlier today — superseded by the section above)
Production is LIVE on **v0.9.0-beta.107** with the full Dejavoo checkout (two-tap:
sale tap + card-present deposit tap; `IPOS_FORCE_CARD_PRESENT_DEPOSIT=true`).
**Tokenized CNP (charge card on file / autocharge) WORKS for CREDIT cards** and fails
ONLY for DEBIT cards (Fiserv host 904 — Dejavoo gateway must route tokenized CNP debit
as signature debit; email sent with RRNs, awaiting their fix). Once debit is fixed:
retest everything, then flip `IPOS_FORCE_CARD_PRESENT_DEPOSIT=false` to go ONE-TAP.

Fix ladder today: DEJ_ERR_003 → `NetGrossIndicator: false` (beta.105) · response shape
`iposhpresponse` + alphanumeric referenceIds (beta.106) · reconId for Fiserv (beta.107)
· L3 currently disabled via `IPOS_TRANSACT_AUTO_RENTAL=false` (re-enable + retest later).
Open items: re-enable/retest L3, debit CNP (Dejavoo), forecast cold-cache 504, report
sweep, Vehicle.tankCapacityGallons missing from schema (fuel fees assume 15 gal),
8 overdue rentals shown available in forecast, TL import missing vehicleTypeId, dedupe
stacked env lines in backend/.env.

## Late-night state (historical)
Production was rolled back to **v0.9.0-beta.65** (pre-Dejavoo). It keeps **all** of tonight's
other work and the DOB/age hotfix. The full Dejavoo checkout redesign was saved as tag
v0.9.0-beta.104 (later superseded by beta.105–107).

## What's LIVE now (beta.65)
- Override panel (beta.60)
- Bug #44 vehicle-status sync (beta.61)
- Incident / damage report module (beta.62/63)
- Settings clauses chip (beta.64)
- Tenant-configurable post-check-in autocharge: AUTO/MANUAL + delay (beta.65)
- **DOB/age hotfix** — `backend/src/lib/dob.js`, wired into rental-agreements, customers,
  customer-portal, additional-drivers. (Confirmed present in beta.65; "age 1076" block fixed.)

NOT live: the Dejavoo Spin checkout redesign (beta.66 → beta.104).

## Dejavoo status — the one open blocker
Tonight we fixed two real bugs and hit one external blocker:
1. **Auth-token "API Key is required" (AUTH_ERR_001)** — FIXED (beta.103). iPOSpays'
   authenticate-token API reads credentials from HTTP headers, not the JSON body. Token now
   mints fine.
2. **Amount split / "2.12 & $0 pre-auth"** — FIXED (beta.101/102). getById now returns all
   selected agreement charges with `source`; wizard splits sale ($1.12) vs deposit ($1.00).
   (Also note: a stale frontend Docker cache can resurface this — fix with
   `docker compose ... build --no-cache frontend` + hard refresh.)
3. **Deposit hold + charge-card-on-file → DEJ_ERR_003 "Transaction Failed"** — BLOCKED on
   Dejavoo. Both tokenized Transact ops (PreAuth tt5 + Sale tt1) fail identically. Our request
   matches the iPOSpays spec and SPIn is a valid token source, so the cause is **merchant
   provisioning**: the Transact / CNP tokenization channel isn't enabled on the TPN.
   Card-present terminal sales/auths work fine; only CNP is dark.

Tonight's workaround (in beta.104 only): `IPOS_FORCE_CARD_PRESENT_DEPOSIT=true` routes the
deposit hold to a card-present second tap. Not relevant under beta.65.

## What to ask Dejavoo (the morning call)
Account: **TPN 8160…9983**, API key prefix `dakey_`, endpoint
`payment.ipospays.com/api/v3/iposTransact` (prod V3). Failing attempts logged
**2026-06-03 04:44 & 04:51 UTC**, error `DEJ_ERR_003`, transactionType 5 (PreAuth) & 1 (Sale)
using `cardToken`.

1. Enable iPOS Transact card-not-present tokenized transactions (PreAuth type 5 + Sale type 1
   with `cardToken`) on this TPN.
2. Confirm SPIn terminal–generated tokens are valid for Transact CNP on the **same merchant/MID**
   (link MIDs / enable cross-MID token use if they're separate).
3. Confirm Pre-Authorization (hold) is an allowed transaction type on the account.
4. Confirm the API key's `PaymentTokenization` scope is provisioned (and whether PreAuth needs
   another scope).
5. Ask them to read the real decline reason behind DEJ_ERR_003 for those two timestamps.

Already verified on our side (so it's their config, not our integration): auth JWT mints,
card-present settles, request format matches their spec, token captured from SPIn sale.

## How to bring Dejavoo back (once Dejavoo confirms CNP is enabled)
> 2026-06-03 update: redeploy tag is now **v0.9.0-beta.105** (beta.104 + removal of
> the NetGrossIndicator L3 field that Dejavoo's gateway validator rejects).
```
cd ~/RideFleetManagement
git fetch --tags
git checkout v0.9.0-beta.105
docker compose -f docker-compose.prod.yml up -d --build
# IPOS_FORCE_CARD_PRESENT_DEPOSIT is already in backend/.env; set it false to restore the
# no-second-tap CNP hold once CNP works:
#   sed -i 's/^IPOS_FORCE_CARD_PRESENT_DEPOSIT=.*/IPOS_FORCE_CARD_PRESENT_DEPOSIT=false/' backend/.env
#   docker compose -f docker-compose.prod.yml up -d
```
Test: run a checkout — deposit hold + charge-card-on-file should both approve, no DEJ_ERR_003.
No code changes needed; the tokens captured tonight are already valid for when CNP turns on.

## Rollback reference
- Pre-Dejavoo tag: **v0.9.0-beta.65** (488c3ea) — currently LIVE.
- Dejavoo build (saved): **v0.9.0-beta.104** (31757d3).
- No DB rollback was needed; Dejavoo tables remain in the DB, unused by beta.65.
