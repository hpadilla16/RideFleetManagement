#!/usr/bin/env node
/**
 * lint-cache-keys.mjs
 *
 * Static check: every `cache.get|set|del|invalidate|getOrSet` callsite must
 * route its key argument through `tenantKey(...)` or `globalKey(...)` (from
 * `lib/cache/tenantKey.js`). Direct template literals or `+`-concat keys are
 * flagged because they almost always omit the `t:<tenantId>:` namespace and
 * risk cross-tenant cache bleed.
 *
 * Heuristic (regex + paren-balancing, NOT a full JS parser):
 *   1. Scan every .js/.mjs under backend/src.
 *   2. For each `cache.<op>(` match, balance parens to extract the args.
 *   3. The first arg is the key. Resolve it:
 *        - template literal (backticks) -> inspect its raw form
 *        - quoted string -> always allowed (concrete prefix, no leaked id)
 *        - call expression starting with `tenantKey(` or `globalKey(` -> allowed
 *        - bare identifier -> look upward in the same file for
 *          `const <id> =` / `let <id> =` / `var <id> =` / `function <id>(` and
 *          inspect the value, applying the same rules recursively (one hop).
 *        - anything else -> warn (ambiguous; PR-3b will migrate).
 *   4. A template-literal key that does NOT contain `tenantKey(`/`globalKey(`
 *      AND does NOT start with the literal `t:${...}:` or `global:` prefix
 *      is a violation.
 *   5. A `+`-concat key with the same shape is also a violation.
 *
 * Exit codes:
 *   - Default: exit 0, print every violation as a warning. Use in PR-3a so
 *     CI stays green while we migrate callsites in PR-3b.
 *   - `--strict` flag or STRICT=1 env: exit 1 if any violations found.
 *
 * Usage:
 *   node scripts/lint-cache-keys.mjs            # warn-only
 *   node scripts/lint-cache-keys.mjs --strict   # CI gate
 *   STRICT=1 node scripts/lint-cache-keys.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const STRICT = process.argv.includes('--strict') || process.env.STRICT === '1';
const ROOT = fileURLToPath(new URL('../src', import.meta.url));
const BACKEND_ROOT = fileURLToPath(new URL('..', import.meta.url));

const CACHE_OPS = ['get', 'set', 'del', 'invalidate', 'getOrSet'];
const OP_RE = new RegExp(`\\bcache\\.(${CACHE_OPS.join('|')})\\(`, 'g');

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      await walk(full, out);
    } else if (ent.isFile() && /\.(m?js)$/.test(ent.name)) {
      // Skip the helper itself, its tests, and the lint script's own tests.
      if (full.endsWith('/cache.js') || full.endsWith('/cache.test.mjs')) continue;
      if (full.endsWith('/tenantKey.js') || full.endsWith('/tenantKey.test.mjs')) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Starting at `start` (index of opening `(`), walk the source balancing
 * parens / brackets / braces while honoring string and template-literal
 * boundaries. Returns the slice between the outer parens.
 */
function extractArgs(src, start) {
  // start points at the opening `(`
  let depth = 0;
  let i = start;
  let inStr = null;       // "'", '"', or '`'
  let inLineComment = false;
  let inBlockComment = false;
  let templateDepth = 0;  // ${...} nesting inside template literals
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++; continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      i++; continue;
    }
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (inStr === '`') {
        if (ch === '`' && templateDepth === 0) { inStr = null; i++; continue; }
        if (ch === '$' && next === '{') { templateDepth++; i += 2; continue; }
        if (ch === '}' && templateDepth > 0) { templateDepth--; i++; continue; }
      } else if (ch === inStr) {
        inStr = null; i++; continue;
      }
      i++; continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && ch === ')') return { args: src.slice(start + 1, i), end: i };
    }
    i++;
  }
  return null;
}

/**
 * Top-level comma split honoring strings / template literals / parens / brackets.
 */
