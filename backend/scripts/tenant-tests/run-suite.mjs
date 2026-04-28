import { spawnSync } from 'node:child_process';

const files = [
  'v3-read-isolation.mjs',
  'v4-write-isolation.mjs',
  'v5-superadmin.mjs',
  'v6-lifecycle.mjs',
  'v7-website-fees.mjs',
  'v8-addendum-isolation.mjs',
  'v8-stop-sale-isolation.mjs'
];

const results = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const r = spawnSync(process.execPath, [new URL(f, import.meta.url).pathname], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(out); } catch {}
  results.push({ file: f, code: r.status ?? 1, parsed, stderr: (r.stderr || '').trim() });
  // Sleep 65s between scripts so the per-IP /auth/login rate-limit bucket
  // (5 req / 60s, see backend/src/modules/auth/auth.routes.js) clears
  // between scripts. Without this, v5/v6/v7 fail with HTTP 429 after
  // v3+v4 burn the budget in the same suite run.
  if (i < files.length - 1) {
    await new Promise((resolve) => setTimeout(resolve, 65_000));
  }
}

const summary = results.map((r) => ({
  file: r.file,
  code: r.code,
  failed: r.parsed?.summary?.failed ?? null
}));

console.log(JSON.stringify({ summary, results }, null, 2));
const anyFail = results.some((r) => r.code !== 0 || (r.parsed?.summary?.failed ?? 1) > 0);
if (anyFail) process.exit(1);