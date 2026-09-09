/**
 * Regenerate src/docs/extra-routes.generated.js from the routes that actually
 * exist (2026-09-09).
 *
 * The file has always been named `.generated.js` and was never generated — it
 * was hand-typed, and by today it had drifted badly: last touched 2026-08-24
 * while route files changed the same morning, documenting 686 operations
 * against roughly 1,200 route definitions in the tree. Endpoints shipped since
 * late August — QR self-return, the price self-check, branch terms, the market
 * targets — appeared nowhere in the published spec.
 *
 * ── HOW IT READS THE TREE ───────────────────────────────────────────────────
 * Static analysis, deliberately, so this runs with no database, no env and no
 * booted app:
 *   1. main.js is scanned for `app.use('<prefix>', …, <routerName>)` to learn
 *      every mount and its prefix. A router mounted twice yields both prefixes.
 *   2. each router's file is found from main.js's own import statements.
 *   3. the file is scanned for `<routerName>.<method>('<path>' …)`, including
 *      the array form `.get(['/a','/b'], …)`.
 *
 * ── WHAT IT REFUSES TO THROW AWAY ───────────────────────────────────────────
 * The hand-written DESCRIPTIONS are the valuable part of the old file — they
 * say what an endpoint is for, which no parser can infer. Every existing entry
 * is keyed by METHOD + PATH and its description is carried over verbatim. Only
 * genuinely new routes get a derived description, and those are marked with a
 * trailing comment so a human can see at a glance what still needs wording.
 *
 * NOTHING IS EVER DROPPED. The first run wanted to delete 22 entries it could
 * not see; every one sampled answered 401, not 404 — they were live, registered
 * in ways this parser cannot read. A stale line in the spec is a nuisance;
 * silently removing a real endpoint is a lie about the API. Unmatched entries
 * are carried forward and counted, so the number is visible rather than
 * comfortable.
 *
 *   node scripts/generate-openapi-routes.mjs            # report only
 *   node scripts/generate-openapi-routes.mjs --write
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', 'src');
const MAIN = join(SRC, 'main.js');
const OUT = join(SRC, 'docs', 'extra-routes.generated.js');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** `/api/foo/:id` → `/api/foo/{id}` — OpenAPI path templating. */
function toOpenApiPath(p) {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function joinPath(prefix, route) {
  const a = String(prefix || '').replace(/\/+$/, '');
  const b = String(route || '');
  if (b === '/' || b === '') return a || '/';
  return `${a}${b.startsWith('/') ? '' : '/'}${b}`;
}

/** Router variable → the file that exports it, from main.js's imports. */
function readRouterFiles(mainSrc) {
  const out = new Map();
  const re = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(mainSrc))) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    for (const n of names) {
      if (/router/i.test(n)) out.set(n, resolve(dirname(MAIN), spec));
    }
  }
  return out;
}

/** Every `app.use('<prefix>', …, <router>)` — a router may be mounted twice. */
function readMounts(mainSrc) {
  const out = new Map(); // router -> Set(prefix)
  const re = /app\.use\(\s*'([^']+)'\s*,([^;]*?)\)\s*;/g;
  let m;
  while ((m = re.exec(mainSrc))) {
    const prefix = m[1];
    for (const name of m[2].matchAll(/\b([A-Za-z_$][\w$]*[Rr]outer[\w$]*)\b/g)) {
      if (!out.has(name[1])) out.set(name[1], new Set());
      out.get(name[1]).add(prefix);
    }
  }
  return out;
}

/** Every `<router>.<method>('<path>' | ['<a>','<b>'], …)` in one file. */
function readRoutes(file, routerName) {
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  const esc = routerName.replace(/[$]/g, '\\$');
  const re = new RegExp(`\\b${esc}\\s*\\.\\s*(${METHODS.join('|')})\\s*\\(\\s*(\\[[^\\]]*\\]|'[^']*')`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const method = m[1].toUpperCase();
    const raw = m[2];
    const paths = raw.startsWith('[')
      ? [...raw.matchAll(/'([^']*)'/g)].map((x) => x[1])
      : [raw.slice(1, -1)];
    for (const p of paths) out.push({ method, path: p });
  }
  return out;
}

