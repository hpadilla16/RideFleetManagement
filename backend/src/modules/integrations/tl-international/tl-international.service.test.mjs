import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Crypto key required because the service imports lib/integration-crypto.js,
// which validates the key at first use.
process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const {
  parseDashboardHtmlFallback,
  parseDashboardHtml,
  parseCookieString,
  mapDetailToRow,
  fetchDashboardPickups,
  TLAuthExpiredError,
  USER_AGENT_POOL,
  pickUserAgent,
  randomDelay,
  __test,
} = await import('./tl-international.service.js');

// ----------------------------------------------------------------------------
// Dashboard HTML parser (regex fallback)
// ----------------------------------------------------------------------------

const SAMPLE_HTML = `
<html><body>
  <table id="bookings">
    <tr><th>Status</th><th>Number</th><th>Customer</th><th>Time</th><th>Location</th></tr>
    <tr class="row-pickup">
      <td>PICKUP</td>
      <td><a href="#">ZE1521152BA</a></td>
      <td>John Doe</td>
      <td>2026-05-21 10:30</td>
      <td>San Juan Airport (SJUA01)</td>
    </tr>
    <tr class="row-pickup">
      <td>PICKUP</td>
      <td><a href="#">ZE9988777CC</a></td>
      <td>Jane Roe</td>
      <td>2026-05-21 14:00</td>
      <td>Aguadilla Airport (BQNA01)</td>
    </tr>
    <tr class="row-return">
      <td>RETURN</td>
      <td><a href="#">ZE5555555DD</a></td>
      <td>Carlos Vega</td>
      <td>2026-05-21 16:00</td>
      <td>San Juan Airport (SJUA01)</td>
    </tr>
    <!-- duplicate row (defensive — sub-tables sometimes echo) -->
    <tr class="row-pickup">
      <td>PICKUP</td>
      <td><a href="#">ZE1521152BA</a></td>
      <td>John Doe</td>
      <td>2026-05-21 10:30</td>
      <td>San Juan Airport (SJUA01)</td>
    </tr>
  </table>
</body></html>
`;

test('parseDashboardHtmlFallback extracts every PICKUP row with a ZE#', () => {
  const rows = parseDashboardHtmlFallback(SAMPLE_HTML);
  assert.equal(rows.length, 2, 'should find exactly 2 unique pickups (return row filtered, dupe deduped)');
  assert.deepEqual(rows.map((r) => r.externalRef).sort(), ['ZE1521152BA', 'ZE9988777CC']);
});

test('parseDashboardHtmlFallback returns positional cell text', () => {
  const rows = parseDashboardHtmlFallback(SAMPLE_HTML);
  const row = rows.find((r) => r.externalRef === 'ZE1521152BA');
  assert.ok(row);
  assert.equal(row.cells[2], 'John Doe');
  assert.match(row.cells[4], /SJUA01/);
});

test('parseDashboardHtmlFallback dedupes repeated ZE#s', () => {
  const rows = parseDashboardHtmlFallback(SAMPLE_HTML);
  const refs = rows.map((r) => r.externalRef);
  assert.equal(new Set(refs).size, refs.length);
});

test('parseDashboardHtmlFallback returns [] for HTML without pickups', () => {
  assert.deepEqual(parseDashboardHtmlFallback('<html><body>no bookings</body></html>'), []);
  assert.deepEqual(parseDashboardHtmlFallback(''), []);
});

test('parseDashboardHtmlFallback skips rows missing a ZE# even if "PICKUP" is present', () => {
  const html = `<tr><td>PICKUP</td><td>not-a-ze-code</td></tr>`;
  assert.deepEqual(parseDashboardHtmlFallback(html), []);
});

// ----------------------------------------------------------------------------
// parseCookieString (Puppeteer cookie shaping)
// ----------------------------------------------------------------------------

test('parseCookieString splits "k=v; k=v" pairs', () => {
  const out = parseCookieString('PHPSESSID=abc123; __cf_logged_in=1; CF_VERIFIED_DEVICE_x=token');
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { name: 'PHPSESSID', value: 'abc123' });
  assert.deepEqual(out[1], { name: '__cf_logged_in', value: '1' });
  assert.deepEqual(out[2], { name: 'CF_VERIFIED_DEVICE_x', value: 'token' });
});

test('parseCookieString tolerates values containing "="', () => {
  const out = parseCookieString('token=eyJhbGc=.payload=.sig');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'token');
  assert.equal(out[0].value, 'eyJhbGc=.payload=.sig');
});

