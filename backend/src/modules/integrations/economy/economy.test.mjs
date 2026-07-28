/**
 * Economy (RezLight) integration — unit tests.
 *
 * Pure where possible; fetch/prisma mocked. Covers the correctness-critical
 * pieces of the multi-location integration:
 *   1. area filter — areaFromLocPickup + config lookup (incl. row DROPPED when
 *      no enabled config for its area)
 *   2. field mapper — rg* list row → ExternalReservation shape
 *   3. login token-scrape + re-login-once retry (mocked fetch)
 *   4. date-window filter by rgDatePickup
 *
 * The promotion/dedup/crypto logic is reused UNCHANGED from TL — covered by the
 * existing tl-international suites — so it is not re-tested here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Crypto key required because the service imports lib/integration-crypto.js.
process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const {
  areaFromLocPickup,
  timeZoneForArea,
  SOURCE_SYSTEM,
  BOOKING_CHANNEL,
  RESERVATION_PREFIX,
  LOOKUP_PAGE_SIZE,
  MAX_PAGES,
  RG_DATE_PICKUP_INDEX,
  LOOKUP_COLUMNS,
  DATE_WINDOW_LOOKBACK_DAYS,
  DATE_WINDOW_LOOKAHEAD_DAYS,
  effectiveWindowDays,
  unionWindowDays,
  windowBoundsForConfig,
  unionWindowBounds,
} = await import('./economy.constants.js');

const {
  scrapeVerificationToken,
  inspectLoginForm,
  filterByPickupWindow,
  parseRezDate,
  fetchReservationList,
  fetchReservationDetail,
  login,
  authedFetch,
  EconomyAuthExpiredError,
  isDeadLookupResponse,
  __test,
  _resetCookieJarsForTests,
} = await import('./economy.service.js');

const { mapRowToExternalReservation } = await import('./economy.worker.js');

const {
  evaluatePromotion,
  REVIEW_REASONS,
} = await import('../tl-international/promotion-matcher.service.js');

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------
test('constants: source/channel/prefix are the Economy values', () => {
  assert.equal(SOURCE_SYSTEM, 'ECONOMY');
  assert.equal(BOOKING_CHANNEL, 'FRANCHISE_ECONOMY');
  assert.equal(RESERVATION_PREFIX, 'ECON-');
});

// ---------------------------------------------------------------------------
// 1. Area filter
// ---------------------------------------------------------------------------
test('areaFromLocPickup: first 3 chars uppercased (MIAO01 → MIA)', () => {
  assert.equal(areaFromLocPickup('MIAO01'), 'MIA');
  assert.equal(areaFromLocPickup('LAXO01'), 'LAX');
  assert.equal(areaFromLocPickup('flla02'), 'FLL');
  assert.equal(areaFromLocPickup('  MIAO01 '), 'MIA');
});

test('areaFromLocPickup: null/short input → null', () => {
  assert.equal(areaFromLocPickup(null), null);
  assert.equal(areaFromLocPickup(''), null);
  assert.equal(areaFromLocPickup('MI'), null);
});

test('area filter: keeps rows with an enabled config, DROPS rows without', () => {
  // Simulate the worker's area→locationId map (only MIA enabled).
  const areaToLocation = new Map([['MIA', 'loc-miami']]);
  const rows = [
    { rgConfirmation: 'R1', rgLocPickup: 'MIAO01' }, // keep → loc-miami
    { rgConfirmation: 'R2', rgLocPickup: 'LAXO01' }, // drop (LAX not enabled)
    { rgConfirmation: 'R3', rgLocPickup: 'MIAT99' }, // keep → loc-miami
    { rgConfirmation: 'R4', rgLocPickup: '' },       // drop (no area)
  ];
  const kept = [];
  let dropped = 0;
  for (const row of rows) {
    const area = areaFromLocPickup(row.rgLocPickup);
    const locationId = area ? areaToLocation.get(area) : null;
    if (!locationId) { dropped++; continue; }
    kept.push({ ref: row.rgConfirmation, area, locationId });
  }
  assert.equal(kept.length, 2);
  assert.equal(dropped, 2);
  assert.deepEqual(kept.map((k) => k.ref), ['R1', 'R3']);
  assert.ok(kept.every((k) => k.locationId === 'loc-miami'));
});

test('timeZoneForArea: MIA/FLL/MCO=ET, LAX=PT, unknown → ET default', () => {
  assert.equal(timeZoneForArea('MIA'), 'America/New_York');
  assert.equal(timeZoneForArea('FLL'), 'America/New_York');
  assert.equal(timeZoneForArea('MCO'), 'America/New_York');
  assert.equal(timeZoneForArea('LAX'), 'America/Los_Angeles');
  assert.equal(timeZoneForArea('ZZZ'), 'America/New_York');
  assert.equal(timeZoneForArea(null), 'America/New_York');
});

// ---------------------------------------------------------------------------
// 2. Field mapper
// ---------------------------------------------------------------------------
test('mapRowToExternalReservation: maps a list-row object onto the ExternalReservation shape', () => {
  const row = {
    rgConfirmation: 'ABC12345',
    rgDateBooked: '2026-07-01',
    rgClass: 'ccar',
    rgLocPickup: 'MIAO01',
    rgLocDropOff: 'MIAO01',
    rgDatePickup: '2026-07-10T14:00:00',
    rgDateDropOff: '2026-07-13T14:00:00',
    rgRate: '$149.50',
    rgLastName: 'Doe',
    rgName: 'John',
    rgEmail: 'john@example.com',
    rgIata: 'AA123',
    rgStatus: 'OK',
  };
  const mapped = mapRowToExternalReservation(row, { timeZone: 'America/New_York' });

  assert.equal(mapped.externalRef, 'ABC12345');
  assert.equal(mapped.customerFirstName, 'John');
  assert.equal(mapped.customerLastName, 'Doe');
  assert.equal(mapped.customerEmail, 'john@example.com');
  assert.equal(mapped.vehicleAcriss, 'CCAR');          // uppercased
  assert.equal(mapped.pickupLocation, 'MIAO01');
  assert.equal(mapped.dropoffLocation, 'MIAO01');
  assert.equal(mapped.totalAmount, '149.50');          // currency symbol stripped
  assert.equal(mapped.currency, 'USD');
  assert.equal(mapped.status, 'CONFIRMED');
  assert.ok(mapped.pickupAt instanceof Date);
  assert.ok(mapped.dropoffAt instanceof Date);
  assert.equal(mapped.rawJson.list, row);
});

test('mapRowToExternalReservation: detail enriches time + phone + email + flight (real res* names)', () => {
  const row = {
    rgConfirmation: 'EPRLA1482F6E', rgClass: 'ifar', rgLocPickup: 'MIAO01',
    rgLocDropOff: 'MIAO01', rgDatePickup: '09/19/2026', rgDateDropOff: '09/24/2026',
    rgLastName: 'BREWER', rgName: 'JAMES', rgEmail: null, rgRate: '100.00',
  };
  // Field names as captured live 2026-07-28 (command=load response).
  const detail = {
    resPickupFullDate: '09/19/2026 14:30', resPickupDate: '09/19/2026',
    resDropOffFullDate: '09/24/2026 11:00',
    resCustomerPhone: '0016236700101', resCustomerEmail: 'james@example.com',
    resCustomerName: 'JAMES', resCustomerLastName: 'BREWER',
    resCustomerFlightInfo: 'DL1961', resReqFlight: 'N', // N = flag, NOT a flight number
    resRateTotal: '175.00', resCurrency: 'USD', resVehClass: 'IFAR',
    resProvider: '61201', isPrepaid: true,
  };
  const mapped = mapRowToExternalReservation(row, { detail, timeZone: 'America/New_York' });
  // THE bug fix: 14:30 ET (EDT, UTC-4) → 18:30Z — not 00:00 UTC / "8pm yesterday".
  assert.equal(mapped.pickupAt.toISOString(), '2026-09-19T18:30:00.000Z');
  assert.equal(mapped.dropoffAt.toISOString(), '2026-09-24T15:00:00.000Z');
  assert.equal(mapped.customerPhone, '0016236700101');
  assert.equal(mapped.customerEmail, 'james@example.com');
  assert.equal(mapped.flightNumber, 'DL1961');         // resCustomerFlightInfo, not resReqFlight
  assert.equal(mapped.totalAmount, '175.00');          // detail overrides list rate
  assert.equal(mapped.isPrepaid, true);
  assert.equal(mapped.channel, '61201');
  assert.equal(mapped.rawJson.detail, detail);
});

test('mapRowToExternalReservation: US date in LAX timezone + list-only fallback is local midnight', () => {
  const row = {
    rgConfirmation: 'X1', rgClass: 'ccar', rgLocPickup: 'LAXO01',
    rgDatePickup: '09/19/2026', rgLastName: 'Doe', rgName: 'John',
  };
  const withDetail = mapRowToExternalReservation(row, {
    detail: { resPickupFullDate: '09/19/2026 14:30' }, timeZone: 'America/Los_Angeles',
  });
  // 14:30 PT (PDT, UTC-7) → 21:30Z.
  assert.equal(withDetail.pickupAt.toISOString(), '2026-09-19T21:30:00.000Z');
  // No detail: the date-only list value must mean midnight LOCAL (07:00Z),
  // never midnight UTC (which rendered as 8pm/5pm the previous day).
  const listOnly = mapRowToExternalReservation(row, { timeZone: 'America/Los_Angeles' });
  assert.equal(listOnly.pickupAt.toISOString(), '2026-09-19T07:00:00.000Z');
});

test('mapRowToExternalReservation: empty-string detail fields never clobber list values', () => {
  const row = {
    rgConfirmation: 'X2', rgClass: 'ccar', rgLocPickup: 'MIAO01',
    rgDatePickup: '09/19/2026', rgLastName: 'Doe', rgName: 'John',
    rgEmail: 'john@example.com',
  };
  // RezLight uses '' (and null) for "not captured" — e.g. PRICELINE rows carry
  // resCustomerEmail: null, resCustomerBirthDate: ''.
  const detail = { resCustomerEmail: '', resCustomerName: '', resCustomerPhone: null };
  const mapped = mapRowToExternalReservation(row, { detail, timeZone: 'America/New_York' });
  assert.equal(mapped.customerEmail, 'john@example.com');
  assert.equal(mapped.customerFirstName, 'John');
  assert.equal(mapped.customerPhone, null);
  assert.equal(mapped.isPrepaid, null); // absent boolean stays null, not false
});

test('mapRowToExternalReservation: accepts a positional array row', () => {
  // LOOKUP_COLUMNS order: [conf, booked, class, locPickup, locDrop, datePickup,
  //                        dateDrop, rate, lastName, name, email, iata, status]
  const arr = ['XYZ99', '2026-07-01', 'ecar', 'LAXO01', 'LAXO01',
    '2026-07-05T09:00:00', '2026-07-08T09:00:00', '89.00', 'Roe', 'Jane',
    'jane@example.com', 'UA1', 'OK'];
  const mapped = mapRowToExternalReservation(arr, { timeZone: 'America/Los_Angeles' });
  assert.equal(mapped.externalRef, 'XYZ99');
  assert.equal(mapped.customerFirstName, 'Jane');
  assert.equal(mapped.customerLastName, 'Roe');
  assert.equal(mapped.vehicleAcriss, 'ECAR');
  assert.equal(mapped.pickupLocation, 'LAXO01');
  assert.equal(mapped.totalAmount, '89.00');
});

// ---------------------------------------------------------------------------
// 3. Date-window filter
// ---------------------------------------------------------------------------
test('parseRezDate: ISO, US, and ASP.NET /Date()/ formats', () => {
  assert.equal(parseRezDate('2026-07-10T14:00:00Z'), Date.parse('2026-07-10T14:00:00Z'));
  assert.equal(parseRezDate('/Date(1783000800000)/'), 1783000800000);
  assert.equal(parseRezDate(''), null);
  assert.equal(parseRezDate(null), null);
  assert.equal(parseRezDate('not-a-date'), null);
});

test('filterByPickupWindow: keeps in-window rows, drops out-of-window + unparseable', () => {
  const rows = [
    { rgConfirmation: 'A', rgDatePickup: '2026-07-10T12:00:00Z' }, // in
    { rgConfirmation: 'B', rgDatePickup: '2020-01-01T12:00:00Z' }, // before → drop
    { rgConfirmation: 'C', rgDatePickup: '2030-01-01T12:00:00Z' }, // after → drop
    { rgConfirmation: 'D', rgDatePickup: 'garbage' },              // unparseable → drop
  ];
  const from = new Date('2026-07-01T00:00:00Z');
  const to = new Date('2026-07-31T23:59:59Z');
  const kept = filterByPickupWindow(rows, from, to);
  assert.deepEqual(kept.map((r) => r.rgConfirmation), ['A']);
});

test('filterByPickupWindow: no bounds → returns all rows unchanged', () => {
  const rows = [{ rgDatePickup: 'whatever' }, { rgDatePickup: '2026-07-10' }];
  assert.equal(filterByPickupWindow(rows, null, null).length, 2);
});

// ---------------------------------------------------------------------------
// 4. Login token-scrape + re-login-once retry (mocked fetch + prisma)
// ---------------------------------------------------------------------------
test('scrapeVerificationToken + inspectLoginForm: pull the hidden token + fields', () => {
  const html = `
    <form action="/Production/Account/Login" method="post">
      <input name="username" type="text" />
      <input name="password" type="password" />
      <input name="__RequestVerificationToken" type="hidden" value="TOKEN-ABC-123" />
    </form>`;
  assert.equal(scrapeVerificationToken(html), 'TOKEN-ABC-123');
  const form = inspectLoginForm(html);
  assert.ok(form.inputNames.includes('username'));
  assert.ok(form.inputNames.includes('password'));
  assert.equal(form.action, '/Production/Account/Login');
});

// Build a fake Response with a cookie jar + optional set-cookie / status.
function fakeRes({ status = 200, body = '', setCookie = null, location = null } = {}) {
  const headers = new Map();
  if (location) headers.set('location', location);
  return {
    status,
    headers: {
      get: (k) => (k.toLowerCase() === 'set-cookie' ? (Array.isArray(setCookie) ? setCookie.join(', ') : setCookie) : headers.get(k.toLowerCase()) ?? null),
      getSetCookie: () => (setCookie ? (Array.isArray(setCookie) ? setCookie : [setCookie]) : []),
    },
    text: async () => body,
  };
}

const LOGIN_HTML = `<form action="/Production/Account/Login" method="post">
  <input name="username"/><input name="password"/>
  <input name="__RequestVerificationToken" value="TKN1"/></form>`;

test('login: fails (EconomyAuthExpiredError) when no .AspNet.ApplicationCookie appears', async () => {
  _resetCookieJarsForTests();
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));

  const script = [
    () => fakeRes({ status: 200, body: LOGIN_HTML }),          // GET '/'
    () => fakeRes({ status: 200, body: 'bad creds, no cookie' }), // POST → NO auth cookie
  ];
  let call = 0;
  __test.setFetch(async () => (script[call++] || (() => fakeRes({})))());

  await assert.rejects(() => login('tenant-x'), (err) => err instanceof EconomyAuthExpiredError);

  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('login: succeeds when .AspNet.ApplicationCookie lands in Set-Cookie', async () => {
  _resetCookieJarsForTests();
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));

  const script = [
    () => fakeRes({ status: 200, body: LOGIN_HTML }),
    () => fakeRes({ status: 200, body: 'ok', setCookie: '.AspNet.ApplicationCookie=SESSION1; path=/' }),
  ];
  let call = 0;
  __test.setFetch(async () => (script[call++] || (() => fakeRes({})))());

  const ok = await login('tenant-x');
  assert.equal(ok, true);
  assert.equal(__test.hasAuthCookie('tenant-x'), true);

  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('authedFetch: logs in first, then re-logs-in EXACTLY once on a mid-flight bounce', async () => {
  _resetCookieJarsForTests();
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));

  // Full scripted sequence:
  //  0 login GET '/'                     → login form
  //  1 login POST creds                  → SESSION1 cookie
  //  2 authedFetch target                → 302 bounce (expired)
  //  3 re-login GET '/'                  → login form
  //  4 re-login POST creds               → SESSION2 cookie
  //  5 retry target                      → 200 OK
  let call = 0;
  const script = [
    () => fakeRes({ status: 200, body: LOGIN_HTML }),
    () => fakeRes({ status: 200, body: 'ok', setCookie: '.AspNet.ApplicationCookie=SESSION1; path=/' }),
    () => fakeRes({ status: 302, location: '/Production/Account/Login' }),
    () => fakeRes({ status: 200, body: LOGIN_HTML }),
    () => fakeRes({ status: 200, body: 'ok', setCookie: '.AspNet.ApplicationCookie=SESSION2; path=/' }),
    () => fakeRes({ status: 200, body: '{"ok":true}' }),
  ];
  __test.setFetch(async () => (script[call++] || (() => fakeRes({ status: 200, body: '{}' })))());

  const res = await authedFetch('tenant-x', '/RezAlliance/Reservations');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true}');
  // Exactly 6 fetch calls: initial login (2) + bounced target (1) + re-login (2) + retry (1).
  assert.equal(call, 6);

  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('authedFetch: a SECOND bounce after re-login throws EconomyAuthExpiredError (no infinite loop)', async () => {
  _resetCookieJarsForTests();
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));

  let call = 0;
  const script = [
    () => fakeRes({ status: 200, body: LOGIN_HTML }),
    () => fakeRes({ status: 200, body: 'ok', setCookie: '.AspNet.ApplicationCookie=SESSION1; path=/' }),
    () => fakeRes({ status: 401 }),                       // target bounce
    () => fakeRes({ status: 200, body: LOGIN_HTML }),     // re-login GET
    () => fakeRes({ status: 200, body: 'ok', setCookie: '.AspNet.ApplicationCookie=SESSION2; path=/' }),
    () => fakeRes({ status: 401 }),                       // still bounced → give up
  ];
  __test.setFetch(async () => (script[call++] || (() => fakeRes({ status: 401 })))());

  await assert.rejects(
    () => authedFetch('tenant-x', '/RezAlliance/Reservations'),
    (err) => err instanceof EconomyAuthExpiredError
  );

  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

// ---------------------------------------------------------------------------
// Detail fetch — command=load contract (captured 2026-07-28)
// ---------------------------------------------------------------------------
// URL/method-aware mock: login GET/POST seed the cookie, the authed page GET
// serves a token, and each detail POST (?Length=12) is answered by `onDetail`,
// which receives the parsed url-encoded body. Records detail bodies + how many
// token-page GETs happened.
function installDetailFetch({ onDetail }) {
  const detailBodies = [];
  let tokenPageGets = 0;
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));
  __test.setFetch(async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = String(url);
    if (method === 'GET' && /RezAlliance\/Reservations$/.test(u)) {
      tokenPageGets++;
      return fakeRes({ status: 200, body: '<input name="__RequestVerificationToken" value="DTKN"/>' });
    }
    if (method === 'GET') {
      return fakeRes({ status: 200, body: LOGIN_HTML });
    }
    if (method === 'POST' && /Length=12/.test(u)) {
      const params = new URLSearchParams(opts.body);
      const body = Object.fromEntries(params.entries());
      detailBodies.push(body);
      return onDetail(body, detailBodies.length);
    }
    // Any other POST = the login credential post.
    return fakeRes({ status: 200, body: 'ok', setCookie: '.AspNet.ApplicationCookie=S1; path=/' });
  });
  return { detailBodies, tokenPageGets: () => tokenPageGets };
}

function detailTeardown() {
  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
}

test('fetchReservationDetail: posts the 4-field payload, unwraps the envelope, caches the token', async () => {
  _resetCookieJarsForTests();
  const RESP = { resConfirmation: 'EPRLA1482F6E', resPickupTime: '14:30', resCustomerPhone: '0016236700101' };
  const mock = installDetailFetch({
    onDetail: () => fakeRes({ status: 200, body: JSON.stringify({ command: 'load', response: RESP }) }),
  });

  const detail = await fetchReservationDetail('tenant-d', 'EPRLA1482F6E');
  assert.deepEqual(detail, RESP);
  // The exact captured contract: token + command=load + resConfirmation + resDocType=R.
  assert.deepEqual(mock.detailBodies[0], {
    __RequestVerificationToken: 'DTKN',
    command: 'load',
    resConfirmation: 'EPRLA1482F6E',
    resDocType: 'R',
  });

  // Second row in the same run: the cached token is reused — no extra page GET.
  await fetchReservationDetail('tenant-d', 'OTHERCONF001');
  assert.equal(mock.tokenPageGets(), 1);
  assert.equal(mock.detailBodies[1].resConfirmation, 'OTHERCONF001');

  detailTeardown();
});

test('fetchReservationDetail: 400 (unknown confirmation) → null WITHOUT healing the session', async () => {
  _resetCookieJarsForTests();
  const mock = installDetailFetch({
    onDetail: () => fakeRes({ status: 400, body: JSON.stringify({ command: 'load', response: null }) }),
  });

  const detail = await fetchReservationDetail('tenant-d', 'BOGUS');
  assert.equal(detail, null);
  assert.equal(mock.detailBodies.length, 1);  // no retry
  assert.equal(mock.tokenPageGets(), 1);      // no fresh-token heal

  detailTeardown();
});

test('fetchReservationDetail: 500 (dead token/session) → heals ONCE with fresh login + token', async () => {
  _resetCookieJarsForTests();
  const RESP = { resConfirmation: 'EPRLA1482F6E' };
  const mock = installDetailFetch({
    onDetail: (body, n) => (n === 1
      ? fakeRes({ status: 500, body: '' })
      : fakeRes({ status: 200, body: JSON.stringify({ command: 'load', response: RESP }) })),
  });

  const detail = await fetchReservationDetail('tenant-d', 'EPRLA1482F6E');
  assert.deepEqual(detail, RESP);
  assert.equal(mock.detailBodies.length, 2);  // original + one retry
  assert.equal(mock.tokenPageGets(), 2);      // fresh token scraped for the retry

  detailTeardown();
});

// ---------------------------------------------------------------------------
// M1 — bounded / paginated list fetch (order:desc + page-cap + stop-on-cross)
//
// Install a URL/method-aware fetch mock: login GET/POST seed the cookie, the
// authed page GET returns token HTML, and each LIST POST is served a page from
// a caller-supplied page generator. The mock records every DataTables payload
// so tests can assert the `order` and `start` params + how many pages were hit.
// ---------------------------------------------------------------------------
const LIST_URL_RE = /GetReservationLookupRecords/;
const AUTHED_PAGE_RE = /RezAlliance\/Reservations$/;

function installPaginatedFetch({ pageFor }) {
  const listCalls = []; // { start, order, length } parsed from each LIST POST
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));
  __test.setFetch(async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = String(url);
    // Login GET '/' (base) → login form.
    if (method === 'GET' && !LIST_URL_RE.test(u) && !AUTHED_PAGE_RE.test(u)) {
      return fakeRes({ status: 200, body: LOGIN_HTML });
    }
    // Login POST creds → drop the auth cookie.
    if (method === 'POST' && !LIST_URL_RE.test(u)) {
      return fakeRes({ status: 200, body: 'ok', setCookie: '.AspNet.ApplicationCookie=S1; path=/' });
    }
    // Authed page GET → token HTML.
    if (method === 'GET' && AUTHED_PAGE_RE.test(u)) {
      return fakeRes({ status: 200, body: '<input name="__RequestVerificationToken" value="TKN"/>' });
    }
    // LIST POST → parse the DataTables payload, serve the matching page.
    if (method === 'POST' && LIST_URL_RE.test(u)) {
      const params = new URLSearchParams(opts.body);
      const dt = JSON.parse(params.get('jsonPaginationParameters'));
      listCalls.push({ start: dt.start, order: dt.order, length: dt.length });
      const data = pageFor(dt.start, dt.length);
      return fakeRes({ status: 200, body: JSON.stringify({ draw: 1, recordsTotal: 92093, data }) });
    }
    return fakeRes({ status: 200, body: '{}' });
  });
  return { listCalls };
}

// Build a descending-by-rgDatePickup dataset of `n` rows starting `startDay`
// days from `anchor`, one day apart, newest first.
function descRows(n, anchorMs, startDayOffset = 0) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const dayMs = anchorMs - (startDayOffset + i) * 24 * 60 * 60 * 1000;
    rows.push({
      rgConfirmation: `R${startDayOffset + i}`,
      rgLocPickup: 'MIAO01',
      rgDatePickup: new Date(dayMs).toISOString(),
    });
  }
  return rows;
}

test('M1 fetchReservationList: sends order=rgDatePickup DESC and stops once rows cross below dateFrom', async () => {
  _resetCookieJarsForTests();
  const now = Date.now();
  const dateFrom = new Date(now - 3 * 24 * 60 * 60 * 1000); // today-3d
  const dateTo = new Date(now + 30 * 24 * 60 * 60 * 1000);

  // Full desc corpus: pages of LOOKUP_PAGE_SIZE. Newest at day -( -30) … oldest.
  // We create a corpus that spans well before dateFrom so the loop must STOP
  // once it crosses below dateFrom rather than sweeping everything.
  const anchor = now + 30 * 24 * 60 * 60 * 1000; // newest = today+30d
  const corpus = descRows(LOOKUP_PAGE_SIZE * 10, anchor, 0); // 10 pages worth
  const pageFor = (start, length) => corpus.slice(start, start + length);

  const { listCalls } = installPaginatedFetch({ pageFor });
  const rows = await fetchReservationList('tenant-x', { dateFrom, dateTo });

  // Every in-window row is >= dateFrom AND <= dateTo (precision filter applied).
  assert.ok(rows.length > 0);
  for (const r of rows) {
    const t = Date.parse(r.rgDatePickup);
    assert.ok(t >= dateFrom.getTime(), 'kept row must be >= dateFrom');
    assert.ok(t <= dateTo.getTime(), 'kept row must be <= dateTo');
  }
  // The order param carried rgDatePickup index + desc on the LIST POSTs.
  assert.ok(listCalls.length >= 1);
  for (const c of listCalls) {
    assert.deepEqual(c.order, [{ column: RG_DATE_PICKUP_INDEX, dir: 'desc' }]);
  }
  // rgDatePickup is column index 5 in the 13-col array.
  assert.equal(RG_DATE_PICKUP_INDEX, LOOKUP_COLUMNS.indexOf('rgDatePickup'));
  assert.equal(RG_DATE_PICKUP_INDEX, 5);
  // It did NOT sweep all 10 pages — the desc window is ~33 days wide starting at
  // today+30d, so it crosses below dateFrom within the first couple pages and
  // stops well short of the cap.
  assert.ok(listCalls.length < 10, `expected early stop, fetched ${listCalls.length} pages`);
  assert.ok(listCalls.length <= MAX_PAGES);
  // Pages advance start by LOOKUP_PAGE_SIZE each time (0, PAGE, 2*PAGE …).
  listCalls.forEach((c, i) => assert.equal(c.start, i * LOOKUP_PAGE_SIZE));

  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('M1 fetchReservationList: newest-first means old rows land on LATE pages and are never fetched', async () => {
  _resetCookieJarsForTests();
  const now = Date.now();
  const dateFrom = new Date(now - 2 * 24 * 60 * 60 * 1000);
  const dateTo = new Date(now + 5 * 24 * 60 * 60 * 1000);

  // Page 0: a handful of in-window rows THEN rows that cross below dateFrom.
  // Ancient rows would be on later pages (desc) — assert we never request them.
  const anchor = now + 5 * 24 * 60 * 60 * 1000;
  const corpus = descRows(LOOKUP_PAGE_SIZE * 5, anchor, 0);
  const pageFor = (start, length) => corpus.slice(start, start + length);

  const { listCalls } = installPaginatedFetch({ pageFor });
  const rows = await fetchReservationList('tenant-x', { dateFrom, dateTo });

  // The window (~7 days) is far smaller than one page → crossed on page 0, so
  // exactly ONE list page fetched, and no later (older) page requested.
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].start, 0);
  assert.ok(rows.every((r) => Date.parse(r.rgDatePickup) >= dateFrom.getTime()));

  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('M1 fetchReservationList: hard page cap bounds the sweep (never all 92k) and WARNs when hit', async () => {
  _resetCookieJarsForTests();
  const now = Date.now();
  // A window so wide that EVERY row served (up to the cap's ceiling of
  // MAX_PAGES*PAGE_SIZE rows, one day apart) is in-window → the loop can never
  // cross below dateFrom, so only the MAX_PAGES cap stops it.
  const capCeilingDays = MAX_PAGES * LOOKUP_PAGE_SIZE + 100;
  const dateFrom = new Date(now - capCeilingDays * 24 * 60 * 60 * 1000);
  const dateTo = new Date(now + capCeilingDays * 24 * 60 * 60 * 1000);

  // Every page returns a FULL page of in-window rows forever.
  const anchor = now;
  const pageFor = (start, length) => descRows(length, anchor, start);

  const { listCalls } = installPaginatedFetch({ pageFor });

  // Capture the WARN.
  const logger = (await import('../../../lib/logger.js')).default;
  const origWarn = logger.warn;
  let capWarn = null;
  logger.warn = (msg, meta) => { if (/page cap hit/i.test(String(msg))) capWarn = { msg, meta }; };

  const rows = await fetchReservationList('tenant-x', { dateFrom, dateTo });

  logger.warn = origWarn;

  // Stopped at exactly MAX_PAGES — bounded, NOT a full 92k sweep.
  assert.equal(listCalls.length, MAX_PAGES);
  assert.equal(rows.length, MAX_PAGES * LOOKUP_PAGE_SIZE);
  assert.ok(capWarn, 'expected a page-cap WARN');
  assert.equal(capWarn.meta.maxPages, MAX_PAGES);

  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

// ---------------------------------------------------------------------------
// S2 — EconomyLocationConfig authoritative for location (via overrideLocationId)
//
// evaluatePromotion is shared with TL. We prove: (a) with overrideLocationId a
// row whose ONLY blocker was location_unmapped now promotes with the config
// locationId; (b) a row with ANOTHER blocker (customer_not_found) still goes to
// MANUAL_REVIEW even WITH the override; (c) TL callers (no override) are
// unaffected — the LocationCodeMap gate still runs.
// ---------------------------------------------------------------------------
function fakePrisma({ acriss = { vehicleCategory: 'ECONOMY' }, locMap = null, customers = [] } = {}) {
  return {
    acrissCategoryMap: {
      findUnique: async () => acriss,
      findFirst: async () => acriss,
    },
    locationCodeMap: {
      findUnique: async () => locMap, // null → location_unmapped for TL path
    },
    customer: {
      findMany: async () => customers,
    },
  };
}

const S2_EXT = Object.freeze({
  tenantId: 't1',
  currency: 'USD',
  vehicleAcriss: 'CCAR',
  pickupLocation: 'MIAO01',
  customerEmail: 'match@example.com',
});

test('S2: overrideLocationId promotes a row whose ONLY blocker was location_unmapped', async () => {
  const prisma = fakePrisma({
    locMap: null, // no LocationCodeMap row → TL would say location_unmapped
    customers: [{ id: 'cust-1', firstName: 'A', lastName: 'B', email: 'match@example.com', phone: null }],
  });
  const decision = await evaluatePromotion(S2_EXT, { prisma, overrideLocationId: 'loc-miami' });
  assert.equal(decision.decision, 'AUTO');
  assert.equal(decision.mappedLocation.id, 'loc-miami');
  assert.equal(decision.mappedCustomer.id, 'cust-1');
  assert.equal(decision.mappedVehicleCategory, 'ECONOMY');
});

test('S2: a row with ANOTHER blocker stays MANUAL_REVIEW even with overrideLocationId', async () => {
  const prisma = fakePrisma({
    locMap: null,
    customers: [], // no customer → customer_not_found
  });
  const decision = await evaluatePromotion(S2_EXT, { prisma, overrideLocationId: 'loc-miami' });
  assert.equal(decision.decision, 'MANUAL_REVIEW');
  assert.equal(decision.reason, REVIEW_REASONS.CUSTOMER_NOT_FOUND);
});

test('S2: TL path (no overrideLocationId) is UNAFFECTED — LocationCodeMap gate still fires', async () => {
  const prisma = fakePrisma({
    locMap: null, // TL: no map row → must still be location_unmapped
    customers: [{ id: 'cust-1', firstName: 'A', lastName: 'B', email: 'match@example.com', phone: null }],
  });
  const decision = await evaluatePromotion(S2_EXT, { prisma }); // no override
  assert.equal(decision.decision, 'MANUAL_REVIEW');
  assert.equal(decision.reason, REVIEW_REASONS.LOCATION_UNMAPPED);
});

test('S2: TL path WITH a LocationCodeMap row resolves the mapped location (byte-identical shape)', async () => {
  const prisma = fakePrisma({
    locMap: { location: { id: 'loc-tl', code: 'SJUA01', name: 'San Juan' } },
    customers: [{ id: 'cust-1', firstName: 'A', lastName: 'B', email: 'match@example.com', phone: null }],
  });
  const decision = await evaluatePromotion(S2_EXT, { prisma });
  assert.equal(decision.decision, 'AUTO');
  assert.deepEqual(decision.mappedLocation, { id: 'loc-tl', code: 'SJUA01', name: 'San Juan' });
});

// ---------------------------------------------------------------------------
// S1 — cross-tenant guard (pure branch logic on the pre-queried owner map).
// Mirrors the worker's guard: an existing row owned by a DIFFERENT tenant is
// skipped (+counter+WARN); same-tenant (or unknown) proceeds to upsert.
// ---------------------------------------------------------------------------
test('S1: existing row owned by a DIFFERENT tenant is skipped (counter++), same-tenant upserts', () => {
  // existingByRef: externalRef → owning tenantId (from the run pre-query).
  const existingByRef = new Map([
    ['REF-A', 'tenant-A'], // owned by A
    ['REF-B', 'tenant-B'], // owned by B (current sync)
  ]);
  const currentTenant = 'tenant-B';

  const decideRow = (externalRef) => {
    const owner = existingByRef.get(externalRef);
    if (owner && owner !== currentTenant) return 'skip';
    return 'upsert';
  };

  let skippedCrossTenant = 0;
  const results = {};
  for (const ref of ['REF-A', 'REF-B', 'REF-NEW']) {
    const action = decideRow(ref);
    if (action === 'skip') skippedCrossTenant++;
    results[ref] = action;
  }
  assert.equal(results['REF-A'], 'skip');    // cross-tenant → guarded
  assert.equal(results['REF-B'], 'upsert');  // same tenant → proceeds
  assert.equal(results['REF-NEW'], 'upsert'); // unknown → proceeds (new insert)
  assert.equal(skippedCrossTenant, 1);
});

// ---------------------------------------------------------------------------
// Per-area date window (Fase 5, 2026-07-09) — union for the single fetch +
// per-area precision filter. Env defaults are the constants' defaults (the env
// vars are unset in the test process): lookback=2, lookahead=30.
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;

test('effectiveWindowDays: null override falls back to env defaults; set values win', () => {
  assert.deepEqual(effectiveWindowDays({ lookbackDays: null, lookaheadDays: null }), {
    lookbackDays: DATE_WINDOW_LOOKBACK_DAYS, lookaheadDays: DATE_WINDOW_LOOKAHEAD_DAYS,
  });
  assert.deepEqual(effectiveWindowDays({ lookbackDays: 7, lookaheadDays: 90 }), {
    lookbackDays: 7, lookaheadDays: 90,
  });
  // Partial override: only lookback set, lookahead falls back.
  assert.deepEqual(effectiveWindowDays({ lookbackDays: 5, lookaheadDays: null }), {
    lookbackDays: 5, lookaheadDays: DATE_WINDOW_LOOKAHEAD_DAYS,
  });
  // Invalid (negative / NaN) → treated as null → env fallback.
  assert.deepEqual(effectiveWindowDays({ lookbackDays: -3, lookaheadDays: 'x' }), {
    lookbackDays: DATE_WINDOW_LOOKBACK_DAYS, lookaheadDays: DATE_WINDOW_LOOKAHEAD_DAYS,
  });
});

test('unionWindowDays: takes the WIDEST lookback + WIDEST lookahead across enabled configs', () => {
  const configs = [
    { externalArea: 'MIA', lookbackDays: 2, lookaheadDays: 30 },  // narrow
    { externalArea: 'LAX', lookbackDays: 10, lookaheadDays: 90 }, // wide
    { externalArea: 'FLL', lookbackDays: null, lookaheadDays: null }, // env (2/30)
  ];
  assert.deepEqual(unionWindowDays(configs), { lookbackDays: 10, lookaheadDays: 90 });
});

test('unionWindowDays: no configs → env defaults (well-defined)', () => {
  assert.deepEqual(unionWindowDays([]), {
    lookbackDays: DATE_WINDOW_LOOKBACK_DAYS, lookaheadDays: DATE_WINDOW_LOOKAHEAD_DAYS,
  });
});

test('unionWindowBounds is at least as wide as every area window (contains each)', () => {
  const now = Date.UTC(2026, 6, 9, 12, 0, 0);
  const configs = [
    { externalArea: 'MIA', lookbackDays: 2, lookaheadDays: 30 },
    { externalArea: 'LAX', lookbackDays: 10, lookaheadDays: 90 },
  ];
  const union = unionWindowBounds(configs, now);
  for (const c of configs) {
    const area = windowBoundsForConfig(c, now);
    assert.ok(union.dateFrom.getTime() <= area.dateFrom.getTime(), `union covers ${c.externalArea} lower bound`);
    assert.ok(union.dateTo.getTime() >= area.dateTo.getTime(), `union covers ${c.externalArea} upper bound`);
  }
});

test('per-area precision: a row inside the UNION but outside its own area window is DROPPED', () => {
  // Replicates the worker's kept-row logic: area config lookup + per-area window.
  const now = Date.UTC(2026, 6, 9, 12, 0, 0);
  const areaConfig = new Map([
    ['MIA', { locationId: 'loc-mia', lookbackDays: 2, lookaheadDays: 30 }],   // narrow
    ['LAX', { locationId: 'loc-lax', lookbackDays: 10, lookaheadDays: 90 }],  // wide (drives union)
  ]);

  // Union is [now-10d, now+90d]. A MIA pickup 60 days out is inside the union
  // (because LAX widened it) but OUTSIDE MIA's own [now-2d, now+30d] → dropped.
  const rows = [
    { rgConfirmation: 'MIA-IN',  rgLocPickup: 'MIAO01', rgDatePickup: new Date(now + 10 * DAY).toISOString() }, // keep
    { rgConfirmation: 'MIA-OUT', rgLocPickup: 'MIAO01', rgDatePickup: new Date(now + 60 * DAY).toISOString() }, // drop (MIA window)
    { rgConfirmation: 'LAX-IN',  rgLocPickup: 'LAXO01', rgDatePickup: new Date(now + 60 * DAY).toISOString() }, // keep (LAX window)
  ];

  const kept = [];
  let droppedByArea = 0;
  let droppedByAreaWindow = 0;
  for (const row of rows) {
    const area = areaFromLocPickup(row.rgLocPickup);
    const cfg = area ? areaConfig.get(area) : null;
    if (!cfg) { droppedByArea++; continue; }
    const { dateFrom, dateTo } = windowBoundsForConfig(cfg, now);
    const t = parseRezDate(row.rgDatePickup);
    if (t == null || t < dateFrom.getTime() || t > dateTo.getTime()) { droppedByAreaWindow++; continue; }
    kept.push(row.rgConfirmation);
  }

  assert.deepEqual(kept, ['MIA-IN', 'LAX-IN']);
  assert.equal(droppedByAreaWindow, 1);
  assert.equal(droppedByArea, 0);
});

test('per-area precision: null override on a config uses the ENV window as the precision filter', () => {
  const now = Date.UTC(2026, 6, 9, 12, 0, 0);
  // MIA has NO override → env window (2/30). LAX wide → union pushes to +90d.
  const areaConfig = new Map([
    ['MIA', { locationId: 'loc-mia', lookbackDays: null, lookaheadDays: null }],
    ['LAX', { locationId: 'loc-lax', lookbackDays: 10, lookaheadDays: 90 }],
  ]);
  const mia45 = { rgLocPickup: 'MIAO01', rgDatePickup: new Date(now + 45 * DAY).toISOString() };
  const { dateFrom, dateTo } = windowBoundsForConfig(areaConfig.get('MIA'), now);
  const t = parseRezDate(mia45.rgDatePickup);
  // 45 days out is beyond MIA's env lookahead (30) → outside → would be dropped.
  assert.ok(t > dateTo.getTime());
  assert.ok(t > dateFrom.getTime());
  // sanity: MIA env window resolves to +30d upper bound
  assert.equal(dateTo.getTime(), now + DATE_WINDOW_LOOKAHEAD_DAYS * DAY);
});

// Innovation O3 — the union-vs-precision drop, asserted directly through the
// EXPORTED pure helpers (unionWindowBounds / windowBoundsForConfig) rather than
// re-implementing the worker's kept-row loop inline. A MIA row that lands inside
// LAX's wider UNION window but outside MIA's OWN window must be dropped.
test('O3: MIA row inside the union but outside MIA own window is droppedByAreaWindow (exported helpers)', () => {
  const now = Date.UTC(2026, 6, 9, 12, 0, 0);
  const configs = [
    { externalArea: 'MIA', lookbackDays: 2, lookaheadDays: 30 },   // narrow
    { externalArea: 'LAX', lookbackDays: 10, lookaheadDays: 90 },  // wide → drives the union
  ];
  const mia = configs[0];
  const lax = configs[1];

  const union = unionWindowBounds(configs, now);
  const miaWindow = windowBoundsForConfig(mia, now);
  const laxWindow = windowBoundsForConfig(lax, now);

  // Union must be exactly LAX's wide window here (widest lookback + lookahead).
  assert.equal(union.dateFrom.getTime(), laxWindow.dateFrom.getTime());
  assert.equal(union.dateTo.getTime(), laxWindow.dateTo.getTime());

  // A MIA pickup 60 days out.
  const miaPickupMs = now + 60 * DAY;

  // Inside the UNION (the single fetch would return it)…
  assert.ok(miaPickupMs >= union.dateFrom.getTime() && miaPickupMs <= union.dateTo.getTime(),
    'row is inside the union fetch window');
  // …but OUTSIDE MIA's own precision window → droppedByAreaWindow.
  const insideMiaOwn = miaPickupMs >= miaWindow.dateFrom.getTime()
    && miaPickupMs <= miaWindow.dateTo.getTime();
  assert.equal(insideMiaOwn, false, 'row is outside MIA own window → dropped');

  // The identical instant for a LAX row WOULD be kept (inside LAX own window).
  const insideLaxOwn = miaPickupMs >= laxWindow.dateFrom.getTime()
    && miaPickupMs <= laxWindow.dateTo.getTime();
  assert.equal(insideLaxOwn, true, 'same instant is inside LAX own window → kept');
});

// ---------------------------------------------------------------------------
// S2 — per-tenant master switch enforcement in the scheduler.
//   (a) masterEnabledFromConfig parses Tenant.integrationConfig consistently
//       with the routes' readMasterEnabled.
//   (b) enumerateActiveTenants EXCLUDES a tenant whose master switch is off,
//       even when it has a credential AND an enabled area config.
// prisma is monkey-patched (no DB): the scheduler calls it via the imported ref.
// ---------------------------------------------------------------------------
const {
  masterEnabledFromConfig,
  enumerateActiveTenants,
} = await import('./economy.scheduler.js');

test('S2: masterEnabledFromConfig — only { economy: { enabled: true } } counts', () => {
  assert.equal(masterEnabledFromConfig(null), false);
  assert.equal(masterEnabledFromConfig({}), false);
  assert.equal(masterEnabledFromConfig({ economy: {} }), false);
  assert.equal(masterEnabledFromConfig({ economy: { enabled: false } }), false);
  assert.equal(masterEnabledFromConfig({ economy: { enabled: true } }), true);
  assert.equal(masterEnabledFromConfig({ tl: { enabled: true }, economy: { enabled: true } }), true);
});

test('S2: enumerateActiveTenants excludes a tenant with master enabled=false', async () => {
  const { prisma } = await import('../../../lib/prisma.js');
  const origCred = prisma.integrationCredential.findMany;
  const origCfg = prisma.economyLocationConfig.findMany;

  // Two tenants, both with a credential + an enabled area config, but only
  // tenant-on has the master switch ON.
  prisma.integrationCredential.findMany = async () => ([
    { tenantId: 'tenant-on', tenant: { integrationConfig: { economy: { enabled: true } } } },
    { tenantId: 'tenant-off', tenant: { integrationConfig: { economy: { enabled: false } } } },
  ]);
  prisma.economyLocationConfig.findMany = async ({ where }) =>
    where.tenantId.in.map((id) => ({ tenantId: id }));

  try {
    const tenants = await enumerateActiveTenants();
    assert.deepEqual(tenants, ['tenant-on']);
    assert.ok(!tenants.includes('tenant-off'), 'master-disabled tenant must be excluded');
  } finally {
    prisma.integrationCredential.findMany = origCred;
    prisma.economyLocationConfig.findMany = origCfg;
  }
});

test('S2: enumerateActiveTenants returns [] when NO tenant has the master switch on', async () => {
  const { prisma } = await import('../../../lib/prisma.js');
  const origCred = prisma.integrationCredential.findMany;
  const origCfg = prisma.economyLocationConfig.findMany;

  prisma.integrationCredential.findMany = async () => ([
    { tenantId: 'tenant-off', tenant: { integrationConfig: { economy: { enabled: false } } } },
  ]);
  // Should never be reached (short-circuits before the config query), but stub it.
  let cfgCalled = false;
  prisma.economyLocationConfig.findMany = async ({ where }) => {
    cfgCalled = true;
    return where.tenantId.in.map((id) => ({ tenantId: id }));
  };

  try {
    const tenants = await enumerateActiveTenants();
    assert.deepEqual(tenants, []);
    assert.equal(cfgCalled, false, 'config query skipped once no master-on tenants remain');
  } finally {
    prisma.integrationCredential.findMany = origCred;
    prisma.economyLocationConfig.findMany = origCfg;
  }
});

// ---------------------------------------------------------------------------
// Session self-heal (QA 2026-07-28): RezLight killed the session server-side
// but kept answering 200, so every 15-min run silently imported 0 for 6 hours.
// The fix: a page-0 lookup body with NO recordsTotal = dead session -> clear
// jar + re-login + retry once; still dead -> throw EconomyAuthExpiredError.
// ---------------------------------------------------------------------------

test('isDeadLookupResponse: no recordsTotal = dead; numeric (even 0) = alive; bare array = data', () => {
  assert.equal(isDeadLookupResponse({}), true);
  assert.equal(isDeadLookupResponse({ error: 'x' }), true);
  assert.equal(isDeadLookupResponse(null), true);
  assert.equal(isDeadLookupResponse({ recordsTotal: 0, data: [] }), false);
  assert.equal(isDeadLookupResponse({ recordsTotal: 94931, data: [{}] }), false);
  assert.equal(isDeadLookupResponse([]), true);
  assert.equal(isDeadLookupResponse([{ rgConfirmation: 'R1' }]), false);
});

// Fetch mock where the lookup POST plays dead ({}) until `loginsNeeded` login
// POSTs have happened — models a server-side session kill that a fresh login
// repairs. Counts logins so tests can assert the self-heal actually re-logged.
function installSelfHealFetch({ loginsNeeded, pageFor }) {
  const state = { loginPosts: 0, listPosts: 0 };
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));
  __test.setFetch(async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = String(url);
    if (method === 'GET' && !LIST_URL_RE.test(u) && !AUTHED_PAGE_RE.test(u)) {
      return fakeRes({ status: 200, body: LOGIN_HTML });
    }
    if (method === 'POST' && !LIST_URL_RE.test(u)) {
      state.loginPosts += 1;
      return fakeRes({ status: 200, body: 'ok', setCookie: `.AspNet.ApplicationCookie=S${state.loginPosts}; path=/` });
    }
    if (method === 'GET' && AUTHED_PAGE_RE.test(u)) {
      return fakeRes({ status: 200, body: '<input name="__RequestVerificationToken" value="TKN"/>' });
    }
    if (method === 'POST' && LIST_URL_RE.test(u)) {
      state.listPosts += 1;
      if (state.loginPosts < loginsNeeded) {
        // Dead session: RezLight answers 200 with an empty shell (no recordsTotal).
        return fakeRes({ status: 200, body: '{}' });
      }
      const params = new URLSearchParams(opts.body);
      const dt = JSON.parse(params.get('jsonPaginationParameters'));
      return fakeRes({ status: 200, body: JSON.stringify({ draw: 1, recordsTotal: 92093, data: pageFor(dt.start, dt.length) }) });
    }
    return fakeRes({ status: 200, body: '{}' });
  });
  return state;
}

test('self-heal: dead page-0 lookup triggers ONE re-login and the run recovers rows', async () => {
  _resetCookieJarsForTests();
  const now = Date.now();
  const anchor = now + 30 * 24 * 60 * 60 * 1000;
  const corpus = descRows(LOOKUP_PAGE_SIZE * 2, anchor, 0);
  // First login (jar was empty) yields the DEAD session; the self-heal's second
  // login repairs it.
  const state = installSelfHealFetch({ loginsNeeded: 2, pageFor: (s, l) => corpus.slice(s, s + l) });

  const rows = await fetchReservationList('tenant-x', {
    dateFrom: new Date(now - 3 * 24 * 60 * 60 * 1000),
    dateTo: new Date(now + 30 * 24 * 60 * 60 * 1000),
  });

  assert.equal(state.loginPosts, 2, 'self-heal performed exactly one extra login');
  assert.ok(rows.length > 0, 'recovered rows after the re-login');

  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('self-heal: still dead after re-login -> throws EconomyAuthExpiredError (loud, no silent zero)', async () => {
  _resetCookieJarsForTests();
  const now = Date.now();
  // loginsNeeded impossibly high -> lookup stays dead through the healing retry.
  const state = installSelfHealFetch({ loginsNeeded: 99, pageFor: () => [] });

  await assert.rejects(
    () => fetchReservationList('tenant-x', {
      dateFrom: new Date(now - 3 * 24 * 60 * 60 * 1000),
      dateTo: new Date(now + 30 * 24 * 60 * 60 * 1000),
    }),
    (err) => err instanceof EconomyAuthExpiredError
  );
  assert.equal(state.loginPosts, 2, 'healed once (initial + retry), then gave up loudly');

  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});