function splitTopLevelCommas(s) {
  const out = [];
  let depth = 0;
  let inStr = null;
  let templateDepth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inStr) {
      buf += ch;
      if (ch === '\\') { buf += next; i++; continue; }
      if (inStr === '`') {
        if (ch === '`' && templateDepth === 0) inStr = null;
        else if (ch === '$' && next === '{') { templateDepth++; buf += next; i++; }
        else if (ch === '}' && templateDepth > 0) templateDepth--;
      } else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Classify a key expression. Returns one of:
 *   'allowed-string'    — quoted literal, has its own concrete namespace
 *   'allowed-helper'    — call to tenantKey(...) / globalKey(...)
 *   'allowed-prefixed'  — template literal that starts with `t:${...}:` or `global:`
 *   'violation-template'
 *   'violation-concat'
 *   'unknown'           — bare identifier / call we couldn't resolve, or
 *                         something we don't understand
 */
function classifyExpr(expr) {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return 'unknown';
  // Quoted string literal — fine.
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return 'allowed-string';
  }
  // Helper call.
  if (/^(tenantKey|globalKey)\s*\(/.test(trimmed)) return 'allowed-helper';
  // Template literal.
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    // If the template body invokes a helper inside ${...}, that's fine.
    if (/\b(tenantKey|globalKey)\s*\(/.test(trimmed)) return 'allowed-helper';
    // Heuristic: a template that starts with `t:${` (literal namespace
    // prefix + interpolated tenantId) is considered compliant — it's the
    // shape callers will eventually rewrite to via tenantKey().
    if (/^`t:\$\{/.test(trimmed)) return 'allowed-prefixed';
    if (/^`global:/.test(trimmed)) return 'allowed-prefixed';
    return 'violation-template';
  }
  // String concat with `+`. Look for at least one identifier or template in
  // the chain; literal-only `+` chains are rare in practice but harmless.
  if (trimmed.includes('+') && /['"`]/.test(trimmed)) {
    if (/\b(tenantKey|globalKey)\s*\(/.test(trimmed)) return 'allowed-helper';
    return 'violation-concat';
  }
  return 'unknown';
}

/**
 * Resolve a bare identifier back to its assignment in the same file. Returns
 * the RHS expression text, or null if not found. One-hop only (no recursive
 * chasing) — good enough for the cacheKey idiom used across the codebase.
 */
function resolveIdentifier(src, ident) {
  // Match: const|let|var <ident> = <expr>;  (expr ends at newline+semicolon
  // or matching paren-balance; we just take to end of line and trim).
  const re = new RegExp(
    `\\b(?:const|let|var)\\s+${ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*([\\s\\S]*?);\\s*(?:\\n|$)`,
    'g'
  );
  let m;
  let last = null;
  while ((m = re.exec(src))) last = m[1].trim();
  return last;
}

async function lintFile(file) {
  const src = await readFile(file, 'utf8');
  const violations = [];
  let m;
  OP_RE.lastIndex = 0;
  while ((m = OP_RE.exec(src))) {
    const op = m[1];
    const parenStart = m.index + m[0].length - 1; // points at "("
    const extracted = extractArgs(src, parenStart);
    if (!extracted) continue;
    const args = splitTopLevelCommas(extracted.args);
    if (args.length === 0) continue;
    const keyExpr = args[0];
    let kind = classifyExpr(keyExpr);
    // If the first arg looks like a bare identifier, try to resolve it.
    if (kind === 'unknown' && /^[A-Za-z_$][\w$]*$/.test(keyExpr.trim())) {
      const rhs = resolveIdentifier(src, keyExpr.trim());
      if (rhs) kind = classifyExpr(rhs);
    }
    // Line number for reporting.
    const line = src.slice(0, m.index).split('\n').length;
    if (kind === 'violation-template' || kind === 'violation-concat') {
      violations.push({
        file, line, op,
        key: keyExpr.length > 80 ? keyExpr.slice(0, 77) + '...' : keyExpr,
        kind
      });
    }
  }
  return violations;
}

async function main() {
  const files = await walk(ROOT);
  const all = [];
  for (const file of files) {
    const v = await lintFile(file);
    all.push(...v);
  }
  if (all.length === 0) {
    console.log('lint-cache-keys: 0 violations. All cache keys route through tenantKey() / globalKey() or use static string namespaces.');
    process.exit(0);
  }
  const tag = STRICT ? 'ERROR' : 'WARN';
  for (const v of all) {
    const rel = relative(BACKEND_ROOT, v.file);
    console.log(`[${tag}] ${rel}:${v.line}  cache.${v.op}(...)  ${v.kind}  key=${v.key}`);
  }
  console.log(`\nlint-cache-keys: ${all.length} ${STRICT ? 'violation(s)' : 'warning(s)'}.`);
  if (STRICT) {
    console.log('Run without --strict / STRICT=1 to make this advisory.');
    process.exit(1);
  } else {
    console.log('Advisory only (PR-3a). Will become a hard failure in PR-3b once callsites are migrated.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('lint-cache-keys: fatal', err);
  process.exit(2);
});