/** Tag from the mount prefix: '/api/rental-agreements' → 'Rental Agreements'. */
function tagFor(prefix) {
  const seg = String(prefix).replace(/^\/api\/?/, '').split('/').filter(Boolean)[0] || 'Root';
  return seg.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** A readable fallback when no human has described the route yet. */
function deriveDescription(method, path) {
  const parts = path.replace(/^\/api\//, '').split('/').filter(Boolean)
    .filter((s) => !s.startsWith('{'))
    .map((s) => s.replace(/-/g, ' '));
  const subject = parts.slice(1).join(' ') || parts[0] || 'resource';
  const verb = { GET: 'Get', POST: 'Create or run', PUT: 'Replace', PATCH: 'Update', DELETE: 'Delete' }[method];
  return `${verb} ${subject}`.replace(/\s+/g, ' ').trim();
}

/** Existing hand-written descriptions, keyed METHOD + PATH. */
function readExisting() {
  let src;
  try { src = readFileSync(OUT, 'utf8'); } catch { return new Map(); }
  const out = new Map();
  // Capture the TODO marker too. Without it a second run reads its OWN output,
  // sees every derived description as hand-written, and quietly loses the only
  // signal saying which endpoints nobody has actually described yet.
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/\[\s*'([A-Z]+)'\s*,\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/);
    if (!m) continue;
    out.set(`${m[1]} ${m[2]}`, {
      tag: m[3],
      description: m[4],
      derived: /TODO\(describe\)/.test(line),
    });
  }
  return out;
}

/**
 * Reports register themselves at runtime — `reportsV2Router.get(`/${slug}`)`
 * inside registerReport() — so a parser looking for string literals cannot see
 * them. That blind spot nearly deleted a dozen live endpoints from the spec on
 * the first run (/api/reports/sales answers 401, not 404). Each report yields
 * the data route plus /pdf and /excel.
 */
function readReportSlugs() {
  const dir = join(SRC, 'modules', 'reports');
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.report.js')); } catch { return []; }
  const slugs = new Set();
  for (const f of names) {
    let src;
    try { src = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    // Only the slug passed to registerReport, not every `slug:` in the file.
    const m = src.match(/registerReport\(\s*\{[\s\S]{0,400}?slug:\s*'([^']+)'/);
    if (m) slugs.add(m[1]);
  }
  return [...slugs].sort();
}

function main() {
  const write = process.argv.includes('--write');
  const mainSrc = readFileSync(MAIN, 'utf8');
  const files = readRouterFiles(mainSrc);
  const mounts = readMounts(mainSrc);
  const existing = readExisting();

  const rows = new Map(); // "METHOD path" -> [method, path, tag, description]
  let unmounted = 0;
  for (const [router, prefixes] of mounts) {
    const file = files.get(router);
    if (!file) { unmounted += 1; continue; }
    const routes = readRoutes(file, router);
    for (const prefix of prefixes) {
      for (const r of routes) {
        const full = toOpenApiPath(joinPath(prefix, r.path));
        const key = `${r.method} ${full}`;
        if (rows.has(key)) continue;
        const prior = existing.get(key);
        rows.set(key, [
          r.method, full,
          prior?.tag || tagFor(prefix),
          prior?.description || deriveDescription(r.method, full),
        ]);
      }
    }
  }

  // Dynamically registered reports.
  for (const slug of readReportSlugs()) {
    for (const suffix of ['', '/pdf', '/excel']) {
      const full = `/api/reports/${slug}${suffix}`;
      const key = `GET ${full}`;
      if (rows.has(key)) continue;
      const prior = existing.get(key);
      rows.set(key, ['GET', full, prior?.tag || 'Reports',
        prior?.description || `${suffix ? (suffix === '/pdf' ? 'PDF of the' : 'Excel export of the') : 'Data for the'} ${slug.replace(/-/g, ' ')} report`]);
    }
  }

  // NEVER drop an entry this parser could not confirm. Every route sampled from
  // the first run's "dropped" list was live (401, not 404) — the parser simply
  // could not see it. A stale doc line is a nuisance; silently deleting a real
  // endpoint from the published spec is a lie about the API.
  let carried = 0;
  for (const [key, prior] of existing) {
    if (rows.has(key)) continue;
    const sp = key.indexOf(' ');
    rows.set(key, [key.slice(0, sp), key.slice(sp + 1), prior.tag, prior.description]);
    carried += 1;
  }

  const all = [...rows.values()].sort((a, b) => (a[2] === b[2] ? a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]) : a[2].localeCompare(b[2])));
  const kept = all.filter(([m, p]) => existing.has(`${m} ${p}`)).length;
  const added = all.length - kept;
  const dropped = [];

  console.log(`routers mounted: ${mounts.size}  (files resolved: ${mounts.size - unmounted})`);
  console.log(`routes found:    ${all.length}`);
  console.log(`  descriptions carried over from the hand-written file: ${kept}`);
  console.log(`  newly documented:                                      ${added}`);
  console.log(`  kept because the parser could not see them:            ${carried}`);

  if (!write) { console.log('\n(report only — pass --write to regenerate)'); return; }

  const byTag = new Map();
  for (const row of all) {
    if (!byTag.has(row[2])) byTag.set(row[2], []);
    byTag.get(row[2]).push(row);
  }
  const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  let body = '';
  for (const [tag, list] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    body += `\n  // ── ${tag} ${'─'.repeat(Math.max(2, 70 - tag.length))}\n`;
    for (const [method, path, t, desc] of list) {
      const prior = existing.get(`${method} ${path}`);
      const isNew = !prior || prior.derived;
      body += `  [${q(method)}, ${q(path)}, ${q(t)}, ${q(desc)}],${isNew ? ' // TODO(describe)' : ''}\n`;
    }
  }

  const header = `/**
 * Route inventory for the OpenAPI spec — GENERATED. Do not hand-edit paths.
 *
 * Produced by scripts/generate-openapi-routes.mjs, which reads main.js's mounts
 * and each router file. Re-run it after adding routes:
 *
 *     node scripts/generate-openapi-routes.mjs --write
 *
 * DESCRIPTIONS ARE THE PART WORTH KEEPING. The generator carries every existing
 * one over verbatim and only derives text for routes it has never seen, marking
 * those \`// TODO(describe)\` — a derived description says the shape of a URL,
 * not what the endpoint is for. Replacing those with real wording is the one
 * edit to make here by hand, and it survives the next regeneration.
 *
 * Last generated: ${new Date().toISOString().slice(0, 10)}
 */
export const EXTRA_ROUTES = [`;

  // The repo keeps its files CRLF. Emitting LF would rewrite every line on each
  // run and bury the actual change in a thousand-line diff — the exact trap that
  // turned a 59-line edit into 10,980 insertions earlier today.
  const text = `${header}${body}];\n`.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  writeFileSync(OUT, text, 'utf8');
  console.log(`\nwrote ${OUT}`);
}

main();
