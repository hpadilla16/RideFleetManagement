/**
 * Mex sync worker — HANDLER-level guards (Innovation gate, 2026-07-16).
 *
 * NO DATABASE, NO NETWORK: the prisma singleton is monkey-patched per test
 * (booking-source.test.mjs's style) and the HTTP layer is driven through the
 * service's `__test.setFetch` seam with a fake TSD RezCentral that speaks real
 * WebForms (login form → landing → menu postback → report grid). That means the
 * whole stack under test is the REAL one — mapper, service, parser and the shared
 * matcher — which is precisely the seam the unit tests were missing.
 *
 * What is locked here:
 *   1. MC2 — a failed/drifted Email report can NEVER read as a healthy run.
 *      A transport failure COUNTS (→ PARTIAL + notes); a layout drift on the
 *      email grid raises ATTENTION, same as the T&M grid. The old code swallowed
 *      both into a logger.warn and reported `status: 'OK', errorsCount: 0` — a run
 *      where 100% of rows silently lost their email looked perfect, which is
 *      exactly the input that maximizes the no-email population.
 *   2. MC3 — the run notes carry the RAW server span (rows + DateOut/Booked
 *      min-max vs what we asked for), so a wrong-column server range is a number
 *      a human can read instead of a silent permanent under-fetch.
 *   3. NIT — a source-side cancel of an ALREADY-PROMOTED row surfaces as the
 *      `cancelledAfterPromote` counter + a run note. The live Reservation is
 *      still deliberately left alone (ops/money call), but the inaction is now
 *      legible instead of buried in a log line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { prisma } = await import('../../../lib/prisma.js');
const svc = await import('./mex.service.js');
const { mexSyncHandler } = await import('./mex.worker.js');
const { toMonthOptionLabel, MENU_PATH_EMAIL } = await import('./mex.constants.js');

// ---------------------------------------------------------------------------
// A fake TSD RezCentral. Dispatches on method + body so the service's real
// request sequence (login → menu postback → report submit) drives it unchanged.
// ---------------------------------------------------------------------------

const TM_HEADERS = [
  'Confirm #', 'Name', 'Loc', 'Date Out', 'Date In', 'Booked', 'Class', 'Days', 'IATA',
  'Total Rate', 'Total Tax', 'Total Bill', 'Date Cancelled', 'Rate Code', 'PNR', 'Source',
  'CD', 'PO/BR',
];
const EMAIL_HEADERS = ['Email Address', 'Confirm', 'Name', 'Branch', 'Pickup', 'Return', 'Class'];

/** Dates the window helper will accept: pickup inside [today-2, today+30]. */
function isoDay(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The "Jul 2026"-shaped month option label, N months from now — so lstFromMonth /
 * lstToMonth offer the months the sync window actually spans, whenever this runs.
 */
function monthLabel(offsetMonths) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 15, 12));
  return toMonthOptionLabel(d);
}

/**
 * A T&M row. MEASURED 2026-07-17: a cancelled row keeps a REAL, NON-ZERO
 * `Total Bill` (the source does not zero it) and its `Date Cancelled` is a
 * TIMESTAMP. That phantom amount is exactly what must never reach a promoted
 * reservation's estimatedTotal.
 */
function tmRow(ref, { cancelled = false } = {}) {
  return [
    ref, 'MARIO GARCIA', '61302.MCO', isoDay(3), isoDay(6), isoDay(-20),
    'ECAR', '6', '33895934', cancelled ? 'Cancelled' : '101.16', '22.69',
    cancelled ? '130.98' : '135.85', cancelled ? `${isoDay(-1)} 02:31` : '', 'D6',
    'PNR789', 'AMADEUS', 'AD0016', '',
  ];
}

/**
 * The grid, WITH the real footer row (measured): cell 0 = "Rows: N", cells 1..17
 * repeat the header labels. The fake portal always renders it, so every worker
 * test implicitly proves the footer never becomes a booking.
 */
function gridHtml(headers, rows, { footer = true } = {}) {
  const td = (v) => `<td>${v === '' ? '&nbsp;' : v}</td>`;
  const footerRow = footer && rows.length
    ? `<tr>${[`Rows: ${rows.length}`, ...headers.slice(1)].map(td).join('')}</tr>`
    : '';
  return `<html><body><form name="Form1" method="post" action="WebRezClient.aspx">
    <input type="hidden" name="__VIEWSTATE" value="/wEPDwUKMTIz" />
    <table id="_ctl0_cphMaster1_dgRates">
      <tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>
      ${rows.map((r) => `<tr>${r.map(td).join('')}</tr>`).join('')}
      ${footerRow}
    </table></form></body></html>`;
}

