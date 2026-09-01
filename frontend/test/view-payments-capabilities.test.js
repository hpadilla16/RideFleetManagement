/**
 * View Payments capability helpers — the pure half of the capability→control
 * matrix. The render tests prove what the page draws; these pin the rules the
 * page keys off, including the one money-path guard that must never regress:
 * autoReconcileArmed() is FALSE for anything that is not a confirmed
 * Authorize.Net tenant — including unknown/failed capabilities.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeCapabilities,
  capabilityFlags,
  autoReconcileArmed,
  parseReference,
  refundKind
} from '../src/app/reservations/[id]/payments/payments-capabilities';

describe('normalizeCapabilities', () => {
  it('accepts a sane payload and coerces to booleans', () => {
    const caps = normalizeCapabilities({
      gateway: 'IPOS',
      spin: { enabled: true },
      ipos: { enabled: true, linkReady: 'yes' }, // non-boolean → false
      authorizenet: { enabled: 1 }
    });
    expect(caps.gateway).toBe('ipos');
    expect(caps.spin.enabled).toBe(true);
    expect(caps.ipos.enabled).toBe(true);
    expect(caps.ipos.linkReady).toBe(false);
    expect(caps.authorizenet.enabled).toBe(false);
  });

  it('rejects garbage shapes (null → page fails open)', () => {
    for (const raw of [null, undefined, 'ipos', 42, {}, { gateway: 7 }]) {
      expect(normalizeCapabilities(raw)).toBeNull();
    }
  });
});

describe('capabilityFlags', () => {
  it('maps each gateway to exactly one mode', () => {
    expect(capabilityFlags({ gateway: 'ipos' })).toMatchObject({ known: true, gwIpos: true, gwAuthnet: false, gwLinkOnly: false });
    expect(capabilityFlags({ gateway: 'authorizenet' })).toMatchObject({ gwAuthnet: true, gwIpos: false });
    expect(capabilityFlags({ gateway: 'stripe' })).toMatchObject({ gwLinkOnly: true, gwAuthnet: false });
    expect(capabilityFlags({ gateway: 'square' })).toMatchObject({ gwLinkOnly: true });
    expect(capabilityFlags(null)).toMatchObject({ known: false, gwAuthnet: false, gwIpos: false, gwLinkOnly: false });
  });
});

describe('autoReconcileArmed — the loop that used to fire for every tenant', () => {
  const web = { isWebReservation: true, unpaid: 212.4 };
  it('arms ONLY for a confirmed authorizenet tenant + WEB reservation + balance', () => {
    expect(autoReconcileArmed({ caps: { gateway: 'authorizenet' }, ...web })).toBe(true);
  });
  it('never arms for ipos / stripe / square tenants', () => {
    for (const gateway of ['ipos', 'stripe', 'square']) {
      expect(autoReconcileArmed({ caps: { gateway }, ...web })).toBe(false);
    }
  });
  it('never arms while capabilities are unknown (loading or failed fetch)', () => {
    expect(autoReconcileArmed({ caps: null, ...web })).toBe(false);
    expect(autoReconcileArmed({ caps: undefined, ...web })).toBe(false);
  });
  it('still requires the WEB- channel and a positive balance', () => {
    expect(autoReconcileArmed({ caps: { gateway: 'authorizenet' }, isWebReservation: false, unpaid: 10 })).toBe(false);
    expect(autoReconcileArmed({ caps: { gateway: 'authorizenet' }, isWebReservation: true, unpaid: 0 })).toBe(false);
  });
});

describe('parseReference — processor chips instead of raw prefixes', () => {
  it('splits machine references', () => {
    expect(parseReference('IPOS:K1a2b3')).toMatchObject({ prefix: 'IPOS', label: 'IPOS', value: 'K1a2b3' });
    expect(parseReference('AUTHNET:120058491022')).toMatchObject({ prefix: 'AUTHNET', value: '120058491022' });
    expect(parseReference('SPIN:DVJ-88213')).toMatchObject({ prefix: 'SPIN', value: 'DVJ-88213' });
    // longest-match-first: SPIN_RELEASE must not parse as SPIN with a mangled value
    expect(parseReference('SPIN_RELEASE:abc')).toMatchObject({ prefix: 'SPIN_RELEASE', label: 'SPIN', value: 'abc' });
    expect(parseReference('PAYARC:tx_1')).toMatchObject({ prefix: 'PAYARC', value: 'tx_1' });
    expect(parseReference('REFUND:pm_8d21')).toMatchObject({ prefix: 'REFUND', value: 'pm_8d21' });
  });
  it('passes human-typed references through with no chip', () => {
    for (const raw of ['****1234 · auth A8K2X9', 'OTC-1756224061', 'A8K2X9', '']) {
      const parsed = parseReference(raw);
      expect(parsed.prefix).toBeNull();
      expect(parsed.value).toBe(raw.trim());
    }
  });
});

describe('refundKind — mirrors backend reference-prefix routing', () => {
  it('AUTHNET:/PAYARC: rows produce a real card refund', () => {
    expect(refundKind('AUTHNET:120058491022')).toBe('card');
    expect(refundKind('PAYARC:tx_1')).toBe('card');
  });
  it('everything else is a bookkeeping-only negative row', () => {
    for (const raw of ['IPOS:K1a2b3', 'SPIN:DVJ-88213', 'OTC-1756224061', '****1234', '']) {
      expect(refundKind(raw)).toBe('record');
    }
  });
});
