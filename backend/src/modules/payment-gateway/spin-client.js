import logger from '../../lib/logger.js';

/**
 * SPIn/iPOSPays REST API client.
 *
 * Docs: https://docs.ipospays.com/spin-specification
 * REST API: https://app.theneo.io/dejavoo/spin/spin-rest-api-methods
 *
 * Production: https://api.spinpos.net
 * Sandbox:    https://test.spinpos.net/spin
 */

const SPIN_PRODUCTION_URL = 'https://api.spinpos.net';
const SPIN_SANDBOX_URL = 'https://test.spinpos.net/spin';

function getConfig(tenantConfig = {}) {
  const useSandbox = tenantConfig.spinSandbox !== false && process.env.SPIN_SANDBOX !== 'false';
  return {
    baseUrl: useSandbox ? SPIN_SANDBOX_URL : SPIN_PRODUCTION_URL,
    authKey: tenantConfig.spinAuthKey || process.env.SPIN_AUTH_KEY || '',
    tpn: tenantConfig.spinTpn || process.env.SPIN_TPN || '',
    merchantNumber: tenantConfig.spinMerchantNumber ? Number(tenantConfig.spinMerchantNumber) : 1,
    callbackUrl: tenantConfig.spinCallbackUrl || process.env.SPIN_CALLBACK_URL || '',
    proxyTimeout: Number(tenantConfig.spinProxyTimeout || process.env.SPIN_PROXY_TIMEOUT || 120),
    sandbox: useSandbox,
  };
}

async function spinRequest(method, path, body, tenantConfig = {}) {
  const config = getConfig(tenantConfig);
  if (!config.authKey) throw new Error('SPIn authKey is not configured');
  if (!config.tpn) throw new Error('SPIn terminal TPN is not configured');

  const url = `${config.baseUrl}/${path}`;
  const payload = {
    Authkey: config.authKey,
    Tpn: config.tpn,
    MerchantNumber: config.merchantNumber,
    SPInProxyTimeout: config.proxyTimeout,
    ...body,
  };

  if (config.callbackUrl && !payload.CallbackInfo) {
    payload.CallbackInfo = { Url: config.callbackUrl };
  }

  logger.info(`SPIn API ${method} ${path}`, { spinPath: path, sandbox: config.sandbox });

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method !== 'GET' ? JSON.stringify(payload) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok || data?.GeneralResponse?.ResultCode !== 0) {
    const code = data?.GeneralResponse?.StatusCode || res.status;
    const msg = data?.GeneralResponse?.Message || data?.GeneralResponse?.DetailedMessage || `SPIn request failed (${code})`;
    logger.warn(`SPIn API error: ${msg}`, { spinPath: path, statusCode: code, resultCode: data?.GeneralResponse?.ResultCode });
    const err = new Error(msg);
    err.spinStatusCode = code;
    err.spinResponse = data;
    throw err;
  }

  return data;
}

