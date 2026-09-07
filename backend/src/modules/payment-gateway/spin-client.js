import logger from '../../lib/logger.js';
import { isBusyFailure, busyDelaySeconds } from './terminal-state.js';
import { buildTerminalSaleL3, TERMINAL_L3_SKIP } from './terminal-sale-l3.js';

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
    // BOTH halves, not the first truthy one (2026-09-07).
    //
    // This used to read `message || detailedMessage`, and on the refusal that
    // matters most that is exactly backwards: a 2201 answers Message "Error"
    // — a word with no information in it — and puts the whole explanation in
    // DetailedMessage ("The Amount field is required...", the field it does
    // not like, the credential it will not take). The useless half is truthy,
    // so it won the `||` and the useful half was dropped on the floor.
    //
    // Cost of that, measured: a counter agent reading "Sale declined: Error",
    // a droplet log saying the same, and a live LAX sale (2026-09-07) that
    // took a round trip through the logs to learn only its status code. Both
    // halves now travel, de-duplicated, all the way to the wizard.
    const parts = [message, detailedMessage]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .filter((v, i, all) => all.indexOf(v) === i);
    const msg = parts.join(' — ') || `SPIn request failed (${code})`;
    logger.warn(`SPIn API error: ${msg}`, {
      spinPath: path, statusCode: code,
      resultCode: resultCodeRaw, resultCodeType: typeof resultCodeRaw,
      // Logged separately too: a grep for the message text should not have to
      // guess where the em-dash falls.
      spinMessage: message || '', spinDetailedMessage: detailedMessage || '',
    });
    const err = new Error(msg);
    err.spinStatusCode = code;
    err.spinMessage = message || '';
    err.spinDetailedMessage = detailedMessage || '';
    err.spinResponse = data;
    throw err;
  }

  return data;
}

/**
 * The Sale body, as a PURE function of its inputs.
 *
 * Extracted 2026-09-04 for one reason: scripts/probe-terminal-sale-l3.mjs must
 * be able to PRINT the exact bytes it is about to charge with, and a probe that
 * prints a reconstruction of the payload rather than the payload is a probe
 * that can lie to you. Now there is one builder and both the live sale and the
 * probe call it.
 *
 * What this does NOT include is the common block spinRequest() adds on the way
 * out — Authkey, Tpn, MerchantNumber, SPInProxyTimeout, and CallbackInfo when a
 * callback URL is configured. The probe says so where it prints.
 *
 * @returns {{body: object, l3Decision: object|null}} l3Decision is null when
 *          the caller threaded no `level3` at all, which is today's every caller.
 */
export function buildSalePayload({
  amount, referenceId, paymentType = 'Credit', tipAmount, invoiceNumber,
  cart, customFields, level3 = null,
} = {}, tenantConfig = {}) {
  // ⚠️ `amount` is passed to the L3 builder from HERE, never from the level3
  // object, so the itemization is always checked against the money that is
  // actually being charged. A level3.amount that disagreed with the Amount
  // field would defeat the entire §5.3 invariant.
  const { payload: l3Payload, decision } = level3
    ? buildTerminalSaleL3({ ...level3, amount }, tenantConfig)
    : { payload: {}, decision: null };

  return {
    body: {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      ...(tipAmount ? { TipAmount: Number(tipAmount) } : {}),
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      // Spread BEFORE `cart` so an explicitly-passed Cart always wins over a
      // generated one. A caller that hand-built a cart meant it.
      ...l3Payload,
      ...(cart ? { Cart: cart } : {}),
      ...(customFields ? { CustomFields: customFields } : {}),
      CaptureSignature: false,
      GetExtendedData: true,
    },
    l3Decision: decision,
  };
}

/**
 * Say what happened to the L2/L3 enrichment, every time, before the money moves.
 *
 * Counts and totals only — NEVER charge names or the payload, which carry
 * renter PII (autorental-validation.js says the same thing about the response
 * side). A refusal is a WARN because it is the case worth noticing: either the
 * amount legitimately is not the agreement total, or a charge row does not
 * reconcile and we would otherwise never learn about it.
 */
