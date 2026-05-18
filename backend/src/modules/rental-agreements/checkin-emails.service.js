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

  const companyLogoBlock = companyLogoUrl
    ? `<img src="${esc(companyLogoUrl)}" alt="${esc(companyName)}" />`
    : `<div class="logo-fallback">${esc(companyInitials(companyName))}</div>`;

  // Charge rows
  const chargesRows = (agreement.charges || []).map((c) => {
    return `<tr>
      <td>${esc(c.name)}</td>
      <td class="num">${Number(c.quantity || 0).toFixed(2)}</td>
      <td class="num">$${fmtMoney(c.rate)}</td>
      <td class="num">$${fmtMoney(c.total)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4">No charges recorded</td></tr>';

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

  // Agreement URL — public token if available, otherwise fallback to internal print
  const baseUrl = process.env.PUBLIC_PORTAL_BASE_URL || process.env.PUBLIC_BASE_URL || '';
  const agreementUrl = baseUrl
    ? `${baseUrl.replace(/\/$/, '')}/agreements/${agreement.id}/print`
    : `/agreements/${agreement.id}/print`;

  return {
    // Recipient
    customerEmail,
    // Template vars
    vars: {
      companyName: esc(companyName),
      companyAddress: esc(companyAddress),
      companyPhone: esc(companyPhone),
      companyLogoBlock,
      companySupportEmail: esc(companySupportEmail),

      reservationNumber: esc(agreement.reservation?.reservationNumber || agreement.agreementNumber || '-'),
      agreementNumber: esc(agreement.agreementNumber || '-'),
      agreementUrl: esc(agreementUrl),

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
// Public API
// =============================================================================

export async function sendInvoiceAfterCheckin({ reservationId, agreementId }) {
  const { customerEmail, vars } = await buildEmailContext({ reservationId, agreementId });
  if (!customerEmail) {
    logger.warn('[checkin-emails] no customer email — invoice not sent', { reservationId, agreementId });
    return { sent: false, reason: 'no_email' };
  }

  const html = applyTemplate(getInvoiceTemplate(), vars);
  const subject = `Invoice for your rental — ${vars.companyName} — ${vars.reservationNumber}`;
  const text = stripHtml(html);

  await sendEmail({ to: customerEmail, subject, html, text });
  logger.info('[checkin-emails] invoice sent', { reservationId, agreementId, to: customerEmail });
  return { sent: true };
}

export async function sendReceiptPaidInFull({ reservationId, agreementId }) {
  const { customerEmail, vars } = await buildEmailContext({ reservationId, agreementId });
  if (!customerEmail) {
    logger.warn('[checkin-emails] no customer email — receipt not sent', { reservationId, agreementId });
    return { sent: false, reason: 'no_email' };
  }

  const html = applyTemplate(getReceiptTemplate(), vars);
  const subject = `Thanks for renting with ${vars.companyName} — Receipt ${vars.reservationNumber}`;
  const text = stripHtml(html);

  await sendEmail({ to: customerEmail, subject, html, text });
  logger.info('[checkin-emails] receipt sent', { reservationId, agreementId, to: customerEmail });
  return { sent: true };
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
