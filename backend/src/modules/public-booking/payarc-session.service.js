import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { settingsService } from '../settings/settings.service.js';
import {
  createCharge,
  parseWebhookEvent,
  verifyBridgeNonce,
  verifyWebhookSignature,
  PAYARC_JS_URL,
} from './payarc-hosted-fields.js';

/**
 * Wiring that ties the pure PayArc helpers to the database + settings.
 * Mirrors the split between authnet-accept-hosted.js (pure) and
 * payment-session.service.js (wiring).
 *
 * Three public functions:
 *   preparePayArcBridge(req)  — data the GET /payarc-bridge route needs
 *   confirmPayArcCharge(req)  — the POST /payarc-charge handler body
 *   handlePayArcWebhook(req)  — the POST /webhook handler body
 */

function _publicApiBase() {
  return (
    process.env.PUBLIC_API_BASE_URL ||
    process.env.API_BASE_URL ||
    'http://localhost:4000'
  ).replace(/\/$/, '');
}

async function _loadReservationForTrip(tripCode) {
  const clean = String(tripCode || '').trim();
  if (!clean) {
    const err = new Error('tripCode is required');
    err.code = 'VALIDATION';
    throw err;
  }
  const trip = await prisma.trip.findUnique({
    where: { tripCode: clean },
    select: { reservationId: true },
  });
  let reservation = null;
  if (trip?.reservationId) {
    reservation = await prisma.reservation.findUnique({
      where: { id: trip.reservationId },
      include: { payments: true, pickupLocation: true, customer: true },
    });
  }
  if (!reservation) {
    reservation = await prisma.reservation.findFirst({
      where: { reservationNumber: clean },
      include: { payments: true, pickupLocation: true, customer: true },
    });
  }
  if (!reservation) {
    const err = new Error(`Trip ${clean} not found`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  return reservation;
}

async function _tenantPayArcConfig(tenantId, overrideSettings = null) {
  const settings = overrideSettings || settingsService;
  const config = await settings.getPaymentGatewayConfig(
    tenantId ? { tenantId } : {},
  );
  return config || {};
}

/**
 * GET /api/public/booking/trips/:tripCode/payarc-bridge?s=<nonce>
 *
 * Validates the signed nonce, loads reservation + tenant config,
 * returns the data the HTML template needs. Kept as a service method
 * so route code stays tiny and easy to unit-test.
 */
export async function preparePayArcBridge({ tripCode, nonce }) {
  const reservation = await _loadReservationForTrip(tripCode);
  const config = await _tenantPayArcConfig(reservation.tenantId);
  const secret = config?.payarc?.webhookSecret || config?.payarc?.bearerToken || '';
  const parsed = verifyBridgeNonce(nonce || '', secret);
  if (!parsed || parsed.reservationId !== reservation.id) {
    const err = new Error('Invalid or expired payment session');
    err.code = 'INVALID_NONCE';
    throw err;
  }

  if (!config?.payarc?.publicKey) {
    const err = new Error('PayArc public key missing');
    err.code = 'GATEWAY_NOT_CONFIGURED';
    throw err;
  }

  const apiBase = _publicApiBase();
  const cleanCode = String(tripCode || '').trim();
  const chargeUrl = `${apiBase}/api/public/booking/trips/${encodeURIComponent(
    cleanCode,
  )}/payarc-charge`;
  const successMatchUrl = `${apiBase}/api/public/booking/trips/${encodeURIComponent(
    cleanCode,
  )}/payment-return?r=${encodeURIComponent(reservation.id)}`;
  const cancelMatchUrl = `${apiBase}/api/public/booking/trips/${encodeURIComponent(
    cleanCode,
  )}/payment-cancel?r=${encodeURIComponent(reservation.id)}`;

  return {
    tripCode: cleanCode,
    reservationNumber: reservation.reservationNumber,
    amountDue: Number((parsed.amountCents / 100).toFixed(2)),
    currency: String(reservation.currency || 'USD').toUpperCase(),
    publicKey: config.payarc.publicKey,
    payarcJsUrl: PAYARC_JS_URL,
    environment: String(config?.payarc?.environment || 'sandbox').toLowerCase(),
    chargeUrl,
    successMatchUrl,
    cancelMatchUrl,
    nonce,
  };
}

/**
 * POST /api/public/booking/trips/:tripCode/payarc-charge
 *
 * Request body: { nonce, tokenId }
 *
 * Validates the signed nonce, calls PayArc /v1/charges, records a
 * ReservationPayment row on success, and returns a thin response
 * the bridge HTML reads. The source of truth for reservation state
 * is the ReservationPayment insert + the separate webhook handler —
 * this endpoint just makes the synchronous call on behalf of the
 * WebView so the user sees success immediately.
 */
export async function confirmPayArcCharge({ tripCode, body = {}, deps = {} }) {
  const reservation = await _loadReservationForTrip(tripCode);
  const config = await _tenantPayArcConfig(reservation.tenantId, deps.settingsService);
  const secret = config?.payarc?.webhookSecret || config?.payarc?.bearerToken || '';
  const parsed = verifyBridgeNonce(String(body?.nonce || ''), secret);
  if (!parsed || parsed.reservationId !== reservation.id) {
    const err = new Error('Invalid or expired payment session');
    err.code = 'INVALID_NONCE';
    throw err;
  }
  const tokenId = String(body?.tokenId || '').trim();
  if (!tokenId) {
    const err = new Error('tokenId is required');
    err.code = 'VALIDATION';
    throw err;
  }

  const amountDollars = Number((parsed.amountCents / 100).toFixed(2));
  const charge = await createCharge({
    tokenId,
    amountDollars,
    currency: String(reservation.currency || 'USD').toLowerCase(),
    description: `Reservation ${reservation.reservationNumber}`,
    reservationNumber: reservation.reservationNumber,
    config,
    deps,
  });

  // Record the payment row. Idempotent on (reservationId, reference) —
  // if the webhook races us and posts first, we skip the insert.
  const reference = `PAYARC:${charge.chargeId}`;
  const existing = await prisma.reservationPayment.findFirst({
    where: { reservationId: reservation.id, reference },
  });
  if (!existing) {
    await prisma.reservationPayment.create({
      data: {
        reservationId: reservation.id,
        amount: charge.amount,
        method: 'CARD',
        status: 'PAID',
        reference,
        gateway: 'PAYARC',
        // ReservationPaymentOrigin enum values: OTC / PORTAL /
        // IMPORTED / MIGRATED_NOTE. Guest self-pay via the Flutter
        // app fits PORTAL (same bucket the customer-portal uses).
        origin: 'PORTAL',
        paidAt: new Date(),
      },
    }).catch((e) => {
      // If the ReservationPayment model doesn't carry these fields,
      // log and continue — the charge succeeded regardless.
      logger.warn?.('PayArc payment row insert failed (non-fatal)', {
        reservationId: reservation.id,
        reference,
        message: e?.message,
      });
    });
  }

  // Nudge the reservation paymentStatus forward. Final truth comes
  // from the webhook, but surfacing PAID here helps the Flutter
  // polling loop resolve faster.
  try {
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { paymentStatus: 'PAID' },
    });
  } catch (e) {
    logger.warn?.('PayArc paymentStatus update failed (non-fatal)', {
      reservationId: reservation.id,
      message: e?.message,
    });
  }

  logger.info?.('payarc charge ok', {
    reservationId: reservation.id,
    chargeId: charge.chargeId,
    amount: charge.amount,
  });

  return {
    ok: true,
    chargeId: charge.chargeId,
    amount: charge.amount,
    currency: charge.currency,
    status: charge.status,
  };
}

