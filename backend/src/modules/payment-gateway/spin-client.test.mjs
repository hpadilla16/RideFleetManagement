import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spinClient } from './spin-client.js';

describe('SPIn Client normalizeResponse', () => {
  it('normalizes an approved sale response', () => {
    const raw = {
      GeneralResponse: { StatusCode: '0000', ResultCode: 0, Message: 'Approved', DetailedMessage: 'Transaction approved' },
      AuthCode: '123456',
      ReferenceId: 'REF-001',
      Token: 'tok_abc123',
      IPosToken: 'ipos_xyz',
      CardData: { CardType: 'Visa', EntryType: 'Chip', Last4: '4242', First4: '4111', BIN: '411111', ExpirationDate: '12/28', Name: 'JOHN DOE' },
      BatchNumber: '001',
      SerialNumber: 'SN123',
      PaymentType: 'Credit',
      TransactionType: 'Sale',
    };
    const result = spinClient.normalizeResponse(raw);
    assert.equal(result.approved, true);
    assert.equal(result.statusCode, '0000');
    assert.equal(result.authCode, '123456');
    assert.equal(result.token, 'tok_abc123');
    assert.equal(result.iposToken, 'ipos_xyz');
    assert.equal(result.cardData.last4, '4242');
    assert.equal(result.cardData.cardType, 'Visa');
    assert.equal(result.cardData.name, 'JOHN DOE');
    assert.equal(result.batchNumber, '001');
    assert.equal(result.paymentType, 'Credit');
  });

  it('normalizes a declined response', () => {
    const raw = {
      GeneralResponse: { StatusCode: '1015', ResultCode: 1, Message: 'Declined', DetailedMessage: 'Insufficient funds' },
      ReferenceId: 'REF-002',
    };
    const result = spinClient.normalizeResponse(raw);
    assert.equal(result.approved, false);
    assert.equal(result.statusCode, '1015');
    assert.equal(result.message, 'Declined');
    assert.equal(result.detailedMessage, 'Insufficient funds');
    assert.equal(result.cardData, null);
    assert.equal(result.token, '');
  });

  it('normalizes an empty response', () => {
    const result = spinClient.normalizeResponse({});
    assert.equal(result.approved, false);
    assert.equal(result.statusCode, '');
    assert.equal(result.authCode, '');
    assert.equal(result.cardData, null);
  });

  it('normalizes null response', () => {
    const result = spinClient.normalizeResponse(null);
    assert.equal(result.approved, false);
  });

  it('extracts card entry type', () => {
    const raw = {
      GeneralResponse: { StatusCode: '0000', ResultCode: 0 },
      CardData: { EntryType: 'Contactless', Last4: '1234' },
    };
    const result = spinClient.normalizeResponse(raw);
    assert.equal(result.cardData.entryType, 'Contactless');
    assert.equal(result.cardData.last4, '1234');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2026-05-29 — Launch-hardening regression tests. These pin the
// behaviour of the new sandbox/dry-run/iPOS-token request shape so a
// future refactor can't accidentally route real cards to the sandbox
// endpoint or drop the GetToken flag (which would silently break the
// CNP deposit hold).
// ─────────────────────────────────────────────────────────────────────

describe('SPIn Client dry-run + iPOS token request shape', () => {
  it('dry-run sale returns a synthetic IPosToken so CNP hold path stays exercised in dev', async () => {
    const prev = { dry: process.env.SPIN_DRY_RUN, tpn: process.env.SPIN_TPN, key: process.env.SPIN_AUTH_KEY };
    process.env.SPIN_DRY_RUN = 'true';
    try {
      const resp = await spinClient.sale({ amount: 49.99, referenceId: 'TEST-REF' }, {});
      assert.equal(String(resp.GeneralResponse?.StatusCode), '0000');
      assert.ok(resp.IPosToken, 'dry-run response should include IPosToken');
      assert.ok(resp.AuthCode, 'dry-run response should include AuthCode');
      const card = spinClient.extractCardOnFile(resp);
      assert.ok(card?.token, 'extractCardOnFile should pick up the IPosToken');
      assert.equal(card.last4, '4242');
    } finally {
      process.env.SPIN_DRY_RUN = prev.dry || '';
      process.env.SPIN_TPN = prev.tpn || '';
      process.env.SPIN_AUTH_KEY = prev.key || '';
    }
  });

  it('dry-run preAuthDeposit with token returns approval (CNP simulation)', async () => {
    const prev = process.env.SPIN_DRY_RUN;
    process.env.SPIN_DRY_RUN = 'true';
    try {
      const resp = await spinClient.preAuthDeposit({
        amount: 500, referenceId: 'TEST-DEP', token: 'ipos_xyz',
      }, {});
      const norm = spinClient.normalizeResponse(resp);
      assert.equal(norm.approved, true);
      assert.ok(norm.authCode);
    } finally {
      process.env.SPIN_DRY_RUN = prev || '';
    }
  });

  it('void carries the original amount (dry-run) — and refuses to run without one', async () => {
    const prev = process.env.SPIN_DRY_RUN;
    process.env.SPIN_DRY_RUN = 'true';
    try {
      // 2026-09-04, proven live at LAX: a void without the original Amount is
      // refused by the gateway with 2201, so the client refuses it up front
      // rather than guessing at the size of somebody's refund.
      await assert.rejects(
        () => spinClient.void({ referenceId: 'TEST-VOID' }, {}),
        /requires the original amount/i,
      );
      const resp = await spinClient.void({ referenceId: 'TEST-VOID', amount: 1.01 }, {});
      assert.equal(String(resp.GeneralResponse?.StatusCode), '0000');
    } finally {
      process.env.SPIN_DRY_RUN = prev || '';
    }
  });

  it('missing TPN throws a clear error (no silent sandbox fallback)', async () => {
    const prev = { dry: process.env.SPIN_DRY_RUN, tpn: process.env.SPIN_TPN, key: process.env.SPIN_AUTH_KEY };
    process.env.SPIN_DRY_RUN = '';
    process.env.SPIN_TPN = '';
    process.env.SPIN_AUTH_KEY = 'fake';
    try {
      await assert.rejects(
        () => spinClient.sale({ amount: 10, referenceId: 'X' }, {}),
        /TPN is not configured/i,
      );
    } finally {
      process.env.SPIN_DRY_RUN = prev.dry || '';
      process.env.SPIN_TPN = prev.tpn || '';
      process.env.SPIN_AUTH_KEY = prev.key || '';
    }
  });

  it('missing AuthKey throws a clear error', async () => {
    const prev = { dry: process.env.SPIN_DRY_RUN, tpn: process.env.SPIN_TPN, key: process.env.SPIN_AUTH_KEY };
    process.env.SPIN_DRY_RUN = '';
    process.env.SPIN_TPN = 'fake';
    process.env.SPIN_AUTH_KEY = '';
    try {
      await assert.rejects(
        () => spinClient.sale({ amount: 10, referenceId: 'X' }, {}),
        /authKey is not configured/i,
      );
    } finally {
      process.env.SPIN_DRY_RUN = prev.dry || '';
      process.env.SPIN_TPN = prev.tpn || '';
      process.env.SPIN_AUTH_KEY = prev.key || '';
    }
  });

  it('chargeWithToken without a token throws synchronously', async () => {
    await assert.rejects(
      () => spinClient.chargeWithToken({ amount: 10, referenceId: 'X' }, {}),
      /requires a token/i,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2026-09-04 — busy-only retry on the sale (second live checkout at
// LAX). The sale fires seconds after GetSignature releases the
// terminal — the same ~30-50s closing window the void and the deposit
// pre-auth already wait out. The rule these tests pin: busy retries
// honouring DelayBeforeNextRequest, refusals throw immediately.
// ─────────────────────────────────────────────────────────────────────

describe('SPIn Client sale busy-retry', () => {
  const cfg = { spinAuthKey: 'testkey123', spinTpn: '000011112222' };

  function stubFetch(t, responses) {
    const orig = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      const body = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    t.after(() => { global.fetch = orig; });
    return () => calls;
  }

  const busy2008 = {
    GeneralResponse: {
      StatusCode: '2008', ResultCode: 1,
      Message: 'Terminal in use', DetailedMessage: 'Terminal in use, please wait 30 sec',
      DelayBeforeNextRequest: '2',
    },
  };
  const approved = {
    GeneralResponse: { StatusCode: '0000', ResultCode: 0, Message: 'Approved' },
    AuthCode: 'A1B2C3', ReferenceId: 'BUSY-1',
  };
  const rejected2201 = {
    GeneralResponse: { StatusCode: '2201', ResultCode: 2, Message: 'Error', DetailedMessage: 'The Amount field is required.' },
  };

  it('waits out a busy terminal, honouring the gateway countdown, then succeeds', async (t) => {
    const callCount = stubFetch(t, [busy2008, approved]);
    const sleeps = [];
    const resp = await spinClient.sale({
      amount: 1.01, referenceId: 'BUSY-1', sleep: async (ms) => sleeps.push(ms),
    }, cfg);
    assert.equal(resp.AuthCode, 'A1B2C3');
    assert.equal(callCount(), 2);
    assert.deepEqual(sleeps, [2000], 'the wait is the gateway DelayBeforeNextRequest, not a guess');
  });

  it('a 2201 refusal throws immediately — an identical resend cannot help and this is money', async (t) => {
    const callCount = stubFetch(t, [rejected2201, approved]);
    const sleeps = [];
    await assert.rejects(
      () => spinClient.sale({ amount: 1.01, referenceId: 'REF-1', sleep: async (ms) => sleeps.push(ms) }, cfg),
      (err) => String(err?.spinStatusCode) === '2201',
    );
    assert.equal(callCount(), 1, 'no second attempt on a refusal');
    assert.deepEqual(sleeps, []);
  });

  it('gives up after the configured attempts if the terminal never frees up', async (t) => {
    const callCount = stubFetch(t, [busy2008, busy2008, busy2008, busy2008]);
    const sleeps = [];
    await assert.rejects(
      () => spinClient.sale({ amount: 1.01, referenceId: 'BUSY-2', attempts: 3, sleep: async (ms) => sleeps.push(ms) }, cfg),
      (err) => String(err?.spinStatusCode) === '2008',
    );
    assert.equal(callCount(), 3);
    assert.equal(sleeps.length, 2, 'no sleep after the final attempt');
  });
});
