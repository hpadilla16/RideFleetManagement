import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYARC_SESSION_TTL_MS,
  computeAmountDue,
  createCharge,
  dollarsToCents,
  extractPayArcError,
  parseWebhookEvent,
  payarcApiUrl,
  payarcEnabled,
  refundCharge,
  selectPaymentGateway,
  signBridgeNonce,
  verifyBridgeNonce,
  verifyWebhookSignature,
} from './payarc-hosted-fields.js';

// ─── Gateway selector (PR → authnet, US → payarc) ────────────────────────

describe('payarc: gateway selector', () => {
  function enabledConfig() {
    return {
      payarc: {
        enabled: true,
        bearerToken: 'bt_123',
        publicKey: 'pk_test_abc',
      },
    };
  }

  it('PR pickup always routes to authorizenet (even with PayArc enabled)', () => {
    const reservation = {
      pickupLocation: { country: 'Puerto Rico' },
    };
    assert.equal(selectPaymentGateway(reservation, enabledConfig()), 'authorizenet');
  });

  it('PR pickup case-insensitive + ISO "PR" also routes to authorizenet', () => {
    for (const country of ['puerto rico', 'PUERTO RICO', 'Puerto Rico', 'PR']) {
      const reservation = { pickupLocation: { country } };
      assert.equal(
        selectPaymentGateway(reservation, enabledConfig()),
        'authorizenet',
        `country=${country}`,
      );
    }
  });

  it('US pickup with PayArc enabled routes to payarc', () => {
    for (const country of ['USA', 'usa', 'US', 'United States', 'United States of America']) {
      const reservation = { pickupLocation: { country } };
      assert.equal(
        selectPaymentGateway(reservation, enabledConfig()),
        'payarc',
        `country=${country}`,
      );
    }
  });

  it('US pickup with PayArc NOT enabled falls back to authorizenet', () => {
    const reservation = { pickupLocation: { country: 'USA' } };
    assert.equal(selectPaymentGateway(reservation, {}), 'authorizenet');
    assert.equal(
      selectPaymentGateway(reservation, { payarc: { bearerToken: 'x' } }),
      'authorizenet', // missing publicKey
    );
  });

  it('missing pickup location falls back to authorizenet', () => {
    assert.equal(selectPaymentGateway({}, enabledConfig()), 'authorizenet');
    assert.equal(selectPaymentGateway({ pickupLocation: null }, enabledConfig()), 'authorizenet');
  });

  it('payarcEnabled guard rejects explicit disable', () => {
    const cfg = enabledConfig();
    cfg.payarc.enabled = false;
    assert.equal(payarcEnabled(cfg), false);
  });
});

// ─── Amount helpers ──────────────────────────────────────────────────────

describe('payarc: amount helpers', () => {
  it('computeAmountDue subtracts non-voided, non-refunded payments', () => {
    const due = computeAmountDue({
      estimatedTotal: 234,
      payments: [
        { amount: 50 },
        { amount: 100, voided: true },
        { amount: 80, refunded: true },
      ],
    });
    assert.equal(due, 184);
  });

  it('dollarsToCents rounds properly', () => {
    assert.equal(dollarsToCents(234), 23400);
    assert.equal(dollarsToCents(234.5), 23450);
    assert.equal(dollarsToCents(234.504), 23450); // banker's/math-round friendly
    assert.equal(dollarsToCents(0), 0);
    assert.equal(dollarsToCents(null), 0);
  });
});

// ─── Base URL + enablement ───────────────────────────────────────────────

describe('payarc: config helpers', () => {
  it('payarcApiUrl switches on environment', () => {
    assert.match(
      payarcApiUrl({ payarc: { environment: 'sandbox' } }),
      /testapi\.payarc\.net/,
    );
    assert.match(
      payarcApiUrl({ payarc: { environment: 'production' } }),
      /^https:\/\/api\.payarc\.net\/v1$/,
    );
  });
});

// ─── Bridge nonce signing ────────────────────────────────────────────────

