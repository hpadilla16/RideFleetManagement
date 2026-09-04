/**
 * Void one SPIn charge by reference (2026-09-04).
 *
 *   node scripts/void-spin-charge.mjs --tenant "Corpusa" --ref L3PROBE-1-xxxx --amount 1.00
 *
 * Written the day a probe charge stayed live because spinClient.void() was
 * sending only ReferenceId and the gateway answered 2201:
 *
 *   "The Amount field is required. For PaymentType field required values are
 *    [Credit, Debit, EBT_Food, EBT_Cash, Card, Cash, Check, Gift, UserChoice]"
 *
 * The client is fixed, but a charge that is already live needs a way to be
 * reversed that does not involve pasting an inline node -e. This is that way.
 *
 * MONEY: this REVERSES a charge. It cannot create one. The worst outcome of
 * running it with wrong arguments is a refusal, not a debit — but it is still
 * a money operation, so it prints what it is about to do and requires --apply.
 */
import { spinClient } from '../src/modules/payment-gateway/spin-client.js';
import { resolveTenantTerminalConfig, toSpinClientConfig, maskTpn } from '../src/modules/payment-gateway/tenant-terminal-config.js';
import { prisma } from '../src/lib/prisma.js';

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APPLY = process.argv.includes('--apply');
const TENANT_NAME = arg('--tenant');
const TENANT_ID = arg('--tenant-id');
const REF = arg('--ref');
const AMOUNT = Number(arg('--amount', '0'));
const PAYMENT_TYPE = arg('--payment-type', 'Credit');
const LOCATION = arg('--location');

async function main() {
  if (!TENANT_NAME && !TENANT_ID) throw new Error('Pass --tenant "<name>" or --tenant-id <id>.');
  if (!REF) throw new Error('Pass --ref <referenceId> — the reference of the charge to void.');
  if (!Number.isFinite(AMOUNT) || AMOUNT <= 0) {
    throw new Error('Pass --amount <the ORIGINAL charge amount>. The gateway refuses a void without it.');
  }

  const tenant = await prisma.tenant.findFirst({
    where: TENANT_ID ? { id: TENANT_ID } : { name: TENANT_NAME },
    select: { id: true, name: true },
  });
  if (!tenant) throw new Error(`Tenant not found: ${TENANT_ID || TENANT_NAME}`);

  let locationId = null;
  if (LOCATION) {
    const loc = await prisma.location.findFirst({
      where: { tenantId: tenant.id, OR: [{ id: LOCATION }, { code: LOCATION.toUpperCase() }] },
      select: { id: true, code: true },
    });
    if (!loc) throw new Error(`No location "${LOCATION}" in ${tenant.name}`);
    locationId = loc.id;
  }

  const resolved = await resolveTenantTerminalConfig(tenant.id, { locationId });
  if (resolved.source !== 'TENANT') {
    throw new Error(`No terminal of their own for ${tenant.name} (${resolved.source} · ${resolved.reason}). Refusing.`);
  }
  const cfg = toSpinClientConfig(resolved);

  console.log(`\nTenant     ${tenant.name}`);
  console.log(`Terminal   ${maskTpn(resolved.tpn)}`);
  console.log(`Reference  ${REF}`);
  console.log(`Amount     $${AMOUNT.toFixed(2)}  (${PAYMENT_TYPE})`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing sent. Re-run with --apply to void this charge.\n');
    return;
  }

  console.log('\n  … voiding');
  const res = await spinClient.void({ referenceId: REF, amount: AMOUNT, paymentType: PAYMENT_TYPE }, cfg);
  const gr = res?.GeneralResponse || {};
  const ok = String(gr.ResultCode ?? '') === '0' && String(gr.StatusCode ?? '') === '0000';
  console.log(`     ResultCode ${gr.ResultCode ?? '(none)'}  StatusCode ${gr.StatusCode ?? '(none)'}  ${gr.Message ?? ''}`);
  if (gr.DetailedMessage) console.log(`     Detail     ${gr.DetailedMessage}`);
  console.log(`     RAW        ${JSON.stringify(res)}`);
  console.log(ok
    ? `\n  ✔ Voided. Confirm it in the iPOSpays portal as well — the record there is the one that settles.\n`
    : `\n  ✖ NOT voided. The charge is still live; void it in the iPOSpays portal.\n`);
}

main()
  .catch((e) => {
    const gr = e?.spinResponse?.GeneralResponse;
    console.error(`\n${e?.message || e}`);
    if (gr?.DetailedMessage) console.error(`Detail: ${gr.DetailedMessage}`);
    console.error('');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
