import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * The (public) route group is the set of pages a CUSTOMER opens from a
 * tokenized link on their own phone. Nothing under it may carry this
 * platform's identity: the only business those pages name is the tenant's,
 * and a Ride Fleet logo in the tab strip or a "Ride Fleet" home-screen
 * shortcut undoes that at the exact moment it matters.
 *
 * WHY A TEST AND NOT JUST THE LAYOUT
 * ----------------------------------
 * The layout neutralises icons, appleWebApp and description for the whole
 * group, and that would be the end of it — except `manifest` cannot be
 * cleared from a layout. app/manifest.js is FILE-BASED metadata, and next
 * 14.2 re-applies file-based metadata after merging each segment's exported
 * object, so a layout's `manifest: null` is overwritten a moment later while
 * the same line on a leaf page survives (verified against a running server,
 * 2026-08-17).
 *
 * That leaves exactly one rule a new public page has to remember, which is
 * one more than zero. This is that rule, enforced. It fails loudly rather
 * than letting a renter be offered "Ride Fleet" on their home screen.
 *
 * The page assertions read SOURCE rather than importing: these are Next
 * pages whose `.js` files contain JSX, which this vitest config's `.js`
 * loader does not parse. The layout has no JSX and is imported properly.
 */

const GROUP_DIR = join(process.cwd(), 'src', 'app', '(public)');

function pageFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return pageFiles(p);
    return /^page\.(js|jsx)$/.test(name) ? [p] : [];
  });
}

/** The body of `export const metadata = { … }`, or null if there is none. */
function metadataBlock(source) {
  const start = source.indexOf('export const metadata');
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n};', open);
  return close === -1 ? null : source.slice(open, close);
}

const pages = pageFiles(GROUP_DIR).map((file) => ({
  label: file.split(sep).slice(-4).join('/'),
  metadata: metadataBlock(readFileSync(file, 'utf8')),
}));

describe('(public) route group', () => {
  it('actually contains the public pages', () => {
    // A walk that silently matched nothing would make every assertion below
    // vacuously true — the classic way this shape of guard rots.
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map((p) => p.label)).toContain('(public)/sign/[token]/page.js');
  });

  it.each(pages.map((p) => [p.label, p]))('%s drops the platform web manifest', (_label, page) => {
    expect(page.metadata, 'the page exports no metadata at all').not.toBeNull();
    expect(page.metadata).toMatch(/manifest:\s*null/);
  });

  it.each(pages.map((p) => [p.label, p]))('%s never names the platform', (_label, page) => {
    expect(page.metadata).not.toContain('Ride Fleet');
  });

  it('the group layout neutralises what a layout CAN neutralise', async () => {
    const layout = await import('../src/app/(public)/layout.js');
    expect(layout.metadata.appleWebApp).toBeNull();
    expect(layout.metadata.description).toBeNull();
    expect(layout.metadata.robots).toEqual({ index: false, follow: false });
    // Neutral glyph only — no wordmark asset, no brand purple.
    const icons = JSON.stringify(layout.metadata.icons);
    expect(icons).not.toContain('ride-logo');
    expect(icons).toContain('document-icon');
  });
});
