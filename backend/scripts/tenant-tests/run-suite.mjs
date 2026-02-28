import { spawnSync } from 'node:child_process';

const files = [
  'v3-read-isolation.mjs',
  'v4-write-isolation.mjs',
  'v5-superadmin.mjs',
  'v6-lifecycle.mjs'
];

const results = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [new URL(f, import.meta.url).pathname], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(out); } catch {}
  results.push({ file: f, code: r.status ?? 1, parsed, stderr: (r.stderr || '').trim() });
}

const summary = results.map((r) => ({
  file: r.file,
  code: r.code,
  failed: r.parsed?.summary?.failed ?? null
}));

console.log(JSON.stringify({ summary, results }, null, 2));
const anyFail = results.some((r) => r.code !== 0 || (r.parsed?.summary?.failed ?? 1) > 0);
if (anyFail) process.exit(1);