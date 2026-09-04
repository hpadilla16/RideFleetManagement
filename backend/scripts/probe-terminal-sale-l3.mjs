/**
 * Probe: WHICH Level 2 / Level 3 fields does our terminal's gateway actually
 * accept on a Sale? (2026-09-04, for the US terminal checkout at LAX.)
 *
 *   node scripts/probe-terminal-sale-l3.mjs --tenant Corpusa --location LAX
 *   node scripts/probe-terminal-sale-l3.mjs --tenant Corpusa --location LAX --apply
 *   node scripts/probe-terminal-sale-l3.mjs --tenant Corpusa --location LAX --apply --stage 3
 *   node scripts/probe-terminal-sale-l3.mjs --tenant Corpusa --location LAX --envelope CART --apply
 *   node scripts/probe-terminal-sale-l3.mjs --tenant Corpusa --agreement RA-10021   (dry run only)
 *
 * ── THIS ONE SPENDS MONEY. READ THIS PART. ─────────────────────────────────
 *
 * Unlike probe-terminal-disclaimer.mjs, which only puts text on a screen, every
 * live stage here is a REAL SALE on a REAL CARD at a REAL COUNTER. Somebody has
 * to stand at the terminal and tap. So:
 *
 *   • DRY RUN IS THE DEFAULT. Without --apply this prints the exact payload of
 *     every stage and sends nothing. That alone answers most questions.
 *   • --amount defaults to 1.00 and is the amount of EVERY stage.
 *   • Each approved stage is VOIDED IMMEDIATELY, before the next one runs. A
 *     failed void is shouted about and STOPS the probe, because an un-voided
 *     probe charge is a real charge on a real person's card.
 *   • The probe refuses to run on anything but the tenant's OWN terminal.
 *
 * If the probe is interrupted mid-ladder (Ctrl+C), any stage already approved
 * and not yet voided is still a live charge. The run summary lists every
 * reference id it charged and whether the void succeeded — keep it.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * A card-present rental at LAX settles at plain-Sale interchange today. Level 2
 * (tax) and Level 3 (line items) are what move it to the auto-rental rate, and
 * RFM has had the itemization the whole time — autorental-l3.builder.js builds
 * it and it is wired into the Transact CNP rail. It has never been sent to the
 * terminal, and the terminal rail's history is four StatusCode 2201 rejections
 * in a row, each caused by the SHAPE of a field:
 *
 *   cc4efdd8  the body key was `RentalData`; the gateway wanted `AutoRental`
 *   02af6407  a FLAT AutoRental object → HTTP 500 from their ASP.NET parser
 *   bc29c096  ExtraCharges: []        → "ExtraCharges are required"
 *   ddd6d4b0  ExtraCharges: ['']      → "Unacceptable value for ExtraCharges[0]"
 *   (and 2026-05-30, on the plain Sale: GetToken/EnableTip/PrintReceipt → 2201)
 *
 * Every one of those was found by charging a live card and reading the error.
 * The point of this script is that the NEXT one gets found at $1.00, on a
 * staged ladder, with a void after each rung — instead of at the counter with a
 * customer's card and a $400 rental.
 *
 * 2201 means the GATEWAY refused before the terminal saw anything: no prompt,
 * no portal record, no money. That is the cheap failure and the one we want.
 *
 * ── THE LADDER ─────────────────────────────────────────────────────────────
 *
 *   0  TerminalStatus              read-only, no money, never fatal
 *   1  today's payload             THE CONTROL. If this fails, nothing below
 *                                  means anything.
 *   2  + CEDP summary header only  LEVEL 2: the tax figure, LineItemCount 0, no
 *                                  items. Is the envelope name even recognised,
 *                                  with nothing inside it to argue about? Also a
 *                                  shippable posture in its own right
 *                                  (spinL3HeaderOnly) if stage 3 fails.
 *   3  + one line item             the minimum real Level 3
 *   4  + all lines                 multi-line, DAY + EA, a discount, tax, and a
 *                                  deposit row that must be excluded
 *   5  + the AutoRental block      the half with the 2201 history
 *   6  the other envelope          Cart instead of L3Data (see below)
 *
 * Each rung adds ONE group of fields and holds everything below it constant, so
 * the first rung that stops approving names the fields the gateway will not
 * take. Nothing is hand-assembled: every rung is built by the same
 * buildSalePayload() that spinClient.sale() calls, so what is printed is what
 * would be sent.
 *
 * Stage 6 is not decoration. The CEDP `L3Data` shape in stages 2-4 is PROVEN on
 * the Transact API and UNPROVEN here; `Cart` is the structure SPIn itself
 * validated field by field in May 2026. If stages 2-4 come back 2201 and stage
 * 6 approves, the answer is "this rail itemizes through Cart" and the wiring
 * flips envelope. If stages 2-4 approve and ARLFlag comes back 'Y', L3Data wins.
 *
 * ── THE TWO SILENT FAILURES TO WATCH FOR ───────────────────────────────────
 *
 * An approval is not a pass. Two things can go wrong inside a 200 OK:
 *
 *   1. L2L3ValidationError / AutoRentalValidationError — objects keyed by field
 *      name, returned INSIDE a success. The money moves, the customer drives
 *      away, and the enrichment silently did not happen. Every stage prints
 *      them, mapped through autorental-validation.js to the RFM field behind
 *      each gateway key. ExtData.ARLFlag === 'Y' is the positive signal.
 *   2. The gateway ACCEPTS the fields and IGNORES them. Approved, no errors, no
 *      ARLFlag. That is stage 2's real job: an envelope name nobody recognises
 *      produces exactly this, and it is indistinguishable from success unless
 *      you are looking for the flag.
 *
 * And the third thing, which is not a gateway failure but would break checkout:
 * the sale response must still carry the iPOS TOKEN, because the deposit
 * pre-auth is placed against it (spin-charge.service.js). Every stage reports
 * token presence for exactly that reason.
 *
 * ── THE 2201 TRAP (inherited from the disclaimer probe) ────────────────────
 *
 * spinRequest adds CallbackInfo whenever a callbackUrl is configured. If a
 * stage fails 2201 with a blank terminal, re-run it with --no-callback before
 * concluding anything about L3.
 */
