# BUG: garbage date-of-birth blocks checkout with "age 1076" (2026-06-02)

**Severity:** high (blocks checkout at the counter). **Status:** fixed in
`v0.9.0-beta.65`. **Incident reservation:** TL-ZE40789836BA (Tyrone Mahee, IRC).

## Symptom

At checkout the agent got a hard error that the customer's age was ~1076 and
could not finalize. Customer was at the counter.

## What was in the data

- `Customer.dateOfBirth`        = `2800-04-01`  → computed age **-774** (future)
- `RentalAgreement.dateOfBirth` = `0959-04-01`  → computed age **~1067**

Month/day (`04-01`) looked plausible; only the **year** was garbage.

## Root cause

Two compounding issues:

1. **No DOB validation anywhere.** Every write path turned the raw value into a
   date with `new Date(value)`, which happily accepts absurd years:
   `new Date('0959-04-01')` → year 959, `new Date('2800-04-01')` → year 2800.
   These flowed unchecked into `Customer.dateOfBirth` and
   `RentalAgreement.dateOfBirth`.
2. **The checkout gate surfaced it confusingly.** `rentalAgreementsService`
   finalize computes `ageOnDate(dob, pickupAt)` and throws
   `Driver age <n> exceeds maximum age <max>` when the location has a
   `chargeAgeMax`. With a year-959 DOB that's "age 1067 exceeds maximum" — true,
   but it reads like a policy limit, not "the DOB is garbage."

The original garbage almost certainly came from a malformed DOB string entered
upstream (manual entry / a self-service form / an import field). The TL worker
itself does **not** capture DOB — it's filled later.

## Counter hotfix (done 2026-06-02)

Corrected both records to the real DOB from the customer's license (see
`doc/fixes` chat history). Customer got on the road.

## Permanent fix (beta.65)

- **New shared sanitizer** `backend/src/lib/dob.js` → `normalizeDob(value)`
  returns a Date only when the value is physically plausible (parseable, not in
  the future, year ≥ 1900, age ≤ 120); otherwise `null`. Plus `isImplausibleAge()`.
  Unit-tested (`dob.test.mjs`, incl. the exact 2800/0959 cases). It does NOT
  enforce the rental minimum age — that stays a per-location business rule.
- **Applied at every human/import DOB write path:** customer create/update
  (`customers.service.js`), pre-check-in self-service form
  (`customer-portal.routes.js`), agent checkout customer-info patch and
  additional drivers (`rental-agreements.service.js`,
  `reservation-additional-drivers.service.js`). A garbage value is now stored as
  `null` ("no DOB on file") so the agent re-enters it, instead of an impossible
  date.
- **Clear gate message:** the finalize gate now detects an implausible computed
  age first and throws *"The date of birth on file is invalid (it computes to
  age N). Please correct the customer's date of birth before checkout."* — so
  next time staff know exactly what to do.

## Data cleanup

`doc/fixes/2026-06-02-implausible-dob-sweep.sql` finds any other
Customer/RentalAgreement rows with implausible DOBs and (optionally) nulls them so
they get re-entered. Run PASS 1 after deploy; null out the rest if the list is
short.

## Follow-up (not blocking)

- If a specific upstream source is feeding bad DOB strings (e.g. a license-scan
  format or a 2-digit-year field), normalize it at that source too. The sanitizer
  is the safety net; fixing the source stops the bad input at the door.
