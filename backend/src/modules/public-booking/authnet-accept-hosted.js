/**
 * Authorize.Net Accept Hosted helpers — pure, no DB or settings
 * dependencies. Used by payment-session.service.js to mint hosted-page
 * tokens for the Flutter car-sharing app. Kept standalone so the unit
 * tests don't have to load prisma.
 */

export const SESSION_TTL_MS = 15 * 60 * 1000;

export const PAYABLE_STATUSES = new Set(['PENDING', 'PARTIAL']);

export function authNetApiUrl(config = {}) {
  const env = String(
    config?.authorizenet?.environment || 'sandbox',
  ).toLowerCase();
  return env === 'production'
    ? 'https://api2.authorize.net/xml/v1/request.api'
    : 'https://apitest.authorize.net/xml/v1/request.api';
}

export function authNetHostedBase(config = {}) {
  const env = String(
    config?.authorizenet?.environment || 'sandbox',
  ).toLowerCase();
  return env === 'production'
    ? 'https://accept.authorize.net/payment/payment'
    : 'https://test.authorize.net/payment/payment';
}

export function authNetEnabled(config = {}) {
  return !!(
    config?.authorizenet?.enabled !== false &&
    config?.authorizenet?.loginId &&
    config?.authorizenet?.transactionKey
  );
}

export function currentGateway(config = {}) {
  const gateway = String(config?.gateway || 'authorizenet').toLowerCase();
  return ['authorizenet', 'stripe', 'square', 'spin'].includes(gateway)
    ? gateway
    : 'authorizenet';
}

export function invoiceNumberValue(value = '') {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 20);
}

export function extractAuthNetMessage(payload = {}) {
  const roots = [payload?.getHostedPaymentPageResponse, payload].filter(
    Boolean,
  );
  for (const root of roots) {
    const direct = root?.messages?.message;
    const list = Array.isArray(direct) ? direct : direct ? [direct] : [];
    const text = list
      .map((item) => String(item?.text || '').trim())
      .find(Boolean);
    if (text) return text;
  }
  return '';
}

async function authNetRequest(
  payload,
  config,
  { fetchImpl = fetch } = {},
) {
  const r = await fetchImpl(authNetApiUrl(config), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const raw = await r.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : {};
  } catch {
    body = { raw };
  }
  return { ok: r.ok, status: r.status, body };
}

export function paidFromPayments(payments = []) {
  if (!Array.isArray(payments)) return 0;
  return payments.reduce((acc, p) => {
    if (!p || p.voided || p.refunded) return acc;
    const amt = Number(p.amount || 0);
    return acc + (Number.isFinite(amt) ? amt : 0);
  }, 0);
}

export function computeAmountDue(reservation) {
  const estimated = Number(reservation?.estimatedTotal || 0);
  const paid = paidFromPayments(reservation?.payments);
  return Math.max(0, Number((estimated - paid).toFixed(2)));
}

/**
 * Throws a tagged error if the reservation can't take a charge.
 * Returns the amount due otherwise.
 */
export function assertPayable(reservation) {
  const status = String(reservation?.paymentStatus || '').toUpperCase();
  if (!PAYABLE_STATUSES.has(status)) {
    if (status === 'PAID') {
      const err = new Error('Trip is already paid');
      err.code = 'ALREADY_PAID';
      throw err;
    }
    const err = new Error(`Trip is not payable (status ${status})`);
    err.code = 'NOT_PAYABLE';
    throw err;
  }
  const resStatus = String(reservation?.status || '').toUpperCase();
  if (resStatus === 'CANCELED' || resStatus === 'CANCELLED') {
    const err = new Error('Trip is cancelled');
    err.code = 'NOT_PAYABLE';
    throw err;
  }
  const due = computeAmountDue(reservation);
  if (due <= 0) {
    const err = new Error('No balance due');
    err.code = 'ALREADY_PAID';
    throw err;
  }
  return due;
}

/**
 * Mint an Accept Hosted token configured for a full-page mobile
 * WebView (not iframe). Uses hostedPaymentReturnOptions to tell
 * Authorize.Net where to redirect after success / cancel.
 *
 * @returns {Promise<string>} hosted token to POST to authNetHostedBase()
 */
export async function mintAcceptHostedToken({
  reservation,
  amount,
  config,
  successMatchUrl,
  cancelMatchUrl,
  deps,
}) {
  const requestPayload = {
    getHostedPaymentPageRequest: {
      merchantAuthentication: {
        name: config.authorizenet.loginId,
        transactionKey: config.authorizenet.transactionKey,
      },
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: Number(Math.max(0.5, Number(amount))).toFixed(2),
        order: {
          invoiceNumber: invoiceNumberValue(
            reservation.reservationNumber || reservation.id,
          ),
        },
      },
      hostedPaymentSettings: {
        setting: [
          {
            settingName: 'hostedPaymentReturnOptions',
            settingValue: JSON.stringify({
              showReceipt: false,
              url: successMatchUrl,
              urlText: 'Return to RideFleet',
              cancelUrl: cancelMatchUrl,
              cancelUrlText: 'Cancel and return',
            }),
          },
          {
            settingName: 'hostedPaymentButtonOptions',
            settingValue: JSON.stringify({ text: 'Pay' }),
          },
          {
            settingName: 'hostedPaymentPaymentOptions',
            settingValue: JSON.stringify({
              showCreditCard: true,
              showBankAccount: false,
              cardCodeRequired: true,
            }),
          },
          {
            settingName: 'hostedPaymentShippingAddressOptions',
            settingValue: JSON.stringify({ show: false, required: false }),
          },
          {
            settingName: 'hostedPaymentBillingAddressOptions',
            settingValue: JSON.stringify({ show: true, required: false }),
          },
          {
            settingName: 'hostedPaymentCustomerOptions',
            settingValue: JSON.stringify({
              showEmail: false,
              requiredEmail: false,
            }),
          },
          {
            settingName: 'hostedPaymentOrderOptions',
            settingValue: JSON.stringify({ show: false }),
          },
        ],
      },
    },
  };

  const response = await authNetRequest(requestPayload, config, deps || {});
  const body = response?.body || {};
  const inner = body?.getHostedPaymentPageResponse || body;
  const hostedToken = inner?.token || body?.token;
  const resultCode = String(
    inner?.messages?.resultCode || body?.messages?.resultCode || '',
  ).trim();
  if (resultCode !== 'Ok' || !hostedToken) {
    const detail = extractAuthNetMessage(body) || 'Authorize.Net token creation failed';
    const err = new Error(detail);
    err.code = 'GATEWAY_ERROR';
    err.gateway = 'authorizenet';
    err.gatewayStatus = response.status;
    throw err;
  }
  return hostedToken;
}

export function renderReturnPage({ status = 'success' } = {}) {
  const copy =
    status === 'cancel'
      ? {
          title: 'Payment cancelled',
          body: 'No charge was made. You can close this page and return to the RideFleet app.',
        }
      : {
          title: 'Payment received',
          body: 'Thanks — you can close this page and return to the RideFleet app.',
        };
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${copy.title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;background:#fafafc;color:#211a38;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#5a5370;font-size:14px;max-width:320px}</style>
</head><body><div><h1>${copy.title}</h1><p>${copy.body}</p></div></body></html>`;
}