import { spinClient, buildSalePayload } from '../src/modules/payment-gateway/spin-client.js';
import {
  resolveTenantTerminalConfig, toSpinClientConfig, maskTpn,
} from '../src/modules/payment-gateway/tenant-terminal-config.js';
import { extractValidationErrors, isAutoRentalAccepted } from '../src/modules/payment-gateway/autorental-validation.js';
import { L3_ENVELOPE } from '../src/modules/payment-gateway/terminal-sale-l3.js';
import { buildLevel3LineItems } from '../src/modules/payment-gateway/autorental-l3.builder.js';
import { prisma } from '../src/lib/prisma.js';
import { pathToFileURL } from 'node:url';

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TENANT_NAME = arg('--tenant');
const TENANT_ID = arg('--tenant-id');
const LOCATION = arg('--location');
const REGISTER_ID = arg('--register');
const ONLY_STAGE = arg('--stage') === null ? null : Number(arg('--stage'));
const APPLY = process.argv.includes('--apply');
const NO_CALLBACK = process.argv.includes('--no-callback');
const NO_VOID = process.argv.includes('--i-will-void-these-myself');
const AGREEMENT = arg('--agreement');
const ENVELOPE = String(arg('--envelope', L3_ENVELOPE.L3DATA)).toUpperCase() === L3_ENVELOPE.CART
  ? L3_ENVELOPE.CART : L3_ENVELOPE.L3DATA;

// The smallest amount worth sending. Card networks and the Dejavoo proxy both
// accept $1.00; $0.01 and $0.00 are rejected or treated as account-verification
// by some processors, which would make an approval mean something different
// from what we are testing.
const MIN_AMOUNT = 1.00;
const AMOUNT = Math.max(MIN_AMOUNT, Number(arg('--amount', String(MIN_AMOUNT))) || MIN_AMOUNT);

const money = (v) => Number(Number(v || 0).toFixed(2));

// ---------------------------------------------------------------------------
// The charge rows each stage itemizes.
//
// SYNTHETIC, and deliberately so: the §5.3 invariant requires
// Σ ExtLineAmount + TaxAmount === Amount to the cent, so rows that sum to a
// real agreement's $400 total cannot ride on a $1.00 probe. Rescaling real rows
// would break the quantity × rate reconciliation the builder checks, i.e. it
// would test a payload we would never send.
//
// So these are shaped to exercise everything the real thing does, at $1.00:
// several lines, a DAY unit and an EA unit, a NEGATIVE discount row, a non-ASCII
// description (the transliteration path), a DEPOSIT row that must be excluded,
// and a synthesized TAX row that must NOT become a line item.
//
// --agreement runs the REAL rows through the builder in dry run, so the actual
// production shape is inspectable without charging anything.
// ---------------------------------------------------------------------------
const TAX_RATE = 11.5;          // Puerto Rico-ish; any non-zero rate exercises TaxRate

/**
 * ALL ARITHMETIC IN INTEGER CENTS.
 *
 * Not fussiness. The builder checks `quantity × rate === total` to the cent and
 * COLLAPSES a row that does not reconcile to Quantity 1 — so a base row built
 * with floating-point division (0.65 / 2 → 0.33 → 2 × 0.33 = 0.66 ≠ 0.65) would
 * silently stop testing the multi-quantity path, and the operator would charge a
 * card to learn nothing about it. Cents make the reconciliation exact, and the
 * daily row's cents are forced EVEN so it divides by two cleanly.
 */
