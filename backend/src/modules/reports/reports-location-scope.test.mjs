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

// ---------------------------------------------------------------------------
// Per-slug wiring (2026-08-28)
//
// The cases above prove the guard is correct in isolation. They do NOT prove
// any given report actually got it — `registerReport` only applies the location
// gate when the report omits `locationScoped: false`, so one stray opt-out
// silently hands a branch user the whole tenant's numbers. unpaid-balance is
// now the destination of the Ops Hub tile, so its wiring is worth pinning.
// ---------------------------------------------------------------------------

// Importing the report module is what MOUNTS it — registerReport runs as an
// import side effect (in production that happens via register-all-reports.js).
// Only this one report is imported so the suite stays fast and does not drag in
// the other twenty.
await import('./unpaid-balance.report.js');
const { reportsV2Router } = await import('./reports-v2.routes.js');

// Run a route's middleware in order, stopping at the first one that responds.
// The final layer is the report handler itself (it would hit the database), so
// it is never invoked — reaching it is the pass condition.
function runRouteGuards(path, user) {
  const layer = (reportsV2Router.stack || []).find((l) => l.route && l.route.path === path);
  assert.ok(layer, `route ${path} is mounted`);
  const handlers = layer.route.stack.map((s) => s.handle);
  const req = { user, query: {} };
  const res = fakeRes();
  for (const h of handlers.slice(0, -1)) {
    let advanced = false;
    h(req, res, () => { advanced = true; });
    if (!advanced) return { req, res, reachedHandler: false };
  }
  return { req, res, reachedHandler: true };
}

describe('unpaid-balance is registered location-scoped', () => {
  it('a single-location ADMIN reaches the report with her location pinned', () => {
    const { req, res, reachedHandler } = runRouteGuards('/unpaid-balance', scopedUser(['loc-mayaguez']));
    assert.equal(res.statusCode, null, 'no 403 — a branch user can run this report');
    assert.equal(reachedHandler, true);
    assert.equal(req.query.locationId, 'loc-mayaguez',
      'and it runs on HER branch, not the tenant — the report filters on this');
  });

  it('a multi-location ADMIN is asked which location rather than shown everything', () => {
    const { res, reachedHandler } = runRouteGuards('/unpaid-balance', scopedUser(['loc-a', 'loc-b']));
    assert.equal(reachedHandler, false);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body.allowedLocationIds, ['loc-a', 'loc-b']);
  });

  it('the excel export carries the same gate as the data route', () => {
    // Accounting downloads the spreadsheet; an unguarded export would leak the
    // whole tenant even while the on-screen report stayed correctly scoped.
    const { req, res, reachedHandler } = runRouteGuards('/unpaid-balance/excel', scopedUser(['loc-mayaguez']));
    assert.equal(res.statusCode, null);
    assert.equal(reachedHandler, true);
    assert.equal(req.query.locationId, 'loc-mayaguez');
  });

  it('a program-restricted account is still rejected on it', () => {
    const { res, reachedHandler } = runRouteGuards(
      '/unpaid-balance', { role: 'OPS', programScope: 'LOANER_ONLY' });
    assert.equal(reachedHandler, false);
    assert.equal(res.statusCode, 403);
  });
});
