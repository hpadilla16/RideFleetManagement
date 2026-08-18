-- ════════════════════════════════════════════════════════════════════
-- PERCENTAGE insurance base — sizing the change · 2026-08-17
-- READ-ONLY diagnostic. Run in the Supabase SQL editor. No writes, no DDL.
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
SELECT
  a.source,
  a.is_agent_written,
  count(*)                                  AS rows,
  round(sum(a.total), 2)                    AS addon_dollars,
  round(sum(a.total * a.pct / 100), 2)      AS premium_change
FROM addon_rows a
GROUP BY 1, 2
ORDER BY premium_change DESC NULLS LAST;


-- ── 4 · DRIFT THAT HAD ALREADY HAPPENED ─────────────────────────────
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


-- Cleanup. Order matters: the views depend on each other.
DROP VIEW IF EXISTS addon_rows;
DROP VIEW IF EXISTS pct_reservations;
DROP VIEW IF EXISTS plan_catalog;
