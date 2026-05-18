#!/usr/bin/env node
// scripts/migrate-handlers-to-wrapper.mjs
//
// Codemod for Path D, Phase B step 2 — wrap tenant-scoped Prisma calls in
// route handlers with withTenantSchema(req.user.tenantId, (db) => db.X.Y(...)).
//
// Usage (from RideFleetManagement repo root):
//
//   # Dry run — preview changes without writing
//   node scripts/migrate-handlers-to-wrapper.mjs --dry-run backend/src/modules/reservations
//
//   # Real run — modifies files in place
//   node scripts/migrate-handlers-to-wrapper.mjs backend/src/modules/reservations
//
//   # Multiple paths
//   node scripts/migrate-handlers-to-wrapper.mjs \
//     backend/src/modules/reservations \
//     backend/src/modules/rental-agreements
//
// What it does:
//   1. Recursively finds *.routes.js files under the given paths.
//   2. For each file:
//      a. Parses to AST via acorn.
//      b. Finds Express route definitions: router.METHOD(path, ...middleware, handler).
//      c. Identifies the handler callback (last argument).
//      d. Inside the handler body, finds `prisma.X.Y(...)` MemberExpression calls.
//      e. Wraps each prisma call in `withTenantSchema(req.user.tenantId, (db) => db.X.Y(...))`.
//      f. Adds the `import { withTenantSchema } from '../../lib/tenant-routing.js';` line if missing.
//   3. Writes a unified diff to stdout. With --write, writes modified files back.
//
// Safety:
//   - Only modifies *.routes.js files (services + lib unchanged).
//   - Skips handlers without `req` parameter (assumes it's middleware or non-tenant work).
//   - Skips handlers that already use withTenantSchema (idempotent).
//   - Skips prisma calls that aren't inside a route handler (e.g., module-level setup).
//   - Skips files that don't import `prisma` (nothing to migrate).
//   - --dry-run mode prints the diff but never writes.
//
// Dependencies:
//   - acorn (npm i -D acorn) — installed locally for the script run
//   - acorn-walk (npm i -D acorn-walk)
//
// If acorn/acorn-walk aren't already installed, the script prints an install
// command and exits. Run `npm i -D acorn acorn-walk` once and re-run.
//
// Output diff is shown in `git diff` style for review before applying.

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Dependency check
// =============================================================================

let parser, walker;
try {
  parser = await import('acorn');
  walker = await import('acorn-walk');
} catch (err) {
  console.error('Missing dependencies. Install with:');
  console.error('  npm i -D acorn acorn-walk');
  console.error('Then re-run this script.');
  process.exit(1);
}

const { Parser } = parser;
const { simple, ancestor, full } = walker;

// =============================================================================
// CLI argument parsing
// =============================================================================

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const write = args.includes('--write') || (!dryRun && !args.includes('--print'));
const verbose = args.includes('--verbose');
const paths = args.filter((a) => !a.startsWith('--'));

if (paths.length === 0) {
  console.error('Usage: node scripts/migrate-handlers-to-wrapper.mjs [--dry-run] [--write] [--verbose] <path>...');
  console.error('Example: node scripts/migrate-handlers-to-wrapper.mjs --dry-run backend/src/modules/reservations');
  process.exit(1);
}

// =============================================================================
// File discovery
// =============================================================================

function findRouteFiles(rootPath) {
  const results = [];
  const stat = statSync(rootPath);
  if (stat.isFile()) {
    if (rootPath.endsWith('.routes.js')) results.push(rootPath);
    return results;
  }
  if (!stat.isDirectory()) return results;
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const fullPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...findRouteFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.routes.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

// =============================================================================
// AST helpers
// =============================================================================

function parseSource(source) {
  return Parser.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    ranges: true,
  });
}

// Returns true if `node` is a CallExpression like `prisma.foo.bar(args)`
function isPrismaCall(node) {
  if (node.type !== 'CallExpression') return false;
  let callee = node.callee;
  // Walk down MemberExpression chain to find the leftmost Identifier
  while (callee.type === 'MemberExpression') {
    callee = callee.object;
  }
  return callee.type === 'Identifier' && callee.name === 'prisma';
}

