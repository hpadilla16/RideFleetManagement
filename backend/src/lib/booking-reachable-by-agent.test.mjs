/**
 * Everything the new-reservation wizard reads must be reachable by an AGENT.
 *
 * The lesson has arrived three times now, always as "the screen looks fine":
 *   2026-08-10  locations   → 403 drawn as an empty branch dropdown
 *   2026-08-17  vehicle types → 403 drawn as "there are no cars"
 *   2026-08-17  rental minimum → 403 replaced by a hardcoded 24h rule
 *
 * Agents are the people who create reservations. Any endpoint the wizard
 * needs, gated to ADMIN/OPS, breaks the core job silently — the frontend
 * catches the failure and renders an absence.
 *
 * So this walks the wizard's ACTUAL source for the endpoints it calls, then
 * walks main.js for how each is mounted, and fails if any is only reachable
 * behind a role gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = readFileSync(join(HERE, '..', 'main.js'), 'utf8');
const WIZARD = readFileSync(
  join(HERE, '..', '..', '..', 'frontend', 'src', 'app', 'reservations', 'new', 'page.js'),
  'utf8',
);

/**
 * Endpoints the wizard calls, as mount prefixes. Query strings and path
 * params are dropped: what matters is which app.use() line governs them.
 */
function endpointsTheWizardCalls() {
  const found = new Set();
  for (const m of WIZARD.matchAll(/api\(\s*[`'"]([^`'"?$]*\/api\/[^`'"?$]*)/g)) {
    const path = m[1].slice(m[1].indexOf('/api/'));
    const parts = path.split('/').filter(Boolean); // ['api','rates','rental-minimum']
    if (parts.length < 2) continue;
    found.add(`/${parts[0]}/${parts[1]}`);
  }
  return [...found].sort();
}

/**
 * Every app.use mount for a prefix, in file order. A request is reachable by
 * an agent if ANY mount for that prefix lacks a role gate — Express tries
 * them in order, so an ungated router mounted earlier answers first.
 */
function mountsFor(prefix) {
  const out = [];
  for (const line of MAIN.split('\n')) {
    if (!line.includes('app.use(') || !line.includes(`'${prefix}'`)) continue;
    out.push({ line: line.trim(), roleGated: /requireRole\(/.test(line) });
  }
  return out;
}

/**
 * Deliberately admin-only, with the reason. Anything here degrades to LESS
 * information for an agent, never to a broken flow — that is the bar for
 * being on this list.
 */
const EXEMPT = new Map([
  ['/api/market', 'Market Intelligence is a management add-on: competitor pricing is not an agent view. The class cards simply render without market context.'],
]);

test('the wizard only calls endpoints an AGENT can reach', () => {
  const unreachable = [];
  for (const prefix of endpointsTheWizardCalls()) {
    if (EXEMPT.has(prefix)) continue;
    const mounts = mountsFor(prefix);
    if (!mounts.length) continue; // mounted elsewhere (e.g. a nested router)
    if (mounts.every((m) => m.roleGated)) unreachable.push(prefix);
  }
  assert.deepEqual(
    unreachable, [],
    'The new-reservation wizard reads these, but every mount is behind a role '
    + 'gate — an agent gets a 403 that the form will render as missing data. '
    + 'Expose a booking-safe read (see locations-selectable / '
    + 'vehicle-types-selectable) mounted BEFORE the gate:\n  '
    + unreachable.join('\n  '),
  );
});

test('the booking-safe reads are mounted BEFORE their gated siblings', () => {
  // Order is the whole mechanism: mounted after the gate, they never run.
  for (const [prefix, needle] of [
    ['/api/locations', 'locationsSelectableRouter'],
    ['/api/vehicle-types', 'vehicleTypesSelectableRouter'],
    ['/api/rates', 'ratesBookingRouter'],
  ]) {
    const open = MAIN.indexOf(needle + ')');
    const gated = MAIN.indexOf(`app.use('${prefix}', requireAuth, tenantRateLimit, requireModuleAccess`);
    assert.ok(open > 0, `${needle} is not mounted`);
    assert.ok(gated > 0, `${prefix} gated mount not found`);
    assert.ok(open < gated, `${needle} must be mounted before the gated ${prefix} router, or it never answers`);
  }
});

test('the wizard actually asks for the booking-safe vehicle-type read', () => {
  // Guards the other half: the endpoint existing is useless if the form still
  // calls the admin one.
  assert.match(WIZARD, /\/api\/vehicle-types\/selectable/);
  assert.ok(
    !/api\(\s*['"`]\/api\/vehicle-types['"`]/.test(WIZARD),
    'the wizard is back on the ADMIN-gated /api/vehicle-types',
  );
});

test('every admin-only endpoint the wizard touches has a stated reason', () => {
  for (const [prefix, reason] of EXEMPT) {
    assert.ok(reason && reason.length > 30, `${prefix} needs a real reason, got: ${reason}`);
    assert.ok(
      endpointsTheWizardCalls().includes(prefix),
      `${prefix} is exempted but the wizard no longer calls it — drop the entry`,
    );
  }
});
