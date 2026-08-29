-- ONE-TIME BACKFILL for tenants that are suspended RIGHT NOW. 2026-08-28.
--
-- Their previous status exists only in the audit trail, which the new restore
-- path does not read. Without this, the first tenant restored after this deploy
-- would hit the ACTIVE fallback and lose its status exactly as before — the fix
-- would not reach the very rows it was written for.
--
-- Separate from the ADD COLUMN migration on purpose: see the note there. If this
-- one fails, the column is already in place and every FUTURE suspend/restore is
-- correct; only pre-existing suspensions degrade to the documented ACTIVE
-- fallback. That is the failure mode worth having.
--
-- NOTE FOR THE NEXT PERSON WRITING A BACKFILL: 20260726_toll_location_staff_alerts
-- puts its ALTER and its UPDATE in ONE file and was signed off in that shape, so
-- it is the precedent you will find first. It carries the coupling described
-- above. Split yours.
--
-- Scoped hard, and safe to re-run:
--   * only tenants currently SUSPENDED *by billing* (billingSuspendedAt NOT NULL)
--     — a hand-suspended tenant is not restorable from this screen anyway;
--   * only rows where the column is still NULL, so a value written by the new
--     code is never overwritten (this is what makes a re-run a no-op);
--   * only the MOST RECENT TENANT_SUSPEND audit row for that tenant — for a
--     tenant that is suspended right now, that is the suspension in effect;
--   * never writes 'SUSPENDED' back (restore treats that as nothing recorded
--     anyway) and never writes an empty string.
-- A tenant with no usable audit row is left NULL and falls back to ACTIVE, which
-- is the documented behaviour for "nothing was recorded".
--
-- AdminAuditLog.metadata is JSONB and passes through redactSensitive before
-- persist, but that redactor matches EXACT keys only ('token', 'email',
-- 'password', …) — 'previousTenantStatus' is not one, and the suspend metadata
-- object carries no person-context key, so the value is stored verbatim.
UPDATE "Tenant" t
   SET "billingPreviousStatus" = src.prev
  FROM (
    SELECT DISTINCT ON (a."tenantId")
           a."tenantId" AS tenant_id,
           NULLIF(TRIM(a."metadata" ->> 'previousTenantStatus'), '') AS prev
      FROM "AdminAuditLog" a
     WHERE a."action" = 'TENANT_SUSPEND'
       -- `->>` rather than the jsonb `?` operator. Both are safe here (the
       -- runner uses node-postgres, whose placeholders are $1, not ?), so this
       -- is a style choice, not a workaround: NULLIF/TRIM above already rejects
       -- absent and blank, which makes a separate key-existence test redundant.
       AND a."metadata" IS NOT NULL
     ORDER BY a."tenantId", a."at" DESC
  ) src
 WHERE t."id" = src.tenant_id
   AND t."status" = 'SUSPENDED'
   AND t."billingSuspendedAt" IS NOT NULL
   AND t."billingPreviousStatus" IS NULL
   AND src.prev IS NOT NULL
   -- UPPER() so this matches resolveRestoredTenantStatus()'s case-INSENSITIVE
   -- guard in billing-admin.service.js. A case-sensitive test here would seed a
   -- 'suspended' the helper then resolves to ACTIVE anyway: harmless, but two
   -- rules that read as if they agree and do not.
   AND UPPER(src.prev) <> 'SUSPENDED';
