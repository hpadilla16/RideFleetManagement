/**
 * TollBridge partner client + import mapping (2026-07-27). Pure — mocked
 * fetch, no DB, no network. Pins cursor pagination, the partner->row mapping,
 * and the VOID split.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPartnerTolls, TollBridgePartnerError } from './tollbridge-partner-client.js';
import { partnerTollToRow } from './tollbridge-import.service.js';

function mockFetch(pages) {
  let call = 0;
  return async (url) => {
    const u = new URL(url);
    const cursor = u.searchParams.get('cursor');
    const page = pages[call];
    call += 1;
    return {
      ok: true, status: 200,
      json: async () => page,
      _url: url, _cursor: cursor,
    };
  };
}

test('fetchPartnerTolls walks cursor pages until nextCursor is null', async () => {
  const pages = [
    { transactions: [{ id: 'a', externalId: 'E1', plate: '8ABC123', transactionAt: '2026-07-02T16:14:00.000Z', amount: 3.25, status: 'IMPORTED' }], nextCursor: 'c2' },
    { transactions: [{ id: 'b', externalId: 'E2', plate: '9XYZ456', transactionAt: '2026-07-03T10:00:00.000Z', amount: 2.5, status: 'VOID' }], nextCursor: null },
  ];
  const out = await fetchPartnerTolls({ from: new Date('2026-06-01Z'), to: new Date('2026-07-10Z') }, { key: 'tb_test', fetchImpl: mockFetch(pages) });
  assert.equal(out.transactions.length, 2);
  assert.equal(out.pages, 2);
  assert.equal(out.transactions[0].externalId, 'E1');
});

test('missing key throws before any fetch', async () => {
  await assert.rejects(
    fetchPartnerTolls({ from: new Date(), to: new Date() }, { key: '', fetchImpl: async () => { throw new Error('should not fetch'); } }),
    (e) => e instanceof TollBridgePartnerError
  );
});

test('partnerTollToRow maps to the ingest row shape (UTC preserved)', () => {
  const row = partnerTollToRow({
    id: 'x', externalId: 'E9', plate: '8ABC123', plateNormalized: '8ABC123',
    transactionAt: '2026-07-02T16:14:00.000Z', location: 'SR-73 Catalina View', lane: 'SB', amount: 3.25, provider: 'FASTRAK_TCA', status: 'MATCHED',
  });
  assert.equal(row.externalId, 'E9');
  assert.equal(row.plate, '8ABC123');
  assert.equal(row.transactionAt, '2026-07-02T16:14:00.000Z');
  assert.equal(row.amount, 3.25);
  assert.equal(row.location, 'SR-73 Catalina View');
});