function logL3Decision(decision, context = {}) {
  if (!decision || !decision.enabled) return;
  if (decision.skipped === TERMINAL_L3_SKIP.BUILDER_REFUSED) {
    logger.warn('[spin-client] terminal L2/L3 REFUSED — sending the sale payload unchanged', {
      ...context, reason: decision.reason, ...(decision.detail || {}),
    });
    return;
  }
  if (!decision.applied) {
    logger.info('[spin-client] terminal L2/L3 not applied', { ...context, skipped: decision.skipped });
    return;
  }
  logger.info('[spin-client] terminal L2/L3 attached to sale', {
    ...context,
    envelope: decision.envelope,
    lineItemCount: decision.lineItemCount,
    taxAmount: decision.taxAmount,
    lineTotal: decision.lineTotal,
    excludedDeposits: decision.excludedDeposits,
    autoRental: decision.autoRental,
    rentalClassId: decision.rentalClassId,
  });
}

/**
 * Busy-only retry, shared by every op that can land while the terminal is
 * still closing out the previous interaction (the ~30–50s hold proven live at
 * LAX 2026-09-04). ONLY busy failures are retried (2008, or 1000 with a busy
 * detail — see isBusyFailure), honouring the gateway's own
 * DelayBeforeNextRequest. A decline or a 2201 refusal is thrown immediately:
 * retrying a refused money call is how somebody gets charged twice, and
 * retrying a refused prompt just hides a payload bug. Busy is safe to resend
 * for both kinds — a busy request never reached the terminal, and Dejavoo
 * dedupes money calls by ReferenceId besides.
 *
 * voidWithRetry / preAuthDeposit carry their own identical loops from the day
 * this rule was learned; they are live-proven and deliberately left alone.
 */
async function retryWhileBusy(label, send, { attempts = 3, sleep = null, referenceId = '' } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr = null;
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    try {
      return await send();
    } catch (err) {
      lastErr = err;
      if (!isBusyFailure(err) || i === attempts - 1) throw err;
      const secs = busyDelaySeconds(err);
      logger.warn(`SPIn ${label} busy, waiting ${secs}s before retry ${i + 2}/${attempts}`, {
        referenceId, spinStatusCode: err?.spinStatusCode,
      });
      await wait(secs * 1000);
    }
  }
  throw lastErr;
}

