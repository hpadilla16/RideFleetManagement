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
  }
};