const LOGIN_HTML = `<html><body><form method="post" action="WebLogin.aspx">
  <input type="hidden" name="__VIEWSTATE" value="/wEPDwUKMTIz" />
  <input type="text" name="_ctl0:txtUserID" value="" />
  <input type="password" name="_ctl0:txtPwd" value="" />
  <input type="image" name="_ctl0:imgLogin" />
</form></body></html>`;

const LANDING_HTML = `<html><body><form method="post" action="WebRezClient.aspx">
  <input type="hidden" name="__VIEWSTATE" value="/wEPDwUKNDU2" />
</form></body></html>`;

/**
 * The report screen as MEASURED 2026-07-17: no cmbReport (the menu path IS the
 * report selector), lstRunBy present, and CalFrom/CalTo are Calendar server
 * controls — <table>s, NOT inputs — so they are absent from the form's elements.
 */
const SCREEN_HTML = `<html><body><form method="post" action="WebRezClient.aspx">
  <input type="hidden" name="__VIEWSTATE" value="/wEPDwUKNzg5" />
  <input type="hidden" name="__EVENTTARGET" value="" />
  <input type="hidden" name="__EVENTARGUMENT" value="" />
  <select name="_ctl0:cphMaster1:lstTSDNumber"><option value="61302" selected>61302</option></select>
  <select name="_ctl0:cphMaster1:lstBranch"><option value="MCO" selected>MCO</option></select>
  <select name="_ctl0:cphMaster1:lstRunBy">
    <option value="Date Booked">Date Booked</option>
    <option value="Date Out" selected>Date Out</option>
    <option value="Date In">Date In</option>
  </select>
  <select name="_ctl0:cphMaster1:lstFromMonth"><option value="${monthLabel(0)}" selected>${monthLabel(0)}</option><option value="${monthLabel(1)}">${monthLabel(1)}</option></select>
  <select name="_ctl0:cphMaster1:lstToMonth"><option value="${monthLabel(0)}" selected>${monthLabel(0)}</option><option value="${monthLabel(1)}">${monthLabel(1)}</option></select>
  <table id="_ctl0_cphMaster1_CalFrom"><tr><td><a href="javascript:__doPostBack('_ctl0$cphMaster1$CalFrom','9693')">16</a></td></tr></table>
  <table id="_ctl0_cphMaster1_CalTo"><tr><td><a href="javascript:__doPostBack('_ctl0$cphMaster1$CalTo','9693')">16</a></td></tr></table>
  <input type="submit" name="_ctl0:cphMaster1:Button1" value="Submit" />
  <input type="submit" name="_ctl0:cphMaster1:cmdMonthTD" value="Current MTD" />
</form></body></html>`;

function fakeRes(body, { status = 200, setCookie = [] } = {}) {
  return {
    status,
    headers: {
      getSetCookie: () => setCookie,
      get: (k) => (k.toLowerCase() === 'set-cookie' ? (setCookie[0] || null) : null),
    },
    text: async () => body,
  };
}

/**
 * @param {object} plan
 * @param {string|Error} plan.emailResponse  grid HTML, or an Error to throw.
 */
function installFakePortal(plan = {}) {
  const calls = { tm: 0, email: 0 };
  // Which report the session is currently ON. The portal is single-window and
  // navigates by MENU postback — there is no cmbReport to dispatch on (measured
  // 2026-07-17), so the fake tracks the screen exactly as the real server does:
  // the menu postback puts you on a report, and Submit runs THAT report.
  let currentReport = 'TM';
  svc.__test.setCredentialsResolver(async () => ({ username: 'u', password: 'p' }));
  svc.__test.setFetch(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = String(opts.body || '');
    const params = new URLSearchParams(body);

    // Pre-login GET: ASP.NET hands out ASP.NET_SessionId with the LOGIN FORM —
    // the exact reason "any cookie" was not a valid authenticated-session test.
    if (method === 'GET') {
      const authed = /ASP\.NET_SessionId/.test(String(opts.headers?.Cookie || ''));
      return fakeRes(authed ? LANDING_HTML : LOGIN_HTML, {
        setCookie: authed ? [] : ['ASP.NET_SessionId=abc123; path=/'],
      });
    }
    if (/txtPwd/.test(body)) return fakeRes(LANDING_HTML); // login POST → landed

    if (params.get('__EVENTTARGET') === '_ctl0$Menu1') {
      currentReport = params.get('__EVENTARGUMENT') === MENU_PATH_EMAIL ? 'EMAIL' : 'TM';
      return fakeRes(SCREEN_HTML);
    }

    // Only Button1 renders a grid. A range postback (calendar day / month select)
    // just re-renders the screen — same as the real server.
    const clickedSubmit = [...params.keys()].some((k) => k.split(/[:$]/).pop() === 'Button1');
    if (!clickedSubmit) return fakeRes(SCREEN_HTML);

    if (currentReport === 'EMAIL') {
      calls.email++;
      if (plan.emailResponse instanceof Error) throw plan.emailResponse;
      return fakeRes(plan.emailResponse ?? gridHtml(EMAIL_HEADERS, []));
    }
    calls.tm++;
    return fakeRes(plan.tmResponse ?? gridHtml(TM_HEADERS, [tmRow('D4NE001234')]));
  });
  return calls;
}

