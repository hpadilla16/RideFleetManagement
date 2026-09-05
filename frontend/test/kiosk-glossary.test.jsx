import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KioskButtonGlossary } from '../src/components/training/KioskButtonGlossary';
import { KIOSK_GLOSSARY } from '../src/lib/training/kiosk-glossary.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const lookup = (obj, key) => key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);

/**
 * Hector, 2026-09-04: "explicar qué hacen todos los botones". The glossary
 * quotes the kiosk's OWN labels by key, so every label it names must be a real
 * kiosk string in both languages — a renamed button breaks this test instead
 * of showing a raw key to a trainee.
 */
describe('kiosk button glossary', () => {
  const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8'));
  const es = JSON.parse(readFileSync(join(LOCALES, 'es.json'), 'utf8'));

  it('every label key it quotes is a real kiosk string, in English and Spanish', () => {
    const missing = [];
    for (const g of KIOSK_GLOSSARY.groups) for (const e of g.entries) for (const k of e.labels) {
      if (typeof lookup(en, k) !== 'string') missing.push(`en: ${k}`);
      if (typeof lookup(es, k) !== 'string') missing.push(`es: ${k}`);
    }
    expect(missing, `Glossary names kiosk labels that do not exist:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('entry ids are unique — each is a translation key', () => {
    const ids = KIOSK_GLOSSARY.groups.flatMap((g) => g.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renders every group and entry when open, and closes on Escape', () => {
    const onClose = vi.fn();
    render(<KioskButtonGlossary open onClose={onClose} />);
    const dialog = screen.getByTestId('kiosk-glossary');
    for (const g of KIOSK_GLOSSARY.groups) {
      expect(dialog.textContent).toContain(g.title);
      for (const e of g.entries) expect(dialog.textContent).toContain(e.what);
    }
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<KioskButtonGlossary open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('kiosk-glossary')).toBeNull();
  });
});
