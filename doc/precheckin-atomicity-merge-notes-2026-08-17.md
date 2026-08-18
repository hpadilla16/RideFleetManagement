# Merging pre-check-in atomicity with `fix/insurance-flag-and-terms-url`

Written 2026-08-17, while both branches are open. Delete this file once the
merge has landed.

The atomicity work (`claude/eloquent-shtern-fc90fb`, commits `e17d60e5`,
`f6315a67` and `db9352d2`) moved the money half of `POST /customer-info/:token` out of
`customer-portal.routes.js` and into `customer-portal/precheckin-charges.js`.
`fix/insurance-flag-and-terms-url` edits the same handler. **The merge is not
mechanical, and resolving the conflict "ours" silently drops a control.** This
is the recipe, verified by a trial merge with both suites run.

## The question that prompted this: does the gate need a Prisma client?

**No.** `assertInsuranceSelectionEditable()` in
`checkout-session/insurance-selection-gate.js` reads only — agreement, session,
handoff token, section initials — and its call site is a PREFLIGHT that runs
before the transaction is opened, not inside it. A read taken before `BEGIN`
sees exactly the committed state a read taken just after `BEGIN` would; adding a
`client = prisma` parameter and threading the transaction client through would
change nothing about what the gate can see. Leave the signature alone.

Keep the preflight placement, too. Its original justification —
"a gate at the write site would reject the request only after destroying the
charges it was meant to protect" — is no longer true once the work is
transactional, but failing fast before doing any work is still the better shape.

What DOES have to change is the gate's own prose. Two comments now describe a
handler that no longer exists:

- `insurance-selection-gate.js`, in the `assertInsuranceSelectionEditable` block:
  *"The portal's pre-check-in handler deletes the reservation's INSURANCE charges
  before it reaches the flag, and none of it is wrapped in a transaction."*
- `customer-portal.routes.js`, in the PREFLIGHT comment: *"that branch is already
  past a deleteMany() ... and none of this handler is wrapped in a transaction."*

Both should say the placement is now about failing before doing work, and the
WRITER INVENTORY in the gate header should name `precheckin-charges.js` rather
than `customer-portal.routes.js` as writer #2.

## The three conflicts

### 1. `backend/src/lib/npm-test-chain.test.mjs`
Both branches added a `KNOWN_OUT` entry. Keep BOTH
(`test:precheckin-charges` and `test:declined-insurance-embedded`).

### 2. `backend/scripts/embedded-pg-boot.mjs`
Both branches independently fixed the same Windows breakage (`npx` is a `.cmd`
shim: ENOENT from `execFileSync`, then EINVAL since CVE-2024-27980). Keep the
atomicity branch's version — it runs prisma's own entry point with
`process.execPath` and needs no shell, where the other side passes
`shell: true`. The atomicity branch also forces a UTF8 cluster; that hunk merges
cleanly and must be kept, or any fixture with a character outside WIN1252 fails
on a Windows box.

### 3. `backend/src/modules/customer-portal/customer-portal.routes.js`
Take the atomicity branch's side (the whole inline charge block is gone), then
port ONE thing across by hand.

**The thing that is easy to lose:** `fix/insurance-flag-and-terms-url` hardened
the decline-signature write. It skips the signature columns when the contract is
already signed, and re-checks at the database with
`updateMany({ where: { id, tcSignedAt: null } })`, falling back to a flag-only
update when `count === 0`. Resolving "ours" drops both, and
`buildDeclinedInsuranceBlock` prints `declinedInsuranceSignatureDataUrl` on the
contract — so a re-submitted pre-check-in would replace a signed addendum's
signature and re-date it to after the signing.

Port it into `applyPrecheckinCharges` behind a new parameter:

```js
// precheckin-charges.js — add to the destructured args
agreementSealed = false,
```

