import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { renderBrandedEmail, resolveEmailBrand } from '../../lib/email-template.js';
import logger from '../../lib/logger.js';

/**
 * Long-Term (Monthly) Reservations — P2 customer emails (2026-06-04).
 *
 * Four templates with simple {{tag}} merge substitution:
 *   • reminder — renewal reminder, sent 48h/24h BEFORE nextCycleStartsAt
 *   • receipt  — payment receipt after a successful cycle auto-charge
 *   • overdue  — dunning notice, every 24h after the grace period
 *   • ended    — plan ended confirmation
 *
 * Defaults are built in; tenant overrides live in the appSetting key
 * 'longTermEmailTemplates' (tenant-scoped via the same `tenant:<id>:<key>`
 * convention the settings module uses). Config shape:
 *
 *   {
 *     reminder: { subject, body, enabled },
 *     receipt:  { subject, body, enabled },
 *     overdue:  { subject, body, enabled },
 *     ended:    { subject, body, enabled },
 *     remindBeforeHours: [48, 24],
 *     overdueEveryHours: 24,
 *     graceDays: 1,
 *     billingMode: 'AUTO'   // 'AUTO' | 'MANUAL'
 *   }
 *
 * Merge tags: {{customerFirstName}}, {{vehicle}}, {{amount}}, {{dueDate}},
 * {{periodStart}}, {{periodEnd}}, {{cycleNumber}}, {{cardBrand}},
 * {{cardLast4}}, {{companyName}}, {{locationPhone}}.
 * Missing tags render as empty strings.
 */

export const LONG_TERM_EMAIL_SETTING_KEY = 'longTermEmailTemplates';

export const DEFAULT_LONG_TERM_EMAIL_CONFIG = {
  reminder: {
    enabled: true,
    subject: 'Upcoming monthly renewal — {{vehicle}}',
    body:
      'Hello {{customerFirstName}},\n\n'
      + 'Your monthly rental of {{vehicle}} renews on {{dueDate}} '
      + '(cycle {{cycleNumber}}, {{periodStart}} – {{periodEnd}}).\n\n'
      + 'The renewal amount of ${{amount}} will be charged automatically to your '
      + '{{cardBrand}} card ending in {{cardLast4}} on the due date.\n\n'
      + 'No action is needed. If you would like to make changes or end your plan, '
      + 'please contact us at {{locationPhone}} before the renewal date.\n\n'
      + 'Thank you,\n{{companyName}}',
  },
  receipt: {
    enabled: true,
    subject: 'Payment received — monthly rental cycle {{cycleNumber}}',
    body:
      'Hello {{customerFirstName}},\n\n'
      + 'We received your payment of ${{amount}} for your monthly rental of {{vehicle}} '
      + '(cycle {{cycleNumber}}, {{periodStart}} – {{periodEnd}}).\n\n'
      + 'Charged to your {{cardBrand}} card ending in {{cardLast4}}.\n\n'
      + 'Thank you for renting with us!\n{{companyName}}\n{{locationPhone}}',
  },
  overdue: {
    enabled: true,
    subject: 'Payment past due — monthly rental of {{vehicle}}',
    body:
      'Hello {{customerFirstName}},\n\n'
      + 'The payment of ${{amount}} for your monthly rental of {{vehicle}} '
      + '(cycle {{cycleNumber}}, due {{dueDate}}) could not be processed and is now past due.\n\n'
      + 'Please contact us at {{locationPhone}} to bring your account current and keep '
      + 'your rental active.\n\n'
      // TODO(P2.5): insert the Hosted Payment Page pay-link here once Dejavoo
      // confirms HPP is enabled on the TPN (token-scoped /pay/{token} page —
      // records payment, marks cycle PAID, replaces card on file, auto-clears
      // overdue). Pending Dejavoo.
      + 'Thank you,\n{{companyName}}',
  },
  ended: {
    enabled: true,
    subject: 'Your monthly rental plan has ended',
    body:
      'Hello {{customerFirstName}},\n\n'
      + 'Your monthly rental plan for {{vehicle}} has ended as of {{periodEnd}}.\n\n'
      + 'Thank you for renting with {{companyName}}. We hope to see you again soon!\n\n'
      + '{{companyName}}\n{{locationPhone}}',
  },
  remindBeforeHours: [48, 24],
  overdueEveryHours: 24,
  graceDays: 1,
  billingMode: 'AUTO', // 'AUTO' | 'MANUAL'
};

