import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `/settings?tab=…` deep links (2026-08-26).
 *
 * The shuttle Monitor's empty states send an operator to Settings to turn the
 * tracker on; without a tab they landed on Agreement and had to hunt. The page
 * now reads `?tab=` on mount and validates it against SETTINGS_TABS.
 *
 * That allowlist is a hand-maintained mirror of the `tab === '…'` render
 * guards, and a stale mirror fails SILENTLY — the link just opens the default
 * tab, which is exactly the bug it was added to fix. So this is a source-level
 * ratchet rather than a render test: mounting the 7.6k-line page to assert one
 * useState is not worth the seconds, but the drift it would catch is real.
 */

const SETTINGS_PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'settings', 'page.js');

function readSource() {
  return readFileSync(SETTINGS_PAGE, 'utf8');
}

/** The names inside the SETTINGS_TABS literal. */
function allowlist(src) {
  const block = src.match(/const SETTINGS_TABS = new Set\(\[([\s\S]*?)\]\);/);
  expect(block, 'SETTINGS_TABS literal not found — did the deep-link support get removed?').toBeTruthy();
  return new Set([...block[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));
}

/** Every tab the page actually renders a section for. */
function renderedTabs(src) {
  return new Set([...src.matchAll(/\btab === '([A-Za-z]+)'/g)].map((m) => m[1]));
}

describe('/settings?tab= deep link', () => {
  it('the page reads the query param on mount and guards it', () => {
    const src = readSource();
    expect(src).toMatch(/new URLSearchParams\(window\.location\.search\)\.get\('tab'\)/);
    expect(src).toMatch(/SETTINGS_TABS\.has\(wanted\)/);
  });

  it('every renderable tab is deep-linkable', () => {
    const src = readSource();
    const missing = [...renderedTabs(src)].filter((t) => !allowlist(src).has(t)).sort();
    expect(missing, `tab(s) rendered but not in SETTINGS_TABS — ?tab= would silently ignore them: ${missing.join(', ')}`).toEqual([]);
  });

  it('the allowlist does not name tabs that no longer exist', () => {
    const src = readSource();
    const stale = [...allowlist(src)].filter((t) => !renderedTabs(src).has(t)).sort();
    expect(stale, `SETTINGS_TABS names tab(s) the page never renders: ${stale.join(', ')}`).toEqual([]);
  });

  it('the two tabs the shuttle Monitor links to are among them', () => {
    // `locations` holds the per-location Shuttle Tracker card; `telematics`
    // holds the OneStepGPS connector panel.
    const tabs = allowlist(readSource());
    expect(tabs.has('locations')).toBe(true);
    expect(tabs.has('telematics')).toBe(true);
  });
});