/** Monkey-patch the prisma singleton; returns { restore, runUpdate, upserts }. */
function installFakePrisma({ existing = [] } = {}) {
  const captured = { runUpdate: null, upserts: [], updates: [] };
  const saved = {};
  const patch = (key, value) => { saved[key] = prisma[key]; prisma[key] = value; };

  patch('mexLocationConfig', {
    findMany: async () => ([{
      tsdNumber: '61302', branch: 'MCO', locationId: 'loc-mco',
      lookbackDays: null, lookaheadDays: null,
    }]),
  });
  patch('externalSyncRun', {
    create: async () => ({ id: 'run1' }),
    update: async (args) => { captured.runUpdate = args.data; return args.data; },
  });
  patch('externalReservation', {
    findMany: async () => existing,
    upsert: async ({ create, update, where }) => {
      captured.upserts.push({ create, update });
      const known = existing.find((e) => e.externalRef === where.source_ref_unique.externalRef);
      return {
        id: 'ext1',
        externalRef: where.source_ref_unique.externalRef,
        promotionStatus: known?.promotionStatus || 'PENDING',
        ...create,
      };
    },
    update: async (args) => { captured.updates.push(args.data); return args.data; },
  });
  patch('acrissCategoryMap', {
    findUnique: async () => ({ vehicleCategory: 'ECON' }),
    findFirst: async () => null,
  });
  patch('customer', { findMany: async () => [], findFirst: async () => null });
  patch('integrationCredential', { updateMany: async () => ({ count: 0 }) });

  return {
    captured,
    restore: () => { for (const [k, v] of Object.entries(saved)) prisma[k] = v; },
  };
}

async function runHandler(portalPlan = {}, prismaPlan = {}) {
  svc._resetCookieJarsForTests();
  const portal = installFakePortal(portalPlan);
  const db = installFakePrisma(prismaPlan);
  try {
    const result = await mexSyncHandler({ data: { tenantId: 't1', triggeredBy: 'test' } });
    return { result, notes: db.captured.runUpdate?.notes || '', captured: db.captured, portal };
  } finally {
    db.restore();
    svc.__test.setFetch(null);
    svc.__test.setCredentialsResolver(null);
    svc._resetCookieJarsForTests();
  }
}

// ---------------------------------------------------------------------------
// MC2 — a degraded email report is never a silent OK.
// ---------------------------------------------------------------------------

test('MC2: a FAILED email report counts as an error and downgrades the run to PARTIAL', async () => {
  const { result, notes } = await runHandler({
    emailResponse: new Error('ECONNRESET'),
  });

  // The rows still import — email is enrichment, ~50% coverage is by design and a
  // transport blip must not lose the config. But it is NOT a healthy run.
  assert.equal(result.newlyInserted, 1);
  assert.notEqual(result.status, 'OK', 'a run that lost 100% of its emails must not read OK');
  assert.equal(result.status, 'PARTIAL');
  assert.ok(result.errorsCount >= 1, 'the failure must be COUNTED, not just logged');
  assert.match(notes, /email report failed/i);
  assert.match(notes, /WITHOUT email enrichment/i);
});

test('MC2: LAYOUT DRIFT on the email grid raises ATTENTION (same as the T&M grid)', async () => {
  // The email report renders, but its join key is gone — a real drift signal.
  // Swallowing it would import every row as email-less and call the run OK.
  const { result, notes } = await runHandler({
    emailResponse: gridHtml(['Email Address', 'Nombre', 'Sucursal'], []),
  });
  assert.equal(result.status, 'ATTENTION');
  assert.match(notes, /LAYOUT DRIFT/);
});

