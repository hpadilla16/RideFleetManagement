/**
 * The anti-drift test the whole design rests on.
 *
 * Every tour step points at a `data-tour="..."` attribute on a real element.
 * Nothing in the language stops someone renaming an attribute, deleting the
 * element, or adding a curriculum step for an anchor that was never placed —
 * and the failure is silent: the tour just highlights nothing, on the screen a
 * brand-new employee is looking at.
 *
 * So this walks the actual source and asserts the two sets agree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allModules } from '../src/lib/training/curriculum.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(js|jsx)$/.test(entry) && !full.includes('lib\\training') && !full.includes('lib/training')) out.push(full);
  }
  return out;
}

/** Every data-tour value present in the app source. */
function placedAnchors() {
  const found = new Set();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    // data-tour="literal"
    for (const m of text.matchAll(/data-tour=["']([a-z0-9-]+)["']/gi)) found.add(m[1]);
    // data-tour={...'literal'...} — covers the .map() cases where the value
    // comes from an array or an item field written inline.
    for (const m of text.matchAll(/data-tour=\{[^}]*\}/gi)) {
      for (const lit of m[0].matchAll(/['"]([a-z0-9-]+)['"]/gi)) found.add(lit[1]);
    }
  }
  return found;
}

/** Anchor values a NAV_ITEMS-style table supplies via a `tour:` key. */
function tourKeyValues() {
  const found = new Set();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\btour:\s*['"]([a-z0-9-]+)['"]/gi)) found.add(m[1]);
  }
  return found;
}

const curriculumAnchors = () => {
  const set = new Set();
  for (const m of allModules()) for (const s of m.steps || []) set.add(s.anchor);
  return set;
};

describe('curriculum anchors resolve to real elements', () => {
  const placed = new Set([...placedAnchors(), ...tourKeyValues()]);

  it('every anchor the curriculum names is placed in the source', () => {
    const missing = [...curriculumAnchors()].filter((a) => !placed.has(a)).sort();
    expect(missing, `Curriculum steps point at anchors that do not exist in the app:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('every anchor placed in the source is used by the curriculum', () => {
    const orphans = [...placed].filter((a) => !curriculumAnchors().has(a)).sort();
    expect(orphans, `data-tour attributes nothing points at — dead weight or a renamed step:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });
});

describe('curriculum routes exist as pages', () => {
  const appDir = join(SRC, 'app');

  const routeExists = (route) => {
    if (route === '/') return true;
    const segments = String(route).split('/').filter(Boolean);
    let dir = appDir;
    for (const seg of segments) {
      const entries = readdirSync(dir);
      // exact segment, or a dynamic [param] directory
      const match = entries.find((e) => e === seg) || entries.find((e) => /^\[.+\]$/.test(e));
      if (!match) return false;
      dir = join(dir, match);
      if (!statSync(dir).isDirectory()) return false;
    }
    return readdirSync(dir).some((e) => /^page\.(js|jsx)$/.test(e));
  };

  it('every route a step navigates to has a page', () => {
    const routes = new Set();
    for (const m of allModules()) for (const s of m.steps || []) if (s.route) routes.add(s.route);
    const broken = [...routes].filter((r) => !routeExists(r)).sort();
    expect(broken, `Steps navigate to routes with no page:\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  it('no step routes to /dashboard — it is a redirect alias to /', () => {
    for (const m of allModules()) {
      for (const s of m.steps || []) {
        expect(s.route, `${m.key} would land on the alias and bounce`).not.toBe('/dashboard');
      }
    }
  });
});
