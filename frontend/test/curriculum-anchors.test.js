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

/**
 * PLACED IS NOT THE SAME AS REACHABLE (2026-08-26).
 *
 * The tests above all stayed green through a real, shipped breakage. The
 * 2026-08-25 topbar redesign dropped the duplicate desktop search field and
 * left `data-tour="global-search"` on `.tb-search-mobile` — a button that
 * `@media (min-width: 981px) { display: none }` hides on every desktop. The
 * attribute was still in the source, so the counting ratchet was satisfied;
 * TourHost's isUsable() correctly refused an invisible element, and the
 * onboarding tour's second step simply waited forever.
 *
 * So the anchor set is now checked against the stylesheet too: an anchor may
 * not live on an element whose own classes are display:none at desktop widths.
 * Desktop is the floor because that is where staff are trained and where the
 * showcase runs; a mobile-only control is never a valid home for a step.
 */
const CSS_FILES = [
  join(SRC, 'app', 'globals.css'),
  join(SRC, 'app', 'kiosk', 'kiosk.css'),
];

/** The block a `@media (...)` prelude opens, by brace balance. */
function blockAfter(css, from) {
  let depth = 1;
  let i = from;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
    i += 1;
  }
  return css.slice(from, i - 1);
}

/**
 * Class names some `display: none` rule inside a `min-width` media query
 * applies to. Only the SUBJECT of a selector counts — the last compound —
 * because `.a .b { display: none }` hides `.b`, not `.a`.
 */
function desktopHiddenClasses() {
  const hidden = new Set();
  for (const file of CSS_FILES) {
    const css = readFileSync(file, 'utf8');
    const media = /@media[^{]*\(\s*min-width\s*:\s*\d+px\s*\)[^{]*\{/gi;
    let open;
    while ((open = media.exec(css))) {
      for (const rule of blockAfter(css, media.lastIndex).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/display\s*:\s*none/i.test(rule[2])) continue;
        for (const selector of rule[1].split(',')) {
          const subject = selector.trim().split(/[\s>+~]+/).pop() || '';
          for (const cls of subject.matchAll(/\.([A-Za-z0-9_-]+)/g)) hidden.add(cls[1]);
        }
      }
    }
  }
  return hidden;
}

/** The opening JSX tag containing the index, as raw text. */
function enclosingTag(text, index) {
  const start = text.lastIndexOf('<', index);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** Every anchor placement paired with the classes its element carries. */
function anchorPlacements() {
  const placements = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/data-tour=(?:["']([a-z0-9-]+)["']|\{([^}]*)\})/gi)) {
      const tag = enclosingTag(text, m.index);
      const className = tag.match(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\})/);
      const raw = className ? (className[1] ?? className[2] ?? className[3] ?? className[4] ?? className[5]) : '';
      // Drop `${...}` interpolations — only statically present classes count.
      const classes = raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
      // An expression binding covers every `tour:` key in the file (same rule
      // the counting ratchet uses); a literal names exactly one anchor.
      const names = m[1]
        ? [m[1]]
        : [...(/\.\s*tour\b/.test(m[2] || '') ? text.matchAll(/\btour:\s*['"]([a-z0-9-]+)['"]/gi) : (m[2] || '').matchAll(/['"]([a-z0-9-]+)['"]/gi))].map((x) => x[1]);
      for (const name of names) placements.push({ name, file, classes });
    }
  }
  return placements;
}

describe('curriculum anchors are reachable, not just present', () => {
  it('no anchor lives on an element the stylesheet hides on desktop', () => {
    const hidden = desktopHiddenClasses();
    const used = new Set([...allModules()].flatMap((m) => (m.steps || []).map((s) => s.anchor)));
    const unreachable = anchorPlacements()
      .filter((p) => used.has(p.name))
      .flatMap((p) => p.classes.filter((c) => hidden.has(c)).map((c) => `${p.name} (on .${c})`))
      .sort();
    expect(
      unreachable,
      `Anchor(s) placed on a control that is display:none at desktop widths — the tour will wait forever:\n  ${unreachable.join('\n  ')}`,
    ).toEqual([]);
  });

  it('global-search sits on the sidebar control, the only desktop entry', () => {
    const shell = readFileSync(join(SRC, 'components', 'AppShell.jsx'), 'utf8');
    const tag = enclosingTag(shell, shell.indexOf('data-tour="global-search"'));
    expect(tag, 'global-search left the sidebar "Go to…" button').toMatch(/className="sb-search"/);
    expect(shell).not.toMatch(/tb-search-mobile[\s\S]{0,200}data-tour="global-search"/);
  });

  it('a collapsed sidebar section cannot hide a nav step from the tour', () => {
    // TourHost stamps the document for the tour's duration and the stylesheet
    // un-hides collapsed groups; both halves have to be there or `nav-reports`
    // disappears for anyone who closed "Dinero".
    const host = readFileSync(join(SRC, 'components', 'training', 'TourHost.jsx'), 'utf8');
    expect(host).toMatch(/setAttribute\(\s*TOUR_ACTIVE_ATTR/);
    expect(host).toMatch(/const TOUR_ACTIVE_ATTR = 'data-tour-active'/);
    const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/:root\[data-tour-active\][^{]*\.nav-sec\.closed\s+\.nav-sec-items\s*\{[^}]*display:\s*flex/);
  });

  it('every nav anchor the curriculum names is still on a NAV_SECTIONS item', () => {
    // The sectioned-sidebar refactor kept the `tour:` keys; a later regrouping
    // that drops one would otherwise only show up as a dead tour step.
    const shell = readFileSync(join(SRC, 'components', 'AppShell.jsx'), 'utf8');
    const sectionTours = new Set([...shell.matchAll(/\btour:\s*'([a-z0-9-]+)'/gi)].map((m) => m[1]));
    const navAnchors = [...curriculumAnchors()].filter((a) => a.startsWith('nav-')).sort();
    const dropped = navAnchors.filter((a) => !sectionTours.has(a));
    expect(dropped, `nav anchor(s) no longer carried by any NAV_SECTIONS item:\n  ${dropped.join('\n  ')}`).toEqual([]);
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