describe('payarc: bridge nonce', () => {
  const secret = 'test-secret-key';

  it('round-trips a valid nonce within TTL', () => {
    const token = signBridgeNonce({
      tripCode: 'RF-7251',
      reservationId: 'res-abc',
      amountCents: 23400,
      secret,
    });
    const parsed = verifyBridgeNonce(token, secret);
    assert.ok(parsed);
    assert.equal(parsed.tripCode, 'RF-7251');
    assert.equal(parsed.reservationId, 'res-abc');
    assert.equal(parsed.amountCents, 23400);
  });

  it('rejects a nonce signed with a different secret', () => {
    const token = signBridgeNonce({
      tripCode: 'RF-7251',
      reservationId: 'res-abc',
      amountCents: 23400,
      secret,
    });
    assert.equal(verifyBridgeNonce(token, 'wrong-secret'), null);
  });

  it('rejects a nonce past the TTL', () => {
    const issuedAt = Date.now() - PAYARC_SESSION_TTL_MS - 1000;
    const token = signBridgeNonce({
      tripCode: 'RF-7251',
      reservationId: 'res-abc',
      amountCents: 23400,
      secret,
      issuedAt,
    });
    assert.equal(verifyBridgeNonce(token, secret), null);
  });

  it('rejects malformed tokens', () => {
    assert.equal(verifyBridgeNonce('', secret), null);
    assert.equal(verifyBridgeNonce('not-a-token', secret), null);
    assert.equal(verifyBridgeNonce('a.b', secret), null);
  });
});

// ─── createCharge ────────────────────────────────────────────────────────

describe('payarc: createCharge', () => {
  function cfg() {
    return {
      payarc: {
        environment: 'sandbox',
        bearerToken: 'bt_secret_abc',
        publicKey: 'pk_test_xyz',
      },
    };
  }

  it('POSTs to /v1/charges with Bearer auth + cents amount', async () => {
    let captured = null;
    const fakeFetch = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            id: 'ch_12345',
            amount: 23400,
            currency: 'usd',
            status: 'submitted_for_settlement',
            successful: true,
          },
        }),
      };
    };

    const result = await createCharge({
      tokenId: 'tok_abc',
      amountDollars: 234,
      currency: 'usd',
      description: 'Reservation RF-7251',
      reservationNumber: 'RF-7251',
      config: cfg(),
      deps: { fetchImpl: fakeFetch },
    });
    assert.equal(result.ok, true);
    assert.equal(result.chargeId, 'ch_12345');
    assert.equal(result.amount, 234);
    assert.match(captured.url, /testapi\.payarc\.net\/v1\/charges$/);
    assert.equal(captured.init.headers.Authorization, 'Bearer bt_secret_abc');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.amount, 23400); // cents
    assert.equal(body.source.token_id, 'tok_abc');
    assert.equal(body.description, 'Reservation RF-7251');
  });

  it('throws VALIDATION when tokenId is missing', async () => {
    await assert.rejects(
      createCharge({ amountDollars: 50, config: cfg() }),
      (err) => err.code === 'VALIDATION',
    );
  });

  it('throws VALIDATION when amount is zero', async () => {
    await assert.rejects(
      createCharge({ tokenId: 't', amountDollars: 0, config: cfg() }),
      (err) => err.code === 'VALIDATION',
    );
  });

  it('throws GATEWAY_NOT_CONFIGURED when bearerToken missing', async () => {
    await assert.rejects(
      createCharge({ tokenId: 't', amountDollars: 50, config: {} }),
      (err) => err.code === 'GATEWAY_NOT_CONFIGURED',
    );
  });

  it('throws CARD_DECLINED on declined-card response', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({
        error: { code: 'card_declined', message: 'The card was declined' },
      }),
    });
    await assert.rejects(
      createCharge({
        tokenId: 'tok_declined',
        amountDollars: 100,
        config: cfg(),
        deps: { fetchImpl: fakeFetch },
      }),
      (err) => err.code === 'CARD_DECLINED' && /declined/i.test(err.message),
    );
  });
});

// ─── refundCharge ────────────────────────────────────────────────────────

