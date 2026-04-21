import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { settingsService } from '../settings/settings.service.js';
import {
  SESSION_TTL_MS,
  assertPayable,
  authNetEnabled,
  authNetHostedBase,
  currentGateway,
  mintAcceptHostedToken,
  renderReturnPage as _renderReturnPage,
} from './authnet-accept-hosted.js';

/**
 * Gateway-agnostic guest payment session minting for the Flutter
 * car-sharing app. Today backed by Authorize.Net Accept Hosted; when
 * we flip the same tenant to SPIn for online payments, ONLY this
 * module changes — the Flutter app receives the same neutral response
 * shape: { checkoutUrl, checkoutMethod, checkoutFields, successMatchUrl,
 * cancelMatchUrl, gateway, expiresAt }.
 *
 * The counterpart helpers in customer-portal.routes.js drive the web
 * guest portal where the hosted page is iframed. Mobile cannot embed
 * an iframe inside a native WebView cleanly (X-Frame-Options blocks
 * + postMessage plumbing is fragile), so this module renders a full
 * Accept Hosted redirect flow with hostedPaymentReturnOptions pointing
 * at an HTTPS success URL the Flutter WebView watches for.
 *
 * Payment *posting* is unchanged — Authorize.Net fires the silent
 * webhook at /api/public/payment-gateway/authorizenet/webhook and the
 * customer-portal webhook handler marks the reservation paid. The
 * redirect here is pure UX (close the WebView, deep-link back into
 * the Flutter app).
 */

function _publicApiBase() {
  return (
    process.env.PUBLIC_API_BASE_URL ||
    process.env.API_BASE_URL ||
    'http://localhost:4000'
  ).replace(/\/$/, '');
}

async function _findReservationForPayment(tripCode, tenantId) {
  const clean = String(tripCode || '').trim();
  if (!clean) {
    const err = new Error('tripCode is required');
    err.code = 'VALIDATION';
    throw err;
  }
  let reservation = null;
  const trip = await prisma.trip.findUnique({
    where: { tripCode: clean },
    select: { reservationId: true },
  });
  if (trip?.reservationId) {
    reservation = await prisma.reservation.findUnique({
      where: { id: trip.reservationId },
      include: { payments: true },
    });
  }
  if (!reservation) {
    reservation = await prisma.reservation.findFirst({
      where: { reservationNumber: clean },
      include: { payments: true },
    });
  }
  if (!reservation) {
    const err = new Error(`Trip ${clean} not found`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (tenantId && reservation.tenantId && reservation.tenantId !== tenantId) {
    const err = new Error(`Trip ${clean} not found`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  return reservation;
}

/**
 * Create a payment session for a guest-facing trip.
 *
 * @param {object} opts
 * @param {string} opts.tripCode  car-sharing Trip.tripCode (e.g. RF-7251)
 * @param {string|null} opts.tenantId  if the request carried a tenant hint, verify the reservation belongs to it
 * @param {object} [opts.deps]  seam for tests: { fetchImpl, settingsService, now, prisma }
 * @returns {Promise<{checkoutUrl, checkoutMethod, checkoutFields, successMatchUrl, cancelMatchUrl, gateway, expiresAt, amountDue, currency}>}
 */
export async function createGuestPaymentSession({
  tripCode,
  tenantId = null,
  deps = {},
} = {}) {
  const reservation = await _findReservationForPayment(tripCode, tenantId);
  const amountDue = assertPayable(reservation);

  const settings = deps.settingsService || settingsService;
  const config = await settings.getPaymentGatewayConfig(
    reservation.tenantId ? { tenantId: reservation.tenantId } : {},
  );
  const gateway = currentGateway(config || {});

  const apiBase = _publicApiBase();
  const cleanCode = String(tripCode || '').trim();
  const successMatchUrl = `${apiBase}/api/public/booking/trips/${encodeURIComponent(
    cleanCode,
  )}/payment-return?r=${encodeURIComponent(reservation.id)}`;
  const cancelMatchUrl = `${apiBase}/api/public/booking/trips/${encodeURIComponent(
    cleanCode,
  )}/payment-cancel?r=${encodeURIComponent(reservation.id)}`;

  const now = deps.now instanceof Date ? deps.now : new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  if (gateway === 'authorizenet') {
    if (!authNetEnabled(config || {})) {
      const err = new Error('Authorize.Net is not configured for this tenant');
      err.code = 'GATEWAY_NOT_CONFIGURED';
      throw err;
    }
    const hostedToken = await mintAcceptHostedToken({
      reservation,
      amount: amountDue,
      config,
      successMatchUrl,
      cancelMatchUrl,
      deps,
    });
    logger.info?.('payment-session minted', {
      tripCode,
      reservationId: reservation.id,
      gateway,
      amount: amountDue,
    });
    return {
      checkoutUrl: authNetHostedBase(config),
      checkoutMethod: 'POST',
      checkoutFields: { token: hostedToken },
      successMatchUrl,
      cancelMatchUrl,
      gateway: 'authorizenet',
      expiresAt,
      amountDue,
      currency: String(reservation.currency || 'USD').toUpperCase(),
    };
  }

  if (gateway === 'spin') {
    // Phase-2 flip lands here. Today the SPIn client is terminal-only
    // (spin-client.js `sale` assumes physical card presentment) and
    // can't serve a self-serve online flow. When online-SPIn ships,
    // swap the body of this branch; the Flutter response contract
    // does NOT change.
    const err = new Error('SPIn online gateway is not yet available');
    err.code = 'GATEWAY_NOT_CONFIGURED';
    throw err;
  }

  const err = new Error(`Unsupported gateway: ${gateway}`);
  err.code = 'GATEWAY_NOT_CONFIGURED';
  throw err;
}

// Re-exported from authnet-accept-hosted so routes don't need to know
// where the helper lives.
export const renderReturnPage = _renderReturnPage;
