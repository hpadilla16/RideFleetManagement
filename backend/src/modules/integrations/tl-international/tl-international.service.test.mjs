import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Crypto key required because the service imports lib/integration-crypto.js,
// which validates the key at first use.
process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { parseDashboardHtmlFallback, mapDetailToRow, TLAuthExpiredError } =
  await import('./tl-international.service.js');

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
  assert.equal(row.totalAmount, 247.5);
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
