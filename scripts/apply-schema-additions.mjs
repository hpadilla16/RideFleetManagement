#!/usr/bin/env node
// scripts/apply-schema-additions.mjs
//
// One-shot script to add Path D fields to schema.prisma.
// - Adds `tier` and `schemaName` columns to the Tenant model (after `plan` line).
// - Appends the LoadObservation model at the end of the file.
//
// Idempotent — safe to re-run, skips if changes already applied.
//
// Usage:
//   node scripts/apply-schema-additions.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const SCHEMA_PATH = 'backend/prisma/schema.prisma';

let source = readFileSync(SCHEMA_PATH, 'utf8');
let changed = false;

// =============================================================================
// 1. Add tier + schemaName fields to Tenant model
// =============================================================================

if (source.match(/^\s+tier\s+String/m)) {
  console.log('Tenant.tier already present — skipping field additions.');
} else {
  // Find the Tenant model and insert after the `plan` field line.
  // Pattern: `  plan                    String   @default("BETA")`
  const planLineRegex = /^(\s+)plan(\s+)String(\s+)@default\("BETA"\)\s*$/m;
  const match = source.match(planLineRegex);
  if (!match) {
    console.error('FATAL: could not locate the `plan` line in Tenant model.');
    console.error('Apply the additions manually using the patch file.');
    process.exit(1);
  }
  const indent = match[1];
  const insertion = `\n${indent}// Path D multi-tenancy fields (added 2026-05-17, see doc/multitenancy-hybrid-architecture.md)\n${indent}tier                    String   @default("STANDARD")  // STANDARD | PREMIUM | ENTERPRISE\n${indent}schemaName              String   @default("public")    // 'public' | 'tenant_<slug>'`;
  source = source.replace(planLineRegex, (m) => m + insertion);
  console.log('Added tier + schemaName fields to Tenant model.');
  changed = true;
}

// =============================================================================
// 2. Append LoadObservation model at the end of the file
// =============================================================================

if (source.includes('model LoadObservation')) {
  console.log('LoadObservation model already present — skipping.');
} else {
  const loadObservationModel = `

// Path D per-tenant volume metrics for promotion criteria automation.
// Written by daily 02:00-ET snapshot job. Read by the promotion-flagger
// service that surfaces candidates in SUPER_ADMIN review queue once a tenant
// crosses 2+ thresholds for 7 consecutive days.
//
// See doc/multitenancy-hybrid-architecture.md sections 7 + 8.
model LoadObservation {
  id                      String   @id @default(cuid())
  tenantId                String
  observedAt              DateTime @default(now())
  windowStart             DateTime
  windowEnd               DateTime
  reservationsCreated     Int      @default(0)
  concurrentStaffPeak     Int      @default(0)
  cacheInvalidations      Int      @default(0)
  inspectionMediaUploads  Int      @default(0)
  voiceAgentMinutes       Int      @default(0)
  tierAtObservation       String   @default("STANDARD")

  @@index([tenantId, observedAt(sort: Desc)])
}
`;
  // Ensure file ends with a newline before appending
  if (!source.endsWith('\n')) source += '\n';
  source += loadObservationModel;
  console.log('Appended LoadObservation model.');
  changed = true;
}

if (changed) {
  writeFileSync(SCHEMA_PATH, source, 'utf8');
  console.log(`\nWrote ${SCHEMA_PATH}.`);
  console.log('\nNext steps:');
  console.log('  1. cd backend && npx prisma generate');
  console.log('  2. cd .. && git diff backend/prisma/schema.prisma');
  console.log('  3. Commit and push');
} else {
  console.log('\nNo changes needed — schema already up to date.');
}