export function syntheticCharges(amount) {
  const c = Math.round(amount * 100);
  const taxC = Math.round(c * 0.10);
  const netC = c - taxC;              // what the lines must sum to
  const discountC = -5;
  const cdwC = 20;
  // Base + concession share what is left; the concession absorbs the odd cent
  // so the base row stays exactly divisible by its quantity of 2.
  const shareC = netC - cdwC - discountC;
  const baseC = (shareC - 10) - ((shareC - 10) % 2);
  const concC = shareC - baseC;
  if (baseC <= 0 || concC <= 0) {
    throw new Error(`--amount ${amount} is too small to build a multi-line probe cart (base ${baseC}c, concession ${concC}c). Use at least $${MIN_AMOUNT.toFixed(2)}.`);
  }
  const d = (cents) => cents / 100;
  return {
    taxAmount: d(taxC),
    rows: [
      // quantity 2 × rate reconciles exactly → the builder keeps Quantity 2 and
      // UnitOfMeasure DAY, which is the shape a real rental sends.
      { name: 'Alquiler diario (probe)', chargeType: 'DAILY', quantity: 2, rate: d(baseC / 2), total: d(baseC), taxable: true, sortOrder: 1, source: 'BASE_RATE' },
      { name: 'Collision Damage Waiver', chargeType: 'UNIT', quantity: 1, rate: d(cdwC), total: d(cdwC), taxable: true, sortOrder: 2 },
      { name: 'Airport concession fee', chargeType: 'UNIT', quantity: 1, rate: d(concC), total: d(concC), taxable: true, sortOrder: 3 },
      { name: 'Discount', chargeType: 'UNIT', quantity: 1, rate: d(discountC), total: d(discountC), taxable: false, sortOrder: 4 },
      // Excluded by the builder. Present so the probe PROVES the exclusion.
      { name: 'Security Deposit', chargeType: 'DEPOSIT', quantity: 1, rate: 250, total: 250, sortOrder: 90 },
      // Folded into the header TaxAmount, never emitted as a line.
      { name: 'Tax', chargeType: 'TAX', quantity: 1, rate: d(taxC), total: d(taxC), sortOrder: 99 },
    ],
  };
}

/** Stage 3's single line: one row that is the whole non-tax amount. */
export function singleLineCharges(amount) {
  const tax = money(Math.round(amount * 100 * 0.10) / 100);
  return {
    taxAmount: tax,
    rows: [
      { name: 'Vehicle rental', chargeType: 'DAILY', quantity: 1, rate: money(amount - tax), total: money(amount - tax), taxable: true, sortOrder: 1 },
      { name: 'Tax', chargeType: 'TAX', quantity: 1, rate: tax, total: tax, sortOrder: 99 },
    ],
  };
}

/**
 * The AutoRental inputs for stage 5. Plausible, ASCII, in-range — the point of
 * the stage is the SHAPE, and a RentalClassId of 'SFAR' would just reproduce the
 * known 2026-05-23 2201 instead of testing anything new. normalizeRentalClassId
 * turns the letter code below into '9999', which is the value production would
 * send for a vehicle with no numeric class, so this IS the realistic case.
 */
export function autoRentalInputs(agreementNumber, days = 2) {
  const pickup = new Date();
  const ret = new Date(pickup.getTime() + days * 86400000);
  return {
    agreementNumber,
    rentalDays: days,
    renterName: 'Probe Renter',
    renterMobile: '7875550100',
    vehicle: { make: 'Toyota', model: 'Corolla', classCode: 'ECAR' },  // → 9999
    dailyRate: 0.45,
    pickupAt: pickup,
    returnAt: ret,
    pickupLocation: { address: '1 World Way', city: 'Los Angeles', state: 'CA', country: 'USA', code: 'LAX' },
    returnLocation: { address: '1 World Way', city: 'Los Angeles', state: 'CA', country: 'USA', code: 'LAX' },
    rentalDistance: 200,
  };
}

// ---------------------------------------------------------------------------
// Readout
// ---------------------------------------------------------------------------

function printPayload(label, body) {
  console.log(`\n     ── PAYLOAD (${label})`);
  console.log('     (plus the common block spinRequest adds: Authkey, Tpn, MerchantNumber,');
  console.log(`      SPInProxyTimeout${NO_CALLBACK ? '' : ', CallbackInfo when configured'})`);
  for (const line of JSON.stringify(body, null, 2).split('\n')) console.log(`     ${line}`);
}

/**
 * What came back, said plainly — and specifically the three things an approval
 * can still be hiding: validation errors inside the 200, a missing ARLFlag, and
 * a missing token.
 */