describe('payarc: refundCharge', () => {
  function cfg() {
    return {
      payarc: { environment: 'sandbox', bearerToken: 'bt_x', publicKey: 'pk_x' },
    };
  }

  it('hits /void first when preferVoid=true and returns kind=void on 200', async () => {
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { id: 'ch_1', status: 'voided' } }),
      };
    };
    const out = await refundCharge({
      chargeId: 'ch_1',
      amountDollars: 50,
      config: cfg(),
      deps: { fetchImpl: fakeFetch },
    });
    assert.equal(out.kind, 'void');
    assert.match(calls[0], /\/charges\/ch_1\/void$/);
  });

  it('falls through to /refunds when /void fails', async () => {
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/void')) {
        return { ok: false, status: 409, text: async () => '{"error":{"message":"already settled"}}' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { id: 're_1', status: 'refunded' } }),
      };
    };
    const out = await refundCharge({
      chargeId: 'ch_1',
      amountDollars: 50,
      config: cfg(),
      deps: { fetchImpl: fakeFetch },
    });
    assert.equal(out.kind, 'refund');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /\/charges\/ch_1\/refunds$/);
  });
});

// ─── Error mapping ───────────────────────────────────────────────────────

describe('payarc: extractPayArcError', () => {
  it('maps card_declined → CARD_DECLINED', () => {
    const r = extractPayArcError({ error: { code: 'card_declined', message: 'Declined' } }, 402);
    assert.equal(r.code, 'CARD_DECLINED');
    assert.match(r.message, /declined/i);
  });

  it('maps invalid_cvc → CARD_INVALID_CVC', () => {
    const r = extractPayArcError({ code: 'invalid_cvc', message: 'Bad CVC' }, 400);
    assert.equal(r.code, 'CARD_INVALID_CVC');
  });

  it('maps expired_card → CARD_EXPIRED', () => {
    const r = extractPayArcError({ code: 'expired_card' }, 400);
    assert.equal(r.code, 'CARD_EXPIRED');
  });

  it('maps 401 → GATEWAY_NOT_CONFIGURED', () => {
    const r = extractPayArcError({}, 401);
    assert.equal(r.code, 'GATEWAY_NOT_CONFIGURED');
  });

  it('maps 5xx → GATEWAY_ERROR', () => {
    const r = extractPayArcError({}, 502);
    assert.equal(r.code, 'GATEWAY_ERROR');
  });
});

// ─── Webhook parsing + signature ─────────────────────────────────────────

describe('payarc: webhook', () => {
  it('parseWebhookEvent pulls charge id + reservationNumber from description', () => {
    const parsed = parseWebhookEvent({
      event: 'charge.succeeded',
      data: {
        id: 'ch_abc',
        amount: 23400,
        status: 'succeeded',
        description: 'Reservation RF-7251',
      },
    });
    assert.equal(parsed.chargeId, 'ch_abc');
    assert.equal(parsed.amountCents, 23400);
    assert.equal(parsed.amountDollars, 234);
    assert.equal(parsed.reservationNumber, 'RF-7251');
    assert.equal(parsed.isSuccess, true);
    assert.equal(parsed.isRefund, false);
  });

  it('parseWebhookEvent flags refund events', () => {
    const parsed = parseWebhookEvent({
      event: 'charge.refunded',
      data: { id: 'ch_r', status: 'refunded', description: 'Reservation RF-1' },
    });
    assert.equal(parsed.isRefund, true);
    assert.equal(parsed.isSuccess, false);
  });

  it('verifyWebhookSignature accepts matching Bearer token', () => {
    const ok = verifyWebhookSignature({
      rawBody: '{"hi":1}',
      headers: { authorization: 'Bearer secret-123' },
      webhookSecret: 'secret-123',
    });
    assert.equal(ok, true);
  });

  it('verifyWebhookSignature rejects wrong Bearer', () => {
    const ok = verifyWebhookSignature({
      rawBody: '{"hi":1}',
      headers: { authorization: 'Bearer wrong' },
      webhookSecret: 'secret-123',
    });
    assert.equal(ok, false);
  });

  it('verifyWebhookSignature accepts matching HMAC-SHA256 header', async () => {
    const crypto = await import('node:crypto');
    const body = '{"hi":1}';
    const secret = 'secret-123';
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const ok = verifyWebhookSignature({
      rawBody: body,
      headers: { 'x-payarc-signature': `sha256=${sig}` },
      webhookSecret: secret,
    });
    assert.equal(ok, true);
  });

  it('verifyWebhookSignature rejects when no secret configured', () => {
    const ok = verifyWebhookSignature({
      rawBody: '{}',
      headers: { authorization: 'Bearer whatever' },
      webhookSecret: '',
    });
    assert.equal(ok, false);
  });
});
