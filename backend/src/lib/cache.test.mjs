import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cache } from './cache.js';

describe('TTL Cache', () => {
  beforeEach(() => cache.clear());

  it('set and get a value', () => {
    cache.set('key1', 'value1');
    assert.equal(cache.get('key1'), 'value1');
  });

  it('returns undefined for missing key', () => {
    assert.equal(cache.get('nonexistent'), undefined);
  });

  it('expires after TTL', async () => {
    cache.set('short', 'data', 50); // 50ms TTL
    assert.equal(cache.get('short'), 'data');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(cache.get('short'), undefined);
  });

  it('del removes a key', () => {
    cache.set('to-delete', 'value');
    cache.del('to-delete');
    assert.equal(cache.get('to-delete'), undefined);
  });

  it('invalidate removes keys by prefix', () => {
    cache.set('kb:list:a', 1);
    cache.set('kb:list:b', 2);
    cache.set('other:key', 3);
    cache.invalidate('kb:list:');
    assert.equal(cache.get('kb:list:a'), undefined);
    assert.equal(cache.get('kb:list:b'), undefined);
    assert.equal(cache.get('other:key'), 3);
  });

  it('clear removes everything', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), undefined);
  });

  it('getOrSet returns cached value on hit', async () => {
    cache.set('cached', 42);
    let called = false;
    const result = await cache.getOrSet('cached', () => { called = true; return 99; });
    assert.equal(result, 42);
    assert.equal(called, false);
  });

  it('getOrSet calls fn on miss and caches', async () => {
    const result = await cache.getOrSet('miss', () => 'computed', 1000);
    assert.equal(result, 'computed');
    assert.equal(cache.get('miss'), 'computed');
  });

  it('stats returns size', () => {
    cache.set('x', 1);
    cache.set('y', 2);
    const s = cache.stats();
    assert.equal(s.size, 2);
    assert.ok(s.maxEntries > 0);
  });

  // L-1 (Redis pub/sub for cross-worker invalidation): the new cache.js
  // ships with optional Redis fan-out for del / invalidate / clear events.
  // When REDIS_URL is unset (the case in this test run), behavior must be
  // identical to the old in-memory-only implementation. These tests pin
  // that contract so a future Redis change can't silently regress local
  // behavior.
  it('stats reports redis as not configured when REDIS_URL is unset', () => {
    const s = cache.stats();
    assert.ok(s.redis, 'stats should always include a redis section');
    assert.equal(s.redis.configured, false);
    assert.equal(s.redis.ready, false);
  });

  it('del / invalidate / clear still work synchronously without REDIS_URL', () => {
    cache.set('a:1', 1);
    cache.set('a:2', 2);
    cache.set('b:1', 3);

    // Sync del — both the local entry is gone AND the call returns sync
    cache.del('a:1');
    assert.equal(cache.get('a:1'), undefined);
    assert.equal(cache.get('a:2'), 2, 'sibling key untouched');

    // Sync invalidate-by-prefix
    cache.invalidate('a:');
    assert.equal(cache.get('a:2'), undefined);
    assert.equal(cache.get('b:1'), 3, 'other-prefix key untouched');

    // Sync clear
    cache.clear();
    assert.equal(cache.get('b:1'), undefined);
  });
});
