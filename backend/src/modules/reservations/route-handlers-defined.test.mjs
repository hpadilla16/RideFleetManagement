/**
 * RES-849093 FIX 3 smoke test: every registered Express route handler must be a
 * function. This catches the dead-endpoint class of bug (e.g. a route wired to a
 * service method that does not exist would register `undefined` as a handler).
 * Pure import-time introspection — no DB required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reservationsRouter } from './reservations.routes.js';
import { rentalAgreementsRouter } from '../rental-agreements/rental-agreements.routes.js';

function collectHandlerProblems(router, label) {
  const problems = [];
  const stack = Array.isArray(router?.stack) ? router.stack : [];
  for (const layer of stack) {
    const route = layer.route;
    if (!route) continue;
    const methods = Object.keys(route.methods || {}).join(',').toUpperCase();
    for (const h of route.stack || []) {
      if (typeof h.handle !== 'function') {
        problems.push(`${label} ${methods} ${route.path}: handler is ${typeof h.handle}`);
      }
    }
  }
  return problems;
}

test('every reservations route handler is a defined function', () => {
  const problems = collectHandlerProblems(reservationsRouter, 'reservations');
  assert.equal(problems.length, 0, problems.join('\n'));
});

test('every rental-agreements route handler is a defined function', () => {
  const problems = collectHandlerProblems(rentalAgreementsRouter, 'rental-agreements');
  assert.equal(problems.length, 0, problems.join('\n'));
});