```js
// precheckin-charges.js — the declinedCoverage branch
const canWriteDeclineSignature =
  !agreementSealed && declineSig && String(declineSig).length > 200;
if (canWriteDeclineSignature) {
  const fenced = await tx.rentalAgreement.updateMany({
    where: { id: declAg.id, tcSignedAt: null },
    data: {
      declinedInsurance: true,
      declinedInsuranceSignatureDataUrl: declineSig,
      declinedInsuranceSignedAt: new Date(),
    },
  });
  if (fenced.count === 0) {
    await tx.rentalAgreement.update({
      where: { id: declAg.id }, data: { declinedInsurance: true },
    });
  }
} else {
  await tx.rentalAgreement.update({
    where: { id: declAg.id }, data: { declinedInsurance: true },
  });
}
```

```js
// customer-portal.routes.js — the applyPrecheckinCharges call
agreementSealed: insuranceVerdict.signed,
```

Without that last line `insuranceVerdict` becomes a dead local — assigned by the
preflight and read by nobody, which is the tell that the fence was lost. An
earlier revision of `precheckin-charges.js` carried the fence with exactly that
parameter unpassed; it was always `false`, so the fence was unconditional and it
silently dropped a legitimate decline signature whenever staff signed at the
counter first. Wire the caller in the same commit as the fence, not after.

**Porting it turns a green test red, on purpose.** The case
`records a decline WITH its signature on the agreement`
(`precheckin-charges.embedded.test.mjs`) creates the agreement with `tcSignedAt`
SET, because on THIS branch that is a reachable order and the signature must be
written. Under the merged world it is not reachable through the route: the
preflight refuses that submission with a 409 before `applyPrecheckinCharges` is
ever called, and the test reaches the function directly. So the fixture stops
describing anything a customer can do. Rewrite the case deliberately as part of
the merge — split it into an unsigned-agreement case that still asserts the
signature IS written, and a signed-agreement case that asserts the fence holds —
rather than deleting it because it went red.

The `tcSignedAt: null` fence stays necessary even inside the transaction: the
verdict is computed at the preflight, which by construction runs before `BEGIN`,
so the contract can still be signed in the gap. Letting Postgres decide is the
point.

## The ratchet will fail, and that is it working

`declined-insurance-and-sign-url.test.mjs` pins the exact set of files naming
`declinedInsurance`. After the merge, `precheckin-charges.js` and
`precheckin-charges.embedded.test.mjs` are new names. Add both to `KNOWN`,
classify `precheckin-charges.js` as a WRITER, and demote
`customer-portal.routes.js` to whatever it has become.

## What the trial merge actually verified

The resolution above was carried out and the suites run, then the merge was
aborted — this branch does not carry it. What was green in that state:

- `npm run test:precheckin-charges` 8/8 — the suite had 8 cases then; it has 10
  now, and the two added cases are exactly the ones the section above says to
  rewrite. Re-run and re-read them during the real merge.
- `npm run test:declined-insurance-embedded` 7/7
- `npm run test:portal` 3/3, `node --test src/lib/npm-test-chain.test.mjs` 4/4

`npm run test:declined-insurance` was NOT verified in the trial merge: it exits
on `Invalid value undefined for datasource "db"`, i.e. `DATABASE_URL` unset in
the shell, before reaching any assertion. That is an environment gap, not a
merge conflict — but it does mean the ratchet above is un-run locally, so run it
with `DATABASE_URL` set (or in CI) as part of the real merge.

---

# The OTHER merge: the two sibling pre-check-in branches (2026-08-18)

Different pair, same file. `fix/precheckin-ota-tax-snapshot` and
`fix/precheckin-insurance-base-rental-only` both branch from `db9352d2` and both
edit `precheckin-charges.js` and its embedded suite. Merged into
`fix/precheckin-charges-merged`, **tax first, insurance second**, and the order
is not arbitrary:

- The tax branch is the only one that touches `customer-portal.routes.js` — the
  missing `include: { pricingSnapshot: true }` on the `'customer-info'` branch,
  which is where the actual money bug lives. Landing it first means its
  source-level guard is in place from the first commit of the integration.
- The insurance branch rewrites the tail of the test file and rewrites base case
  #10, so taking it second means its five new cases are read once, against the
  final `makeReservation()`.

**Git merged it clean** — no conflict markers, in either order. That is worth
saying out loud because the review expected two: the imports and
`makeReservation()`. Git resolved both because the two branches added their
imports at different offsets and only the tax branch touched
`makeReservation()`. The result was checked by hand and is what the recipe
wanted: both imports present (`node:fs/promises` and `SERVICE_CHARGE_SOURCES`),
`makeReservation({ charges, notes, snapshot })` with the tax branch's
`include: { pricingSnapshot: true }`, and all five insurance cases compatible
with that signature. A clean auto-merge on a money file is not evidence of a
correct merge; the suite run below is.

## What the merge then fixed (innovation review MUSTs)

1. **The suite ran nowhere.** `test:precheckin-charges` is out of the `npm test`
   chain by design (`npm-test-chain.test.mjs` KNOWN_OUT, DB-backed) and was in
   no CI job. New job `precheckin-charges-embedded` in `beta-ci.yml`:
   `npm ci` -> `prisma:generate` -> `npm install --no-save
   embedded-postgres@18.4.0-beta.17` -> `npm run test:precheckin-charges`. Its
   own job on purpose — the money-guard step runs with a dummy `DATABASE_URL`
   and no server, and `embedded-pg-boot.mjs` boots its own cluster, so the
   docker-compose job is not needed either.
2. **The direction that costs the customer had no test.** The base change also
   quotes MORE: `addManualCharge` rejects only `amount === 0`
   (`reservation-pricing.service.js:964`) and stamps
   `preSource='ADDITIONAL_SERVICE_PRECHECKIN'` regardless of the caller's source
   (`:1037`), so an admin credit of -100 lands as an excluded row. Old base
   `300 - 100 = 200` -> `$20.00`; new base `300` -> `$30.00`. Pinned.
3. **A docblock that overclaimed.** "The pricing service stores NULL for unset"
   was true of one writer out of four. Corrected in place, with the inventory.

## The writers that store 0, and what was decided

`reservationPricingSnapshot.taxRate` is `Decimal?` and every reader now honours
a stored 0 as a real rate (`resolveTaxRate`, `buildReservationBreakdown`,
`rental-agreements.service.js:2844/3241`). So a 0 written to mean "I do not
know" suppresses sales tax permanently.

- `reservations.routes.js:1251/1264` — `pickupLoc?.taxRate ?? 0`, and `pickupLoc`
  is null when the id does not resolve in the caller's tenant scope, which
  `validateLocationWindow()` does not refuse (it returns silently,
  `reservations.service.js:873`). **CHANGED to `?? null`.** `Location.taxRate` is
  non-null with default 0, so the resolved path is byte-identical; only the
  "location not found" case moves, and that is the case that was lying.
- `booking-engine.service.js:1769` — `Number(search.location?.taxRate || 0)`.
  **LEFT ALONE.** The premise is already true here: `searchRental()` SELECTs
  `taxRate` and throws when no location matches, and `Location.taxRate` is
  non-null, so the operand is always a Decimal — truthy even at zero — and the
  `|| 0` cannot fire. It stores the location's real rate. Editing a money path
  whose defect is unreachable would only leave a future reader thinking a bug
  had been found there.

## Loose end, not fixed here

`reservation-extend.service.js:312` resolves the same rate with `if (!taxRate)`,
i.e. it treats a stored 0 as unset — the opposite of the other three readers. A
car-sharing reservation (`car-sharing.service.js:253` writes a deliberate 0) that
is extended will be taxed at the location's rate. Same class of bug, different
route; raised rather than ridden along.