function report(label, res) {
  const gr = res?.GeneralResponse || {};
  console.log(`\n     ── RESPONSE (${label})`);
  console.log(`        ResultCode   ${gr.ResultCode ?? '(none)'}`);
  console.log(`        StatusCode   ${gr.StatusCode ?? '(none)'}`);
  console.log(`        Message      ${gr.Message ?? '(none)'}`);
  if (gr.DetailedMessage) console.log(`        Detail       ${gr.DetailedMessage}`);
  console.log(`        AuthCode     ${res?.AuthCode || '(none)'}`);

  // ── The card-on-file half of the goal. GetExtendedData is what returns the
  // iPOS token, the deposit pre-auth is placed against it, and if adding L3
  // costs us the token then checkout is broken in a way no error would show.
  const cof = spinClient.extractCardOnFile(res);
  console.log(`        TOKEN        ${cof ? `YES (${String(cof.token).slice(0, 6)}…, ${cof.brand || '?'} ${cof.last4 || '????'}, ${cof.type || 'type not stated'})` : 'NO — the deposit pre-auth would have nothing to hold against'}`);

  // ── Validation errors inside the success.
  const v = extractValidationErrors(res);
  if (v.errors.length) {
    console.log(`        ⚠ L2/L3 VALIDATION FAILED on ${v.errors.length} field(s) INSIDE this 200:`);
    for (const e of v.errors) {
      console.log(`            [${e.kind}] ${e.key} — ${e.value}`);
      console.log(`                 sent as : ${e.path}`);
      console.log(`                 RFM     : ${e.rfmField}`);
    }
    if (v.unmapped.length) {
      console.log(`        ⚠ UNMAPPED keys (their vocabulary grew, ours did not): ${v.unmapped.join(', ')}`);
      console.log('          Add them to autorental-validation.js.');
    }
  } else {
    console.log('        L2/L3 errors none');
  }
  console.log(`        ARLFlag      ${v.arlFlag ?? '(absent)'}${isAutoRentalAccepted(res) ? '  ← ACCEPTED as auto-rental' : '  ← NOT the positive signal; absence is not success'}`);

  const known = /^(GeneralResponse|AuthCode|ReferenceId|Token|IPosToken|CardData|BatchNumber|SerialNumber|PaymentType|TransactionType|ExtData|L2L3ValidationError|AutoRentalValidationError)$/;
  const extra = Object.keys(res || {}).filter((k) => !known.test(k));
  if (extra.length) console.log(`        Other keys   ${extra.join(', ')}`);
  console.log(`        RAW          ${JSON.stringify(res)}`);

  const ok = String(gr.ResultCode ?? '') === '0' && String(gr.StatusCode ?? '') === '0000';
  return { ok, approved: ok, hasToken: !!cof, validationOk: v.ok, arlFlag: v.arlFlag };
}

function explainThrow(e) {
  console.log(`\n     ✖ threw: ${e?.message || e}`);
  if (e?.spinStatusCode) console.log(`       StatusCode ${e.spinStatusCode}`);
  const gr = e?.spinResponse?.GeneralResponse;
  if (gr?.DetailedMessage) console.log(`       DETAIL     ${gr.DetailedMessage}`);
  if (e?.spinResponse) {
    console.log(`       RAW        ${JSON.stringify(e.spinResponse)}`);
    // The validation objects can ride on a FAILURE too, and they are the most
    // useful thing in the body when they do — they name the field.
    const v = extractValidationErrors(e.spinResponse);
    for (const err of v.errors) {
      console.log(`       [${err.kind}] ${err.key} — ${err.value}  (sent as ${err.path}; RFM ${err.rfmField})`);
    }
  }
  const code = String(e?.spinStatusCode || '');
  if (code === '2201') {
    console.log('\n       2201 — THIS IS THE ANSWER WE CAME FOR. The GATEWAY refused the request');
    console.log('       before the terminal saw it: no prompt, no portal record, NO MONEY MOVED.');
    console.log('       Read the DETAIL line — it names the field it did not like. The fields');
    console.log('       added by THIS stage are the ones on trial; everything below it already');
    console.log('       passed.');
    if (!NO_CALLBACK) console.log('       If the DETAIL is unhelpful, re-run this stage with --no-callback.');
  }
  if (code === '2008') {
    const wait = Number(e?.spinResponse?.GeneralResponse?.DelayBeforeNextRequest || 31);
    console.log(`\n       2008 — the terminal is still busy with an earlier request (a Ctrl+C aborts`);
    console.log(`       us, not the device). The gateway says to wait ${wait}s.`);
  }
  if (code === '2001') {
    console.log('\n       2001 — the gateway accepted the request and our credentials but could not');
    console.log('       find the terminal. Everything from RFM to Dejavoo works; the device is');
    console.log('       offline or not registered in Cloud mode. Nothing here is about L3.');
  }
  return { ok: false, approved: false, hasToken: false, validationOk: null, arlFlag: null, statusCode: code };
}

