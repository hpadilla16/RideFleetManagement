-- ════════════════════════════════════════════════════════════════════
-- PERCENTAGE insurance base — sizing the change · 2026-08-17
-- READ-ONLY diagnostic. Run in the Supabase SQL editor. It reads user tables and
-- writes nothing: no INSERT/UPDATE/DELETE, no DDL on anything real, and no locks
-- beyond the ACCESS SHARE a SELECT takes, which blocks nobody. It DOES create
-- three views in pg_temp (dropped at the end, and gone with the session either
-- way) — technically DDL, in your own private schema only.
--
-- BEFORE TRUSTING THE TOTALS, two sanity checks:
--   * Query 1: if a row comes back as "(global/unscoped key)", a legacy bare
--     `insurancePlans` key exists and matches EVERY tenant, which duplicates
--     rows in queries 2/3/5. Say so and these need a tenant filter.
--   * Query 3 classifies an add-on as agent-written from its AuditLog row. If
--     AuditLog has ever been pruned, older agent extras look handler-written and
--     `pre_existing_dollars` — the number that matters most — is UNDERSTATED.
--     `SELECT min("createdAt") FROM "AuditLog";` tells you how far back it goes.
-- Expect the two metadata LIKE '%...%' scans to be slow; they are unindexed.
--
-- WHY THIS EXISTS
-- insuranceBaseFrom() in backend/src/modules/customer-portal/
-- precheckin-charges.js used to compute the base for a PERCENTAGE insurance
-- plan from every charge on the reservation except INSURANCE / TAX / DEPOSIT —
-- add-ons included. Hector's call (2026-08-17): the base is THE RENTAL AND ITS
-- FEES, and nothing sold on top. These queries size what that changes.
--
-- Two things it changes, and they pull in opposite directions:
--   (a) DRIFT, now fixed. The handler writes its own add-on rows AFTER the base
--       was read, so a customer who submitted and then came back to fix their
--       address was re-priced UPWARD off the first run's rows (300 daily + a
--       12.00 service → 30.00, then 31.20). Query 3's `handler_written` column
--       is that exposure.
--   (b) REVENUE GIVEN UP. Add-ons already on the sheet at the FIRST submission
--       no longer lift the premium — an agent's extra added via
--       reservation-pricing.service.js:1037, or a seat sold on the website.
--       Query 3's `pre_existing` column is that cost. This is the number that
--       matters most; it is real money on live reservations.
--
-- SCOPE NOTE: the exclusion uses SERVICE_CHARGE_SOURCES from
-- backend/src/lib/sold-items.js — the repo's authoritative list of the four
-- ways an add-on is spelled — not just the pre-check-in portal's own source.
-- These queries use the SAME four, so they measure what the code actually does.
-- If that list gains a source, add it here too or this understates the change.
--
-- NOTE ON PLAN AMOUNTS: insuranceChargeFor() reads
-- `plan.amount || plan.rate || plan.total || 0`, so a plan whose amount is
-- literally 0 falls through to rate. The COALESCE below mirrors that closely
-- enough for sizing; it is not the pricing engine.
-- ════════════════════════════════════════════════════════════════════


-- ── Shared: every insurance plan, per tenant, with its charge mode ───
-- Plans live in AppSetting under `tenant:<tenantId>:insurancePlans` (or a bare
-- `insurancePlans` for legacy/unscoped). Value is a JSON array of plan objects.
CREATE OR REPLACE TEMP VIEW plan_catalog AS
SELECT
  CASE WHEN s.key = 'insurancePlans' THEN NULL
       ELSE split_part(s.key, ':', 2) END                       AS tenant_id,
  upper(trim(p->>'code'))                                       AS plan_code,
  p->>'name'                                                    AS plan_name,
  upper(coalesce(p->>'chargeBy', p->>'mode', 'FIXED'))          AS charge_by,
  coalesce(nullif(p->>'amount',''), nullif(p->>'rate',''),
           nullif(p->>'total',''), '0')::numeric                AS plan_amount,
  coalesce(p->>'isActive', 'true') <> 'false'                   AS is_active
FROM "AppSetting" s
-- The cast lives INSIDE the CASE on purpose. A `WHERE s.value LIKE '[%'` down
-- here would not protect it: WHERE is applied after the LATERAL, and the planner
-- is free to evaluate the cast first — one malformed blob would then error the
-- whole query instead of being skipped. CASE guarantees branch order.
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN s.value LIKE '[%' THEN s.value::jsonb ELSE '[]'::jsonb END
) AS p
WHERE (s.key = 'insurancePlans' OR s.key LIKE 'tenant:%:insurancePlans');


