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

// Round 25 (2026-05-22): SPIN_MOCK=true short-circuits all network calls
// and returns fake successful responses. For LOCAL dev only — never set in
// production. Lets us validate the orchestrator + frontend wizard flow
// without a real Dejavoo terminal.
function mockSpinResponse(method, path, body) {
  const sigPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const ok = (extra) => ({
    GeneralResponse: { ResultCode: 0, StatusCode: '0000', Message: 'OK (MOCK)' },
    ReferenceId: body?.ReferenceId || 'MOCK_REF',
    ...extra,
  });
  if (path.endsWith('/AutoRental/Sale') || path.endsWith('/Payment/Sale')) {
    return ok({
      AuthCode: 'MOCK_SALE',
      IPosToken: 'MOCK_TOKEN_VAULT',
      SignatureData: sigPng,
      CardData: { Last4: '4242', CardType: 'VISA', EntryType: 'CHIP', Name: 'TEST CUSTOMER' },
    });
  }
  if (path.endsWith('/AutoRental/Auth')) {
    return ok({
      AuthCode: 'MOCK_AUTH',
      IPosToken: 'MOCK_TOKEN_VAULT',
      SignatureData: sigPng,
      CardData: { Last4: '4242', CardType: 'VISA', EntryType: 'CHIP' },
    });
  }
  if (path.endsWith('/AutoRental/Capture')) {
    return ok({ AuthCode: 'MOCK_CAP' });
  }
  if (path.endsWith('/Payment/Void')) {
    return ok({ AuthCode: 'MOCK_VOID' });
  }
  if (path.endsWith('/Common/TerminalStatus')) {
    return ok({ Status: 'Online', Battery: 95 });
  }
  // Default — anything we didn't enumerate just gets a generic OK so the
  // orchestrator doesn't crash on unhandled paths.
  return ok({ MockNote: `unmocked path: ${path}` });
}

