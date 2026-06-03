# Deploy readiness — final QA pass (2026-06-02)

Full review of everything built this session, before the final **beta.65** deploy.

## What's live now vs. what ships

- **Live in prod:** `v0.9.0-beta.63` (last pushed). That's: TL fixes, reports v2,
  bug #44 vehicle-status sync (beta.61), override panel (beta.60), incident module
  + migration (beta.62), photosJson pull fix + clause nav link (beta.63).
- **Ships in `v0.9.0-beta.65`** (one consolidated deploy, supersedes unshipped
  beta.64; no schema migration):
  1. Tenant-configurable post-check-in autocharge (Settings → Payments): AUTO/MANUAL
     + delay hours.
  2. Settings Hub "Agreement Clauses" chip.
  3. QA fixes from this review (below).
  4. Docs: incident playbook, Dejavoo readiness review, check-in↔Dejavoo alignment,
     handoff, this checklist.

## Automated validation — all green

- `prisma validate` ✓ (schema valid).
- `node --check` ✓ on all 13 touched backend files.
- Tests: **32 pass / 0 fail** (vehicle-status-sync 9, incident pdf+service 11,
  finalize-tx 12).
- JSX parse ✓ on all 7 touched frontend files; en/es JSON valid.
- New imports resolve; both new routers mounted in `main.js`.

## Independent review findings — addressed

A subagent reviewed all five features end-to-end. Verdicts:

- **Vehicle-status sync, override panel, incident module:** correct as built. Right
  client (tx vs prisma) at every call site; locked states never clobbered; override
  references only this-branch schema; rewind cascades cleanly; incident routes match
  the UI; pull handles both photo storage paths.
- **Autocharge config:** round-trips correctly (UI save → settings key → checkin-close
  read, same tenant scope); AUTO/MANUAL branch correct; MANUAL skips both the job and
  the DB safety-net poll (null `autochargeAt` doesn't match the poll's `lte` filter).

### Issues found and FIXED this pass
1. **BLOCKER (pre-existing) — invalid audit enum.** `autocharge.worker.js` wrote
   `action: 'AUTOCHARGE_SUCCESS'`, which isn't in the `AuditAction` enum, so every
   automatic charge failed to write its audit row (caught, so charge still
   succeeded). **Fixed:** now `action: 'STATUS_CHANGE'` (CHECKED_IN_UNPAID →
   CHECKED_IN) with `metadata.event = 'AUTOCHARGE_SUCCESS'`.
2. **MAJOR — MANUAL mode had no exit.** Neither `postPayment` nor `addManualPayment`
   advanced `CHECKED_IN_UNPAID → CHECKED_IN` when the balance cleared — only the
   autocharge worker did. So in MANUAL mode a fully-paid reservation would stay stuck
   as "unpaid." **Fixed:** both manual-collection paths now settle to `CHECKED_IN`
   (clear `autochargeAt`, sync vehicle, audit) when a payment brings the
   authoritative balance to ~0 on a CHECKED_IN_UNPAID reservation. Tightly guarded
   (only that status + balance ≤ 0.01).
3. **nit — cleared delay field.** Empty `delayHours` now falls back to the default
   (24) instead of persisting 0.

### Known/accepted (not blockers)
- checkin-close writes reservation + vehicle in separate awaited statements (not one
  tx); a crash between them self-heals via the reconciliation sweep / override panel.
  Same as the existing paid-in-full branch.
- SUPER_ADMIN saving payment settings without a tenant scope writes the global key
  (established pattern for all settings here, not autocharge-specific). Save while
  scoped to the tenant.

## Post-deploy smoke tests (run after the droplet rebuild)

1. **Boot clean:** `docker compose ps` all healthy; `docker logs fleet-backend-prod`
   no Prisma errors.
2. **Autocharge config:** Settings → Payments shows "Post-check-in autocharge."
   Set MANUAL, save, reload — value persists.
3. **MANUAL settle (the new fix):** on a test reservation, check in with a small
   unpaid balance → status `CHECKED_IN_UNPAID`, no autocharge fires. Go to View
   Payments, record the full balance → reservation flips to **CHECKED_IN**, vehicle
   stays AVAILABLE.
4. **AUTO timing:** set AUTO + a short delay (e.g. 1h is fine to set; don't need to
   wait), check in with a balance → `autochargeAt` ≈ now+delay and the job is queued.
5. **Settings chip:** Settings Hub → "Agreement Clauses" opens the clause library.
6. **Incident pull (beta.63 fix, now in this image):** open an incident draft →
   Pull check-in/check-out → inspection photos import as evidence rows.
7. **Spot-check unaffected flows:** a normal paid-in-full check-in still closes to
   CHECKED_IN; a normal checkout still flips the vehicle to ON_RENT.

## Go / no-go

**GO.** All automated checks pass, the one blocker and the MANUAL-mode gap are fixed,
and no schema migration is required. Ship with
`.deploy-notes/2026-06-02-ship-autocharge-config-beta65.sh`, then the droplet rebuild,
then run the smoke tests above.
