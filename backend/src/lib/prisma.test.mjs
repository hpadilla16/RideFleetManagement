import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Import from prisma-url.js (the pure helper) NOT prisma.js so the test
// doesn't spawn PrismaClient / the query engine. prisma.js re-exports
// appendPoolParams for runtime callers; tests stay engine-free.
import { appendPoolParams } from './prisma-url.js';

// Pin the behavior of appendPoolParams so future tweaks can't silently
// regress the production pool sizing math (see code comment in prisma.js
// for the per-worker × workers × droplets capacity calculation).
describe('appendPoolParams', () => {
  const baseUrl = 'postgresql://u:p@localhost:5432/db';

  it('bare postgres URL gets all four params with defaults', () => {
    const out = appendPoolParams(baseUrl, {});
    assert.match(out, /\?connection_limit=6&pool_timeout=10&options=/);
    assert.match(out, /statement_timeout%3D15000/);
    assert.match(out, /idle_in_transaction_session_timeout%3D30000/);
  });

  it('uses & when URL already has a query string', () => {
    const url = `${baseUrl}?schema=public`;
    const out = appendPoolParams(url, {});
    assert.ok(out.startsWith(`${url}&connection_limit=6`));
    assert.match(out, /&pool_timeout=10&options=/);
  });

  it('preserves baked connection_limit, appends the others', () => {
    const url = `${baseUrl}?connection_limit=15`;
    const out = appendPoolParams(url, {});
    // Original connection_limit untouched
    assert.match(out, /[?&]connection_limit=15(&|$)/);
    // Should NOT also append connection_limit=6
    assert.equal((out.match(/connection_limit=/g) || []).length, 1);
    // But pool_timeout + options should still get appended
    assert.match(out, /&pool_timeout=10/);
    assert.match(out, /&options=/);
  });

  it('preserves baked pool_timeout', () => {
    const url = `${baseUrl}?pool_timeout=30`;
    const out = appendPoolParams(url, {});
    assert.match(out, /pool_timeout=30/);
    assert.equal((out.match(/pool_timeout=/g) || []).length, 1);
    assert.match(out, /&connection_limit=6/);
  });

  it('preserves existing options string (does not double-append)', () => {
    const url = `${baseUrl}?options=-c%20search_path%3Dpublic`;
    const out = appendPoolParams(url, {});
    assert.equal((out.match(/options=/g) || []).length, 1);
    assert.match(out, /options=-c%20search_path%3Dpublic/);
    // Other params still appended
    assert.match(out, /&connection_limit=6/);
    assert.match(out, /&pool_timeout=10/);
  });

  it('returns input unchanged when all four params are baked', () => {
    const url =
      `${baseUrl}?connection_limit=20&pool_timeout=5&options=-c%20foo%3Dbar`;
    const out = appendPoolParams(url, {});
    assert.equal(out, url);
  });

  it('honors DATABASE_POOL_SIZE env override', () => {
    const out = appendPoolParams(baseUrl, { DATABASE_POOL_SIZE: '12' });
    assert.match(out, /connection_limit=12/);
  });

  it('honors DATABASE_POOL_TIMEOUT env override', () => {
    const out = appendPoolParams(baseUrl, { DATABASE_POOL_TIMEOUT: '20' });
    assert.match(out, /pool_timeout=20/);
  });

  it('honors DATABASE_STATEMENT_TIMEOUT_MS env override', () => {
    const out = appendPoolParams(baseUrl, { DATABASE_STATEMENT_TIMEOUT_MS: '5000' });
    assert.match(out, /statement_timeout%3D5000/);
  });

  it('honors DATABASE_IDLE_TX_TIMEOUT_MS env override', () => {
    const out = appendPoolParams(baseUrl, { DATABASE_IDLE_TX_TIMEOUT_MS: '60000' });
    assert.match(out, /idle_in_transaction_session_timeout%3D60000/);
  });

  it('handles empty / undefined URL gracefully', () => {
    assert.equal(appendPoolParams('', {}), '');
    assert.equal(appendPoolParams(undefined, {}), undefined);
    assert.equal(appendPoolParams(null, {}), null);
  });
});
