/**
 * Bridge HTML for the PayArc mobile WebView flow.
 *
 * Served by GET /api/public/booking/trips/:tripCode/payarc-bridge?s=<nonce>.
 * The Flutter WebView loads this URL directly, the user enters card
 * details into the PayArc Hosted Fields iframe, our inline JS
 * tokenizes, POSTs the token to /payarc-charge, and then redirects
 * the whole document to successMatchUrl on success.
 *
 * No templating engine is used on purpose — this file is small enough
 * that a literal template + careful escaping keeps it reviewable in a
 * single file, with no dependency surface we have to audit separately.
 *
 * Styling matches the approved Sprint 6 mockup at
 * design/mockups/sprint6/payment-webview.html (brand purple #8752FE,
 * mint accent, radius 16, same "Secure payment" chrome).
 */

function htmlEscape(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsStringEscape(input) {
  return String(input ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

/**
 * @param {object} opts
 * @param {string} opts.tripCode
 * @param {string} opts.reservationNumber
 * @param {number} opts.amountDue        dollars (e.g. 234.00)
 * @param {string} opts.currency         ISO 4217 (e.g. "USD")
 * @param {string} opts.publicKey        PayArc publishable key
 * @param {string} opts.payarcJsUrl      CDN URL for payarc.js
 * @param {string} opts.chargeUrl        Backend POST endpoint the inline JS posts the token to
 * @param {string} opts.successMatchUrl  Where to redirect on 200
 * @param {string} opts.cancelMatchUrl   Where to redirect when the user cancels
 * @param {string} opts.nonce            Signed bridge nonce (re-sent with the charge POST)
 * @param {string} [opts.environment]    "sandbox" | "production"
 */
export function renderPayArcBridge(opts = {}) {
  const tripCode = htmlEscape(opts.tripCode || '');
  const reservationNumber = htmlEscape(opts.reservationNumber || '');
  const amountLabel = Number.isFinite(opts.amountDue)
    ? `$${Number(opts.amountDue).toFixed(2)}`
    : '';
  const currency = htmlEscape(opts.currency || 'USD');
  const publicKey = jsStringEscape(opts.publicKey || '');
  const payarcJsUrl = htmlEscape(opts.payarcJsUrl || 'https://secure.payarc.net/payarc.js');
  const chargeUrl = jsStringEscape(opts.chargeUrl || '');
  const successMatchUrl = jsStringEscape(opts.successMatchUrl || '');
  const cancelMatchUrl = jsStringEscape(opts.cancelMatchUrl || '');
  const nonce = jsStringEscape(opts.nonce || '');
  const environment = jsStringEscape(opts.environment || 'sandbox');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Secure payment · ${tripCode}</title>
<style>
  :root {
    --rf-purple: #8752fe;
    --rf-purple-deep: #6c3ff1;
    --rf-mint: #1fc7aa;
    --rf-ink: #211a38;
    --rf-surface: #fafafc;
    --rf-surface-elevated: #ffffff;
    --rf-surface-muted: #f2f1f7;
    --rf-text-primary: var(--rf-ink);
    --rf-text-secondary: #5a5370;
    --rf-text-tertiary: #8f8aa0;
    --rf-good: #16a34a;
    --rf-danger: #dc2626;
    --rf-radius: 12px;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    color: var(--rf-text-primary);
    background: var(--rf-surface);
    -webkit-text-size-adjust: 100%;
  }
  .page {
    max-width: 480px; margin: 0 auto;
    padding: 24px 20px 32px;
  }
  .amount-hero {
    text-align: center;
    padding: 20px 0 8px;
  }
  .amount-hero .lbl {
    font-size: 12px;
    color: var(--rf-text-tertiary);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 700;
  }
  .amount-hero .amt {
    font-size: 36px;
    font-weight: 800;
    margin-top: 4px;
    letter-spacing: -0.5px;
  }
  .amount-hero .sub {
    font-size: 12px;
    color: var(--rf-text-secondary);
    margin-top: 4px;
  }
  .card-panel {
    background: var(--rf-surface-elevated);
    border-radius: var(--rf-radius);
    padding: 16px;
    margin-top: 18px;
    box-shadow: 0 8px 24px rgba(33, 26, 56, 0.08);
  }
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--rf-text-secondary);
    margin: 12px 0 6px;
  }
  label:first-child { margin-top: 0; }
  .pf-field {
    width: 100%;
    min-height: 44px;
    border: 1px solid rgba(33,26,56,0.14);
    border-radius: 10px;
    padding: 0 12px;
    background: #fff;
    display: flex; align-items: center;
  }
  .pf-field iframe {
    border: 0; width: 100%; height: 44px;
  }
  .row { display: flex; gap: 10px; }
  .row > * { flex: 1; }
  .btn {
    width: 100%; margin-top: 20px;
    background: var(--rf-purple);
    color: #fff; border: 0;
    border-radius: var(--rf-radius);
    height: 48px;
    font-size: 15px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .btn:disabled {
    opacity: 0.5; cursor: not-allowed;
  }
  .btn-ghost {
    width: 100%; margin-top: 8px;
    background: transparent; border: 0;
    color: var(--rf-text-secondary);
    height: 44px; font-size: 14px;
  }
  .error {
    display: none;
    margin-top: 14px;
    padding: 10px 12px;
    background: rgba(220,38,38,0.08);
    border: 1px solid rgba(220,38,38,0.18);
    border-radius: 10px;
    color: var(--rf-danger);
    font-size: 13px;
    line-height: 1.4;
  }
  .error.shown { display: block; }
  .trust {
    text-align: center;
    font-size: 11px;
    color: var(--rf-text-tertiary);
    margin-top: 14px;
    letter-spacing: 0.02em;
  }
  .spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid rgba(255,255,255,0.5);
    border-top-color: #fff;
    border-radius: 999px;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
<script src="${payarcJsUrl}" defer></script>
</head>
<body>
  <div class="page">
    <div class="amount-hero">
      <div class="lbl">Trip ${tripCode}</div>
      <div class="amt">${amountLabel}</div>
      <div class="sub">Reservation ${reservationNumber}</div>
    </div>

    <form id="payment-form" class="card-panel" autocomplete="off">
      <label for="card-number">Card number</label>
      <div id="card-number" class="pf-field"></div>

      <div class="row">
        <div>
          <label for="card-expiry">Expiry</label>
          <div id="card-expiry" class="pf-field"></div>
        </div>
        <div>
          <label for="card-cvv">CVV</label>
          <div id="card-cvv" class="pf-field"></div>
        </div>
      </div>

      <button id="pay-button" class="btn" type="submit">
        <span id="pay-label">Pay ${amountLabel}</span>
      </button>

      <button id="cancel-button" class="btn-ghost" type="button">Cancel</button>

      <div id="error" class="error" role="alert" aria-live="polite"></div>
    </form>

    <div class="trust">Secured by PayArc · Encrypted checkout</div>
  </div>

<script>
(function () {
  'use strict';
  var CONFIG = {
    publicKey: '${publicKey}',
    environment: '${environment}',
    chargeUrl: '${chargeUrl}',
    successMatchUrl: '${successMatchUrl}',
    cancelMatchUrl: '${cancelMatchUrl}',
    nonce: '${nonce}'
  };

  var form = document.getElementById('payment-form');
  var button = document.getElementById('pay-button');
  var label = document.getElementById('pay-label');
  var errorEl = document.getElementById('error');
  var cancelBtn = document.getElementById('cancel-button');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('shown');
  }
  function clearError() {
    errorEl.textContent = '';
    errorEl.classList.remove('shown');
  }
  function setLoading(on) {
    button.disabled = !!on;
    label.innerHTML = on
      ? '<span class="spinner"></span> Processing…'
      : 'Pay ' + ${JSON.stringify(amountLabel)};
  }

  cancelBtn.addEventListener('click', function () {
    window.location.href = CONFIG.cancelMatchUrl;
  });

  // TODO(payarc-dashboard): confirm the exact payarc.js global name and
  // Hosted Fields initialization shape. The snippet below follows the
  // pattern documented in the Spreedly gateway guide + payarc.com
  // marketing pages; the real init signature may differ slightly.
  var payarcReady = function () {
    if (!window.PayArc && !window.Payarc && !window.payarc) {
      showError('Secure checkout could not load. Check your connection and try again.');
      return null;
    }
    var PayArcLib = window.PayArc || window.Payarc || window.payarc;
    try {
      return new PayArcLib({
        apiKey: CONFIG.publicKey,
        environment: CONFIG.environment,
        fields: {
          card: '#card-number',
          expiry: '#card-expiry',
          cvc: '#card-cvv'
        }
      });
    } catch (e) {
      showError('Secure checkout failed to initialize. Please try again.');
      return null;
    }
  };

  var instance = null;
  function initWhenReady() {
    instance = payarcReady();
  }
  if (document.readyState === 'complete') {
    initWhenReady();
  } else {
    window.addEventListener('load', initWhenReady);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();
    if (!instance) {
      showError('Secure checkout is still loading. Please wait a moment.');
      return;
    }
    setLoading(true);
    // TODO(payarc-dashboard): confirm exact tokenize method name.
    // Common variants: createToken(), tokenize(), getToken().
    var p = typeof instance.createToken === 'function'
      ? instance.createToken()
      : typeof instance.tokenize === 'function'
        ? instance.tokenize()
        : instance.getToken();

    Promise.resolve(p).then(function (result) {
      if (!result || result.error) {
        setLoading(false);
        showError((result && result.error && result.error.message) || 'Card could not be tokenized.');
        return;
      }
      var tokenId = result.id || result.token_id || result.tokenId || '';
      if (!tokenId) {
        setLoading(false);
        showError('Tokenization returned no token. Please try again.');
        return;
      }
      return fetch(CONFIG.chargeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          nonce: CONFIG.nonce,
          tokenId: tokenId
        })
      }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      }).then(function (r) {
        if (r.ok) {
          window.location.href = CONFIG.successMatchUrl;
        } else {
          setLoading(false);
          showError((r.body && (r.body.error || r.body.message)) || 'Payment could not be completed.');
        }
      }).catch(function () {
        setLoading(false);
        showError('Network error. Please try again.');
      });
    }, function (err) {
      setLoading(false);
      showError((err && err.message) || 'Card could not be tokenized.');
    });
  });
})();
</script>
</body>
</html>`;
}