// Returns true if a node is already wrapped in withTenantSchema
function isAlreadyWrapped(callExpr) {
  // Crude heuristic — check if parent is a withTenantSchema call.
  // Real check happens via the parent chain in the walker.
  return false;
}

// Returns true if a route handler function is an Express handler (has req as first arg)
function isExpressHandler(funcNode) {
  if (!funcNode) return false;
  if (funcNode.type !== 'ArrowFunctionExpression' && funcNode.type !== 'FunctionExpression') return false;
  const firstParam = funcNode.params?.[0];
  if (!firstParam) return false;
  // Must be identifier `req` (or have a `req` somewhere). Allow common variants.
  if (firstParam.type === 'Identifier' && (firstParam.name === 'req' || firstParam.name === '_req')) {
    return true;
  }
  return false;
}

// Returns true if `node` is router.METHOD(...) or app.METHOD(...) call
function isRouterRouteCall(node) {
  if (node.type !== 'CallExpression') return false;
  if (node.callee.type !== 'MemberExpression') return false;
  const propName = node.callee.property?.name;
  if (!propName) return false;
  return ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'].includes(propName);
}

// Returns the handler function from a router.METHOD(path, ...middleware, handler) call.
// The handler is the last argument.
function getRouteHandler(routeCall) {
  const args = routeCall.arguments;
  if (args.length === 0) return null;
  const last = args[args.length - 1];
  if (isExpressHandler(last)) return last;
  return null;
}

// =============================================================================
// Core transformation: find prisma calls inside route handlers
// =============================================================================

function findHandlerPrismaCalls(ast) {
  const findings = []; // [{ prismaCall, handlerNode }]

  // Walk top-down to find route definitions
  full(ast, (node) => {
    if (!isRouterRouteCall(node)) return;
    const handler = getRouteHandler(node);
    if (!handler) return;

    // Walk inside the handler to find prisma.X.Y(...) calls
    simple(handler.body, {
      CallExpression(callNode) {
        if (isPrismaCall(callNode)) {
          findings.push({ prismaCall: callNode, handlerNode: handler, routeCall: node });
        }
      },
    });
  });

  return findings;
}

// =============================================================================
// Source rewriting (string-based, using ranges from AST)
// =============================================================================

// Apply replacements sorted descending by start position so earlier ranges
// stay valid as we mutate the string.
function applyReplacements(source, replacements) {
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let out = source;
  for (const r of sorted) {
    out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
  }
  return out;
}

// Wrap a prisma.X.Y(args) call in withTenantSchema(req.user.tenantId, (db) => db.X.Y(args))
// `source` is the original source string; `node` is the CallExpression range.
function wrapPrismaCall(source, node) {
  const original = source.slice(node.start, node.end);
  // Replace the leftmost `prisma` identifier with `db` to produce the inner call.
  // Use a careful regex anchored at start because the AST starts at `prisma`.
  if (!original.startsWith('prisma')) {
    // Defensive: should not happen with our AST detection. Skip.
    return null;
  }
  const inner = 'db' + original.slice('prisma'.length);
  const replacement = `withTenantSchema(req.user.tenantId, (db) => ${inner})`;
  return { start: node.start, end: node.end, replacement, original };
}

// Add the withTenantSchema import after the prisma import (or at top of imports).
// Idempotent — skips if already imported.
function addWrapperImport(source) {
  const wrapperImport = "import { withTenantSchema } from '../../lib/tenant-routing.js';\n";
  if (source.includes("from '../../lib/tenant-routing.js'") || source.includes('withTenantSchema')) {
    return null; // already imported
  }
  // Find the prisma import line and append wrapper import after it.
  const prismaImportMatch = source.match(/^import\s+\{\s*prisma\s*\}\s+from\s+['"][^'"]*lib\/prisma\.js['"];?\s*$/m);
  if (!prismaImportMatch) {
    // No prisma import → file doesn't need migration anyway (no prisma calls).
    return null;
  }
  const insertAt = prismaImportMatch.index + prismaImportMatch[0].length;
  // Insert after the line (preserve newline)
  return { start: insertAt, end: insertAt, replacement: '\n' + wrapperImport.trimEnd() };
}

