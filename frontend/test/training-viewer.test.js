import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewerFromMe } from '../src/lib/training/viewer.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('viewerFromMe — one viewer shape for every surface', () => {
  it('gates default OPEN, features default CLOSED', () => {
    const v = viewerFromMe({ role: 'AGENT' });
    expect(v.isModuleEnabled('tolls')).toBe(true);
    expect(v.hasFeature('kioskPaymentLive')).toBe(false);
  });
  it('reads both from me', () => {
    const v = viewerFromMe({ role: 'ADMIN', moduleAccess: { tolls: false }, features: { kioskPaymentLive: true } });
    expect(v.isModuleEnabled('tolls')).toBe(false);
    expect(v.hasFeature('kioskPaymentLive')).toBe(true);
    expect(v.hasFeature('other')).toBe(false);
  });
  it('no role, no viewer', () => {
    expect(viewerFromMe(null)).toBeNull();
    expect(viewerFromMe({})).toBeNull();
  });
  it('every surface that hands a viewer to the curriculum builds it here — no hand-rolled copies', () => {
    for (const f of ['components/training/ModuleList.jsx', 'components/training/TourMount.jsx', 'components/copilot/CopilotMount.jsx']) {
      const text = readFileSync(join(SRC, f), 'utf8');
      expect(text, `${f} must import viewerFromMe`).toMatch(/viewerFromMe/);
      expect(text, `${f} still builds isModuleEnabled by hand`).not.toMatch(/isModuleEnabled:\s*\(/);
    }
  });
});