// ---------------------------------------------------------------------------
// THE LADDER
//
// Exported, and pure, so the exact staged payloads can be asserted in
// terminal-sale-l3.test.mjs and printed without a database or a terminal. A
// ladder whose rungs are only described in a comment is a ladder nobody can
// check before somebody taps a card on it.
// ---------------------------------------------------------------------------
export function buildStages({
  amount, envelope = L3_ENVELOPE.L3DATA, taxRate = TAX_RATE,
  agreementNumber = 'PROBE', baseCfg = {}, l3Cfg = {},
} = {}) {
  const many = syntheticCharges(amount);
  const one = singleLineCharges(amount);

  // Guard, not decoration. If the probe's own rows failed the §5.3 invariant,
  // stages 3-6 would each silently fall back to the CONTROL payload and the
  // operator would record six meaningless passes while a card was tapped six
  // times. Fail here instead, before anything is charged.
  const selfCheck = buildLevel3LineItems({
    amount, charges: many.rows, taxAmount: many.taxAmount, taxRate,
    agreementNumber, orderDate: new Date(),
  });
  if (!selfCheck.ok) {
    throw new Error(`the probe's own synthetic rows do not satisfy the sum invariant (${selfCheck.reason}) — fix syntheticCharges before charging anything: ${JSON.stringify(selfCheck.detail)}`);
  }

  const common = { amount, invoiceNumber: agreementNumber };
  const withLines = (rows, tax, days) => ({
    ...common,
    level3: { charges: rows, taxAmount: tax, taxRate, agreementNumber, rentalDays: days },
  });

  // The ladder turns the flags on ITSELF. It must not inherit the tenant's
  // stored posture — the point is to test shapes nobody has enabled — and an
  // l3Cfg that quietly lacked the master switch would make every L3 stage send
  // the CONTROL payload while the operator recorded a pass.
  const on = (extra) => ({
    ...l3Cfg, spinL3Enabled: true, spinL3Envelope: envelope, ...extra,
  });

  return [
    {
      n: 1,
      name: 'CONTROL — today\'s payload, byte for byte',
      why: 'if this fails, every later result is noise',
      args: () => ({ ...common }),
      cfg: baseCfg,
    },
    {
      n: 2,
      name: `+ the CEDP summary header ONLY — LEVEL 2, no line items (${envelope})`,
      why: 'is the envelope name recognised, with nothing inside it to argue about',
      // Goes through the SAME code path as every other stage — spinL3HeaderOnly
      // is a real production posture, not a probe-only escape hatch. If it were
      // hand-assembled here, this script would print one payload and sale()
      // would send another, which is the one thing a probe may never do.
      args: () => ({
        ...common,
        level3: { charges: one.rows, taxAmount: one.taxAmount, taxRate, agreementNumber },
      }),
      cfg: on({ spinL3HeaderOnly: true }),
    },
    {
      n: 3,
      name: '+ ONE line item',
      why: 'the minimum real Level 3',
      args: () => withLines(one.rows, one.taxAmount, 1),
      cfg: on({ spinL3LineItems: true }),
    },
    {
      n: 4,
      name: '+ ALL lines (multi-line, DAY + EA, a discount, tax, a deposit that must be excluded)',
      why: 'the shape production would actually send',
      args: () => withLines(many.rows, many.taxAmount, 2),
      cfg: on({ spinL3LineItems: true }),
    },
    {
      n: 5,
      name: '+ the AutoRental block (RentalClassId via normalizeRentalClassId)',
      why: 'the half with four 2201s behind it',
      args: () => {
        const a = withLines(many.rows, many.taxAmount, 2);
        a.level3.autoRental = autoRentalInputs(agreementNumber, 2);
        return a;
      },
      cfg: on({ spinL3LineItems: true, spinL3AutoRental: true }),
    },
    {
      n: 6,
      name: 'the OTHER envelope — same lines, Cart instead of L3Data (or vice versa)',
      why: 'SPIn validated Cart field by field in May 2026; it has never seen L3Data',
      args: () => withLines(many.rows, many.taxAmount, 2),
      cfg: on({
        spinL3LineItems: true,
        spinL3Envelope: envelope === L3_ENVELOPE.CART ? L3_ENVELOPE.L3DATA : L3_ENVELOPE.CART,
      }),
    },
  ];
}

/**
 * The exact body a stage would put on the wire, common block aside.
 *
 * There is no escape hatch here on purpose: every stage is built by the SAME
 * buildSalePayload() that spinClient.sale() calls, so what this prints is what
 * gets sent. A probe that prints a reconstruction can lie to you, and this one
 * charges a real card.
 */
export function stagePayload(stage, referenceId = 'L3PROBE-REF') {
  const callArgs = { ...stage.args(), referenceId };
  const { body, l3Decision } = buildSalePayload(callArgs, stage.cfg);
  return { body, l3Decision, callArgs };
}

// ---------------------------------------------------------------------------

