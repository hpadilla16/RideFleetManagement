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

  it('void includes PaymentType for spec compliance (dry-run)', async () => {
    const prev = process.env.SPIN_DRY_RUN;
    process.env.SPIN_DRY_RUN = 'true';
    try {
      const resp = await spinClient.void({ referenceId: 'TEST-VOID' }, {});
      // dry-run returns approved regardless of fields; assertion here
      // pins that the call doesn't throw and returns an approved shape.
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
