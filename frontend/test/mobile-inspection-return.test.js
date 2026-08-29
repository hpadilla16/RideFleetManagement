/**
 * The mobile inspection's return path must never leave the site.
 *
 * Step 4 can now open the inspection on the SAME device (the agent working
 * alone on a tablet has nothing left to scan the QR with), and passes a
 * `?return=` path so the wizard is one tap away afterwards. That page is
 * reachable with nothing but a handoff token, so an unvalidated return URL
 * would be an open redirect anyone holding a token could aim anywhere.
 */
import { describe, it, expect } from 'vitest';
import { safeReturnPath } from '../src/lib/safe-return-path.js';

describe('safeReturnPath', () => {
  it('accepts the wizard path it exists for', () => {
    expect(safeReturnPath('/reservations/abc123/checkout-wizard-v2'))
      .toBe('/reservations/abc123/checkout-wizard-v2');
    expect(safeReturnPath('/reservations/abc/checkout-wizard-v2?step=4'))
      .toBe('/reservations/abc/checkout-wizard-v2?step=4');
  });

  it('refuses anything that could land on another site', () => {
    for (const evil of [
      'https://evil.example/steal',
      'http://evil.example',
      '//evil.example/steal',          // protocol-relative
      '/\\evil.example',               // backslash some browsers normalise to /
      'javascript:alert(1)',
      '/path:with-colon',              // scheme-ish, refused rather than parsed
      'reservations/abc',              // relative — resolves against this page
      '',
      null,
      undefined,
    ]) {
      expect(safeReturnPath(evil), `${JSON.stringify(evil)} must be refused`).toBe('');
    }
  });

  it('refuses newline injection', () => {
    expect(safeReturnPath(`/ok${String.fromCharCode(13)}${String.fromCharCode(10)}Location: /evil`)).toBe('');
  });

  it('an empty result means the page shows the hand-the-phone-back message', () => {
    // The component treats '' as "no return" and falls back to the original
    // copy — refusing must degrade to the old behavior, never to a dead end.
    expect(safeReturnPath('https://evil.example')).toBe('');
  });
});
