/**
 * Anti-drift: every email leaves as the TENANT, not as the platform.
 *
 * Passing the sender by hand did not scale — an audit on 2026-08-17 found 6
 * of ~46 send sites doing it, so a Rent & Go customer got their confirmation
 * from rentandgopr.com and their toll notice from ridefleetmanager.com. The
 * resolution moved into sendEmail (pass `tenantId`, get that tenant's
 * verified sender), and this test is what stops the next call site from
 * silently shipping platform-branded mail again.
 *
 * Same shape as the curriculum-anchor guard: walk the real source, count what
 * is actually there, and require an explicit entry for anything exempt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Sites that legitimately send AS THE PLATFORM, with the reason. Anything
 * here is a deliberate decision, not an oversight — shrink this list, never
 * grow it without a reason a customer would accept.
 */
const EXEMPT = new Map([
  ['lib/email-template.js', 'usage example inside a doc comment, not a call'],
  ['modules/messaging/trip-chat.service.js', 'car-sharing chat: the loaded conversation carries the trip but not its tenant; needs a query change, tracked separately'],
]);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.js$/.test(entry) && !/\.test\.mjs$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every sendEmail call site that names neither a tenant nor an explicit from. */
function unattributedSites() {
  const bad = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (rel === 'lib/mailer.js') continue; // the implementation itself
    if (EXEMPT.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('sendEmail({')) return;
      // The call's own options may wrap over the next few lines.
      const window = lines.slice(i, i + 8).join(' ');
      if (/\btenantId\b/.test(window) || /\bfromEmail\b/.test(window)) return;
      bad.push(`${rel}:${i + 1}`);
    });
  }
  return bad;
}

test('every sendEmail call names the tenant it sends for', () => {
  const bad = unattributedSites();
  assert.deepEqual(
    bad, [],
    'These sends would go out as the PLATFORM, not the tenant. Pass tenantId '
    + '(sendEmail resolves that tenant\'s verified sender), or add the file to '
    + 'EXEMPT with a reason:\n  ' + bad.join('\n  '),
  );
});

test('the exemption list stays small and reasoned', () => {
  for (const [file, reason] of EXEMPT) {
    assert.ok(reason && reason.length > 15, `${file} needs a real reason, got: ${reason}`);
  }
  assert.ok(EXEMPT.size <= 4, `exemptions are growing (${EXEMPT.size}) — resolve them instead`);
});