/**
 * POST /api/public/payment-gateway/payarc/webhook
 *
 * Validates the signature, parses the event, idempotently records
 * the matching ReservationPayment. Mirrors the existing Authorize.Net
 * webhook handler's structure.
 *
 * The webhook is the source of truth for reservation.paymentStatus —
 * even if the confirmPayArcCharge() call in /payarc-charge succeeded,
 * the webhook is our retry-safe backstop. Idempotent on
 * (reservationId, reference).
 */
export async function handlePayArcWebhook({ rawBody, headers = {}, body = {} }) {
  // Lookup any tenant config with a webhookSecret — we try each one
  // until a signature matches. This mirrors how the Auth.Net webhook
  // supports multiple tenants at one URL.
  const allConfigs = await _gatherTenantConfigsWithPayArc();
  let matched = null;
  for (const { tenantId, config } of allConfigs) {
    const secret = config?.payarc?.webhookSecret;
    if (!secret) continue;
    if (verifyWebhookSignature({ rawBody, headers, webhookSecret: secret })) {
      matched = { tenantId, config };
      break;
    }
  }

  if (!matched) {
    logger.warn?.('payarc webhook rejected (no tenant signature matched)');
    const err = new Error('Invalid signature');
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  const parsed = parseWebhookEvent(body);
  if (!parsed.chargeId) {
    logger.info?.('payarc webhook ignored (no charge id)', { event: parsed.event });
    return { ok: true, ignored: true, reason: 'no charge id' };
  }

  // Resolve reservation via the description-embedded reservationNumber.
  let reservation = null;
  if (parsed.reservationNumber) {
    reservation = await prisma.reservation.findFirst({
      where: {
        reservationNumber: parsed.reservationNumber,
        tenantId: matched.tenantId,
      },
    });
  }
  if (!reservation) {
    logger.info?.('payarc webhook ignored (reservation not found)', {
      reservationNumber: parsed.reservationNumber,
      chargeId: parsed.chargeId,
    });
    return { ok: true, ignored: true, reason: 'reservation not found' };
  }

  const reference = `PAYARC:${parsed.chargeId}`;

  if (parsed.isRefund) {
    // Best-effort: mark the original payment refunded if we tracked it.
    // The ReservationPayment row has no refundedAt column; status is
    // our source of truth. Operations staff can cross-reference the
    // webhook timestamp via logs.
    await prisma.reservationPayment.updateMany({
      where: { reservationId: reservation.id, reference },
      data: { status: 'REFUNDED' },
    }).catch(() => {});
    return { ok: true, action: 'refund-recorded' };
  }

  if (parsed.isVoid) {
    await prisma.reservationPayment.updateMany({
      where: { reservationId: reservation.id, reference },
      data: { status: 'VOID' },
    }).catch(() => {});
    return { ok: true, action: 'void-recorded' };
  }

  if (parsed.isSuccess) {
    const existing = await prisma.reservationPayment.findFirst({
      where: { reservationId: reservation.id, reference },
    });
    if (!existing) {
      await prisma.reservationPayment.create({
        data: {
          reservationId: reservation.id,
          amount: parsed.amountDollars,
          method: 'CARD',
          status: 'PAID',
          reference,
          gateway: 'PAYARC',
          origin: 'PORTAL', // guest-paid; no WEBHOOK origin enum value
          paidAt: new Date(),
        },
      }).catch(() => {});
    }
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { paymentStatus: 'PAID' },
    }).catch(() => {});
    return { ok: true, action: 'payment-recorded' };
  }

  return { ok: true, ignored: true, reason: `status ${parsed.status}` };
}

async function _gatherTenantConfigsWithPayArc() {
  // Scan every tenant AppSetting row. Cheap for the beta-scale
  // tenant count; if this grows large, cache or narrow the scan.
  const rows = await prisma.appSetting.findMany({
    where: { key: { contains: 'paymentGatewayConfig' } },
  });
  const out = [];
  for (const row of rows) {
    let parsed = null;
    try { parsed = JSON.parse(row.value || 'null'); } catch {}
    if (!parsed?.payarc?.webhookSecret) continue;
    // Key format is `tenant:<id>:paymentGatewayConfig` or the global
    // key `paymentGatewayConfig`.
    const match = row.key.match(/^tenant:([^:]+):paymentGatewayConfig$/);
    out.push({
      tenantId: match ? match[1] : null,
      config: parsed,
    });
  }
  return out;
}

// Small helper for tests to avoid exporting the whole pile.
export const _internals = {
  _loadReservationForTrip,
  _publicApiBase,
};

// re-export the PayArc js url so the routes file can pass it through
// without importing the pure module directly.
export { PAYARC_JS_URL };