test('parseCookieString skips empty / malformed segments', () => {
  const out = parseCookieString(' ; a=1; ;noequals; b=2 ; ');
  assert.deepEqual(out, [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
  ]);
});

test('parseCookieString returns [] for empty / non-string input', () => {
  assert.deepEqual(parseCookieString(''), []);
  assert.deepEqual(parseCookieString('   '), []);
  assert.deepEqual(parseCookieString(null), []);
  assert.deepEqual(parseCookieString(undefined), []);
});

// ----------------------------------------------------------------------------
// parseDashboardHtml (async wrapper used by Puppeteer path)
// ----------------------------------------------------------------------------

test('parseDashboardHtml works end-to-end on SAMPLE_HTML', async () => {
  const rows = await parseDashboardHtml(SAMPLE_HTML);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.externalRef).sort(), ['ZE1521152BA', 'ZE9988777CC']);
});

// ----------------------------------------------------------------------------
// fetchDashboardPickups — Puppeteer path with stubbed loader
// ----------------------------------------------------------------------------

test('fetchDashboardPickups returns parsed pickups (loader stubbed)', async () => {
  let captured = null;
  __test.setPuppeteerLoader(async (tenantId, path) => {
    captured = { tenantId, path };
    return { html: SAMPLE_HTML, finalUrl: 'https://newadmin.tlinternationalgroup.com/dashboard.php', status: 200 };
  });
  try {
    const rows = await fetchDashboardPickups('tenant-abc');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.externalRef).sort(), ['ZE1521152BA', 'ZE9988777CC']);
    assert.equal(captured.tenantId, 'tenant-abc');
    assert.equal(captured.path, '/dashboard.php');
  } finally {
    __test.setPuppeteerLoader(null);
  }
});

test('fetchDashboardPickups propagates TLAuthExpiredError from loader', async () => {
  __test.setPuppeteerLoader(async () => {
    throw new TLAuthExpiredError('Redirected to https://newadmin.tlinternationalgroup.com/login.php');
  });
  try {
    await assert.rejects(
      () => fetchDashboardPickups('tenant-abc'),
      (err) => err instanceof TLAuthExpiredError && /login\.php/.test(err.message)
    );
  } finally {
    __test.setPuppeteerLoader(null);
  }
});

test('fetchDashboardPickups returns [] when HTML has no PICKUP rows', async () => {
  __test.setPuppeteerLoader(async () => ({
    html: '<html><body><table><tr><td>nothing</td></tr></table></body></html>',
    finalUrl: 'https://newadmin.tlinternationalgroup.com/dashboard.php',
    status: 200,
  }));
  try {
    const rows = await fetchDashboardPickups('tenant-empty');
    assert.deepEqual(rows, []);
  } finally {
    __test.setPuppeteerLoader(null);
  }
});

// ----------------------------------------------------------------------------
// JSON → ExternalReservation field mapper
// ----------------------------------------------------------------------------

test('mapDetailToRow maps canonical fields onto schema columns', () => {
  const detail = {
    firstname: 'John',
    lastname: 'Doe',
    email: 'john@example.com',
    phone: '+17875551234',
    country: 'US',
    status: 'CONFIRMED',
    channel: 'EXPEDIA02',
    supplierRef: 'EXP-12345',
    vehicleClass: 'CCAR',
    vehicleDescription: 'Toyota Corolla or similar',
    pickup: '2026-05-21T10:30:00Z',
    pickupLocation: 'San Juan Airport (SJUA01)',
    dropoff: '2026-05-24T10:30:00Z',
    dropoffLocation: 'San Juan Airport (SJUA01)',
    total: 247.50,
    currency: 'USD',
    flight: 'AA1234',
  };
  const row = mapDetailToRow(detail, 'ZE1521152BA');
  assert.equal(row.externalRef, 'ZE1521152BA');
  assert.equal(row.customerFirstName, 'John');
  assert.equal(row.customerLastName, 'Doe');
  assert.equal(row.customerEmail, 'john@example.com');
  assert.equal(row.vehicleAcriss, 'CCAR');
  assert.equal(row.pickupLocation, 'San Juan Airport (SJUA01)');
  assert.equal(row.flightNumber, 'AA1234');
  assert.equal(row.currency, 'USD');
  assert.equal(row.totalAmount, '247.5'); // mapper coerces to decimal-string (TL ships strings)
  assert.ok(row.pickupAt instanceof Date);
  assert.ok(row.dropoffAt instanceof Date);
  assert.equal(row.rawJson, detail);
});

