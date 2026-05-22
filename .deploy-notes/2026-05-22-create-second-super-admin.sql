-- Promote jcdiaz@internationalrentalcorp.com to SUPER_ADMIN
-- Date: 2026-05-22
-- IMPORTANT: copy this from VSCode (or paste from raw file), NOT from chat,
-- to avoid smart-quote substitution.

-- Step 1 verify current state
SELECT id, email, role, "tenantId" FROM "User" WHERE email = 'jcdiaz@internationalrentalcorp.com';

-- Step 2 promote
UPDATE "User"
SET role = 'SUPER_ADMIN',
    "passwordHash" = '$2b$10$tZrMifQ2muVaEndguGoOyenYd4lNohQN5PQenJiAiP73ItFVy8Hgi',
    "fullName" = 'Jose Diaz Second Super Admin',
    "isActive" = true,
    "updatedAt" = NOW()
WHERE email = 'jcdiaz@internationalrentalcorp.com';

-- Step 3 verify
SELECT id, email, "fullName", role, "tenantId", "isActive" FROM "User" WHERE email = 'jcdiaz@internationalrentalcorp.com';

-- Step 4 audit all super admins
SELECT id, email, "fullName", "tenantId", "isActive" FROM "User" WHERE role = 'SUPER_ADMIN' ORDER BY "createdAt";