-- ── 1 · WHICH TENANTS HAVE A PERCENTAGE PLAN AT ALL ─────────────────
-- The blast radius of the whole question. A tenant with zero PERCENTAGE plans
-- cannot be affected either way: FIXED and PER_DAY plans never read the base.
SELECT
  coalesce(pc.tenant_id, '(global/unscoped key)')  AS tenant_id,
  t.name                                          AS tenant_name,
  count(*) FILTER (WHERE pc.charge_by = 'PERCENTAGE')                     AS percentage_plans,
  count(*) FILTER (WHERE pc.charge_by = 'PERCENTAGE' AND pc.is_active)    AS percentage_active,
  string_agg(pc.plan_code || ' (' || pc.plan_amount || '%)', ', ')
    FILTER (WHERE pc.charge_by = 'PERCENTAGE')                            AS percentage_detail,
  count(*)                                                                AS plans_total
FROM plan_catalog pc
LEFT JOIN "Tenant" t ON t.id = pc.tenant_id
GROUP BY 1, 2
ORDER BY percentage_active DESC, percentage_plans DESC;


-- ── 2 · RESERVATIONS CARRYING A PERCENTAGE INSURANCE LINE ───────────
-- Detected by joining the INSURANCE row's sourceRefId (= plan.code) back to the
-- tenant's catalog. NOT by the notes text: insuranceChargeFor() writes notes
-- only when a pre-check-in discount actually lowered the price, so notes are
-- NULL on most rows and would undercount badly.
CREATE OR REPLACE TEMP VIEW pct_reservations AS
SELECT
  r.id            AS reservation_id,
  r."reservationNumber",
  r."tenantId",
  r."customerInfoCompletedAt",
  ins.id          AS insurance_charge_id,
  ins.total       AS insurance_total,
  pc.plan_code,
  pc.plan_amount  AS pct
FROM "Reservation" r
JOIN "ReservationCharge" ins
  ON ins."reservationId" = r.id
 AND ins.source = 'INSURANCE'
 AND ins.selected
JOIN plan_catalog pc
  ON pc.plan_code = upper(trim(ins."sourceRefId"))
 AND pc.charge_by = 'PERCENTAGE'
 AND (pc.tenant_id = r."tenantId" OR pc.tenant_id IS NULL);

SELECT
  coalesce(t.name, pr."tenantId")   AS tenant,
  count(*)                          AS reservations_with_pct_insurance,
  round(sum(pr.insurance_total), 2) AS insurance_dollars_on_the_books
FROM pct_reservations pr
LEFT JOIN "Tenant" t ON t.id = pr."tenantId"
GROUP BY 1
ORDER BY reservations_with_pct_insurance DESC;


-- ── Shared: the add-on rows that are leaving the base ────────────────
-- SERVICE_CHARGE_SOURCES from sold-items.js, verbatim. `is_agent_written` is
-- exact, not a heuristic: reservation-pricing.service.js writes an AuditLog row
-- (ADMIN_OVERRIDE, kind add_precheckout_extra) naming the chargeId it created.
--
-- handler_written = a pre-check-in row with NO such audit row, i.e. the portal's
--   own write. These caused the drift and cost nothing to remove.
-- pre_existing    = agent-added extras plus every add-on sold anywhere else.
--   These are what the tenant stops earning premium on.
CREATE OR REPLACE TEMP VIEW addon_rows AS
WITH agent_rows AS (
  -- Pulled with a regex rather than a ::jsonb cast. metadata is a TEXT column
  -- holding whatever JSON.stringify wrote; one bad row would error a cast, and
  -- the LIKE guard cannot be relied on to run first. The shape is fixed by
  -- JSON.stringify (no spaces), so this match is exact.
  SELECT DISTINCT substring(a.metadata from '"chargeId":"([^"]+)"') AS charge_id
  FROM "AuditLog" a
  WHERE a.action = 'ADMIN_OVERRIDE'
    AND a.metadata LIKE '%add_precheckout_extra%'
    AND substring(a.metadata from '"chargeId":"([^"]+)"') IS NOT NULL
)
SELECT
  pr."tenantId",
  pr.reservation_id,
  pr.pct,
  c.id                      AS charge_id,
  c.source,
  c.total,
  (ar.charge_id IS NOT NULL) AS is_agent_written,
  (c.source = 'ADDITIONAL_SERVICE_PRECHECKIN' AND ar.charge_id IS NULL) AS is_handler_written