test('mapDetailToRow tolerates alternate field names + missing fields', () => {
  const detail = {
    first_name: 'Carlos',
    last_name: 'Vega',
    telephone: '7875559999',
    car_class: 'ECAR',
    pickup_date: '2026-06-01T08:00:00Z',
  };
  const row = mapDetailToRow(detail, 'ZE0000000XX');
  assert.equal(row.customerFirstName, 'Carlos');
  assert.equal(row.customerLastName, 'Vega');
  assert.equal(row.customerPhone, '7875559999');
  assert.equal(row.vehicleAcriss, 'ECAR');
  assert.equal(row.currency, 'USD');   // default when missing
  assert.equal(row.customerEmail, null);
  assert.ok(row.pickupAt instanceof Date);
});

test('mapDetailToRow handles malformed dates as null without throwing', () => {
  const row = mapDetailToRow({ pickup: 'not-a-date', dropoff: '' }, 'ZE9999999XX');
  assert.equal(row.pickupAt, null);
  assert.equal(row.dropoffAt, null);
});

test('mapDetailToRow returns a stub when input is not an object', () => {
  const row = mapDetailToRow(null, 'ZE1');
  assert.equal(row.externalRef, 'ZE1');
  assert.ok(row.rawJson);
});

// ----------------------------------------------------------------------------
// Error class sanity
// ----------------------------------------------------------------------------

test('TLAuthExpiredError has a stable name', () => {
  const e = new TLAuthExpiredError();
  assert.equal(e.name, 'TLAuthExpiredError');
  assert.ok(e instanceof Error);
});

// ----------------------------------------------------------------------------
// Stealth: randomDelay()
// ----------------------------------------------------------------------------

test('randomDelay returns a value in [min, max)', () => {
  for (let i = 0; i < 500; i++) {
    const v = randomDelay(3000, 5000);
    assert.ok(Number.isInteger(v), 'should be integer');
    assert.ok(v >= 3000, `expected >= 3000, got ${v}`);
    assert.ok(v < 5000, `expected < 5000, got ${v}`);
  }
});

test('randomDelay returns minMs when min === max', () => {
  assert.equal(randomDelay(2500, 2500), 2500);
});

test('randomDelay clamps max <= min to min (no negative range)', () => {
  assert.equal(randomDelay(4000, 1000), 4000);
});

test('randomDelay treats negative min as 0', () => {
  const v = randomDelay(-100, 50);
  assert.ok(v >= 0 && v < 50);
});

// ----------------------------------------------------------------------------
// Stealth: pickUserAgent()
// ----------------------------------------------------------------------------

test('pickUserAgent returns a string from USER_AGENT_POOL when no env override', () => {
  const prev = process.env.TL_INTERNATIONAL_USER_AGENT;
  delete process.env.TL_INTERNATIONAL_USER_AGENT;
  try {
    for (let i = 0; i < 100; i++) {
      const ua = pickUserAgent();
      assert.equal(typeof ua, 'string');
      assert.ok(USER_AGENT_POOL.includes(ua), `unexpected UA: ${ua}`);
    }
  } finally {
    if (prev === undefined) delete process.env.TL_INTERNATIONAL_USER_AGENT;
    else process.env.TL_INTERNATIONAL_USER_AGENT = prev;
  }
});

test('pickUserAgent respects env override when set', () => {
  const prev = process.env.TL_INTERNATIONAL_USER_AGENT;
  process.env.TL_INTERNATIONAL_USER_AGENT = 'CustomBot/1.0';
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal(pickUserAgent(), 'CustomBot/1.0');
    }
  } finally {
    if (prev === undefined) delete process.env.TL_INTERNATIONAL_USER_AGENT;
    else process.env.TL_INTERNATIONAL_USER_AGENT = prev;
  }
});

test('USER_AGENT_POOL has at least 6 entries and all are non-empty strings', () => {
  assert.ok(USER_AGENT_POOL.length >= 6, `pool too small: ${USER_AGENT_POOL.length}`);
  for (const ua of USER_AGENT_POOL) {
    assert.equal(typeof ua, 'string');
    assert.ok(ua.length > 20, `UA looks too short: ${ua}`);
    assert.ok(/Mozilla\/5\.0/.test(ua), `UA missing Mozilla/5.0 prefix: ${ua}`);
  }
});

test('USER_AGENT_POOL is frozen (immutable)', () => {
  assert.ok(Object.isFrozen(USER_AGENT_POOL));
});
