# MEX (TSD RezCentral) — rate writeback recon, 2026-08-05

Captured live from the portal with Hector logged in (account MEXRACSJU,
TSD # 61306, branch SJU). This is the write-side contract for the future
`mex-rate-push` service. The READ side (T&M reports) is already in
`backend/src/modules/integrations/mex/`.

## The screen

`POST /WebRezClient/rcUpdateRates1a.aspx?id=<session-token>` — classic ASPX
WebForms (`aspnetForm`, `__VIEWSTATE` + `__VIEWSTATEGENERATOR` + `__EVENTTARGET`
/ `__EVENTARGUMENT`). The `?id=` session token changes per login (the MEX
login client already re-appends it; same handling as LOGIN_PATH).

## Selection controls

| control | name | notes |
|---|---|---|
| Rate codes | `_ctl0:cphMaster1:lstRateCode` | **multi-select**, 21 options (below) |
| Branch | `_ctl0:cphMaster1:lstBranch` | multi-select, `SJU` |
| System | `_ctl0:cphMaster1:lstSystem` | multi-select, `WebLink` |
| TSD # | `_ctl0:cphMaster1:lstTSDNumber` | `61306` |
| From month | `_ctl0:cphMaster1:lstFromMonth` | `Aug 2026`..`Aug 2027` |
| To month | `_ctl0:cphMaster1:lstTOMonth` | same range |
| From/To day | ASP Calendar controls | day click = `__EVENTTARGET` postback — **exact encoding still to capture** |
| Days-of-week | `chkAllDays`, `chkSaturday`..`chkSunday` | checkboxes, `on` |
| Open ended | `_ctl0:cphMaster1:chkOpen` | checkbox |
| Return branch | `_ctl0:cphMaster1:lstReturn` | `*Same` / `SJU` |
| Errors | `_ctl0:cphMaster1:txtErrors` | textarea — "Errors Found" render target; **verify-after-write reads this** |

Buttons: `_ctl0:cphMaster1:Button1` = **Submit**, `btnClearRates` = Clear,
`Button2` = **Preload** (loads current rates into the grid — the read-back for
verify-after-write).

There is also an "Adjust By" tool (`txtRepD1-4`/`W`/`M`/`E` + `lstTypeD1-4`
Flat/Pct%) — percentage adjustments; not needed for absolute writes.

## The rate grid (`dgRates`)

Rows `_ctl2`..`_ctl11` map to vehicle classes ALPHABETICALLY (captured live):

```
_ctl2 CFAR   _ctl3 ECAR   _ctl4 FFAR   _ctl5 FJAR   _ctl6 FVAR
_ctl7 MVAR   _ctl8 SCAR   _ctl9 SFAR   _ctl10 SPAR  _ctl11 STAR
```

⚠ The row→class mapping is by POSITION in an alphabetical class list — if MEX
adds a class the indices shift. The writer must re-scrape row labels per
session, never hardcode.

Per row: `_ctl0:cphMaster1:dgRates:_ctlN:` + `txtDGDailyRate`, `txtDGWeekendRate`,
`txtDGWeeklyRate`, `txtDGMonthlyRate`, `txtDGHourlyRate`, `txtDGMinuteRate`,
`txtDGXDayRate`, `txtDGXHourRate`, `txtDGXMinuteRate`, `txtDGPer`, plus a
`...Free` twin for each (free miles; BLANK = unlimited, `0` = none w/ Per MI/KM).

## Hector's pricing rule (CONFIRMED 2026-08-05)

```
daily   = the decided base price
weekly  = daily × 7
monthly = daily × 28   (Hector first said ×30; corrected to ×28 after the
                        Preload showed ALL existing portal data at ×28)
x-day   = daily
```

Verified against live BPABR rates (Preload capture): ECAR 64/448/1792/64,
FFAR 118/826/3304/118, FJAR 157/1099/4396/157 — all exactly d/d×7/d×28/d.

FINDING flagged to Hector (he is checking): CFAR monthly under BPABR reads
$196.00 where the pattern says ~$1,960 — a missing zero. A month in a Kona for
$196 if bookable.

## Rate codes in the portal (21) vs the classification PDF (9)

Portal: BPABR BPAPR BPPBR BPPETM BPPPA BPPPKM BPPRC IDAEXD INCPOA IPMEXS
IPPEX IPPPA MEXPKG MEXWEB PADCB PADCI PPDCB PPDCI PPEXI PPEXR PPPRB

Classified by the PDF: PPEXR BPPPKM BPPETM IDAEXD (prepaid) / IPMEXS PPEXI
(inclusivo) / BPAPR (POA) / BPPPA PPPRB (prepaid).

WRITE LIST — ANSWERED by Hector 2026-08-05: "solo le vas a escribir a los que
te dije, y de la lista que te di vamos a omitir los que son inclusivo". So the
writer targets EXACTLY the PDF's list minus inclusivo — the 7 codes
`mexRatePushEligibleCodes()` already returns: PPEXR BPPPKM BPPETM IDAEXD BPAPR
BPPPA PPPRB. The other 12 portal codes are NEVER written.

## Preload response facts (captured)

- Preload (`Button2`) re-renders the same page with the grid populated from the
  selected code — this is the verify-after-write read-back.
- The response HTML carries fleet descriptions per class (CFAR = HYUNDAI KONA
  SE OR SIMILAR, ECAR = NISSAN VERSA, FFAR = TOYOTA HIGHLANDER LE, ...).
- `txtErrors` stays empty on success; the page renders "Errors Found" area when
  validation fails.
- Free-miles fields come back BLANK (= unlimited) with `txtDGPer` 0.00.

## CONTRACT COMPLETE — live submit captured 2026-08-05 (00:45 UTC)

Everything below was captured from a REAL successful write (Hector fixing the
CFAR monthly typo on BPABR, Aug 6-7 window):

### Calendar day encoding (derived from DOM + confirmed by live click)

Day click = `__doPostBack('_ctl0$cphMaster1$CalFrom' | '_ctl0$cphMaster1$CalTo',
'<serial>')` where serial = **days since 2000-01-01** (July 26 2026 = 9703;
Hector's live click on Aug 7 2026 = 9715 ✓). Month navigation uses a `V` prefix
(VisibleDate). Standard ASP.NET Calendar semantics.

### The Submit POST

Standard ASPX form POST to `rcUpdateRates1a.aspx?id=<session>` with ALL 165
form fields (empty inputs sent as empty strings) plus the submitter button
`_ctl0:cphMaster1:Button1=Submit`. Captured selector values:
lstRateCode=BPABR, lstBranch=SJU, lstSystem=WebLink, lstTSDNumber=61306,
lstFromMonth/lstTOMonth=Aug 2026, chkAllDays=on, lstReturn=*Same. Grid fields
carry "70.00"-style strings; XDayFree was "0" on this write.

### Success response — WebRateReport1.aspx (the verify-after-write surface)

Submit REDIRECTS to `WebRateReport1.aspx?id=<session>`, which renders one row
PER class PER tier written:

```
Requested            System  TSD#  Branch  Code  Cat Class Rate                              Result                      Allow Undo
2026/08/04 20:45:52  WebLink 61306 SJU-SJU BPABR S  CFAR  1960.00/MY UNL [STD,...] [dates]  Completed 2026/08/04 20:45:52  Yes
```

**Verification contract: every expected (class × tier) row must appear with
Result "Completed ...". Anything else — missing row, other Result text — is a
failed write.** This is line-item confirmation from the portal itself, stronger
than the Preload read-back (use Preload as a secondary check if wanted). The
report also offers per-line UNDO ("Allow Undo: Yes").

### Writer recipe (for mex-rate-push.service.js)

1. Login via the existing MEX client (cookie jar, ?id= token handling).
2. Menu-navigate to Rates → Rate Update 1 (`rcUpdateRates1a.aspx`).
3. GET the page; scrape `__VIEWSTATE`/`__VIEWSTATEGENERATOR` AND the row→class
   mapping from the dgRates labels (never hardcode _ctlN indices).
4. Calendar postbacks to set From/To days (serial = daysSince2000), re-scraping
   viewstate after each postback.
5. Fill the grid per class: daily d, weekly d×7, monthly d×28, x-day d
   (Hector's confirmed formula), select the target rate codes
   (`mexRatePushEligibleCodes()` — the 7, never the other 14 portal codes),
   POST with Button1=Submit.
6. Parse WebRateReport1.aspx: assert every (class × tier) shows "Completed".
   Log to RatePushLog like the Economy push (approval flow reusable).