export const spinClient = {
  /**
   * Process a sale (charge).
   *
   * 2026-05-30 — Reverted to the minimal field set after a live test
   * hit StatusCode 2201 / ResultCode 2 ("Error") on the new payload.
   * The added flags (GetToken, EnableTip, PrintReceipt) appear to be
   * unrecognized by this merchant's Spin proxy configuration, and
   * including them causes the gateway to reject the request before
   * forwarding to the terminal (confirmed: nothing appeared in the
   * Dejavoo merchant portal). GetExtendedData:true alone has
   * historically returned the iPOS token; we keep that and let the
   * downstream Transact CNP hold fall back to card-present if no
   * token comes back.
   *
   * 2026-09-04 — OPTIONAL `level3`. Level 2 / Level 3 data is what moves a
   * card-present rental to the lower auto-rental interchange, and RFM has had
   * the itemization all along. It rides here ONLY when:
   *   • the caller threads a `level3` object (nobody does yet — see below), AND
   *   • the tenant has the spinL3* flags on, which ALL DEFAULT OFF.
   * With no `level3`, buildSalePayload produces the pre-2026-09-04 body field
   * for field; that equivalence is asserted in terminal-sale-l3.test.mjs and is
   * the reason this could be added to a live money path at all.
   *
   * ⚠️ GetExtendedData stays, untouched and unconditional. It is what returns
   * the iPOS token that the deposit pre-auth is placed against
   * (checkout-session/spin-charge.service.js: sale → extractCardOnFile → CNP
   * PreAuth on that token). Adding L3 must not cost us the card on file, so
   * the probe reports token presence at EVERY stage.
   *
   * NOT YET THREADED FROM CHECKOUT. spin-charge.service.js owns the live
   * card-present flow and is being edited by another workstream; passing the
   * agreement's charges from there is a one-line change and is deliberately
   * left out of this branch. Until the probe says which fields the gateway
   * takes, there is nothing to thread it for.
   */
  async sale({
    amount, referenceId, paymentType = 'Credit', tipAmount, invoiceNumber,
    cart, customFields, level3 = null, attempts = 3, sleep = null,
  }, tenantConfig) {
    const { body, l3Decision } = buildSalePayload({
      amount, referenceId, paymentType, tipAmount, invoiceNumber, cart, customFields, level3,
    }, tenantConfig);
    logL3Decision(l3Decision, { referenceId: String(referenceId).slice(0, 50) });
    // BUSY-RETRY (2026-09-04, second live checkout at LAX): the checkout sale
    // fires seconds after the contract's GetSignature releases the terminal,
    // which is exactly the window the void and the deposit pre-auth already
    // wait out. Same rule as theirs: busy retries, refusals throw.
    return retryWhileBusy('sale', () => spinRequest('POST', 'v2/Payment/Sale', body, tenantConfig), {
      attempts, sleep, referenceId: String(referenceId).slice(0, 50),
    });
  },

  /**
   * The SAME payload, sent to the AUTO RENTAL endpoint.
   *
   * Why this exists (LAX, 2026-09-04): all five probe rungs approved on
   * `v2/Payment/Sale` — the Level 2 header, real line items, and the whole
   * nested AutoRental block — and `ARLFlag` never came back on ANY of them.
   * The generic sale endpoint takes these fields without complaint and gives
   * no sign it does anything with them, which is what you would expect: the
   * rental data belongs to the rental endpoint.
   *
   * `v2/AutoRental/Sale` is where the May 2026 work was aimed, and where its
   * four StatusCode 2201s were learned. Every one of those lessons is now in
   * the payload builder — `AutoRental` not `RentalData` (cc4efdd8), nested not
   * flat (02af6407, which returned HTTP 500), `ExtraCharges: ['NoExtraCharge']`
   * rather than empty or [''] (bc29c096, ddd6d4b0), a numeric RentalClassId,
   * and yyyy-MM-dd dates. So this is the same body those attempts were
   * converging on, finished.
   *
   * Deliberately identical to sale() apart from the path: if the two behave
   * differently, the endpoint is the only variable, and that is the whole
   * point of asking.
   */
  async autoRentalSale({
    amount, referenceId, paymentType = 'Credit', tipAmount, invoiceNumber,
    cart, customFields, level3 = null,
  }, tenantConfig) {
    const { body, l3Decision } = buildSalePayload({
      amount, referenceId, paymentType, tipAmount, invoiceNumber, cart, customFields, level3,
    }, tenantConfig);
    logL3Decision(l3Decision, { referenceId: String(referenceId).slice(0, 50), endpoint: 'AutoRental/Sale' });
    return spinRequest('POST', 'v2/AutoRental/Sale', body, tenantConfig);
  },

  /**
   * Authorize only (hold funds, capture later). Same minimal-payload
   * rule as sale() — added optional flags broke this merchant's Spin
   * proxy, so we keep only the proven-working set.
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
   * Void a transaction. Used to release a pre-auth deposit hold (the
   * release-deposit operational tool) and to roll back a sale when the
   * deposit hold declines mid-checkout.
   *
   * 2026-05-30 — Reverted to minimal payload (ReferenceId only) after
   * a Sale call with the new field set hit StatusCode 2201. Optional
   * fields appear to be unrecognized by this merchant's Spin proxy.
   * Dejavoo dedupes by ReferenceId, so passing the original sale/auth's
   * ReferenceId triggers the void on that exact transaction.
   */
  /**
   * Void a transaction.
   *
   * FIXED 2026-09-04, learned on a live $1 probe at LAX: sending only
   * `ReferenceId` is refused with StatusCode 2201 —
   *
   *   "The Amount field is required. For PaymentType field required values
   *    are [Credit, Debit, EBT_Food, EBT_Cash, Card, Cash, Check, Gift,
   *    UserChoice]"
   *
   * — so the void NEVER worked. That matters far beyond the probe: this is
   * the rollback spin-charge.service.js runs when a sale succeeds and the
   * deposit pre-auth then fails. Every one of those rollbacks has been
   * failing, leaving a renter charged for a rental whose deposit was never
   * secured. It is the "renter charged, no deposit" row of the failure matrix,
   * happening always rather than rarely.
   *
   * `amount` is therefore REQUIRED, not optional: a void without it is a call
   * we already know the gateway refuses, and defaulting it would guess at the
   * size of somebody's refund.
   */
  async void({ referenceId, amount, paymentType = 'Credit' }, tenantConfig) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error('SPIn void requires the original amount — the gateway rejects a void without it');
    }
    return spinRequest('POST', 'v2/Payment/Void', {
      Amount: n,
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
    }, tenantConfig);
  },

  /**
   * Void, waiting out a busy terminal instead of giving up on it.
   *
   * Proven necessary live at LAX 2026-09-04: a Void sent 19 seconds after an
   * approved Sale came back `1000 / Canceled / "Service Busy"` — the terminal
   * was still closing out the sale it had just approved. The request was fine;
   * the device was not ready.
   *
   * That matters because the caller that needs this most is the ROLLBACK: sale
   * approved, deposit pre-auth failed, now undo the sale. It runs immediately
   * after a transaction, which is exactly when the terminal is busiest, and if
   * it gives up on the first busy the renter stays charged for a rental whose
   * deposit was never held.
   *
   * ONLY busy failures are retried (see isBusyFailure). A 2201 is the gateway
   * refusing the payload — retrying an identical money call on a guess is how
   * somebody gets charged twice.
   */
  async voidWithRetry({ referenceId, amount, paymentType = 'Credit', attempts = 3, sleep = null }, tenantConfig) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    let lastErr = null;
    for (let i = 0; i < Math.max(1, attempts); i += 1) {
      try {
        return await this.void({ referenceId, amount, paymentType }, tenantConfig);
      } catch (err) {
        lastErr = err;
        if (!isBusyFailure(err) || i === attempts - 1) throw err;
        const secs = busyDelaySeconds(err);
        logger.warn(`SPIn void busy, waiting ${secs}s before retry ${i + 2}/${attempts}`, {
          referenceId, spinStatusCode: err?.spinStatusCode,
        });
        await wait(secs * 1000);
      }
    }
    throw lastErr;
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
  async preAuthDeposit({ amount, referenceId, paymentType = 'Credit', invoiceNumber, token, attempts = 3, sleep = null }, tenantConfig) {
    const isCnp = Boolean(token);
    // BUSY-RETRY (2026-09-04, proven on the first real terminal checkout at
    // LAX): the deposit pre-auth fires SECONDS after the sale approves, which
    // is exactly when the terminal is still closing that sale out. The live
    // run failed twice with 1000 "Canceled/Service Busy" — at +6s and again at
    // +18s (the device holds the session ~30-50s) — and the agent was pushed
    // to a manual deposit for no real reason. Same waiting rule as
    // voidWithRetry: ONLY busy failures retry, honouring the gateway's own
    // DelayBeforeNextRequest; a decline or a 2201 is thrown immediately.
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const send = () => spinRequest('POST', 'v2/Payment/Auth', {
      Amount: Number(amount),
      PaymentType: paymentType,
      ReferenceId: String(referenceId).slice(0, 50),
      ...(invoiceNumber ? { InvoiceNumber: String(invoiceNumber).slice(0, 50) } : {}),
      // When a token is provided we're holding against a previously-
      // tokenized card (CNP). Without it the terminal prompts for tap/
      // insert/swipe just like a normal Auth.
      // 2026-05-30 — token-CNP path on SPIn is now reserved as a
      // fallback only; the documented path for tokenized CNP is the
      // iPOSpays Transact API (ipos-transact-client.js). Token kept
      // here for non-Transact deployments. EnableTip/PrintReceipt
      // dropped — caused gateway StatusCode 2201 on the configured
      // merchant proxy.
      ...(isCnp ? { Token: String(token), CardPresent: false } : {}),
      GetExtendedData: true,
    }, tenantConfig);
    let lastErr = null;
    for (let i = 0; i < Math.max(1, attempts); i += 1) {
      try {
        return await send();
      } catch (err) {
        lastErr = err;
        if (!isBusyFailure(err) || i === attempts - 1) throw err;
        const secs = busyDelaySeconds(err);
        logger.warn(`SPIn preauth busy, waiting ${secs}s before retry ${i + 2}/${attempts}`, {
          referenceId, spinStatusCode: err?.spinStatusCode,
        });
        await wait(secs * 1000);
      }
    }
    throw lastErr;
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
      // 2026-05-30 — EnableTip/PrintReceipt removed (gateway rejected
      // with StatusCode 2201). Primary CNP path is now iPOSpays
      // Transact API; this Spin-with-Token method is a fallback only.
      CardPresent: false,
      GetExtendedData: true,
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
   * Show text on the terminal and capture an ink signature for it.
   *
   * NO MONEY. This is a screen prompt: the renter reads `Title` and signs.
   * It is the mechanism behind terminal-side contract signing — one call per
   * clause captures that clause's initials, and the returned PNG is exactly
   * the artifact AgreementSectionInitial.initialDataUrl already stores, so a
   * contract signed on the terminal and one signed on a phone persist
   * identically.
   *
   * DELIBERATELY MINIMAL — only `Title` beyond the common block. The
   * 2026-05-30 lesson recorded on sale() above is that unrecognized fields
   * make the gateway reject the request with StatusCode 2201 BEFORE the
   * terminal sees it: nothing appears on screen, nothing lands in the Dejavoo
   * portal. Do not add fields here without a live test.
   *
   * UNPROVEN AGAINST OUR TERMINAL as of 2026-09-04. The May 2026 attempt used
   * the PORTAL-configured inline disclaimer — a different mechanism, which
   * never fired on AutoRental. scripts/probe-terminal-disclaimer.mjs is what
   * proves this one.
   */
  async disclaimer({ title }, tenantConfig) {
    const text = String(title ?? '').trim();
    if (!text) throw new Error('SPIn disclaimer requires text');
    return spinRequest('POST', 'v2/Common/Disclaimer', { Title: text }, tenantConfig);
  },

  /**
   * Show text on the terminal WITH buttons, and return which one was pressed.
   *
   * NO MONEY. Unlike disclaimer() this one waits for an answer, and unlike
   * getSignature() the text is on screen AT THE MOMENT of the answer — which
   * is what makes it a candidate for per-clause acceptance: the renter agrees
   * while reading the clause, not from memory in front of a blank box.
   *
   * `Title` is documented as capped at 250 characters here (Disclaimer has no
   * documented cap). Our longest TC_SECTIONS body is 245, so they fit — but
   * that is a fact to re-check whenever the clause text is edited.
   *
   * Minimal payload, same 2201 discipline as disclaimer().
   */
  async userChoice({ title, options, attempts = 3, sleep = null }, tenantConfig) {
    const text = String(title ?? '').trim();
    if (!text) throw new Error('SPIn userChoice requires text');
    const choices = (Array.isArray(options) ? options : []).map((o) => String(o)).filter(Boolean);
    if (choices.length < 2) throw new Error('SPIn userChoice requires at least two options');
    // Busy-retry: a clause prompt sent while the terminal is still closing the
    // previous op never reached the screen — waiting it out beats surfacing an
    // error the agent can only answer by clicking the same button again.
    return retryWhileBusy('userChoice', () => spinRequest('POST', 'v2/Common/UserChoice', { Title: text, ChoiceOptions: choices }, tenantConfig), { attempts, sleep });
  },

  /**
   * Capture an ink signature with no text — the closing signature that follows
   * the per-clause initials. Nothing beyond the common block. NO MONEY.
   */
  async getSignature(tenantConfig, { attempts = 3, sleep = null } = {}) {
    // Busy-retry, same reasoning as userChoice: the signature box follows six
    // UserChoice prompts back-to-back, and a busy submission never showed
    // anything to the customer.
    return retryWhileBusy('getSignature', () => spinRequest('POST', 'v2/Common/GetSignature', {}, tenantConfig), { attempts, sleep });
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
   * Best-effort card funding type from a SPIn response — 'DEBIT',
   * 'CREDIT', or null when the response doesn't say (we never guess).
   *
   * 2026-06-04 — debit-aware deposits. Where the signal can live:
   *   • PaymentType — we SEND 'Credit' on every request, but the
   *     terminal response echoes what actually ran ('Debit' when the
   *     customer's tap routed as debit / they chose debit on the PIN
   *     pad). The iPOSpays Transact API equivalently reports cardType
   *     'DEBIT' / 'CREDIT'.
   *   • CardData.CardType — usually the brand (VISA/MC), but some
   *     Dejavoo proxy configs return 'DEBIT' / 'VISA DEBIT' here.
   *   • CardData.PaymentType / ExtData.PaymentType — extended-data
   *     variants seen across SPIn proxy versions.
   * We scan all candidates for an explicit DEBIT or CREDIT token.
   */
  extractCardType(spinResponse) {
    const candidates = [
      spinResponse?.PaymentType,
      spinResponse?.CardData?.PaymentType,
      spinResponse?.CardData?.CardType,
      spinResponse?.ExtData?.PaymentType,
      spinResponse?.ExtData?.CardType,
      spinResponse?.cardType, // Transact-style lowercase field
    ];
    for (const raw of candidates) {
      const v = String(raw || '').toUpperCase();
      if (!v) continue;
      if (v.includes('DEBIT')) return 'DEBIT';
      if (v.includes('CREDIT')) return 'CREDIT';
    }
    return null;
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
      // 'DEBIT' | 'CREDIT' | null — null means the gateway didn't say.
      type: this.extractCardType(spinResponse),
      last4: norm.cardData?.last4 || null,
      capturedAt: new Date(),
    };
  },
};
