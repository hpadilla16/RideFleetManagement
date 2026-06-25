#!/usr/bin/env node
// Generate the X-Tenant-Token for a tenant's public booking website.
// Stores ONLY the sha256 hash on Tenant.websiteTokenHash; prints the plaintext ONCE.
//
//   node backend/scripts/gen-website-token.mjs <tenant-slug>
//
// Run against the SESSION port (5432), not pgbouncer (6543). Uses DATABASE_URL env.
// Re-running ROTATES the token (old one stops working immediately).
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const slug = process.argv[2];

async function main() {
  if (!slug) {
    console.error('Usage: node scripts/gen-website-token.mjs <tenant-slug>');
    process.exit(1);
  }
  const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true, name: true, status: true } });
  if (!tenant) {
    console.error(`Tenant not found for slug "${slug}".`);
    process.exit(1);
  }

  const token = crypto.randomBytes(32).toString('hex'); // 64-char secret
  const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  await prisma.tenant.update({ where: { slug }, data: { websiteTokenHash: hash } });

  console.log('');
  console.log(`Tenant:  ${tenant.name}  (slug=${slug}, status=${tenant.status})`);
  console.log('websiteTokenHash stored ✓  (plaintext is NOT persisted)');
  console.log('');
  console.log('===== X-Tenant-Token (SAVE NOW — shown only once) =====');
  console.log(token);
  console.log('=======================================================');
  console.log('');
  console.log('Put this in the website Vercel env as TRIANGLE_TENANT_TOKEN (server-only).');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
