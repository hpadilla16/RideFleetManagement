import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tenantKey, globalKey } from './tenantKey.js';

describe('tenantKey', () => {
  it('builds the expected key from a string tenantId and parts', () => {
    assert.equal(
      tenantKey('abc-123', 'reservations', 'list', 1),
      't:abc-123:reservations:list:1'
    );
  });

  it('coerces a numeric tenantId to its decimal string form', () => {
    assert.equal(tenantKey(42, 'fees', 'list'), 't:42:fees:list');
  });

  it('joins multiple parts with ":" preserving order', () => {
    assert.equal(
      tenantKey('t1', 'kb', 'list', 'guides', 'PUBLISHED', 1, 50),
      't:t1:kb:list:guides:PUBLISHED:1:50'
    );
  });

  it('coerces boolean parts to "true"/"false"', () => {
    assert.equal(tenantKey('t1', 'flag', true), 't:t1:flag:true');
  });

  it('throws TypeError on null tenantId', () => {
    assert.throws(() => tenantKey(null, 'x'), TypeError);
  });

  it('throws TypeError on undefined tenantId', () => {
    assert.throws(() => tenantKey(undefined, 'x'), TypeError);
  });

  it('throws TypeError on empty-string tenantId', () => {
    assert.throws(() => tenantKey('', 'x'), TypeError);
  });

  it('throws TypeError on non-string/non-number tenantId', () => {
    assert.throws(() => tenantKey({ id: 't1' }, 'x'), TypeError);
    assert.throws(() => tenantKey(true, 'x'), TypeError);
  });

  it('throws TypeError when no parts are supplied', () => {
    assert.throws(() => tenantKey('t1'), TypeError);
  });

  it('throws TypeError when any part is null or undefined', () => {
    assert.throws(() => tenantKey('t1', 'a', null), TypeError);
    assert.throws(() => tenantKey('t1', undefined), TypeError);
  });

  it('throws TypeError when a part is an object', () => {
    assert.throws(() => tenantKey('t1', { scope: 'x' }), TypeError);
  });
});

describe('globalKey', () => {
  it('builds the expected key from parts', () => {
    assert.equal(globalKey('reservations', 'list', 1), 'global:reservations:list:1');
  });

  it('accepts a single part', () => {
    assert.equal(globalKey('locations'), 'global:locations');
  });

  it('coerces numeric parts to strings', () => {
    assert.equal(globalKey('page', 7), 'global:page:7');
  });

  it('throws TypeError when no parts are supplied', () => {
    assert.throws(() => globalKey(), TypeError);
  });

  it('throws TypeError when any part is null/undefined/object', () => {
    assert.throws(() => globalKey('a', null), TypeError);
    assert.throws(() => globalKey(undefined), TypeError);
    assert.throws(() => globalKey('a', { x: 1 }), TypeError);
  });
});