async function main() {
  if (!TENANT_NAME && !TENANT_ID) throw new Error('Pass --tenant "<name>" or --tenant-id <id>.');

  const tenant = await prisma.tenant.findFirst({
    where: TENANT_ID ? { id: TENANT_ID } : { name: TENANT_NAME },
    select: { id: true, name: true },
  });
  if (!tenant) throw new Error(`Tenant not found: ${TENANT_ID || TENANT_NAME}`);

  let location = null;
  if (LOCATION) {
    location = await prisma.location.findFirst({
      where: { tenantId: tenant.id, OR: [{ id: LOCATION }, { code: LOCATION }] },
      select: { id: true, code: true, name: true, taxRate: true },
    });
    if (!location) {
      const known = await prisma.location.findMany({
        where: { tenantId: tenant.id }, select: { code: true }, orderBy: { code: 'asc' },
      });
      throw new Error(`No location "${LOCATION}" under ${tenant.name}. Have: ${known.map((l) => l.code).join(', ') || '(none)'}`);
    }
  }

  const resolved = await resolveTenantTerminalConfig(tenant.id, {
    locationId: location?.id || null,
    registerId: REGISTER_ID || null,
  });
  const cfg = toSpinClientConfig(resolved);
  if (NO_CALLBACK) delete cfg.spinCallbackUrl;

  // The flags this probe drives are set HERE, per run, not read from the
  // tenant's stored settings. The point is to test shapes the tenant has not
  // enabled — and to guarantee that a probe run can never leave a tenant's live
  // configuration changed.
  const l3cfg = {
    ...cfg,
    spinL3Enabled: true,
    spinL3Envelope: ENVELOPE,
  };

  console.log(`\nTenant     ${tenant.name}`);
  console.log(`Location   ${location ? `${location.code} — ${location.name}` : '(none given)'}`);
  console.log(`Register   ${resolved.registerId ? `${resolved.registerName || '(unnamed)'} · ${resolved.registerId}` : '(none — single tenant terminal)'}`);
  console.log(`Terminal   ${maskTpn(resolved.tpn)}  (source: ${resolved.source}${resolved.reason ? ` · ${resolved.reason}` : ''})`);
  console.log(`Callback   ${NO_CALLBACK ? 'OMITTED (--no-callback)' : (resolved.callbackUrl ? 'sent' : 'none configured')}`);
  console.log(`Envelope   ${ENVELOPE}`);

  if (resolved.reason === 'NO_REGISTER_FOR_LOCATION') {
    console.log('\n⚠ This tenant runs per-location registers and has NONE for that location.');
    console.log('  A charge here would be refused, and so is this probe.\n');
    return;
  }
  if (resolved.reason === 'AMBIGUOUS_REGISTER_NO_LOCATION') {
    console.log('\n⚠ Several registers and no --location. This probe CHARGES A CARD on a real');
    console.log('  device; picking one for you is not a favour.\n');
    return;
  }
  if (resolved.source !== 'TENANT') {
    console.log('\n⚠ This tenant has no terminal of its own — the probe would charge on the');
    console.log('  PLATFORM terminal, i.e. somebody else\'s merchant account. Refusing.\n');
    return;
  }

  // ── The real-agreement inspection. DRY RUN ONLY, and it charges nothing. ──
  if (AGREEMENT) {
    await inspectRealAgreement(tenant.id, AGREEMENT, location);
    if (APPLY) {
      console.log('\n⚠ --agreement is a DRY-RUN inspection and never charges, --apply or not.');
      console.log('  Re-run without --agreement to run the live ladder.\n');
    }
    return;
  }

  const agreementNumber = `PROBE-${Date.now().toString(36).toUpperCase()}`;
  const taxRate = Number(location?.taxRate ?? 0) || TAX_RATE;

  const stages = buildStages({
    amount: AMOUNT, envelope: ENVELOPE, taxRate, agreementNumber,
    baseCfg: cfg, l3Cfg: l3cfg,
  });

  // ── Stage 0, always, never fatal. ────────────────────────────────────────
  if (ONLY_STAGE === null || ONLY_STAGE === 0) {
    console.log('\n▶ Stage 0: TerminalStatus — is the device reachable? (read-only, no money)');
    try {
      const res = await spinClient.terminalStatus(cfg);
      console.log(`     Status  ${res?.TerminalStatus ?? '(none)'}`);
      if (res?.ErrorDescription) console.log(`     Error   ${res.ErrorDescription}`);
      if (String(res?.TerminalStatus || '').toLowerCase() !== 'online') {
        console.log(`     RAW     ${JSON.stringify(res)}`);
        console.log('     ⚠ Not "Online". Does NOT gate the rest — TerminalStatus has its own');
        console.log('       quirks — but a live stage will sit waiting for a card that no device');
        console.log('       is asking for.');
      }
    } catch (e) {
      console.log(`     ✖ ${e?.message || e}  (not fatal)`);
    }
  }

  console.log(`\n${'═'.repeat(76)}`);
  if (!APPLY) {
    console.log('DRY RUN — nothing will be sent. Every stage below prints the exact payload');
    console.log('spin-client would put on the wire. Add --apply to charge for real.');
  } else {
    console.log('*** LIVE. --apply IS SET. ***');
    console.log(`Each stage below charges $${AMOUNT.toFixed(2)} on TPN ${maskTpn(resolved.tpn)}`);
    console.log(`(${tenant.name}${location ? ` · ${location.code}` : ''}${resolved.registerName ? ` · ${resolved.registerName}` : ''})`);
    console.log('and VOIDS it before moving on. Somebody must tap a card at each stage.');
    if (NO_VOID) console.log('⚠⚠ --i-will-void-these-myself: AUTO-VOID IS OFF. Every approval stays a live charge.');
  }
  console.log('═'.repeat(76));

  const charged = [];   // { stage, referenceId, voided }
  let stopped = null;

  for (const stage of stages) {
    if (ONLY_STAGE !== null && stage.n !== ONLY_STAGE) continue;

    const referenceId = `L3PROBE-${stage.n}-${Date.now().toString(36)}`;
    // ONE builder for what is printed and what is sent. Stage 2's hand-built
    // block is merged exactly the way spin-client merges a generated one.
    const { body, l3Decision, callArgs } = stagePayload(stage, referenceId);

    console.log(`\n\n▶ Stage ${stage.n}: ${stage.name}`);
    console.log(`  why: ${stage.why}`);
    if (l3Decision) {
      console.log(`  builder: applied=${l3Decision.applied} envelope=${l3Decision.envelope} lines=${l3Decision.lineItemCount} tax=${l3Decision.taxAmount} lineTotal=${l3Decision.lineTotal} depositsExcluded=${l3Decision.excludedDeposits}${l3Decision.skipped ? ` skipped=${l3Decision.skipped}` : ''}${l3Decision.reason ? ` reason=${l3Decision.reason}` : ''}${l3Decision.rentalClassId ? ` rentalClassId=${l3Decision.rentalClassId}` : ''}`);
      if (l3Decision.skipped === 'BUILDER_REFUSED') {
        console.log(`  ⚠ the builder REFUSED — this stage would send the CONTROL payload, so it`);
        console.log(`    tests nothing. detail: ${JSON.stringify(l3Decision.detail)}`);
      }
    }
    printPayload(`stage ${stage.n}`, body);

    if (!APPLY) {
      console.log('     (dry run — not sent)');
      continue;
    }

    console.log(`\n  *** ABOUT TO CHARGE $${AMOUNT.toFixed(2)} on TPN ${maskTpn(resolved.tpn)} — ref ${referenceId} ***`);
    console.log('  Look at the terminal and tap when it prompts.');

    let out;
    try {
      const res = await spinClient.sale(callArgs, stage.cfg);
      out = report(`stage ${stage.n}`, res);
    } catch (e) {
      out = explainThrow(e);
    }

    if (out.approved) {
      charged.push({ stage: stage.n, referenceId, voided: false });
      if (NO_VOID) {
        console.log(`\n  ⚠ NOT VOIDED (--i-will-void-these-myself). ref ${referenceId} is a live $${AMOUNT.toFixed(2)} charge.`);
      } else {
        const voided = await voidStage(referenceId, cfg, AMOUNT);
        charged[charged.length - 1].voided = voided;
        if (!voided) {
          stopped = `stage ${stage.n} approved and the VOID FAILED`;
          break;
        }
      }
      console.log(`  ✔ Stage ${stage.n} APPROVED${out.validationOk === false ? ' — but with L2/L3 validation errors inside the 200 (see above)' : ''}${out.hasToken ? '' : ' — and NO TOKEN came back'}`);
    } else {
      console.log(`\n  ✖ Stage ${stage.n} was REFUSED. No money moved.`);
      console.log('    Everything in stages below this one already passed, so the fields THIS');
      console.log('    stage adds are what the gateway rejected. That is the finding.');
      stopped = `stage ${stage.n} refused`;
      break;
    }
  }

  // ── The part you keep. ───────────────────────────────────────────────────
  console.log(`\n\n${'═'.repeat(76)}`);
  console.log('RUN SUMMARY');
  console.log('═'.repeat(76));
  if (!APPLY) {
    console.log('Dry run. Nothing charged, nothing to void.');
  } else if (charged.length === 0) {
    console.log('No stage was approved, so nothing was charged.');
  } else {
    for (const c of charged) {
      console.log(`  stage ${c.stage}  $${AMOUNT.toFixed(2)}  ref ${c.referenceId}  ${c.voided ? 'VOIDED' : '*** STILL CHARGED ***'}`);
    }
    const live = charged.filter((c) => !c.voided);
    if (live.length) {
      console.log(`\n  ⚠⚠ ${live.length} charge(s) ARE STILL LIVE ON A REAL CARD.`);
      console.log('  Void them in the iPOSpays portal, or:');
      for (const c of live) console.log(`    node scripts/void-spin-charge.mjs --tenant "<name>" --ref ${c.referenceId} --amount ${c.amount ?? AMOUNT}`);
    }
  }
  if (stopped) console.log(`\nStopped: ${stopped}`);
  console.log('\nWhat to write down, per stage: APPROVED or the StatusCode; whether');
  console.log('L2L3ValidationError/AutoRentalValidationError was populated INSIDE a 200;');
  console.log('whether ExtData.ARLFlag came back "Y"; and whether the TOKEN was still there.');
  console.log('The first stage that stops approving names the fields this gateway will not');
  console.log('take. The first stage that approves WITH ARLFlag=Y is the payload to ship.\n');
}

