/**
 * The CNP rail rules, behaviour-tested (2026-09-04).
 *
 * These two functions decide which gateway client a saved-card operation may
 * use. Getting them wrong is not a bug that errors — it is a charge routed
 * through another merchant's credentials (the silent gateway crossing this
 * codebase forbids) or a void sent to a rail that cannot see the hold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { usesSpinCnpRail, holdVoidRail } from './cnp-rail.js';

test('a tenant-resolved terminal (spinTpn present) is on the SPIn rail', () => {
  assert.equal(usesSpinCnpRail({ spinTpn: '816026434206', spinAuthKey: 'abc' }), true);
});

test('the legacy env deployment (empty config) stays on Transact', () => {
  assert.equal(usesSpinCnpRail({}), false);
  assert.equal(usesSpinCnpRail(), false);
  assert.equal(usesSpinCnpRail(null), false);
});

test('MANUAL- holds touch no gateway', () => {
  assert.equal(holdVoidRail('MANUAL-RES-123456-abc', {}), 'MANUAL');
  assert.equal(holdVoidRail('MANUAL-RES-123456-abc', { spinTpn: 'x' }), 'MANUAL');
});

test('a SPIn pre-auth ReferenceId (-DEP-) voids on SPIn regardless of tenant rail', () => {
  // The exact shape spin-charge minted for the first real LAX checkout.
  assert.equal(holdVoidRail('RES-700371-DEP-mtnhgpib', {}), 'SPIN');
  assert.equal(holdVoidRail('RES-700371-DEP-mtnhgpib', { spinTpn: 'x' }), 'SPIN');
});

test('an all-digit hold id is a Transact RRN and voids on Transact — even for a SPIn tenant', () => {
  // Old Transact holds must stay voidable after a tenant gets its own terminal.
  assert.equal(holdVoidRail('123456789012', { spinTpn: 'x' }), 'TRANSACT');
  assert.equal(holdVoidRail('123456789012', {}), 'TRANSACT');
});

test('an ambiguous hold id falls to the tenant rail', () => {
  assert.equal(holdVoidRail('weird-ref', { spinTpn: 'x' }), 'SPIN');
  assert.equal(holdVoidRail('weird-ref', {}), 'TRANSACT');
});

test('a missing hold id never reads as SPIn-with-no-reference', () => {
  // '' contains no -DEP- and is not digits: it falls to the tenant rail, and
  // the caller's own "no active deposit hold" guard fires before any void.
  assert.equal(holdVoidRail('', {}), 'TRANSACT');
  assert.equal(holdVoidRail(null, { spinTpn: 'x' }), 'SPIN');
});
