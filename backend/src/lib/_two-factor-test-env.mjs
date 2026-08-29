// Test-only env bootstrap for the 2FA suites. Imported FIRST (before any module
// that transitively pulls in lib/prisma.js) so these are set before the real
// PrismaClient constructs — ESM evaluates an imported module fully before the
// next import statement in the same file. The client never connects (every
// query in these tests goes through an injected fake); it only needs to build.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-two-factor-tests-0123456789';
process.env.INTEGRATION_ENC_KEY = process.env.INTEGRATION_ENC_KEY || Buffer.alloc(32, 7).toString('base64');
