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

/**
 * Every anchor placed in the source, COUNTED — not a set.
 *
 * Counting matters: two elements carrying the same name is a real failure the
 * first version could not see, because a Set collapses them (QA, 2026-08-14).
 *
 * Two placement styles exist:
 *   data-tour="literal"                      — a single element
 *   data-tour={item.tour} + tour: 'literal'  — a .map() over a table
 *
 * A `tour:` key only counts when the file ALSO binds it into a data-tour
 * attribute. Counting the keys on their own is what let the earlier version
 * stay green while someone deleted the binding and silently broke eight
 * anchors at once.
 */
function placedAnchorCounts() {
  const counts = new Map();
  const bump = (name, by = 1) => counts.set(name, (counts.get(name) || 0) + by);

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');

    // Literal attributes.
    for (const m of text.matchAll(/data-tour=["']([a-z0-9-]+)["']/gi)) bump(m[1]);

    // Expression attributes: data-tour={...}
    const expressions = [...text.matchAll(/data-tour=\{([^}]*)\}/gi)].map((m) => m[1]);
    for (const expr of expressions) {
      // Inline array of literals — data-tour={['a','b'][i]}
      const inline = [...expr.matchAll(/['"]([a-z0-9-]+)['"]/gi)].map((m) => m[1]);
      for (const name of inline) bump(name);
    }
    // A table-driven binding (data-tour={item.tour} / {s.tour}) makes every
    // `tour:` key in the SAME file live. No binding in this file, no credit.
    const hasTableBinding = expressions.some((e) => /\.\s*tour\b/.test(e));
    if (hasTableBinding) {
      for (const m of text.matchAll(/\btour:\s*['"]([a-z0-9-]+)['"]/gi)) bump(m[1]);
    }
  }
  return counts;
}

const curriculumAnchors = () => {
  const set = new Set();
  for (const m of allModules()) for (const s of m.steps || []) set.add(s.anchor);
  return set;
};

describe('curriculum anchors resolve to real elements', () => {
  const counts = placedAnchorCounts();

  it('every anchor the curriculum names is placed in the source', () => {
    const missing = [...curriculumAnchors()].filter((a) => !counts.has(a)).sort();
    expect(missing, `Curriculum steps point at anchors that do not exist in the app:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('every anchor placed in the source is used by the curriculum', () => {
    const orphans = [...counts.keys()].filter((a) => !curriculumAnchors().has(a)).sort();
    expect(orphans, `data-tour attributes nothing points at — dead weight or a renamed step:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });

  it('no anchor name is placed on two different elements', () => {
    // A duplicate makes the spotlight land on whichever the DOM returns first,
    // which is not something anyone chose. The reservation page's iOS action
    // grid mirrors the desktop bar and is the live example of how this happens.
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([a, n]) => `${a} (${n}×)`).sort();
    expect(dupes, `Anchors placed more than once — the tour would highlight an arbitrary one:\n  ${dupes.join('\n  ')}`).toEqual([]);
  });

  it('a table-driven binding is required for tour: keys to count', () => {
    // Guards the guard: if someone deletes data-tour={item.tour} from AppShell,
    // the nav anchors must go MISSING rather than stay green off the keys alone.
    const shell = readFileSync(join(SRC, 'components', 'AppShell.jsx'), 'utf8');
    expect(/data-tour=\{[^}]*\.\s*tour\b[^}]*\}/.test(shell)).toBe(true);
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
