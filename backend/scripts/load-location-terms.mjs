#!/usr/bin/env node
/**
 * Load a branch's Terms & Conditions RIDER and acknowledgement-section
 * overrides onto a Location.
 *
 * WHY A SCRIPT AND NOT A PASTED `UPDATE`. The rider is a ~21 KB bilingual legal
 * document. Retyping or hand-escaping it into SQL risks a silent corruption in a
 * contract customers sign, so the exact reviewed bytes ship in the repo next to
 * this file (same idea as the canonical agreement living at
 * src/lib/terms/tc-<VERSION>.html) and are written verbatim by Prisma.
 *
 * WHAT IT WRITES
 *   Location.termsHtml          <- scripts/location-terms/<slug>-terms.html   (base, optional)
 *   Location.termsRiderHtml     <- scripts/location-terms/<slug>-rider.html
 *   Location.termsSectionsJson  <- scripts/location-terms/<slug>-sections.json
 *
 * getEffectiveTermsHtml resolves the BASE as
 * location.termsHtml -> tenant.termsHtml -> canonical, then APPENDS
 * location.termsRiderHtml. So a branch can either ride on the canonical agreement
 * and add a rider, or — as LAX does — supply its own base document and append a
 * rider to that.
 *
 * WHY LAX SUPPLIES A BASE. The "canonical" agreement is not generic: it names
 * International Rental Corp as the Company, is governed by Puerto Rico law, and
 * describes the AutoExpreso toll transponder 12 times. A Corpusa customer at LAX
 * would have been signing another company's contract under the wrong
 * jurisdiction. LAX's base is therefore its own Right-cars document (sections
 * 1-13), and its rider carries the general legal clauses that document lacked,
 * written for California (sections 14-19).
 *
 * The sections file overrides the TEXT of the acknowledgements the customer
 * initials, keyed by canonical sectionKey.
 *
 * ⚠ TERMS RESOLVE AT PRINT TIME — THERE IS NO SNAPSHOT. Writing these columns
 * re-renders every ALREADY-SIGNED agreement at that branch: new text beside
 * initials the customer captured on the old text. This script therefore refuses
 * to run if the branch has signed agreements unless you pass
 * --i-know-signed-agreements-will-change. Check first with:
 *
 *   SELECT ra."agreementNumber", ra."tcSignedAt"
 *   FROM "RentalAgreement" ra WHERE ra."pickupLocationId" = '<id>';
 *
 * Usage (on the droplet, from ~/RideFleetManagement/backend):
 *   set -a && . ./.env && set +a
 *   node scripts/load-location-terms.mjs --slug lax --location-id <id>            # dry run
 *   node scripts/load-location-terms.mjs --slug lax --location-id <id> --commit
 *
 * Re-runnable and idempotent: it overwrites both columns with the file contents.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/lib/prisma.js';
import { getEffectiveTermsHtml } from '../src/lib/terms/index.js';
import { sectionsForAgreement } from '../src/modules/checkout-session/terms-content.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const SLUG = arg('slug');
const LOCATION_ID = arg('location-id');
const COMMIT = has('commit');
const FORCE_SIGNED = has('i-know-signed-agreements-will-change');

async function main() {
  if (!SLUG || !LOCATION_ID) {
    throw new Error('usage: --slug <name> --location-id <cuid|uuid> [--commit]');
  }

  const basePath = join(HERE, 'location-terms', `${SLUG}-terms.html`);
  const riderPath = join(HERE, 'location-terms', `${SLUG}-rider.html`);
  const sectionsPath = join(HERE, 'location-terms', `${SLUG}-sections.json`);
  // The base document is OPTIONAL: a branch that rides on the canonical (or on
  // its tenant's) agreement ships only a rider.
  let baseDoc = null;
  try { baseDoc = readFileSync(basePath, 'utf8'); } catch { baseDoc = null; }
  const rider = readFileSync(riderPath, 'utf8');
  const sectionsRaw = readFileSync(sectionsPath, 'utf8');

  // Fail before touching the DB if the sections file is malformed. At runtime a
  // bad blob only logs and falls back to canonical text, which is the right
  // behaviour mid-rental but the wrong thing to discover after a load.
  const parsed = JSON.parse(sectionsRaw);
  const canonicalKeys = new Set(sectionsForAgreement({}).map((s) => s.key));
  const unknown = Object.keys(parsed).filter((k) => !canonicalKeys.has(k));
  if (unknown.length) {
    throw new Error(`sections file has keys that match no acknowledgement section: ${unknown.join(', ')}`);
  }

  const loc = await prisma.location.findUnique({
    where: { id: LOCATION_ID },
    select: { id: true, code: true, name: true, tenantId: true, termsHtml: true, termsRiderHtml: true, termsSectionsJson: true },
  });
  if (!loc) throw new Error(`Location ${LOCATION_ID} not found`);

  const signed = await prisma.rentalAgreement.findMany({
    where: { pickupLocationId: LOCATION_ID, tcSignedAt: { not: null } },
    select: { agreementNumber: true, tcSignedAt: true, tcSignerName: true },
    orderBy: { tcSignedAt: 'desc' },
  });

  console.log(`Branch   : ${loc.code} — ${loc.name}`);
  console.log(`Base doc : ${baseDoc ? `${basePath} (${baseDoc.length} bytes)` : 'none — inherits tenant/canonical'}`);
  console.log(`Rider    : ${riderPath} (${rider.length} bytes)`);
  console.log(`Sections : ${Object.keys(parsed).join(', ')}`);
  console.log(`Currently: base ${loc.termsHtml ? `${loc.termsHtml.length} bytes` : 'unset'}, rider ${loc.termsRiderHtml ? `${loc.termsRiderHtml.length} bytes` : 'unset'}, sections ${loc.termsSectionsJson ? 'set' : 'unset'}`);
  console.log(COMMIT ? 'Mode     : COMMIT' : 'Mode     : DRY RUN — nothing will be written');
  console.log('');

  if (signed.length) {
    console.log(`⚠ ${signed.length} agreement(s) already SIGNED at this branch. Their PDFs re-render`);
    console.log('  from these columns, so their text will change beside initials already captured:');
    for (const a of signed) {
      console.log(`    ${a.agreementNumber}  signed ${a.tcSignedAt.toISOString().slice(0, 16)}  by ${a.tcSignerName || '—'}`);
    }
    if (COMMIT && !FORCE_SIGNED) {
      throw new Error('refusing to write: pass --i-know-signed-agreements-will-change to proceed');
    }
    console.log('');
  }

  if (!COMMIT) {
    // Prove the resolver composes correctly without writing anything.
    const inherited = await getEffectiveTermsHtml(
      { tenantId: loc.tenantId, locationId: null },
      { prisma },
    );
    const base = baseDoc || inherited;
    const combined = `${base}\n${rider}`;
    const nums = [...combined.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
    const contiguous = nums.length > 0 && nums.every((n, i) => n === i + 1);
    const ownBase = baseDoc ? 'this branch own document' : 'inherited';
    console.log('Dry-run checks against the real resolver:');
    console.log(`  base document          : ${base.length} bytes (${ownBase})`);
    console.log(`  combined               : ${combined.length} bytes`);
    console.log(`  section numbering      : ${nums.length ? `1..${nums[nums.length - 1]}` : 'none'} ${contiguous ? '(contiguous)' : '(NOT CONTIGUOUS — gaps or repeats)'}`);
    console.log(`  card authorization     : ${/PAYMENT CARD AUTHORIZATION|CARD-ON-FILE/i.test(combined)}`);
    console.log(`  indemnification        : ${/INDEMNIFICATION/i.test(combined)}`);
    console.log(`  governing law          : ${/GOVERNING LAW/i.test(combined)}`);
    console.log(`  other company named    : ${/International Rental Corp/i.test(combined) ? 'PRESENT — WRONG COMPANY' : 'absent'}`);
    console.log(`  wrong jurisdiction     : ${/Puerto Rico/i.test(combined) ? 'PRESENT — check' : 'absent'}`);
    const secs = sectionsForAgreement({ sectionOverrides: sectionsRaw });
    console.log(`  acknowledgement keys   : ${secs.length} (${secs.length === canonicalKeys.size ? 'canonical, unchanged' : 'CHANGED — bug'})`);
    for (const k of Object.keys(parsed)) {
      const s = secs.find((x) => x.key === k);
      console.log(`    ${k}: ${s.body.slice(0, 72)}…`);
    }
    console.log('\nDry run — nothing written. Re-run with --commit.');
    return;
  }

  const out = await prisma.location.update({
    where: { id: LOCATION_ID },
    data: {
      ...(baseDoc ? { termsHtml: baseDoc } : {}),
      termsRiderHtml: rider,
      termsSectionsJson: sectionsRaw,
    },
    select: { code: true, termsHtml: true, termsRiderHtml: true, termsSectionsJson: true },
  });
  const okBase = !baseDoc || out.termsHtml === baseDoc;
  const okRider = out.termsRiderHtml === rider;
  const okSecs = out.termsSectionsJson === sectionsRaw;
  console.log(`Wrote ${out.code}:`);
  if (baseDoc) console.log(`  base     ${out.termsHtml.length} bytes (byte-identical: ${okBase})`);
  console.log(`  rider    ${out.termsRiderHtml.length} bytes (byte-identical: ${okRider})`);
  console.log(`  sections ${out.termsSectionsJson.length} bytes (byte-identical: ${okSecs})`);
  if (!okBase || !okRider || !okSecs) throw new Error('round-trip mismatch — the stored text does not match the file');
  console.log('\nVerify: open an agreement at this branch and confirm the rider appears after');
  console.log('the canonical terms, and that the initialled sections show the branch figures.');
}

main()
  .catch((e) => { console.error('FAILED:', e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
