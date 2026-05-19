#!/usr/bin/env node
/**
 * tl-international-bootstrap.mjs — one-shot sync runner for ops smoke testing.
 *
 * Invocation:
 *   TENANT_ID=tnt_abc node backend/scripts/tl-international-bootstrap.mjs
 *   node backend/scripts/tl-international-bootstrap.mjs --tenant=tnt_abc
 *   node backend/scripts/tl-international-bootstrap.mjs --tenant=tnt_abc --commit
 *
 * Dry-run by default — it fetches, prints what it WOULD do, but does not
 * write to ExternalReservation / Reservation. Pass --commit to actually
 * upsert.
 *
 * This bypasses BullMQ entirely (no Redis needed) so Hector can sanity-
 * check the cookie + parser before flipping TL_INTEGRATION_ENABLED.
 */

import { argv, env, exit } from 'node:process';
import { tlSyncHandler } from '../src/modules/integrations/tl-international/tl-international.worker.js';
import {
  fetchDashboardPickups,
  fetchReservationDetail,
} from '../src/modules/integrations/tl-international/tl-international.service.js';

function parseArgs() {
  const args = { commit: false, tenantId: null };
  for (const a of argv.slice(2)) {
    if (a === '--commit') args.commit = true;
    else if (a.startsWith('--tenant=')) args.tenantId = a.slice('--tenant='.length);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node tl-international-bootstrap.mjs [--tenant=ID] [--commit]
        --tenant=ID    Override TENANT_ID env var
        --commit       Actually write to the DB (default: dry-run / read-only)`);
      exit(0);
    }
  }
  args.tenantId = args.tenantId || env.TENANT_ID;
  return args;
}

async function main() {
  const { commit, tenantId } = parseArgs();
  if (!tenantId) {
    console.error('error: --tenant=ID or TENANT_ID env required');
    exit(1);
  }

  if (commit) {
    console.log(`\n[bootstrap] COMMIT mode — running full sync handler for tenant ${tenantId}`);
    const result = await tlSyncHandler({ data: { tenantId, triggeredBy: 'cli-bootstrap' } });
    console.log('\n[bootstrap] result:');
    console.log(JSON.stringify(result, null, 2));
    exit(result.status === 'OK' || result.status === 'PARTIAL' ? 0 : 1);
  }

  console.log(`\n[bootstrap] DRY-RUN — fetching dashboard for tenant ${tenantId} (no DB writes)`);
  const pickups = await fetchDashboardPickups(tenantId);
  console.log(`[bootstrap] found ${pickups.length} pickups`);
  for (const p of pickups.slice(0, 3)) {
    console.log(`  - ${p.externalRef}`);
    const detail = await fetchReservationDetail(tenantId, p.externalRef);
    console.log(`    detail keys: ${Object.keys(detail || {}).join(', ')}`);
  }
  if (pickups.length > 3) {
    console.log(`  ... and ${pickups.length - 3} more (truncated)`);
  }
  console.log('\n[bootstrap] dry-run complete. Pass --commit to actually sync.');
}

main().catch((err) => {
  console.error('\n[bootstrap] FATAL:', err.message);
  console.error(err.stack);
  exit(1);
});
