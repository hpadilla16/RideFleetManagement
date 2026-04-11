import { describe, it, expect } from 'vitest';
import en from '../src/locales/en.json';
import es from '../src/locales/es.json';

describe('i18n translation files', () => {
  it('EN has all top-level sections', () => {
    expect(en.nav).toBeDefined();
    expect(en.topbar).toBeDefined();
    expect(en.lockScreen).toBeDefined();
    expect(en.dashboard).toBeDefined();
    expect(en.login).toBeDefined();
    expect(en.common).toBeDefined();
    expect(en.status).toBeDefined();
  });

  it('ES has all top-level sections', () => {
    expect(es.nav).toBeDefined();
    expect(es.topbar).toBeDefined();
    expect(es.lockScreen).toBeDefined();
    expect(es.dashboard).toBeDefined();
    expect(es.login).toBeDefined();
    expect(es.common).toBeDefined();
    expect(es.status).toBeDefined();
  });

  it('EN and ES have same keys in nav', () => {
    const enKeys = Object.keys(en.nav).sort();
    const esKeys = Object.keys(es.nav).sort();
    expect(enKeys).toEqual(esKeys);
  });

  it('EN and ES have same keys in topbar', () => {
    expect(Object.keys(en.topbar).sort()).toEqual(Object.keys(es.topbar).sort());
  });

  it('EN and ES have same keys in lockScreen', () => {
    expect(Object.keys(en.lockScreen).sort()).toEqual(Object.keys(es.lockScreen).sort());
  });

  it('EN and ES have same keys in common', () => {
    expect(Object.keys(en.common).sort()).toEqual(Object.keys(es.common).sort());
  });

  it('EN and ES have same keys in status', () => {
    expect(Object.keys(en.status).sort()).toEqual(Object.keys(es.status).sort());
  });

  it('all nav items have non-empty values in both languages', () => {
    for (const key of Object.keys(en.nav)) {
      expect(en.nav[key].length).toBeGreaterThan(0);
      expect(es.nav[key].length).toBeGreaterThan(0);
    }
  });

  it('EN nav has 17 items', () => {
    expect(Object.keys(en.nav).length).toBe(17);
  });

  it('ES translations are actually different from EN', () => {
    expect(es.nav.dashboard).not.toBe(en.nav.dashboard);
    expect(es.nav.reservations).not.toBe(en.nav.reservations);
    expect(es.topbar.logout).not.toBe(en.topbar.logout);
  });
});
