#!/usr/bin/env node
/**
 * Seed a sample TermsTemplate for a pilot tenant (2026-05-21).
 *
 * Usage (dry-run by default):
 *   node backend/scripts/seed-pilot-terms-template.mjs --tenant <tenantId>
 *
 * Apply for real:
 *   node backend/scripts/seed-pilot-terms-template.mjs --tenant <tenantId> --commit
 *
 * Auto-activate after create:
 *   node backend/scripts/seed-pilot-terms-template.mjs --tenant <tenantId> --commit --activate
 *
 * Custom version (default "1.0"):
 *   node backend/scripts/seed-pilot-terms-template.mjs --tenant <tenantId> --commit --version 1.0
 *
 * Idempotent: if a template with the same (tenantId, version) exists, the
 * script SKIPs creation. Add --force to overwrite (only allowed if the
 * existing template has 0 signings; the service blocks otherwise).
 *
 * The seeded template is a SAMPLE that exercises every field kind:
 *   - 4 INITIAL fields (sections 4, 5, 7, 9)
 *   - 1 SIGNATURE field
 *   - 1 CHECKBOX (optional coverage decline)
 *   - 1 TEXT_FIELD (driver license number)
 *   - 1 DATE (today's date pre-fill)
 *
 * The tenant admin can then edit the HTML + fields to match their own
 * agreement. This seed exists so Hector can run end-to-end through the
 * Dejavoo + Interactive T&C flow on day one without authoring the
 * template by hand.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx);
    const val = trimmed.slice(idx + 1).replace(/^"|"$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    commit: false,
    activate: false,
    force: false,
    tenant: null,
    version: '1.0',
    name: 'RideFleet Sample Agreement',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--activate') args.activate = true;
    else if (a === '--force') args.force = true;
    else if (a === '--tenant' && argv[i + 1]) args.tenant = String(argv[++i]);
    else if (a === '--version' && argv[i + 1]) args.version = String(argv[++i]);
    else if (a === '--name' && argv[i + 1]) args.name = String(argv[++i]);
  }
  return args;
}

const SAMPLE_HTML = `
<h1>Rental Agreement</h1>
<p><em>This is a sample template seeded for testing. The tenant admin should edit this to match their own agreement.</em></p>

<h2>Section 1 — Vehicle Rental Terms</h2>
<p>The renter agrees to return the vehicle to the agreed return location at the date and time specified. Late returns are subject to fees as listed in Section 6.</p>

<h2>Section 2 — Driver Information</h2>
<p>Driver license number: {{TEXT_DRIVER_LICENSE}}</p>
<p>Agreement date: {{DATE_TODAY}}</p>

<h2>Section 3 — Insurance & Coverage</h2>
<p>The vehicle is provided with the manufacturer's basic insurance coverage. Optional collision damage waiver (CDW) is available for an additional daily fee.</p>

<h2>Section 4 — Damage Liability</h2>
<p>The renter is responsible for all damage to the vehicle that occurs during the rental period not covered by the renter's accepted insurance package. Damage assessed at return inspection. Renter initials acceptance: {{INITIALS_S4_DAMAGE}}</p>

<h2>Section 5 — Fuel Policy</h2>
<p>Vehicle is provided with a full tank. Renter must return the vehicle with a full tank or accept the per-gallon refuel fee. Renter initials acceptance: {{INITIALS_S5_FUEL}}</p>

<h2>Section 6 — Late Return Fee</h2>
<p>Returns more than 60 minutes past the scheduled time will be charged a late return fee equivalent to one additional rental day.</p>

<h2>Section 7 — Optional Coverage Decline</h2>
<p>Renter has been offered Collision Damage Waiver (CDW), Personal Accident Insurance (PAI), and Roadside Assistance Plus.</p>
<p>I decline ALL optional coverage: {{CHECKBOX_DECLINE_OPTIONAL}}</p>
<p>If declining, renter initials confirmation: {{INITIALS_S7_DECLINE}}</p>

<h2>Section 8 — Tolls & Traffic Citations</h2>
<p>Renter is responsible for all tolls, parking violations, and traffic citations incurred during the rental period plus a $25 administrative fee per citation.</p>

<h2>Section 9 — Geographic Restrictions</h2>
<p>Vehicle may not leave the territory of the rental jurisdiction without prior written authorization. Unauthorized cross-border use voids insurance. Renter initials acceptance: {{INITIALS_S9_GEO}}</p>

<h2>Acknowledgment & Signature</h2>
<p>By signing below, the renter acknowledges having read, understood, and accepted all terms and conditions of this rental agreement.</p>
<p>Renter signature: {{SIG_RENTER}}</p>
`.trim();

const SAMPLE_FIELDS = [
  { kind: 'TEXT_FIELD', label: 'Driver license number', markerKey: 'TEXT_DRIVER_LICENSE', required: true, order: 0,
    terminalPromptText: 'Enter your driver license number' },
  { kind: 'DATE', label: 'Agreement date', markerKey: 'DATE_TODAY', required: true, order: 1,
    terminalPromptText: 'Confirm today\'s date (YYYY-MM-DD)' },
  { kind: 'INITIAL', label: 'Section 4 — Damage Liability', markerKey: 'INITIALS_S4_DAMAGE', required: true, order: 2,
    terminalPromptText: 'Initial Section 4 — Damage Liability' },
  { kind: 'INITIAL', label: 'Section 5 — Fuel Policy', markerKey: 'INITIALS_S5_FUEL', required: true, order: 3,
    terminalPromptText: 'Initial Section 5 — Fuel Policy' },
  { kind: 'CHECKBOX', label: 'Decline optional coverage', markerKey: 'CHECKBOX_DECLINE_OPTIONAL', required: true, order: 4,
    terminalPromptText: 'Do you decline ALL optional coverage?' },
  { kind: 'INITIAL', label: 'Section 7 — Optional Coverage Decline', markerKey: 'INITIALS_S7_DECLINE', required: true, order: 5,
    terminalPromptText: 'Initial Section 7 — Optional Coverage Decline' },
  { kind: 'INITIAL', label: 'Section 9 — Geographic Restrictions', markerKey: 'INITIALS_S9_GEO', required: true, order: 6,
    terminalPromptText: 'Initial Section 9 — Geographic Restrictions' },
  { kind: 'SIGNATURE', label: 'Renter — Full agreement signature', markerKey: 'SIG_RENTER', required: true, order: 7,
    terminalPromptText: 'Sign the full rental agreement' },
];

async function main() {
  loadDotEnv();
  const args = parseArgs();
  if (!args.tenant) {
    console.error('ERROR: --tenant <tenantId> is required');
    process.exit(1);
  }

  const mod = await import('../src/lib/prisma.js');
  const prisma = mod.prisma;

  // Confirm tenant exists
  const tenant = await prisma.tenant.findUnique({
    where: { id: args.tenant },
    select: { id: true, name: true },
  });
  if (!tenant) {
    console.error(`ERROR: tenant ${args.tenant} not found`);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`Seeding T&C template for tenant: ${tenant.id} (${tenant.name})`);
  console.log(`  version: ${args.version}`);
  console.log(`  name:    ${args.name}`);
  console.log(`  mode:    ${args.commit ? 'COMMIT' : 'dry-run (no writes)'}`);
  console.log(`  activate after create: ${args.activate ? 'yes' : 'no'}`);

  const existing = await prisma.termsTemplate.findUnique({
    where: { tenantId_version: { tenantId: args.tenant, version: args.version } },
    include: { _count: { select: { fields: true, signings: true } } },
  });

  if (existing) {
    console.log('');
    console.log(`A template with version=${args.version} already exists:`);
    console.log(`  id: ${existing.id}`);
    console.log(`  fields: ${existing._count.fields}`);
    console.log(`  signings: ${existing._count.signings}`);
    console.log(`  isActive: ${existing.isActive}`);
    if (!args.force) {
      console.log('');
      console.log('Use --force to overwrite (will fail if signings > 0)');
      console.log('Or use --version <different> to create a new version');
      await prisma.$disconnect();
      process.exit(0);
    }
    if (existing._count.signings > 0) {
      console.error('');
      console.error('ERROR: existing template has signings; cannot overwrite (would orphan evidence)');
      await prisma.$disconnect();
      process.exit(2);
    }
    if (args.commit) {
      console.log('  --force: deleting existing template and recreating');
      await prisma.termsTemplate.delete({ where: { id: existing.id } });
    } else {
      console.log('  (dry-run) would delete and recreate');
    }
  }

  if (!args.commit) {
    console.log('');
    console.log('--- DRY RUN — no writes performed ---');
    console.log(`  would create template: tenantId=${args.tenant} version=${args.version}`);
    console.log(`  contentHtml: ${SAMPLE_HTML.length} chars`);
    console.log(`  ${SAMPLE_FIELDS.length} fields: ${SAMPLE_FIELDS.map((f) => f.markerKey).join(', ')}`);
    if (args.activate) console.log('  would then ACTIVATE this template');
    await prisma.$disconnect();
    process.exit(0);
  }

  // Real commit path
  const { createTemplate, activateTemplate } = await import('../src/modules/terms/terms-templates.service.js');
  const created = await createTemplate({
    tenantId: args.tenant,
    name: args.name,
    version: args.version,
    contentHtml: SAMPLE_HTML,
    contentLanguage: 'en',
    effectiveDate: new Date().toISOString(),
    fields: SAMPLE_FIELDS,
    prisma,
  });
  console.log('');
  console.log(`Created TermsTemplate id=${created.id} with ${created.fields.length} fields`);

  if (args.activate) {
    const activated = await activateTemplate({ id: created.id, tenantId: args.tenant, prisma });
    console.log(`Activated: isActive=${activated.isActive}`);
  } else {
    console.log('NOT activated. To activate later, call:');
    console.log(`  POST /api/admin/terms-templates/${created.id}/activate`);
  }

  await prisma.$disconnect();
  console.log('Done.');
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      import.meta.url.endsWith(path.basename(process.argv[1] || ''));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { parseArgs, SAMPLE_HTML, SAMPLE_FIELDS };