// Same scoping convention as settings.service.js scopedKey().
function scopedKey(baseKey, scope = {}) {
  return scope?.tenantId ? `tenant:${scope.tenantId}:${baseKey}` : baseKey;
}

function normalizeTemplate(raw, fallback) {
  return {
    enabled: raw?.enabled == null ? !!fallback.enabled : !!raw.enabled,
    subject: typeof raw?.subject === 'string' && raw.subject.trim() ? raw.subject : fallback.subject,
    body: typeof raw?.body === 'string' && raw.body.trim() ? raw.body : fallback.body,
  };
}

function normalizeHoursList(raw, fallback) {
  const list = Array.isArray(raw) ? raw : fallback;
  const cleaned = list
    .map((h) => Number(h))
    .filter((h) => Number.isFinite(h) && h > 0 && h <= 720)
    .sort((a, b) => b - a); // largest window first (48 before 24)
  return cleaned.length ? Array.from(new Set(cleaned)) : [...fallback];
}

export function normalizeLongTermEmailConfig(raw = {}) {
  const d = DEFAULT_LONG_TERM_EMAIL_CONFIG;
  const overdueEveryHours = Number(raw?.overdueEveryHours);
  const graceDays = Number(raw?.graceDays);
  return {
    reminder: normalizeTemplate(raw?.reminder, d.reminder),
    receipt: normalizeTemplate(raw?.receipt, d.receipt),
    overdue: normalizeTemplate(raw?.overdue, d.overdue),
    ended: normalizeTemplate(raw?.ended, d.ended),
    remindBeforeHours: normalizeHoursList(raw?.remindBeforeHours, d.remindBeforeHours),
    overdueEveryHours: Number.isFinite(overdueEveryHours) && overdueEveryHours >= 1 && overdueEveryHours <= 168
      ? Math.round(overdueEveryHours)
      : d.overdueEveryHours,
    graceDays: Number.isFinite(graceDays) && graceDays >= 0 && graceDays <= 30
      ? Math.round(graceDays)
      : d.graceDays,
    billingMode: String(raw?.billingMode || d.billingMode).toUpperCase() === 'MANUAL' ? 'MANUAL' : 'AUTO',
  };
}

/** Read the tenant's long-term email config (defaults merged in). */
export async function getLongTermEmailConfig(scope = {}) {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: scopedKey(LONG_TERM_EMAIL_SETTING_KEY, scope) },
    });
    if (!row?.value) return normalizeLongTermEmailConfig({});
    return normalizeLongTermEmailConfig(JSON.parse(row.value));
  } catch (err) {
    logger.warn('[long-term-emails] config read failed — using defaults', {
      tenantId: scope?.tenantId || null, message: err.message,
    });
    return normalizeLongTermEmailConfig({});
  }
}

/** Persist the tenant's long-term email config (normalized). */
export async function updateLongTermEmailConfig(payload = {}, scope = {}) {
  const next = normalizeLongTermEmailConfig(payload);
  const key = scopedKey(LONG_TERM_EMAIL_SETTING_KEY, scope);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}

// ── Rendering ──────────────────────────────────────────────────────────

