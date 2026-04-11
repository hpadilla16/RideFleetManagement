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
