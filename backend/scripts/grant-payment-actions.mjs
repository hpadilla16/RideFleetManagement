#!/usr/bin/env node
// scripts/grant-payment-actions.mjs
//
// Grant (or revoke) the `paymentActions` module for SPECIFIC users, by email.
//
// WHY THIS EXISTS (2026-07-25)
// paymentActions gates the routes that make the system move money at the
// gateway, destroy a payment record, or store a reusable card. It defaults ON
// for ADMIN/OPS and OFF for AGENT. If any counter agent (or the VozIA service
// account, whose role is AGENT) genuinely needs one of those capabilities, this
// script opens it for that person ALONE — without opening it for every agent,
// and without a code change.
//
// Run:
//   node scripts/grant-payment-actions.mjs a@x.com b@x.com             # dry run
//   node scripts/grant-payment-actions.mjs --apply a@x.com b@x.com     # write
//   node scripts/grant-payment-actions.mjs --apply --revoke a@x.com    # take it away
//
// IDEMPOTENT and ADDITIVE: it reads the user's existing
// AppSetting `user:<id>:moduleAccess` blob, sets ONLY the paymentActions key,
// and writes it back. Every other module toggle for that user is preserved
// byte-for-byte. Re-running changes nothing.
//
// Writing an explicit per-user override also PINS the value: it no longer
// follows the role default, so a later role change will not silently move it.
//
// AUDITED. Every --apply write records a ModuleAccessAuditLog row, exactly like
// the Settings/People UI does. The audit table exists to answer "who gave this
// agent the ability to refund a card, and when" — and this script is the tool
// most likely to perform that grant (service accounts and one-off counter
// exceptions never go through the UI). A grant path that skips the audit is a
// hole in the answer, so it does not skip it. Actor is recorded as
// `script:grant-payment-actions`; pair the row's timestamp with the shell
// history/deploy note to attribute it to a person.
//
// On the droplet: exec inside fleet-backend-prod.

import { prisma } from '../src/lib/prisma.js';
import { recordModuleAccessAudit } from '../src/lib/module-access.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const REVOKE = argv.includes('--revoke');
const emails = argv.filter((a) => !a.startsWith('--'));
const VALUE = !REVOKE;

async function main() {
  if (!emails.length) {
    console.error('Usage: node scripts/grant-payment-actions.mjs [--apply] [--revoke] <email> [email...]');
    process.exit(1);
  }

  console.log(`[grant-payment-actions] mode = ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`[grant-payment-actions] setting paymentActions = ${VALUE} for ${emails.length} user(s)\n`);

  let changed = 0;
  let skipped = 0;

  for (const email of emails) {
    const user = await prisma.user.findFirst({
      where: { email },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        tenantId: true,
        isActive: true,
        isServiceAccount: true
      }
    });

    if (!user) {
      console.log(`  MISS   ${email} — no such user`);
      skipped += 1;
      continue;
    }

    const key = `user:${user.id}:moduleAccess`;
    const row = await prisma.appSetting.findUnique({ where: { key } });
    let stored = {};
    try {
      stored = row?.value ? JSON.parse(row.value) : {};
    } catch {
      // A corrupt blob is preserved as {} rather than crashing; the write below
      // would otherwise be the thing that destroys their other toggles.
      console.log(`  WARN   ${email} — existing moduleAccess JSON is unparseable, treating as empty`);
      stored = {};
    }

    const before = Object.prototype.hasOwnProperty.call(stored, 'paymentActions')
      ? String(stored.paymentActions)
      : '(no override — follows role default)';

    if (stored.paymentActions === VALUE) {
      console.log(`  NOOP   ${email} [${user.role}] already ${VALUE}`);
      skipped += 1;
      continue;
    }

    const flags = [
      !user.isActive ? 'INACTIVE' : null,
      user.isServiceAccount ? 'SERVICE-ACCOUNT' : null
    ].filter(Boolean);

    console.log(
      `  ${APPLY ? 'SET  ' : 'WOULD'}  ${email} [${user.role}]` +
        `${flags.length ? ` (${flags.join(', ')})` : ''}: ${before} -> ${VALUE}`
    );

    if (APPLY) {
      const next = { ...stored, paymentActions: VALUE };
      await prisma.appSetting.upsert({
        where: { key },
        create: { key, value: JSON.stringify(next) },
        update: { value: JSON.stringify(next) }
      });

      // Same stored-vs-stored diff the Settings route uses, so a grant made
      // here is indistinguishable from one made in the UI when the table is
      // queried later. Best-effort inside recordModuleAccessAudit — an audit
      // failure logs a warning and never undoes the grant above.
      await recordModuleAccessAudit({
        scope: 'USER',
        tenantId: user.tenantId || null,
        targetUserId: user.id,
        actor: { sub: 'script:grant-payment-actions', role: 'SCRIPT' },
        before: stored,
        after: next
      });
    }
    changed += 1;
  }

  console.log(`\n[grant-payment-actions] ${APPLY ? 'changed' : 'would change'}: ${changed}, skipped: ${skipped}`);
  if (!APPLY && changed > 0) console.log('[grant-payment-actions] re-run with --apply to write.');
  if (APPLY && changed > 0) {
    // Session cache is 30s TTL per worker; the change lands within that window
    // without a restart. Stated explicitly so nobody restarts prod for this.
    console.log('[grant-payment-actions] takes effect within ~30s (session cache TTL). No restart needed.');
  }
}

main()
  .catch((e) => {
    console.error('[grant-payment-actions] FAILED:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    // EXPLICIT EXIT. Importing module-access.js pulls in the cache/logger graph,
    // which leaves a handle that keeps the event loop alive after the work is
    // done — the same reason every module-access suite in package.json carries
    // `--test-force-exit`. Without this the script prints its summary and then
    // HANGS, which on the droplet looks like a stuck write. stdout is async when
    // piped, so flush before the hard exit or `... | tee` loses the output.
    process.stdout.write('', () => process.exit(process.exitCode || 0));
  });