async function spinRequest(method, path, body, tenantConfig = {}) {
  // Mock mode short-circuit — skips network entirely.
  if (process.env.SPIN_MOCK === 'true') {
    logger.info(`SPIn API ${method} ${path} [MOCK]`, { spinPath: path });
    return mockSpinResponse(method, path, body);
  }

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

  // ============================================================================
  // Removed in round 25 (2026-05-22): standalone interactive endpoints.
  //
  //   disclaimer()    POST v2/Payment/Disclaimer    — 404 on api.spinpos.net
  //   getSignature()  POST v2/Payment/GetSignature  — 404 on api.spinpos.net
  //   userChoice()    POST v2/Payment/UserChoice    — 404 on api.spinpos.net
  //   userInput()     POST v2/Payment/UserInput     — 404 on api.spinpos.net
  //   cart()          POST v2/Payment/Cart          — 404 on api.spinpos.net
  //
  // The SPIn REST API doesn't expose these as standalone endpoints under
  // `v2/Payment/*`. The interactive flow is handled INSIDE the Sale request:
  //
  //   - The disclaimer page is configured on the terminal profile via the
  //     iPOSpays merchant portal — it auto-displays before each Sale.
  //   - The signature is captured by the Sale request itself when
  //     `CaptureSignature: true` is passed in the body. The signature PNG
  //     comes back in the response's `SignatureData` field.
  //   - Cart line items travel inline inside Sale/Capture bodies via the
  //     Cart + Level3 envelopes (see autoRentalSale below).
  //
  // See: doc/round-25-plan-2026-05-22.md for the full rationale.
  // ============================================================================

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
      // Round 25 hotfix (2026-05-22): SPIn AutoRental endpoints require the
      // body field be named `AutoRental` (not `RentalData`). The proxy
      // rejected with StatusCode 2201 / ResultCode 2 because the required
      // `AutoRental` object was missing. See docs:
      // https://app.theneo.io/dejavoo/spin/autorental/auto-rental-auth
      ...(rentalData ? { AutoRental: rentalData } : {}),
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
      // Round 25 hotfix (2026-05-22): SPIn AutoRental endpoints require the
      // body field be named `AutoRental` (not `RentalData`). The proxy
      // rejected with StatusCode 2201 / ResultCode 2 because the required
      // `AutoRental` object was missing. See docs:
      // https://app.theneo.io/dejavoo/spin/autorental/auto-rental-auth
      ...(rentalData ? { AutoRental: rentalData } : {}),
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
      // Round 25 hotfix (2026-05-22): SPIn AutoRental endpoints require the
      // body field be named `AutoRental` (not `RentalData`). The proxy
      // rejected with StatusCode 2201 / ResultCode 2 because the required
      // `AutoRental` object was missing. See docs:
      // https://app.theneo.io/dejavoo/spin/autorental/auto-rental-auth
      ...(rentalData ? { AutoRental: rentalData } : {}),
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

  /**
   * AutoRental Auth using a previously-captured IPosToken (card-not-present).
   * Round 22 — used at pickup AFTER the SALE has charged the rental fee, to
   * place the security deposit hold without making the customer re-swipe.
   *
   * The terminal does NOT prompt for card; the API call alone places the hold
   * on the previously-tokenized card.
   */
  async authWithToken({
    amount,
    referenceId,
    iposToken,
    invoiceNumber,
    paymentType = 'Credit',
    rentalData,
    customFields,
  }, tenantConfig) {
    if (!iposToken) {
      throw new Error('authWithToken: iposToken is required');
    }
    return spinRequest('POST', 'v2/AutoRental/Auth', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      IPosToken: String(iposToken),
      CardNotPresent: true,
      CaptureSignature: false, // already signed during T&C / SALE step
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      // Round 25 hotfix (2026-05-22): SPIn AutoRental endpoints require the
      // body field be named `AutoRental` (not `RentalData`). The proxy
      // rejected with StatusCode 2201 / ResultCode 2 because the required
      // `AutoRental` object was missing. See docs:
      // https://app.theneo.io/dejavoo/spin/autorental/auto-rental-auth
      ...(rentalData ? { AutoRental: rentalData } : {}),
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
  // Round 25 hotfix (2026-05-22): SPIn Cart.Items requires `Price` field on
  // each item — without it: "Price field is required for Items in Cart's
  // Items List." We also keep UnitPrice + Total for compatibility with our
  // existing UI / chargeback layer.
  const items = selected.map((c) => ({
    Name: String(c.name || c.code || 'Charge').slice(0, 80),
    Price: dollarsFromDecimal(c.total),
    Quantity: dollarsFromDecimal(c.quantity) || 1,
    UnitPrice: dollarsFromDecimal(c.rate),
    Total: dollarsFromDecimal(c.total),
    CommodityCode: AUTO_RENTAL_COMMODITY_CODE,
  }));
  const cartTotal = Number(items.reduce((acc, it) => acc + (it.Total || 0), 0).toFixed(2));

  const pickup = reservation?.pickupAt instanceof Date
    ? reservation.pickupAt
    : reservation?.pickupAt ? new Date(reservation.pickupAt) : null;
  const ret = reservation?.returnAt instanceof Date
    ? reservation.returnAt
    : reservation?.returnAt ? new Date(reservation.returnAt) : null;

  // Round 25 hotfix (2026-05-22): SPIn AutoRental requires a NESTED structure
  // with these sub-objects:
  //   AutoRentalAgreement (+ AutoRentalAdjustment nested)
  //   AutoRentalRenter
  //   AutoRentalVehicle
  //   AutoRentalPricing
  //   AutoRentalPickup
  //   AutoRentalReturn
  //   AutoRentalDistance
  // Per docs: https://app.theneo.io/dejavoo/spin/autorental/auto-rental-auth
  // Our previous flat shape ({ AgreementNumber, DailyRate, ... }) crashed
  // SPIn's ASP.NET parser with HTTP 500 'An error has occurred'.
  const pickupLoc = reservation?.pickupLocation || {};
  const returnLoc = reservation?.returnLocation || {};
  const customer = reservation?.customer || {};
  const vehicle = reservation?.vehicle || {};

  const renterName = [customer.firstName, customer.lastName]
    .filter(Boolean)
    .join(' ')
    .slice(0, 80) || 'Customer';

  const rentalData = {
    AutoRentalAgreement: {
      AgreementReferenceNumber: (agreement?.agreementNumber || reservation?.id || '').slice(0, 25),
      PurchaseIdentifier: '',
      RentalDuration:
        typeof agreement?.totalDays === 'number' ? agreement.totalDays : null,
      RentalPeriod: 'Daily',
      AutoRentalAdjustment: {
        AdjustmentAmount: null,
        AdjustmentAuditIndicatorCode: 'X', // X = no adjustments (per docs)
      },
    },
    AutoRentalRenter: {
      RenterName: renterName,
      ServiceMobile: (customer.phone || '').slice(0, 20),
    },
    AutoRentalVehicle: {
      VehicleMake: (vehicle.make || '').slice(0, 20),
      VehicleModel: (vehicle.model || '').slice(0, 20),
      RentalClassId:
        (vehicle.classCode || vehicle.vehicleType?.code || '').slice(0, 10),
    },
    AutoRentalPricing: {
      RentalRate: dollarsFromDecimal(agreement?.dailyRate) || null,
      // Round 25 hotfix (2026-05-22): SPIn requires this array to contain a
      // valid enum entry. [] returns "ExtraCharges are required". [""] returns
      // "Unacceptable value for ExtraCharges[0]". Per the validation error
      // message — "NoExtraCharge cannot be combined with other charges" — the
      // 'NoExtraCharge' string is the explicit "no extras" marker. Valid for
      // the SALE/AUTH/Capture endpoints alike.
      ExtraCharges: ['NoExtraCharge'],
    },
    AutoRentalPickup: {
      DateTime: pickup ? pickup.toISOString() : '',
      Address: (pickupLoc.address || '').slice(0, 80),
      City: (pickupLoc.city || '').slice(0, 40),
      State: (pickupLoc.state || '').slice(0, 20),
      Country: (pickupLoc.country || 'USA').slice(0, 20),
      LocationId: (pickupLoc.code || '').slice(0, 20),
      RegionCode: (pickupLoc.state || '').slice(0, 2),
      CountryCode: 'US',
    },
    AutoRentalReturn: {
      DateTime: ret ? ret.toISOString() : '',
      Address: (returnLoc.address || '').slice(0, 80),
      City: (returnLoc.city || '').slice(0, 40),
      State: (returnLoc.state || '').slice(0, 20),
      Country: (returnLoc.country || 'USA').slice(0, 20),
      LocationId: (returnLoc.code || '').slice(0, 20),
      RegionCode: (returnLoc.state || '').slice(0, 2),
      CountryCode: 'US',
    },
    AutoRentalDistance: {
      RentalDistance: null,
      AutoRentalDistanceUnitofMeasure: 'Miles',
    },
  };

  // Round 25 hotfix (2026-05-22): SPIn Cart requires an Amounts array with
  // at least one entry — "List of Amounts required in Cart and it must
  // contain at least one Amount". Each entry is { Name, Value }. We emit a
  // Subtotal + Total pair so the terminal can render the totals row.
  return {
    Cart: {
      Items: items,
      Total: cartTotal,
      Amounts: [
        { Name: 'Subtotal', Value: cartTotal },
        { Name: 'Total', Value: cartTotal },
      ],
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