/**
 * Void, and be loud about it. An un-voided probe charge is a real charge on a
 * real person's card, so a failure here stops the ladder rather than letting a
 * second one accumulate behind it.
 */
async function voidStage(referenceId, cfg, amount) {
  console.log(`\n  … voiding ${referenceId}`);
  try {
    const res = await spinClient.void({ referenceId, amount }, cfg);
    const gr = res?.GeneralResponse || {};
    const ok = String(gr.ResultCode ?? '') === '0' && String(gr.StatusCode ?? '') === '0000';
    console.log(`     void ResultCode ${gr.ResultCode ?? '(none)'} StatusCode ${gr.StatusCode ?? '(none)'} ${gr.Message ?? ''}`);
    if (!ok) {
      console.log(`     RAW ${JSON.stringify(res)}`);
      console.log(`\n  ⚠⚠⚠ VOID DID NOT CONFIRM for ${referenceId}. Treat this as a LIVE CHARGE.`);
      console.log('      Stopping the ladder — check the iPOSpays portal before running more.');
      return false;
    }
    console.log('     ✔ voided');
    return true;
  } catch (e) {
    console.log(`\n  ⚠⚠⚠ VOID THREW for ${referenceId}: ${e?.message || e}`);
    if (e?.spinResponse) console.log(`      RAW ${JSON.stringify(e.spinResponse)}`);
    console.log('      Treat this as a LIVE CHARGE. Stopping the ladder.');
    return false;
  }
}

