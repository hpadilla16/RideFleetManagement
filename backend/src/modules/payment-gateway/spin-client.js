import logger from '../../lib/logger.js';

/**
 * SPIn/iPOSPays REST API client.
 *
 * Docs: https://docs.ipospays.com/spin-specification
 * REST API: https://app.theneo.io/dejavoo/spin/spin-rest-api-methods
 *
 * 2026-05-29 — PRODUCTION-ONLY. We do not run against the Dejavoo
 * sandbox at all. Hector's TPN + AuthKey are bound to a live
 * production terminal; the sandbox endpoint would reject them and
 * even if it accepted them, no funds would settle. The previous
 * sandbox URL / SPIN_SANDBOX / SPIN_ENV plumbing has been removed
 * so there's no code path that can route to test.spinpos.net.
 *
 * For local development WITHOUT a terminal: use SPIN_DRY_RUN=true,
 * which short-circuits every call to a synthetic approved response.
 */

const SPIN_PRODUCTION_URL = 'https://api.spinpos.net';

function getConfig(tenantConfig = {}) {
  return {
    // Hard-coded production endpoint. No sandbox flag. No env override.
    baseUrl: SPIN_PRODUCTION_URL,
    authKey: tenantConfig.spinAuthKey || process.env.SPIN_AUTH_KEY || '',
    tpn: tenantConfig.spinTpn || process.env.SPIN_TPN || '',
    merchantNumber: tenantConfig.spinMerchantNumber ? Number(tenantConfig.spinMerchantNumber) : 1,
    callbackUrl: tenantConfig.spinCallbackUrl || process.env.SPIN_CALLBACK_URL || '',
    // Server-side proxy timeout (seconds) — how long Spin waits for the
    // terminal to respond before giving up. 120s is the Dejavoo default
    // and matches a typical customer interaction (tap → PIN → email).
    proxyTimeout: Number(tenantConfig.spinProxyTimeout || process.env.SPIN_PROXY_TIMEOUT || 120),
    // Client-side fetch timeout (ms). Slightly above the server proxy
    // timeout so the server has time to surface its own timeout error
    // before our fetch aborts. PRIOR BUG: no client timeout — a stuck
    // terminal hung the wizard request forever.
    clientTimeoutMs: Number(
      tenantConfig.spinClientTimeoutMs || process.env.SPIN_CLIENT_TIMEOUT_MS || 130000,
    ),
  };
}

// One-time startup audit so misconfiguration surfaces in the boot log
// rather than at the moment a customer taps their card. Logs a warning
// for each potential foot-gun: dry-run on, missing TPN/key.
let auditLogged = false;
export function auditSpinConfig() {
  if (auditLogged) return;
  auditLogged = true;
  const cfg = getConfig();
  const dry = String(process.env.SPIN_DRY_RUN || '').toLowerCase() === 'true';
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (dry && env === 'production') {
    logger.error('[spin-client] CRITICAL: SPIN_DRY_RUN=true in production — every charge will be synthetic. Unset this immediately.');
  } else if (dry) {
    logger.warn('[spin-client] SPIN_DRY_RUN=true — terminal calls return synthetic approvals.');
  }
  if (!cfg.authKey || !cfg.tpn) {
    logger.warn('[spin-client] Spin credentials missing', {
      hasAuthKey: !!cfg.authKey, hasTpn: !!cfg.tpn,
      hint: 'Set SPIN_AUTH_KEY and SPIN_TPN — these are live production credentials.',
    });
  } else {
    logger.info('[spin-client] Spin production credentials loaded', {
      endpoint: cfg.baseUrl,
      tpn: cfg.tpn.slice(0, 4) + '****' + cfg.tpn.slice(-4),
      proxyTimeout: cfg.proxyTimeout,
      clientTimeoutMs: cfg.clientTimeoutMs,
    });
  }
}

// dryRun short-circuits every Spin call to return a synthetic approved
// response. Used during dev / when no terminal is reachable. Enable per
// tenant via tenantConfig.spinDryRun or globally via SPIN_DRY_RUN=true.
// The synthetic response includes a fake token, last4=4242, and brand=VISA
// so the downstream wizard + card-on-file persistence still exercises
// the full code path. 2026-05-28.
function isDryRun(tenantConfig = {}) {
  return tenantConfig.spinDryRun === true || String(process.env.SPIN_DRY_RUN || '').toLowerCase() === 'true';
}