export const spinClient = {
  /**
   * Process a sale (charge).
   */
  async sale({ amount, referenceId, paymentType = 'Credit', tipAmount, invoiceNumber, cart, customFields }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Sale', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      ...(tipAmount ? { TipAmount: Number(tipAmount) } : {}),
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      ...(cart ? { Cart: cart } : {}),
      ...(customFields ? { CustomFields: customFields } : {}),
      CaptureSignature: false,
      GetExtendedData: true,
    }, tenantConfig);
  },

  /**
   * Authorize only (hold funds, capture later).
   */
  async auth({ amount, referenceId, paymentType = 'Credit', invoiceNumber }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Auth', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      GetExtendedData: true,
    }, tenantConfig);
  },

  /**
   * Capture a previously authorized transaction.
   */
  async capture({ referenceId, amount }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Capture', {
      ReferenceId: String(referenceId).slice(0, 50),
      ...(amount ? { Amount: Number(amount) } : {}),
    }, tenantConfig);
  },

  /**
   * Void a transaction.
   */
  async void({ referenceId }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Void', {
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * Process a return/refund.
   */
  async refund({ amount, referenceId, paymentType = 'Credit' }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Return', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * Tip adjust on an existing transaction.
   */
  async tipAdjust({ referenceId, tipAmount }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/TipAdjust', {
      ReferenceId: String(referenceId).slice(0, 50),
      TipAmount: Number(tipAmount),
    }, tenantConfig);
  },

  /**
   * Get card token without charging (for card-on-file).
   */
  async getCard({ referenceId }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/GetCard', {
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * Check card balance (gift/EBT).
   */
  async balance({ referenceId, paymentType = 'Gift' }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Balance', {
      ReferenceId: String(referenceId).slice(0, 50),
      PaymentType: paymentType,
    }, tenantConfig);
  },

  /**
   * Get transaction status.
   */
  async status({ referenceId }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Status', {
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * Settle/batch close.
   */
  async settle(tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Settle', {}, tenantConfig);
  },

  /**
   * Check terminal connection status.
   */
  async terminalStatus(tenantConfig) {
    const config = getConfig(tenantConfig);
    const url = `${config.baseUrl}/v2/Common/TerminalStatus?request.tpn=${encodeURIComponent(config.tpn)}&request.authkey=${encodeURIComponent(config.authKey)}`;
    const res = await fetch(url);
    return res.json();
  },

  /**
   * Summary report.
   */
  async summaryReport(tenantConfig) {
    return spinRequest('POST', 'v2/Report/Summary', {}, tenantConfig);
  },

  /**
   * Abort current terminal transaction.
   */
  async abort(tenantConfig) {
    return spinRequest('POST', 'v2/Payment/AbortTransaction', {}, tenantConfig);
  },

  /**
   * Parse a SPIn response into a normalized payment result.
   */
  normalizeResponse(spinResponse) {
    return {
      approved: spinResponse?.GeneralResponse?.StatusCode === '0000',
      statusCode: spinResponse?.GeneralResponse?.StatusCode || '',
      message: spinResponse?.GeneralResponse?.Message || '',
      detailedMessage: spinResponse?.GeneralResponse?.DetailedMessage || '',
      authCode: spinResponse?.AuthCode || '',
      referenceId: spinResponse?.ReferenceId || '',
      token: spinResponse?.Token || '',
      iposToken: spinResponse?.IPosToken || '',
      cardData: spinResponse?.CardData ? {
        cardType: spinResponse.CardData.CardType || '',
        entryType: spinResponse.CardData.EntryType || '',
        last4: spinResponse.CardData.Last4 || '',
        first4: spinResponse.CardData.First4 || '',
        bin: spinResponse.CardData.BIN || '',
        expiration: spinResponse.CardData.ExpirationDate || '',
        name: spinResponse.CardData.Name || '',
      } : null,
      batchNumber: spinResponse?.BatchNumber || '',
      serialNumber: spinResponse?.SerialNumber || '',
      paymentType: spinResponse?.PaymentType || '',
      transactionType: spinResponse?.TransactionType || '',
    };
  },

  // =========================================================================
  // Interactive T&C + Dejavoo P1 unified (2026-05-21)
  //
  // Methods below drive the terminal screen for the counter signing flow.
  // The terminal is reached via the Dejavoo cloud (api.spinpos.net) by TPN —
  // we never touch LAN. These are all POST requests with the same
  // { Authkey, Tpn, MerchantNumber, ReferenceId, ... } envelope.
  // =========================================================================

  /**
   * Display arbitrary text on the terminal screen and wait for the customer
   * to acknowledge (Continue / Cancel). Used to show T&C sections before
   * each initial prompt.
   */
  async disclaimer({ text, title, referenceId }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Disclaimer', {
      Text: String(text || '').slice(0, 6000),
      Title: title || 'Acuerdo de Renta',
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * Capture a signature from the terminal screen. Response includes
   * SignatureData as a base64 PNG.
   */
  async getSignature({ promptText, referenceId }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/GetSignature', {
      PromptText: String(promptText || 'Please sign').slice(0, 200),
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * Ask the customer a multiple-choice question on the terminal screen.
   * Returns SelectedChoice in the response.
   */
  async userChoice({ prompt, choices, referenceId }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/UserChoice', {
      PromptText: String(prompt || '').slice(0, 200),
      Choices: Array.isArray(choices) ? choices : ['Sí', 'No'],
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * Collect free-form text input from the customer on the terminal.
   * Returns UserInput in the response.
   */
  async userInput({ prompt, referenceId }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/UserInput', {
      PromptText: String(prompt || '').slice(0, 200),
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * Display an itemized cart on the terminal screen (Items + Total).
   * Read-only display — does NOT charge. Used to show line items before
   * the customer confirms the sale.
   *
   * items: [{ Name, Quantity, UnitPrice, Total }]
   */
  async cart({ items, total, referenceId }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Cart', {
      Items: Array.isArray(items) ? items : [],
      Total: typeof total === 'number' ? total : 0,
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * AutoRental Sale — same as Sale but with car-rental-specific RentalData
   * + Cart + Level3 fields that drive chargeback evidence and Level 3
   * interchange discount.
   */
  async autoRentalSale({
    amount,
    referenceId,
    paymentType = 'Credit',
    invoiceNumber,
    rentalData,
    cart,
    level3,
    customFields,
  }, tenantConfig) {
    return spinRequest('POST', 'v2/AutoRental/Sale', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      ...(rentalData ? { RentalData: rentalData } : {}),
      ...(cart ? { Cart: cart } : {}),
      ...(level3 ? { Level3: level3 } : {}),
      ...(customFields ? { CustomFields: customFields } : {}),
      CaptureSignature: true,
      GetExtendedData: true,
    }, tenantConfig);
  },

  /**
   * AutoRental Auth — pre-auth hold (security deposit) with rental fields.
   */
  async autoRentalAuth({
    amount,
    referenceId,
    paymentType = 'Credit',
    invoiceNumber,
    rentalData,
    customFields,
  }, tenantConfig) {
    return spinRequest('POST', 'v2/AutoRental/Auth', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      ...(rentalData ? { RentalData: rentalData } : {}),
      ...(customFields ? { CustomFields: customFields } : {}),
      CaptureSignature: true,
      GetExtendedData: true,
    }, tenantConfig);
  },

  /**
   * AutoRental Capture — settle a previous AutoRental Auth. Optional
   * amount lets us partial-capture (release remainder back to the customer).
   */
  async autoRentalCapture({ referenceId, amount, rentalData }, tenantConfig) {
    return spinRequest('POST', 'v2/AutoRental/Capture', {
      ReferenceId: String(referenceId).slice(0, 50),
      ...(amount ? { Amount: Number(amount) } : {}),
      ...(rentalData ? { RentalData: rentalData } : {}),
    }, tenantConfig);
  },

  /**
   * Sale using a previously-captured IPosToken (card-not-present).
   * Used for post-rental charges (tolls, late fees, damage assessments)
   * where the customer has already left + their card was tokenized during
   * the prior AUTH/SALE.
   *
   * The Dejavoo SPIn API accepts an IPosToken field on the Sale endpoint
   * to signal "use the saved token instead of prompting the terminal."
   * No physical card interaction; the request returns immediately.
   *
   * Note: CaptureSignature is DISABLED here — there's no terminal
   * interaction so we can't capture a signature. The chargeback evidence
   * for card-not-present transactions relies on the prior signed agreement +
   * the original AUTH's signature.
   *
   * @param {object} args
   * @param {number} args.amount
   * @param {string} args.referenceId
   * @param {string} args.iposToken       — the saved Dejavoo token
   * @param {string} [args.invoiceNumber]
   * @param {string} [args.paymentType]   — defaults to 'Credit'
   * @param {object} [args.cart]
   * @param {object} [args.level3]        — RentalData passthrough for L3
   * @param {object} [args.customFields]
   */
  async saleWithToken({
    amount,
    referenceId,
    iposToken,
    invoiceNumber,
    paymentType = 'Credit',
    cart,
    level3,
    customFields,
  }, tenantConfig) {
    if (!iposToken) {
      throw new Error('saleWithToken: iposToken is required');
    }
    return spinRequest('POST', 'v2/Payment/Sale', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      // IPosToken signals card-not-present + use the saved token.
      // Field name per Dejavoo SPIn API spec. If the field name is
      // different in your firmware, adjust here.
      IPosToken: String(iposToken),
      // CardNotPresent flag tells the API to skip terminal prompts.
      CardNotPresent: true,
      // Disable terminal interaction
      CaptureSignature: false,
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      ...(cart ? { Cart: cart } : {}),
      ...(level3 ? { Level3: level3 } : {}),
      ...(customFields ? { CustomFields: customFields } : {}),
      GetExtendedData: true,
    }, tenantConfig);
  },
};

// =============================================================================
// Level 3 / Cart builder — pure function (2026-05-21)
//
// Maximum chargeback evidence: per-line-item description, commodity codes,
// rental dates, driver name, vehicle metadata. Sent on every AutoRental
// Sale/Auth so the merchant has structured data in the dispute pipeline.
//
// Commodity code 4111 = auto rental (Dejavoo commodity-codes reference).
// =============================================================================

const AUTO_RENTAL_COMMODITY_CODE = '4111';

function dollarsFromDecimal(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  // Prisma Decimal serializes as string
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the Cart + Level3.RentalData payload from a Reservation +
 * RentalAgreement + ReservationCharge[] tuple.
 *
 * Caller passes already-loaded data — this function is pure (no Prisma).
 *
 * @param {object} reservation — { id, pickupAt, returnAt, pickupLocation, returnLocation, vehicle, customer }
 * @param {object} agreement   — { agreementNumber, dailyRate, totalDays }
 * @param {Array<object>} charges — ReservationCharge rows where selected=true
 * @returns {{ Cart: object, Level3: object }}
 */
export function buildLevel3FromReservation(reservation, agreement, charges = []) {
  const selected = (charges || []).filter((c) => c.selected !== false);
  const items = selected.map((c) => ({
    Name: String(c.name || c.code || 'Charge').slice(0, 80),
    Quantity: dollarsFromDecimal(c.quantity) || 1,
    UnitPrice: dollarsFromDecimal(c.rate),
    Total: dollarsFromDecimal(c.total),
    CommodityCode: AUTO_RENTAL_COMMODITY_CODE,
  }));
  const cartTotal = items.reduce((acc, it) => acc + (it.Total || 0), 0);

  const pickup = reservation?.pickupAt instanceof Date
    ? reservation.pickupAt
    : reservation?.pickupAt ? new Date(reservation.pickupAt) : null;
  const ret = reservation?.returnAt instanceof Date
    ? reservation.returnAt
    : reservation?.returnAt ? new Date(reservation.returnAt) : null;

  const rentalData = {
    AgreementNumber: agreement?.agreementNumber || reservation?.id || '',
    PickupDate: pickup ? pickup.toISOString() : null,
    ReturnDate: ret ? ret.toISOString() : null,
    PickupLocation:
      reservation?.pickupLocation?.code || reservation?.pickupLocation?.name || null,
    ReturnLocation:
      reservation?.returnLocation?.code || reservation?.returnLocation?.name || null,
    VehicleClass:
      reservation?.vehicle?.classCode ||
      reservation?.vehicle?.vehicleType?.code ||
      null,
    VehiclePlate: reservation?.vehicle?.plate || null,
    DriverFirstName: reservation?.customer?.firstName || null,
    DriverLastName: reservation?.customer?.lastName || null,
    DailyRate: dollarsFromDecimal(agreement?.dailyRate) || null,
    TotalDays: typeof agreement?.totalDays === 'number' ? agreement.totalDays : null,
  };

  return {
    Cart: {
      Items: items,
      Total: Number(cartTotal.toFixed(2)),
    },
    Level3: {
      RentalData: rentalData,
    },
  };
}

/**
 * Convenience: convert HTML to a plain-text blob suitable for the terminal
 * Disclaimer screen. Strips tags, collapses whitespace, truncates to
 * `maxLen` chars (default 6000 — P1 screen limit).
 */
export function htmlToTerminalText(html, { maxLen = 6000 } = {}) {
  if (!html || typeof html !== 'string') return '';
  // Replace common block tags with newlines for readability
  const withBreaks = html
    .replace(/<\/(h[1-6]|p|li|div|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  const decoded = stripped
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace but preserve paragraph breaks
  const collapsed = decoded
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen - 3) + '...';
}

/**
 * Convenience: extract ~`window` chars of context around a {{markerKey}}
 * occurrence in the contentHtml. Used by the terminal flow as the default
 * Disclaimer text when a TermsTemplateField has no terminalContextText override.
 *
 * Returns plain text (HTML stripped).
 */
export function extractContextAroundMarker(contentHtml, markerKey, { window = 300 } = {}) {
  if (!contentHtml || !markerKey) return '';
  const marker = `{{${markerKey}}}`;
  const idx = contentHtml.indexOf(marker);
  if (idx === -1) return '';
  const half = Math.max(50, Math.floor(window / 2));
  const start = Math.max(0, idx - half);
  const end = Math.min(contentHtml.length, idx + marker.length + half);
  const snippet = contentHtml.slice(start, end);
  return htmlToTerminalText(snippet, { maxLen: window * 2 });
}
