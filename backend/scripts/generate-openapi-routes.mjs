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
 *   4. and for `<routerName>.use('<prefix>', …, <childRouter>)` — a router
 *      mounted inside another router — which is followed recursively, since
 *      those routes are every bit as live as the rest.
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
 * ── WHY NESTED MOUNTS WERE WORTH CHASING (2026-09-10) ───────────────────────
 * Following only main.js missed 33 live endpoints, and the carried-forward
 * count was the clue: the five /api/host-app/messages entries had to be
 * rescued by the no-drop rule precisely because they sit behind
 * `hostAppRouter.use('/messages', hostMessagingRouter)`. The same shape hid the
 * whole trip-chat surface, guest messaging, the location clause editor, and all
 * thirteen tenant BILLING admin routes — cancel, suspend, apply-plan — which is
 * the last surface that should be undocumented. The rescue rule meant nothing
 * was wrong in the spec; it meant a third of a module could be missing from it
 * without the report ever saying so.
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

/**
 * Router variable → the file it is imported from, for ANY file's imports.
 *
 * Node ESM specifiers in this tree carry their own extension, so this resolves
 * by simple join; a specifier without one gets `.js` appended rather than
 * guessed at, because a miss here silently drops a whole router.
 */
function readImportedRouters(src, fromFile) {
  const out = new Map();
  const re = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(fromFile), spec.endsWith('.js') ? spec : `${spec}.js`);
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name && /router/i.test(name)) out.set(name, target);
    }
  }
  return out;
}

/**
 * Every `<router>.use('<prefix>', …, <childRouter>)` in one file.
 *
 * The argument list is walked with a paren counter rather than matched with a
 * regex, because express lets you inline middleware in the same call and
 * `hostAppRouter.use('/messages', async (req, res, next) => { … next(); },
 * hostMessagingRouter)` contains a `);` of its own. A lazy regex stops there,
 * never sees the router at the end, and the five host-app message endpoints go
 * missing -- which is exactly how they ended up surviving on the no-drop rule
 * instead of being found. String and comment bodies are skipped so a `)` inside
 * either cannot throw the count off.
 */
function readUseArgs(src, routerName) {
  const esc = routerName.replace(/[$]/g, '\\$');
  const head = new RegExp(`\\b${esc}\\s*\\.\\s*use\\s*\\(`, 'g');
  const out = [];
  let m;
  while ((m = head.exec(src))) {
    let i = head.lastIndex;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      const two = src.slice(i, i + 2);
      if (two === '//') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
      if (two === '/*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
      if (c === "'" || c === '"' || c === '`') {
        i += 1;
        while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
        i += 1;
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    if (depth === 0) out.push(src.slice(start, i - 1));
    head.lastIndex = i;
  }
  return out;
}

function readNestedMounts(src, routerName) {
  const out = [];
  for (const args of readUseArgs(src, routerName)) {
    const lead = args.match(/^\s*'([^']+)'\s*,/);
    if (!lead) continue; // `.use(middleware)` with no path mounts nothing new
    const names = [...args.matchAll(/\b([A-Za-z_$][\w$]*[Rr]outer[\w$]*)\b/g)].map((x) => x[1]);
    // Express takes the router as the LAST handler, so that is the one to
    // follow; anything earlier is middleware.
    const child = names[names.length - 1];
    if (child && child !== routerName) out.push({ prefix: lead[1], child });
  }
  return out;
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
  // Each field tolerates an ESCAPED quote. The writer below escapes them, so a
  // description as ordinary as "List the guest's conversations" round-trips
  // through this file -- and a pattern of plain [^'] would fail to match that
  // line, treat the route as new, and overwrite the sentence with derived text
  // on the next run. Descriptions are the one thing here a human wrote; losing
  // them quietly to an apostrophe is the worst failure this script has.
  const FIELD = "'((?:[^'\\\\]|\\\\.)*)'";
  const ROW = new RegExp(`\\[\\s*${FIELD}\\s*,\\s*${FIELD}\\s*,\\s*${FIELD}\\s*,\\s*${FIELD}\\s*\\]`);
  const unq = (v) => String(v).replace(/\\(['\\\\])/g, '$1');
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(ROW);
    if (!m) continue;
    out.set(`${unq(m[1])} ${unq(m[2])}`, {
      tag: unq(m[3]),
      description: unq(m[4]),
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
  let nestedFound = 0;

  // Breadth-first over mounts, so a router mounted inside a router inside a
  // router is reached the same way the first level is. `seen` is keyed by
  // router AND prefix: the same child mounted under two parents is two
  // different sets of URLs, and keying by router alone would drop one of them.
  const queue = [];
  for (const [router, prefixes] of mounts) {
    const file = files.get(router);
    if (!file) { unmounted += 1; continue; }
    for (const prefix of prefixes) queue.push({ router, file, prefix, depth: 0 });
  }

  const seen = new Set();
  while (queue.length) {
    const { router, file, prefix, depth } = queue.shift();
    const seenKey = `${router} @ ${prefix}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    if (depth > 0) nestedFound += 1;

    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }

    for (const r of readRoutes(file, router)) {
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

    // Routers mounted inside this one. A depth cap keeps a cycle -- two files
    // importing each other's routers -- from spinning forever; `seen` already
    // blocks the simple case, and 6 is far deeper than this tree goes.
    if (depth >= 6) continue;
    const imported = readImportedRouters(src, file);
    for (const { prefix: sub, child } of readNestedMounts(src, router)) {
      const childFile = imported.get(child) || (new RegExp(`const\\s+${child}\\s*=\\s*Router\\(`).test(src) ? file : null);
      if (!childFile) continue;
      queue.push({ router: child, file: childFile, prefix: joinPath(prefix, sub), depth: depth + 1 });
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
  console.log(`  nested mounts followed:                               ${nestedFound}`);
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