// {{tag}} substitution: every known tag replaced; any leftover {{...}}
// tags become empty strings so half-edited tenant templates never leak
// raw braces to the customer.
export function renderTemplate(str, vars = {}) {
  let out = String(str || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v ?? ''));
  }
  out = out.replace(/\{\{\s*[\w.]+\s*\}\}/g, '');
  return out;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textToHtml(text) {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">${esc(text).replace(/\n/g, '<br/>')}</div>`;
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function fmtMoney(n) {
  return Number(n || 0).toFixed(2);
}

/**
 * Build the merge-tag context for a plan + cycle. Loads the reservation,
 * customer, agreement (card on file), vehicle, and pickup location —
 * tenant-scoped through the plan row itself.
 */
export async function buildLongTermEmailContext({ plan, cycle }) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: plan.reservationId, ...(plan.tenantId ? { tenantId: plan.tenantId } : {}) },
    select: {
      id: true,
      tenantId: true,
      customer: { select: { firstName: true, lastName: true, email: true } },
      vehicle: { select: { make: true, model: true, year: true, plate: true } },
      pickupLocation: { select: { name: true, locationConfig: true } },
    },
  });
  if (!reservation) return null;

  const agreement = await prisma.rentalAgreement.findFirst({
    where: { reservationId: plan.reservationId },
    select: {
      id: true,
      agreementNumber: true,
      customerEmail: true,
      customerFirstName: true,
      cardOnFileBrand: true,
      cardOnFileLast4: true,
    },
  });

  let companyName = 'RideFleet';
  let locationPhone = '';
  try {
    const cfgRaw = reservation.pickupLocation?.locationConfig;
    if (cfgRaw) {
      const cfg = typeof cfgRaw === 'string' ? JSON.parse(cfgRaw) : cfgRaw;
      if (cfg?.companyName) companyName = cfg.companyName;
      if (cfg?.companyPhone) locationPhone = cfg.companyPhone;
    }
  } catch { /* locationConfig is optional JSON — defaults are fine */ }
  if (companyName === 'RideFleet' && reservation.pickupLocation?.name) {
    companyName = reservation.pickupLocation.name;
  }

  const v = reservation.vehicle;
  const vehicleLabel = v
    ? [v.year, v.make, v.model].filter(Boolean).join(' ') + (v.plate ? ` (${v.plate})` : '')
    : 'your rental vehicle';

  const toEmail = reservation.customer?.email || agreement?.customerEmail || '';

  return {
    toEmail,
    vars: {
      customerFirstName: reservation.customer?.firstName || agreement?.customerFirstName || 'Customer',
      vehicle: vehicleLabel,
      amount: fmtMoney(cycle?.amount),
      dueDate: fmtDate(cycle?.periodStart),
      periodStart: fmtDate(cycle?.periodStart),
      periodEnd: fmtDate(cycle?.periodEnd),
      cycleNumber: cycle?.cycleNumber ?? '',
      cardBrand: agreement?.cardOnFileBrand || 'card',
      cardLast4: agreement?.cardOnFileLast4 || '????',
      companyName,
      locationPhone,
    },
  };
}

/**
 * Send one of the four long-term emails for a plan + cycle.
 * kind: 'reminder' | 'receipt' | 'overdue' | 'ended'
 * Returns { sent, reason? }. Never throws — callers (the scheduler)
 * treat email failures as non-fatal and rely on the returned flag for
 * dedupe bookkeeping (only mark sent if it actually went out).
 */
export async function sendLongTermEmail(kind, { plan, cycle, config = null }) {
  try {
    const cfg = config || await getLongTermEmailConfig({ tenantId: plan.tenantId || null });
    const tpl = cfg[kind];
    if (!tpl) return { sent: false, reason: `unknown template kind: ${kind}` };
    if (!tpl.enabled) return { sent: false, reason: 'template disabled' };

    const ctx = await buildLongTermEmailContext({ plan, cycle });
    if (!ctx) return { sent: false, reason: 'reservation not found' };
    if (!ctx.toEmail) return { sent: false, reason: 'customer has no email' };

    const subject = renderTemplate(tpl.subject, ctx.vars);
    const innerText = renderTemplate(tpl.body, ctx.vars);

    const headings = {
      reminder: 'Upcoming monthly renewal',
      receipt: 'Payment received',
      overdue: 'Payment past due',
      ended: 'Your monthly plan has ended',
    };
    let brand;
    try { brand = await resolveEmailBrand({ tenantId: plan.tenantId || null }); } catch { brand = undefined; }
    const { html, text } = renderBrandedEmail({
      brand,
      heading: headings[kind] || subject,
      bodyHtml: textToHtml(innerText),
      bodyText: innerText,
      preheader: subject,
    });
    await sendEmail({ to: ctx.toEmail, subject, text, html });

    logger.info('[long-term-emails] sent', {
      // `email` (not `to`) so the Winston redactor masks the recipient —
      // `to` is not in logger.js REDACT_KEYS and would log in cleartext.
      kind, planId: plan.id, cycleId: cycle?.id || null, email: ctx.toEmail,
    });
    return { sent: true };
  } catch (err) {
    logger.warn('[long-term-emails] send failed', {
      kind, planId: plan?.id, cycleId: cycle?.id || null, message: err.message,
    });
    return { sent: false, reason: err.message };
  }
}