FROM pct_reservations pr
JOIN "ReservationCharge" c
  ON c."reservationId" = pr.reservation_id
 AND c.selected
 AND upper(c.source) IN ('ADDITIONAL_SERVICE','SERVICE','ADDITIONAL_SERVICE_PRECHECKIN','KIOSK_UPSELL')
LEFT JOIN agent_rows ar ON ar.charge_id = c.id;


-- ── 3 · THE DECIDING NUMBERS, per tenant ────────────────────────────
-- `pre_existing_dollars` is the premium the tenant stops collecting.
-- `handler_written_dollars` is the drift that was being over-charged.
SELECT
  coalesce(t.name, a."tenantId")                                              AS tenant,
  count(DISTINCT a.reservation_id)                                            AS reservations_affected,
  count(*) FILTER (WHERE a.is_handler_written)                                AS handler_written_rows,
  count(*) FILTER (WHERE NOT a.is_handler_written)                            AS pre_existing_rows,
  round(sum(a.total * a.pct / 100) FILTER (WHERE a.is_handler_written), 2)    AS handler_written_dollars,
  round(sum(a.total * a.pct / 100) FILTER (WHERE NOT a.is_handler_written), 2) AS pre_existing_dollars,
  round(sum(a.total * a.pct / 100), 2)                                        AS total_premium_change
FROM addon_rows a
LEFT JOIN "Tenant" t ON t.id = a."tenantId"
GROUP BY 1
ORDER BY pre_existing_dollars DESC NULLS LAST;


-- ── 3b · SAME, broken out by which sale path wrote the row ──────────
-- Shows whether the cost is concentrated in agent extras or in website sales —
-- the two behave differently and are worth seeing apart before signing off.
-- `negative_rows` is not a curiosity. addManualCharge() rejects only amount = 0,
-- and its PRE-CHECKOUT branch stamps this source regardless of the caller's
-- `source`, so an admin CREDIT lands here as a negative add-on. Those are the
-- rows where the change quotes the customer MORE, not less: the old base netted
-- the credit off, the new one does not. They net away inside `premium_change`,
-- so read them separately or the cost looks smaller and more one-directional
-- than it is.
SELECT
  a.source,
  a.is_agent_written,
  count(*)                                                    AS rows,
  count(*) FILTER (WHERE a.total < 0)                         AS negative_rows,
  round(sum(a.total), 2)                                      AS addon_dollars,
  round(sum(a.total) FILTER (WHERE a.total < 0), 2)           AS credit_dollars,
  round(sum(a.total * a.pct / 100), 2)                        AS premium_change,
  round(sum(a.total * a.pct / 100) FILTER (WHERE a.total > 0), 2) AS premium_given_up,
  round(-sum(a.total * a.pct / 100) FILTER (WHERE a.total < 0), 2) AS premium_gained
FROM addon_rows a
GROUP BY 1, 2
ORDER BY premium_change DESC NULLS LAST;


-- ── 3c · RENTAL vs FEES: the follow-up decision, priced ─────────────
-- The base chosen on 2026-08-17 is "the rental AND its fees". Booking and the
-- reservation editor both price a PERCENTAGE plan off the RENTAL ALONE
-- (rates.service.js:885 builds baseTotal from daily-rate rows;
-- frontend/src/app/reservations/[id]/page.js uses dailyRate × days). So
-- pre-check-in still disagrees with them, and an agent hitting Save in the
-- editor rebuilds the row off the rental — silently re-pricing what the
-- customer accepted.
--
-- `fee_premium` below is what going rental-only EVERYWHERE would additionally
-- give up, on top of the add-on premium in query 3. Rental rows are identified
-- the way isBaseRentalRow() does it (reservation-extend.service.js:381):
-- BASE_RATE, DAILY, or an old source-less row whose code/name is DAILY.
WITH base_rows AS (
  SELECT
    pr."tenantId",
    pr.reservation_id,
    pr.pct,
    c.total,
    (upper(coalesce(c.source,'')) IN ('BASE_RATE','DAILY')
      OR (coalesce(trim(c.source),'') = ''
          AND (upper(coalesce(c.code,'')) = 'DAILY' OR upper(trim(c.name)) = 'DAILY'))) AS is_rental
  FROM pct_reservations pr
  JOIN "ReservationCharge" c
    ON c."reservationId" = pr.reservation_id
   AND c.selected
   AND upper(coalesce(c.source,'')) <> 'INSURANCE'
   AND upper(coalesce(c."chargeType"::text,'')) NOT IN ('TAX','DEPOSIT')
   AND upper(coalesce(c.source,'')) NOT IN ('ADDITIONAL_SERVICE','SERVICE','ADDITIONAL_SERVICE_PRECHECKIN','KIOSK_UPSELL')
)
SELECT
  coalesce(t.name, b."tenantId")                                        AS tenant,
  round(sum(b.total) FILTER (WHERE b.is_rental), 2)                     AS rental_dollars,
  round(sum(b.total) FILTER (WHERE NOT b.is_rental), 2)                 AS fee_dollars,
  round(sum(b.total * b.pct / 100) FILTER (WHERE NOT b.is_rental), 2)   AS fee_premium,
  count(*) FILTER (WHERE NOT b.is_rental)                               AS fee_rows