/**
 * Run a REAL agreement's charge rows through the builder and print the result.
 * Charges nothing, ever. This is how you see the production payload — real
 * descriptions, real units, real discounts, and whether the §5.3 invariant
 * actually holds for that agreement — without a card being involved.
 */
async function inspectRealAgreement(tenantId, agreementNumber, location) {
  const agreement = await prisma.rentalAgreement.findFirst({
    where: { agreementNumber, reservation: { tenantId } },
    select: {
      id: true, agreementNumber: true, total: true, taxes: true,
      charges: {
        select: {
          name: true, code: true, chargeType: true, quantity: true, rate: true,
          total: true, taxable: true, selected: true, sortOrder: true, source: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
      reservation: {
        select: {
          pickupAt: true, returnAt: true,
          pickupLocation: { select: { taxRate: true } },
        },
      },
    },
  });
  if (!agreement) throw new Error(`No agreement "${agreementNumber}" under this tenant.`);

  const amount = Number(agreement.total);
  const taxAmount = Number(agreement.taxes ?? 0);
  const taxRate = Number(agreement.reservation?.pickupLocation?.taxRate ?? location?.taxRate ?? 0);

  console.log(`\n${'═'.repeat(76)}`);
  console.log(`REAL AGREEMENT ${agreement.agreementNumber} — DRY RUN, nothing is charged`);
  console.log('═'.repeat(76));
  console.log(`  total ${amount}   taxes ${taxAmount}   location taxRate ${taxRate}`);
  console.log(`  charge rows: ${agreement.charges.length}`);

  const built = buildLevel3LineItems({
    amount, charges: agreement.charges, taxAmount, taxRate,
    agreementNumber: agreement.agreementNumber, orderDate: new Date(),
  });

  if (!built.ok) {
    console.log(`\n  ✖ The builder REFUSES this agreement: ${built.reason}`);
    console.log(`     ${JSON.stringify(built.detail, null, 2)}`);
    console.log('\n  That is not necessarily a bug — see autorental-l3.builder.js. It does mean');
    console.log('  this agreement would ship the old single-line payload.');
    return;
  }

  console.log(`\n  ✔ invariant holds: Σ ExtLineAmount ${built.lineTotal} + TaxAmount ${built.taxAmount} = ${amount}`);
  console.log(`     ${built.lineItemCount} line item(s), ${built.excludedDeposits} deposit row(s) excluded`);
  printPayload(`REAL ${agreement.agreementNumber} / ${ENVELOPE}`,
    ENVELOPE === L3_ENVELOPE.CART
      ? { Cart: { Items: built.items.map((i) => ({ Name: i.Description, Price: i.ExtLineAmount, Quantity: i.Quantity, UnitPrice: i.UnitCost, Total: i.ExtLineAmount, CommodityCode: '4111' })), Total: amount, Amounts: [{ Name: 'Subtotal', Value: built.lineTotal }, { Name: 'Tax', Value: built.taxAmount }, { Name: 'Total', Value: amount }] } }
      : { L3Data: { Header: built.header, items: built.items } });
  console.log('\n  To charge this shape, run the ladder WITHOUT --agreement — it uses');
  console.log('  synthetic rows that sum to --amount so a real card is only ever hit for $1.\n');
}

// Run ONLY when executed directly. buildStages/stagePayload are imported by
// terminal-sale-l3.test.mjs so the ladder's payloads are asserted rather than
// described — and importing a script that charges cards must not charge cards.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .catch((e) => { console.error(`\n${e?.message || e}\n`); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
