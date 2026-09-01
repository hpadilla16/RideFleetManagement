import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paymentStepMode, PAYMENT_STEP_MODES } from '../src/lib/checkout-session';

/**
 * Per-tenant "payment step optional at check-out" (2026-08-26).
 *
 * The backend does the real work: when a tenant has `checkoutPaymentRequired`
 * off it pre-stamps `paymentCompletedAt` at session creation, exactly the way
 * DEALERSHIP_LOANER already did, and the state machine's PAID entry guard is
 * satisfied without a charge.
 *
 * But the wizard had its OWN client-side gate on step 3 that only knew about
 * loaners, so a pre-stamped rental session still rendered the full two-tap Spin
 * screen — the agent saw a payment UI for money nobody was collecting, until an
 * auto-advance effect happened to fire. `paymentStepMode` is that gate, pulled
 * out as a pure function so it can be pinned here without mounting the
 * 2k-line wizard.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIZARD = join(ROOT, 'src', 'app', 'reservations', '[id]', 'checkout-wizard-v2', 'page.js');
const SETTINGS = join(ROOT, 'src', 'app', 'settings', 'page.js');

describe('paymentStepMode', () => {
  it('collects payment by default — no stamp, ordinary rental', () => {
    expect(paymentStepMode({ id: 's1' }, { workflowMode: 'RENTAL' })).toBe(PAYMENT_STEP_MODES.COLLECT);
    expect(paymentStepMode({ id: 's1', paymentCompletedAt: null }, {})).toBe(PAYMENT_STEP_MODES.COLLECT);
    expect(paymentStepMode({}, {})).toBe(PAYMENT_STEP_MODES.COLLECT);
    expect(paymentStepMode(null, null)).toBe(PAYMENT_STEP_MODES.COLLECT);
  });

  it('skips the payment screen once the session carries paymentCompletedAt', () => {
    const session = { id: 's1', paymentCompletedAt: '2026-08-26T12:00:00.000Z' };
    expect(paymentStepMode(session, { workflowMode: 'RENTAL' })).toBe(PAYMENT_STEP_MODES.SKIP);
  });

  it('keeps the loaner screen even though loaners are pre-stamped too', () => {
    // Ordering guard. The backend pre-stamps loaners, so a naive
    // "if (paymentCompletedAt) skip" would swallow the CUSTOMER_PAY
    // upgrade-differential prompt the advisor still has to acknowledge.
    const session = { id: 's1', paymentCompletedAt: '2026-08-26T12:00:00.000Z' };
    expect(paymentStepMode(session, { workflowMode: 'DEALERSHIP_LOANER' })).toBe(PAYMENT_STEP_MODES.LOANER);
    expect(paymentStepMode({ id: 's1' }, { workflowMode: 'DEALERSHIP_LOANER' })).toBe(PAYMENT_STEP_MODES.LOANER);
  });

  it('only these three modes exist', () => {
    expect(Object.values(PAYMENT_STEP_MODES).sort()).toEqual(['COLLECT', 'LOANER', 'SKIP']);
  });
});

describe('the wizard actually uses the gate', () => {
  const src = () => readFileSync(WIZARD, 'utf8');

  it('PAYMENT_PENDING dispatches on paymentStepMode, not on workflowMode alone', () => {
    const s = src();
    expect(s).toMatch(/const mode = paymentStepMode\(session, reservation\)/);
    expect(s).toMatch(/mode === PAYMENT_STEP_MODES\.LOANER/);
    expect(s).toMatch(/mode === PAYMENT_STEP_MODES\.SKIP/);
    // The old gate — a bare workflowMode ternary choosing the Spin step — is gone.
    expect(s).not.toMatch(/reservation\.workflowMode === 'DEALERSHIP_LOANER'\s*\?\s*<LoanerPaymentBridge/);
  });

  it('the SKIP branch never renders the Spin charge screen', () => {
    const s = src();
    const block = s.slice(s.indexOf("case 'PAYMENT_PENDING'"), s.indexOf("case 'PAID'"));
    const skipBranch = block.slice(block.indexOf('PAYMENT_STEP_MODES.SKIP'), block.indexOf('return <Step3PaymentPending'));
    expect(skipBranch).toMatch(/StepBridge/);
    expect(skipBranch).not.toMatch(/Step3PaymentPending/);
  });

  it('Step3PaymentPending is still reachable for everyone else', () => {
    // Turning the flag off for one tenant must not delete the payment step.
    expect(src()).toMatch(/return <Step3PaymentPending session=\{session\}/);
  });
});

describe('the Settings switch', () => {
  const src = () => readFileSync(SETTINGS, 'utf8');

  it('reads and writes /api/settings/checkout-payment through scopedSettingsPath', () => {
    // scopedSettingsPath appends ?tenantId= for a SUPER_ADMIN operating inside a
    // tenant. Without it the super admin would read/write their OWN tenant's
    // policy while looking at someone else's settings page.
    const s = src();
    // Both call sites (the mount-time GET and the toggle's PUT) go through it.
    const scoped = s.match(/scopedSettingsPath\('\/api\/settings\/checkout-payment'\)/g) || [];
    expect(scoped.length).toBe(2);
    expect(s).toMatch(/JSON\.stringify\(\{ checkoutPaymentRequired: required \}\)/);
    expect(s).toMatch(/method: 'PUT'/);
    // No unscoped fetch of this endpoint anywhere on the page.
    expect(s).not.toMatch(/api\(\s*'\/api\/settings\/checkout-payment'/);
  });

  it('defaults the switch to ON and only an explicit false turns it off', () => {
    const s = src();
    expect(s).toMatch(/useState\(true\);\s*\n\s*const \[checkoutPaymentSaving/);
    // `!== false` (not `!!`): a missing/failed field leaves payment required.
    expect(s).toMatch(/setCheckoutPaymentRequired\(out\?\.checkoutPaymentRequired !== false\)/);
    expect(s).not.toMatch(/setCheckoutPaymentRequired\(!!out/);
  });

  it('is labelled bilingually and says payments are still possible elsewhere', () => {
    const s = src();
    expect(s).toMatch(/Require payment during check-out/);
    expect(s).toMatch(/Exigir pago durante el check-out/);
    expect(s).toMatch(/View Payments/);
  });
});
