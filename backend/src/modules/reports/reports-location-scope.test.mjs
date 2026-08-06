/**
 * Location-scoped users can run reports — pinned to their locations
 * (Hector, 2026-08-06: a location-restricted ADMIN got the flat 403 on every
 * report page; screenshot was Rental Status with her own location selected).
 *
 * The gate replaces the blanket rejection on registerReport routes: a report
 * that filters by query.locationId admits scoped users with the location
 * VALIDATED or PINNED; a report with no location dimension keeps rejecting.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { applyReportLocationScope, rejectScopedUsers } = await import('./reports-v2.routes.js');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const scopedUser = (ids) => ({ role: 'ADMIN', locationIds: ids });

describe('applyReportLocationScope', () => {
  it('an unscoped user passes untouched', () => {
    const req = { user: { role: 'ADMIN' }, query: {} };
    const res = fakeRes();
    assert.equal(applyReportLocationScope(req, res), true);
    assert.equal(res.statusCode, null);
    assert.equal(req.query.locationId, undefined);
  });

  it('the screenshot case: scoped admin requesting HER OWN location gets through', () => {
    const req = { user: scopedUser(['loc-mayaguez']), query: { locationId: 'loc-mayaguez' } };
    const res = fakeRes();
    assert.equal(applyReportLocationScope(req, res), true);
  });

  it('a location outside the allowed set is a 403, not a silent swap', () => {
    const req = { user: scopedUser(['loc-mayaguez']), query: { locationId: 'loc-sju' } };
    const res = fakeRes();
    assert.equal(applyReportLocationScope(req, res), false);
    assert.equal(res.statusCode, 403);
  });

  it('no location + exactly one allowed → pinned silently', () => {
    const req = { user: scopedUser(['loc-mayaguez']), query: {} };
    const res = fakeRes();
    assert.equal(applyReportLocationScope(req, res), true);
    assert.equal(req.query.locationId, 'loc-mayaguez', 'the report now runs on her location');
  });

  it('no location + several allowed → 400 listing them, never a wrong default', () => {
    const req = { user: scopedUser(['loc-a', 'loc-b']), query: {} };
    const res = fakeRes();
    assert.equal(applyReportLocationScope(req, res), false);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body.allowedLocationIds, ['loc-a', 'loc-b']);
  });

  it('a report with no location dimension still rejects scoped users', () => {
    const req = { user: scopedUser(['loc-mayaguez']), query: { locationId: 'loc-mayaguez' } };
    const res = fakeRes();
    assert.equal(applyReportLocationScope(req, res, { locationScoped: false }), false);
    assert.equal(res.statusCode, 403);
  });

  it('program-restricted accounts stay rejected everywhere', () => {
    const req = { user: { role: 'OPS', programScope: 'LOANER_ONLY' }, query: {} };
    const res = fakeRes();
    assert.equal(applyReportLocationScope(req, res), false);
    assert.equal(res.statusCode, 403);
  });

  it('rejectScopedUsers survives untouched for the whole-tenant routes', () => {
    // /snapshot and the dashboard-v2 endpoints still use the old guard — their
    // datasets take a bare tenantId and share caches, so scoping cannot be
    // pinned there yet.
    const res = fakeRes();
    let called = false;
    rejectScopedUsers({ user: scopedUser(['loc-a']) }, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 403);
  });
});