function syntheticResponse(path, body) {
  const refId = body?.ReferenceId || `dry-${Date.now()}`;
  return {
    GeneralResponse: {
      StatusCode: '0000',
      ResultCode: 0,
      Message: 'DryRun OK',
      DetailedMessage: `Synthetic ${path} response (SPIN_DRY_RUN=true)`,
    },
    ReferenceId: refId,
    AuthCode: `DR${Math.floor(Math.random() * 900000 + 100000)}`,
    Token: `dry-tok-${refId}`,
    IPosToken: `dry-ipos-${refId}`,
    CardData: {
      CardType: 'VISA',
      EntryType: 'Insert',
      Last4: '4242',
      First4: '4111',
      BIN: '411111',
      ExpirationDate: '12/29',
      Name: 'DRY RUN',
    },
    BatchNumber: '0',
    SerialNumber: '0',
    PaymentType: body?.PaymentType || 'Credit',
    TransactionType: path.includes('Auth') ? 'Auth' : (path.includes('Sale') ? 'Sale' : 'Other'),
  };
}

async function spinRequest(method, path, body, tenantConfig = {}) {
  if (isDryRun(tenantConfig)) {
    logger.info(`SPIn DRY-RUN ${method} ${path}`, { spinPath: path });
    return syntheticResponse(path, body || {});
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

  logger.info(`SPIn API ${method} ${path}`, { spinPath: path });

  // Hard fetch timeout so a hung terminal doesn't lock the wizard
  // forever. Uses AbortController instead of Promise.race so the
  // underlying socket actually closes when we abort. PRIOR BUG: there
  // was no client-side timeout — a customer walking away mid-transaction
  // could leave the agent's screen spinning indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.clientTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method !== 'GET' ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      const msg = `SPIn request timed out after ${Math.round(config.clientTimeoutMs / 1000)}s — terminal may be offline or stuck on customer input`;
      logger.warn(msg, { spinPath: path });
      const e = new Error(msg);
      e.spinTimeout = true;
      throw e;
    }
    throw err;
  }
  clearTimeout(timeout);

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  // 2026-05-28 — Dejavoo response success detection.
  //
  // The Spin API returns ResultCode as either a number 0 or a string
  // "0" depending on environment + endpoint. We also need to handle
  // the case where ResultCode might be present but the actual signal
  // for success is Message === "Approved" or the AuthCode field is
  // populated. Strict `!== 0` was rejecting genuine approvals
  // (Hector's production card-tap on 2026-05-28 showed "Sale declined:
  // Approved" — terminal physically approved, response had
  // Message="Approved" but ResultCode was something we weren't
  // recognizing as success).
  const gr = data?.GeneralResponse || {};
  const resultCodeRaw = gr.ResultCode;
  const resultCodeNum = Number(resultCodeRaw);
  const message = String(gr.Message || '').trim();
  const detailedMessage = String(gr.DetailedMessage || '').trim();
  const hasAuthCode = Boolean(data?.AuthCode || data?.Authcode || data?.authCode);
  const looksApproved = /^approved$|^approval$|^success$/i.test(message)
    || /^approved$|^approval$|^success$/i.test(detailedMessage);

  const isSuccess = res.ok && (
    resultCodeNum === 0
    || (resultCodeRaw === '0')
    || looksApproved
    || hasAuthCode
  );

  if (!isSuccess) {
    const code = gr.StatusCode || res.status;
    const msg = message || detailedMessage || `SPIn request failed (${code})`;
    logger.warn(`SPIn API error: ${msg}`, {
      spinPath: path, statusCode: code,
      resultCode: resultCodeRaw, resultCodeType: typeof resultCodeRaw,
    });
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
   *
   * 2026-05-29 hardening for launch:
   *   - GetToken: true → request an iPOS token in the response so the
   *     subsequent deposit hold can run CNP (no second tap). Without
   *     this flag the terminal physically tokenizes but the response
   *     omits IPosToken, silently breaking the saved-card hold path.
   *   - EnableTip: false → suppress the "tip 15/20/25%" prompt that
   *     would otherwise show for rental car charges. Caller can still
   *     opt in by passing { enableTip: true }.
   *   - PrintReceipt: true → terminal prints the customer copy (the
   *     auth slip the customer signs is part of the audit trail).
   *   - GetExtendedData: true → returns CardData (brand, last4) needed
   *     for the agent-facing "Card on file" chip.
   */
  async sale({
    amount, referenceId, paymentType = 'Credit', tipAmount, invoiceNumber,
    cart, customFields, enableTip = false, printReceipt = true,
  }, tenantConfig) {
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
      GetToken: true,        // request iPOS token for downstream CNP
      EnableTip: enableTip,
      PrintReceipt: printReceipt,
    }, tenantConfig);
  },

  /**
   * Authorize only (hold funds, capture later).
   *
   * Same iPOS-token + tip-suppression hardening as sale() so the
   * pre-paid customer path (which routes through this for the
   * card-present deposit hold) opportunistically captures a token
   * for future autocharges.
   */
  async auth({ amount, referenceId, paymentType = 'Credit', invoiceNumber, enableTip = false }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Auth', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      GetExtendedData: true,
      GetToken: true,
      EnableTip: enableTip,
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
   * Void a transaction. Used to release a pre-auth deposit hold (the
   * release-deposit operational tool) and to roll back a sale when the
   * deposit hold declines mid-checkout.
   *
   * 2026-05-29 hardening: include PaymentType per Dejavoo spec so the
   * Void routes through the correct rail; PrintReceipt: false because
   * voids are server-initiated (no customer interaction at the
   * terminal). Dejavoo dedupes by ReferenceId, so passing the original
   * sale/auth's ReferenceId triggers the void on that exact transaction.
   */
  async void({ referenceId, paymentType = 'Credit' }, tenantConfig) {
    return spinRequest('POST', 'v2/Payment/Void', {
      ReferenceId: String(referenceId).slice(0, 50),
      PaymentType: paymentType,
      PrintReceipt: false,
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
   * Security-deposit pre-authorization (2026-05-28). Semantic wrapper
   * around auth() — the underlying Spin endpoint is the same v2/Payment/Auth,
   * but the wizard reads this as "hold these funds for the deposit",
   * not "preauth that we'll capture later". The hold's reference id is
   * what we persist as RentalAgreement.depositHoldId so we can void it
   * via the nightly cleanup job when a session is abandoned.
   */
  async preAuthDeposit({ amount, referenceId, paymentType = 'Credit', invoiceNumber, token }, tenantConfig) {
    const isCnp = Boolean(token);
    return spinRequest('POST', 'v2/Payment/Auth', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      // When a token is provided we're holding against a previously-
      // tokenized card (CNP). Without it the terminal prompts for tap/
      // insert/swipe just like a normal Auth.
      ...(isCnp ? { Token: String(token), CardPresent: false } : {}),
      GetExtendedData: true,
      // Card-present fallback (pre-paid customers who skipped sale)
      // tokenizes opportunistically so post-rental autocharges work.
      // CNP path already has a token so we don't need to re-request one.
      ...(isCnp ? {} : { GetToken: true }),
      EnableTip: false,
      // Voids and CNP auths don't print receipts. Card-present auths do
      // so the customer can sign their auth slip.
      PrintReceipt: !isCnp,
    }, tenantConfig);
  },

  /**
   * Charge a previously-tokenized card (card-not-present). Used post-
   * checkout for autocharges (tolls, overage fuel, damage). The token
   * comes from the initial Sale in step 3 — agreement.cardOnFileToken.
   */
  async chargeWithToken({ amount, referenceId, token, paymentType = 'Credit', invoiceNumber }, tenantConfig) {
    if (!token) throw new Error('chargeWithToken requires a token');
    return spinRequest('POST', 'v2/Payment/Sale', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      Token: String(token),
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      // Tells Spin to bill a stored token (no physical card present).
      CardPresent: false,
      GetExtendedData: true,
      EnableTip: false,
      // CNP charges don't print at the terminal — no customer there.
      PrintReceipt: false,
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

  /**
   * Extract the card-on-file fields we persist to RentalAgreement so
   * subsequent CNP charges (tolls / overage / damage) can run through
   * chargeWithToken. Returns null if the response didn't include a
   * tokenized card (e.g. cash payment, terminal misconfigured, etc).
   */
  extractCardOnFile(spinResponse) {
    const norm = this.normalizeResponse(spinResponse);
    if (!norm.token && !norm.iposToken) return null;
    return {
      token: norm.iposToken || norm.token,
      brand: norm.cardData?.cardType || null,
      last4: norm.cardData?.last4 || null,
      capturedAt: new Date(),
    };
  },
};
