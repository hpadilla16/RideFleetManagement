-- Flip Jose Diaz SUPER_ADMIN to match the main super admin (tenantId=NULL).
-- Date: 2026-05-22
-- Reason: keeping tenantId=IRC made integration endpoints scope to IRC tenant
-- even when viewing other tenants like Zezgo. Same behavior as main super admin.
-- Trade-off: hits bug #12 (empty feature flags for SUPER_ADMIN with tenantId=NULL).
-- Bug #12 fix lands in a follow-up commit.

-- Step 1 verify current state
SELECT id, email, role, "tenantId" FROM "User" WHERE email = 'jcdiaz@internationalrentalcorp.com';

-- Step 2 flip tenantId to NULL
UPDATE "User"
SET "tenantId" = NULL,
    "updatedAt" = NOW()
WHERE email = 'jcdiaz@internationalrentalcorp.com';

-- Step 3 verify
SELECT id, email, "fullName", role, "tenantId", "isActive" FROM "User" WHERE email = 'jcdiaz@internationalrentalcorp.com';
-- Expected: tenantId = NULL
