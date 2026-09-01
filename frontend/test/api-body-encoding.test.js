/**
 * api() serialises request bodies, so no call site has to remember to.
 *
 * `fetch` turns a plain object into the literal string "[object Object]".
 * Rent & Go hit it saving quote add-ons: the request reached the server as
 * garbage and the modal showed `"[object Object]" is not valid JSON`, which
 * reads like a server fault and is not (2026-08-20). Two call sites had the
 * bug and every future one would have been a coin flip, because the correct
 * spelling — JSON.stringify — is the one you have to remember.
 *
 * The wrapper does it now. These pin both halves: objects get encoded, and
 * the body types the browser owns are left alone so uploads keep working.
 */
import { describe, it, expect } from 'vitest';
import { encodeBody } from '../src/lib/client';

describe('encodeBody', () => {
  it('encodes the plain object that caused the bug', () => {
    const addOns = [{ kind: 'SERVICE', code: 'ROAD247' }];
    expect(encodeBody({ addOns })).toBe(JSON.stringify({ addOns }));
    // The failure mode itself: never the literal "[object Object]".
    expect(encodeBody({ addOns })).not.toBe(String({ addOns }));
  });

  it('leaves an already-stringified body untouched', () => {
    // Most of the app spells it out; double-encoding would break all of it.
    const json = JSON.stringify({ amount: 12.5 });
    expect(encodeBody(json)).toBe(json);
  });

  it('never touches the body types the browser owns', () => {
    const fd = new FormData();
    fd.append('file', 'x');
    expect(encodeBody(fd)).toBe(fd);

    const params = new URLSearchParams({ a: '1' });
    expect(encodeBody(params)).toBe(params);

    const blob = new Blob(['hello']);
    expect(encodeBody(blob)).toBe(blob);

    const bytes = new Uint8Array([1, 2, 3]);
    expect(encodeBody(bytes)).toBe(bytes);
  });

  it('passes null and undefined through, so GETs stay bodyless', () => {
    expect(encodeBody(undefined)).toBe(undefined);
    expect(encodeBody(null)).toBe(null);
  });

  it('encodes arrays and nested structures', () => {
    expect(encodeBody([1, 2])).toBe('[1,2]');
    expect(encodeBody({ a: { b: [1] } })).toBe('{"a":{"b":[1]}}');
  });
});