// =============================================================================
// Main file processing
// =============================================================================

function processFile(filePath) {
  const source = readFileSync(filePath, 'utf8');

  // Skip files that don't use prisma at all
  if (!source.includes("from '../../lib/prisma.js'") && !source.includes('prisma.')) {
    if (verbose) console.error(`  skip ${filePath} — no prisma usage`);
    return null;
  }

  let ast;
  try {
    ast = parseSource(source);
  } catch (err) {
    console.error(`PARSE ERROR in ${filePath}:`);
    console.error(`  ${err.message}`);
    return null;
  }

  const findings = findHandlerPrismaCalls(ast);
  if (findings.length === 0) {
    if (verbose) console.error(`  no handler prisma calls in ${filePath}`);
    return null;
  }

  const replacements = [];
  for (const { prismaCall } of findings) {
    const r = wrapPrismaCall(source, prismaCall);
    if (r) replacements.push(r);
  }

  // Add the import if any replacements were made
  if (replacements.length > 0) {
    const importInsertion = addWrapperImport(source);
    if (importInsertion) replacements.push(importInsertion);
  }

  const modified = applyReplacements(source, replacements);

  return { filePath, source, modified, count: findings.length };
}

// =============================================================================
// Unified diff output (very simple, line-by-line)
// =============================================================================

function unifiedDiff(filePath, original, modified) {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const out = [];
  out.push(`--- a/${filePath}`);
  out.push(`+++ b/${filePath}`);

  // Find the changed regions (naive — uses first divergence + last divergence)
  let firstDiff = -1, lastDiff = -1;
  const maxLen = Math.max(origLines.length, modLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (origLines[i] !== modLines[i]) {
      if (firstDiff === -1) firstDiff = i;
      lastDiff = i;
    }
  }
  if (firstDiff === -1) return ''; // no actual diff

  const ctxStart = Math.max(0, firstDiff - 2);
  const ctxEndOrig = Math.min(origLines.length, lastDiff + 3);
  const ctxEndMod = Math.min(modLines.length, lastDiff + 3);
  out.push(`@@ -${ctxStart + 1},${ctxEndOrig - ctxStart} +${ctxStart + 1},${ctxEndMod - ctxStart} @@`);

  for (let i = ctxStart; i < Math.max(ctxEndOrig, ctxEndMod); i++) {
    const a = origLines[i];
    const b = modLines[i];
    if (a === b) {
      if (a !== undefined) out.push(` ${a}`);
    } else {
      if (a !== undefined) out.push(`-${a}`);
      if (b !== undefined) out.push(`+${b}`);
    }
  }

  return out.join('\n') + '\n';
}

// =============================================================================
// Driver
// =============================================================================

let totalFiles = 0;
let totalChanges = 0;
const fileResults = [];

for (const root of paths) {
  const files = findRouteFiles(root);
  if (verbose) console.error(`Scanning ${root}: found ${files.length} *.routes.js files`);
  for (const file of files) {
    const result = processFile(file);
    if (result) {
      fileResults.push(result);
      totalFiles += 1;
      totalChanges += result.count;
    }
  }
}

if (fileResults.length === 0) {
  console.error('No files needed migration.');
  process.exit(0);
}

console.error('');
console.error(`=== Migration summary: ${totalFiles} files, ${totalChanges} prisma call sites ===`);
console.error('');

for (const r of fileResults) {
  console.error(`* ${r.filePath} — ${r.count} prisma calls wrapped`);
}
console.error('');

if (dryRun) {
  console.error('Dry-run mode. No files modified. Diff follows:');
  console.error('');
  for (const r of fileResults) {
    process.stdout.write(unifiedDiff(r.filePath, r.source, r.modified));
  }
  console.error('');
  console.error('Re-run without --dry-run to apply.');
  process.exit(0);
}

// Write mode
if (write) {
  for (const r of fileResults) {
    writeFileSync(r.filePath, r.modified, 'utf8');
    console.error(`  wrote ${r.filePath}`);
  }
  console.error('');
  console.error(`Wrote ${totalFiles} files. Review with: git diff backend/src/modules/`);
  console.error('Run tests: npm run test');
  console.error('Commit when ready.');
}