FROM base_rows b
LEFT JOIN "Tenant" t ON t.id = b."tenantId"
GROUP BY 1
ORDER BY fee_premium DESC NULLS LAST;


-- ── 4 · DRIFT THAT HAD ALREADY HAPPENED ─────────────────────────────
-- CAVEAT: `insurance_new_basis` models the NORMAL path. On an OTA/third-party
-- reservation the third-party sweep deletes the rental rows before a second
-- submission reads the base, so the real new basis there is ~0, not
-- charged − add-ons × pct. Those rows are UNDERSTATED here. See the OTA
-- paragraph in insuranceBaseFrom(); the pin is in the embedded test.
-- Reservations pre-checked-in MORE THAN ONCE carrying a PERCENTAGE line: the
-- ones where a customer was actually re-priced upward. `insurance_new_basis` is
-- what the same reservation would quote under the new rule.
WITH submissions AS (
  SELECT
    a."reservationId",
    count(*) AS submission_count,
    min(a."createdAt") AS first_submission,
    max(a."createdAt") AS last_submission
  FROM "AuditLog" a
  WHERE a.action = 'UPDATE'
    AND a.metadata LIKE '%PUBLIC_PRECHECKIN%'
  GROUP BY 1
  HAVING count(*) > 1
)
SELECT
  coalesce(t.name, pr."tenantId")  AS tenant,
  pr."reservationNumber",
  s.submission_count,
  s.first_submission,
  s.last_submission,
  pr.plan_code,
  pr.pct,
  pr.insurance_total               AS insurance_charged_now,
  round(pr.insurance_total
        - coalesce((SELECT sum(ar.total) FROM addon_rows ar
                    WHERE ar.reservation_id = pr.reservation_id), 0)
          * pr.pct / 100, 2)       AS insurance_new_basis
FROM submissions s
JOIN pct_reservations pr ON pr.reservation_id = s."reservationId"
LEFT JOIN "Tenant" t ON t.id = pr."tenantId"
ORDER BY s.submission_count DESC, pr."reservationNumber";


-- ── 5 · TOTALS, one line — this is the summary to paste back ────────
SELECT
  (SELECT count(DISTINCT coalesce(tenant_id,'(global)')) FROM plan_catalog
    WHERE charge_by = 'PERCENTAGE' AND is_active)              AS tenants_with_active_pct_plan,
  (SELECT count(*) FROM pct_reservations)                      AS reservations_with_pct_insurance,
  (SELECT count(DISTINCT reservation_id) FROM addon_rows)      AS of_those_with_addons_in_base,
  (SELECT count(*) FROM addon_rows WHERE is_handler_written)   AS handler_written_rows,
  (SELECT count(*) FROM addon_rows WHERE NOT is_handler_written) AS pre_existing_rows,
  (SELECT round(sum(total * pct / 100), 2) FROM addon_rows WHERE NOT is_handler_written)
                                                               AS dollars_of_premium_given_up,
  (SELECT round(sum(total * pct / 100), 2) FROM addon_rows WHERE is_handler_written)
                                                               AS dollars_of_drift_removed;


-- Cleanup. Order matters: the views depend on each other. Schema-qualified to
-- pg_temp so that running JUST THIS TAIL in an editor cannot resolve to a real
-- view of the same name in public.
DROP VIEW IF EXISTS pg_temp.addon_rows;
DROP VIEW IF EXISTS pg_temp.pct_reservations;
DROP VIEW IF EXISTS pg_temp.plan_catalog;
