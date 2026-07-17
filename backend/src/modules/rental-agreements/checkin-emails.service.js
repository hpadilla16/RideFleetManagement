/**
 * Pillar 2 — Checkin email service.
 *
 * Two emails, two scenarios:
 *   - sendInvoiceAfterCheckin: balance > 0, status CHECKED_IN_UNPAID,
 *     auto-charge will run in 24h. Includes the "Card ending in XXXX will
 *     be charged" notice.
 *   - sendReceiptPaidInFull: balance = 0 (manual payment or auto-charge
 *     succeeded). Confirmation receipt, no notice.
 *
 * Both reuse the same data-prep pipeline (`buildEmailContext`) to keep the
 * tile rows + line items consistent with the agreement print output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import logger from '../../lib/logger.js';
import { settingsService } from '../settings/settings.service.js';
import { parseLocationConfig } from '../../lib/location-config.js';
import { rentalAgreementsService } from './rental-agreements.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates');

let cachedInvoiceTemplate = null;
let cachedReceiptTemplate = null;

function getInvoiceTemplate() {
  if (!cachedInvoiceTemplate) {
    cachedInvoiceTemplate = fs.readFileSync(path.join(TEMPLATE_DIR, 'invoice-after-checkin.html'), 'utf8');
  }
  return cachedInvoiceTemplate;
}

function getReceiptTemplate() {
  if (!cachedReceiptTemplate) {
    cachedReceiptTemplate = fs.readFileSync(path.join(TEMPLATE_DIR, 'receipt-paid-in-full.html'), 'utf8');
  }
  return cachedReceiptTemplate;
}

// =============================================================================
// Template substitution (mirror of rental-agreements.service.js applyTemplate)
// =============================================================================

function applyTemplate(html, vars = {}) {
  let out = String(html || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v ?? ''));
  }
  return out;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(d) {
  if (!d) return '-';
  const date = new Date(d);
  return date.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function fmtMoney(n) {
  return Number(n || 0).toFixed(2);
}

function fmtPct(n) {
  if (n == null || n === '') return '-';
  return `${Math.round(Number(n) * 100)}%`;
}

function fmtClean(n) {
  if (n == null || n === '') return '-';
  return `${n}/5`;
}

// =============================================================================
// Context builder — shared between both emails
// =============================================================================

async function buildEmailContext({ reservationId, agreementId }) {
  // Load the agreement with everything we need to render
  const agreement = await prisma.rentalAgreement.findUnique({
    where: { id: agreementId },
    include: {
      reservation: {
        include: {
          customer: { select: { id: true, email: true, firstName: true, lastName: true, cardLast4: true, cardBrand: true } },
          pickupLocation: { select: { id: true, name: true, address: true, locationConfig: true } }
        }
      },
      vehicle: { select: { make: true, model: true, year: true, plate: true } },
      charges: { where: { selected: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
    }
  });

  if (!agreement) throw new Error(`Agreement not found: ${agreementId}`);

  const scope = agreement.tenantId ? { tenantId: agreement.tenantId } : {};
  const globalCfg = await settingsService.getRentalAgreementConfig(scope);
  const locCfg = parseLocationConfig(agreement.reservation?.pickupLocation?.locationConfig);

  const companyName = locCfg.companyName || agreement.reservation?.pickupLocation?.name || globalCfg.companyName || 'RideFleet';
  const companyAddress = locCfg.companyAddress || agreement.reservation?.pickupLocation?.address || globalCfg.companyAddress || '';
  const companyPhone = locCfg.companyPhone || globalCfg.companyPhone || '';
  const companyLogoUrl = locCfg.companyLogoUrl || globalCfg.companyLogoUrl || '';
  const companySupportEmail = locCfg.companySupportEmail || globalCfg.companySupportEmail || globalCfg.fromEmail || '';

  // Logo block — inline-styled image or initials fallback (email-client safe)
  const companyLogoBlock = companyLogoUrl
    ? `<img src="${esc(companyLogoUrl)}" alt="${esc(companyName)}" width="36" height="36" style="display:inline-block;width:36px;height:36px;object-fit:contain;border:0;" />`
    : `<span style="display:inline-block;color:#1d1d1f;font-size:14px;font-weight:800;letter-spacing:-0.01em;">${esc(companyInitials(companyName))}</span>`;

  // Charge rows — inline styles only (email-client safe)
  const tdBase = 'padding:10px 14px;font-size:13px;color:#1d1d1f;border-bottom:1px solid #ececf1;vertical-align:top;';
  const tdNum = `${tdBase}text-align:right;font-variant-numeric:tabular-nums;`;
  const chargesRows = (agreement.charges || []).map((c) => {
    return `<tr>
      <td style="${tdBase}">${esc(c.name)}</td>
      <td style="${tdNum}">${Number(c.quantity || 0).toFixed(2)}</td>
      <td style="${tdNum}">$${fmtMoney(c.rate)}</td>
      <td style="${tdNum}">$${fmtMoney(c.total)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" style="${tdBase}text-align:center;color:#6e6e73;">No charges recorded</td></tr>`;

  // Mileage
  const odoOut = Number(agreement.odometerOut || 0);
  const odoIn = Number(agreement.odometerIn || 0);
  const milesDriven = odoIn > odoOut ? (odoIn - odoOut).toLocaleString() : '-';

  // Vehicle
  const v = agreement.vehicle;
  const vehicleDesc = v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '-';

  // Smoking — look at engine-computed charges
  const smokingCharge = (agreement.charges || []).find(
    (c) => String(c.sourceRefId || '').toUpperCase() === 'SMOKING'
  );
  const smokingDisplay = smokingCharge ? 'Detected' : 'None';

  // Customer
  const customer = agreement.reservation?.customer;
  const customerFirstName = customer?.firstName || agreement.customerFirstName || 'Customer';
  const customerEmail = customer?.email || agreement.customerEmail || null;

  // Card metadata for the notice
  const cardLast4 = customer?.cardLast4 || '????';
  const cardBrand = customer?.cardBrand || 'Card';

  return {
    // Recipient
    customerEmail,
    // Surface the agreement number for the attachment filename
    agreementNumber: agreement.agreementNumber || agreement.id,
    // Template vars
    vars: {
      companyName: esc(companyName),
      companyAddress: esc(companyAddress),
      companyPhone: esc(companyPhone),
      companyLogoBlock,
      companySupportEmail: esc(companySupportEmail),

      reservationNumber: esc(agreement.reservation?.reservationNumber || agreement.agreementNumber || '-'),
      agreementNumber: esc(agreement.agreementNumber || '-'),

      customerFirstName: esc(customerFirstName),

      vehicleDesc: esc(vehicleDesc),
      returnAt: esc(fmtDate(agreement.returnAt)),
      milesDriven: esc(milesDriven),
      fuelOut: esc(fmtPct(agreement.fuelOut)),
      fuelIn: esc(fmtPct(agreement.fuelIn)),
      cleanlinessOut: esc(fmtClean(agreement.cleanlinessOut)),
      cleanlinessIn: esc(fmtClean(agreement.cleanlinessIn)),
      smokingDisplay: esc(smokingDisplay),

      chargesRows,
      subtotal: fmtMoney(agreement.subtotal),
      taxesAmount: fmtMoney(agreement.taxes),
      feesAmount: fmtMoney(agreement.fees),
      total: fmtMoney(agreement.total),
      amountPaid: fmtMoney(agreement.paidAmount),
      balance: fmtMoney(agreement.balance),

      cardLast4: esc(cardLast4),
      cardBrand: esc(cardBrand),

      invoiceGeneratedAt: esc(fmtDate(new Date())),
      receiptGeneratedAt: esc(fmtDate(new Date()))
    }
  };
}

function companyInitials(name) {
  return String(name || '')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase() || 'RF';
}

// =============================================================================
// PDF rendering — reuses rentalAgreementsService.agreementPdfBuffer which
// already (a) renders via the singleton Puppeteer/Chromium, (b) respects
// tenant scope via the agreementId lookup, (c) handles the prod
// PUPPETEER_EXECUTABLE_PATH wiring. We swallow failures here so a Chrome
// hiccup never blocks the customer's invoice/receipt email — they still
// receive the email, just without the PDF attachment.
// =============================================================================

async function renderAgreementPdf(agreementId) {
  try {
    const buf = await rentalAgreementsService.agreementPdfBuffer(agreementId);
    if (!buf || !buf.length) {
      logger.warn('[checkin-emails] agreementPdfBuffer returned empty buffer', { agreementId });
      return null;
    }
    return buf;
  } catch (err) {
    logger.warn('[checkin-emails] agreement PDF render failed; sending email without attachment', {
      agreementId,
      error: err?.message || String(err)
    });
    return null;
  }
}

function buildAttachments(pdfBuffer, agreementNumber) {
  if (!pdfBuffer) return undefined;
  const safeName = String(agreementNumber || 'agreement').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return [{
    filename: `Agreement-${safeName}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf'
  }];
}

// =============================================================================
// Public API
// =============================================================================

export async function sendInvoiceAfterCheckin({ reservationId, agreementId }) {
  const { customerEmail, vars, agreementNumber } = await buildEmailContext({ reservationId, agreementId });
  if (!customerEmail) {
    logger.warn('[checkin-emails] no customer email — invoice not sent', { reservationId, agreementId });
    return { sent: false, reason: 'no_email' };
  }

  const html = applyTemplate(getInvoiceTemplate(), vars);
  const subject = `Invoice for your rental — ${vars.companyName} — ${vars.reservationNumber}`;
  const text = stripHtml(html);

  const pdfBuffer = await renderAgreementPdf(agreementId);
  const attachments = buildAttachments(pdfBuffer, agreementNumber);

  await sendEmail({ to: customerEmail, subject, html, text, attachments });
  logger.info('[checkin-emails] invoice sent', {
    reservationId, agreementId, email: customerEmail, withPdf: Boolean(pdfBuffer)
  });
  return { sent: true, withPdf: Boolean(pdfBuffer) };
}

export async function sendReceiptPaidInFull({ reservationId, agreementId }) {
  const { customerEmail, vars, agreementNumber } = await buildEmailContext({ reservationId, agreementId });
  if (!customerEmail) {
    logger.warn('[checkin-emails] no customer email — receipt not sent', { reservationId, agreementId });
    return { sent: false, reason: 'no_email' };
  }

  const html = applyTemplate(getReceiptTemplate(), vars);
  const subject = `Thanks for renting with ${vars.companyName} — Receipt ${vars.reservationNumber}`;
  const text = stripHtml(html);

  const pdfBuffer = await renderAgreementPdf(agreementId);
  const attachments = buildAttachments(pdfBuffer, agreementNumber);

  await sendEmail({ to: customerEmail, subject, html, text, attachments });
  logger.info('[checkin-emails] receipt sent', {
    reservationId, agreementId, email: customerEmail, withPdf: Boolean(pdfBuffer)
  });
  return { sent: true, withPdf: Boolean(pdfBuffer) };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}