test('MC2: a healthy email report leaves the run OK with no error noise', async () => {
  const { result } = await runHandler({
    emailResponse: gridHtml(EMAIL_HEADERS, [
      ['mario@example.com', 'D4NE001234', 'MARIO GARCIA', 'MCO', isoDay(3), isoDay(6), 'ECAR'],
    ]),
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.errorsCount, 0);
});

// ---------------------------------------------------------------------------
// MC3 — coverage is legible in the run notes.
// ---------------------------------------------------------------------------

test('MC3: the run notes carry the RAW server span, not just an out-of-window count', async () => {
  const { notes } = await runHandler();
  assert.match(notes, /Coverage —/);
  assert.match(notes, /61302\.MCO/);
  // What we asked for AND what the server actually sent, on both candidate range
  // keys — the only way to see a wrong-column server range on a green run.
  assert.match(notes, /asked \d{4}-\d{2}-\d{2}→\d{4}-\d{2}-\d{2}/);
  assert.match(notes, /server sent 1 rows/);
  assert.match(notes, /DateOut \d{4}-\d{2}-\d{2}→\d{4}-\d{2}-\d{2}/);
  assert.match(notes, /Booked \d{4}-\d{2}-\d{2}→\d{4}-\d{2}-\d{2}/);
});

test('RANGE: the run notes name the mode and the server\'s own footer count', async () => {
  const { notes } = await runHandler();
  // The mode is part of the record: a run's coverage cannot be judged without it.
  assert.match(notes, /\[explicit\]/);
  // "Rows: N" is the SERVER's count — the reconciliation anchor.
  assert.match(notes, /footer says 1/);
  // explicit covers the requested window → no gap headline.
  assert.doesNotMatch(notes, /COVERAGE GAP/);
});

test('RANGE: the footer row never becomes a booking, end to end', async () => {
  // The fake portal renders the REAL grid — 1 header + 1 data + 1 "Rows: 1"
  // footer. A parser that took the footer for data would stage a second
  // ExternalReservation with externalRef "Rows: 1".
  const { result, captured } = await runHandler();
  assert.equal(result.pickupsFound, 1);
  assert.equal(captured.upserts.length, 1);
  assert.equal(captured.upserts[0].create.externalRef, 'D4NE001234');
  assert.equal(captured.upserts.some((u) => /^Rows:/i.test(u.create.externalRef)), false);
});

// ---------------------------------------------------------------------------
// MONEY — a cancelled row carries a PHANTOM Total Bill (measured: 112 of 590
// cancelled rows keep a real amount). It must never become an estimatedTotal.
// ---------------------------------------------------------------------------

test('MONEY: a cancelled row\'s phantom Total Bill is staged but NEVER promoted', async () => {
  const { result, captured } = await runHandler(
    { tmResponse: gridHtml(TM_HEADERS, [tmRow('D4NE001234', { cancelled: true })]) }
  );

  // Staged honestly — the staging table records what the source said, and rawJson
  // stays faithful for audit.
  assert.equal(captured.upserts.length, 1);
  assert.equal(captured.upserts[0].create.totalAmount, 130.98);
  assert.equal(captured.upserts[0].create.status, 'CANCELLED');

  // …and stamped REJECTED, which is what makes the phantom amount harmless: the
  // worker never calls the promoter for it, the review tray (PENDING +
  // MANUAL_REVIEW) never lists it, and the manual-promote route refuses a
  // REJECTED row outright. estimatedTotal is only ever written by the promoter.
  assert.equal(result.rejectedCancelled, 1);
  assert.equal(result.autoPromoted, 0);
  assert.equal(result.needsReview, 0);
  const rejected = captured.updates.find((u) => u.promotionStatus === 'REJECTED');
  assert.ok(rejected, 'a cancelled row must be REJECTED, not left promotable');
  assert.equal(rejected.rejectedReason, 'source_cancelled');
});

// ---------------------------------------------------------------------------
// NIT — a source-side cancel of a live reservation is visible.
// ---------------------------------------------------------------------------

test('NIT: a source cancel of an ALREADY-PROMOTED row is counted and noted (Reservation untouched)', async () => {
  const { result, notes, captured } = await runHandler(
    { tmResponse: gridHtml(TM_HEADERS, [tmRow('D4NE001234', { cancelled: true })]) },
    { existing: [{ externalRef: 'D4NE001234', tenantId: 't1', promotionStatus: 'AUTO_PROMOTED' }] }
  );

  assert.equal(result.cancelledAfterPromote, 1);
  assert.match(notes, /already-promoted reservation\(s\) are CANCELLED\/NO-SHOW/);
  // The live Reservation is STILL deliberately left alone — the point of the NIT
  // was visibility, not a behavior change. The staged row is not force-REJECTED
  // over a live promotion either.
  assert.equal(result.rejectedCancelled, 0);
  assert.equal(captured.updates.some((u) => u.promotionStatus === 'REJECTED'), false);
});

test('NIT: a clean run says nothing about cancels', async () => {
  const { result, notes } = await runHandler();
  assert.equal(result.cancelledAfterPromote, 0);
  assert.doesNotMatch(notes, /CANCELLED\/NO-SHOW/);
});
