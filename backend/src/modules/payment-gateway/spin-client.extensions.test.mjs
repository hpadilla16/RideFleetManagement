/**
 * Tests for the new spin-client methods + helpers added in P2 (2026-05-21).
 * Run: node --test backend/src/modules/payment-gateway/spin-client.extensions.test.mjs
 *
 * Uses global.fetch overrides to intercept HTTP calls.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  spinClient,
  buildLevel3FromReservation,
  htmlToTerminalText,
  extractContextAroundMarker,
} from './spin-client.js';

// ---------------------------------------------------------------------------
// fetch stub — captures the last request
// ---------------------------------------------------------------------------

let lastRequest = null;
function makeFetchOk(responseBody) {
  return async function fakeFetch(url, opts) {
    lastRequest = {
      url,
      method: opts?.method,
      headers: opts?.headers,
      body: opts?.body ? JSON.parse(opts.body) : null,
    };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const TENANT_CONFIG = { spinAuthKey: 'TEST_KEY', spinTpn: '12345', spinMerchantNumber: 1 };
const OK_RESPONSE = {
  GeneralResponse: { ResultCode: 0, StatusCode: '0000', Message: 'OK' },
};

beforeEach(() => {
  lastRequest = null;
  globalThis.fetch = makeFetchOk(OK_RESPONSE);
});

// ---------------------------------------------------------------------------
// Removed in round 25 (2026-05-22): tests for disclaimer / getSignature /
// userChoice / userInput / cart methods. Those methods were deleted from
// spin-client.js — the SPIn REST API doesn't expose them as standalone
// endpoints under v2/Payment/*. The interactive flow is now handled inside
// the Sale request itself (CaptureSignature: true + disclaimer configured
// on the terminal profile).
//
// See: doc/round-25-plan-2026-05-22.md
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// autoRentalSale / Auth / Capture
// ---------------------------------------------------------------------------

test('autoRentalSale routes to v2/AutoRental/Sale with rentalData + cart + level3', async () => {
  await spinClient.autoRentalSale(
    {
      amount: 123.45,
      referenceId: 'AR1',
      invoiceNumber: 'INV1',
      rentalData: { AgreementNumber: 'A1' },
      cart: { Items: [], Total: 0 },
      level3: { RentalData: { foo: 1 } },
    },
    TENANT_CONFIG
  );
  assert.match(lastRequest.url, /v2\/AutoRental\/Sale$/);
  assert.equal(lastRequest.body.Amount, 123.45);
  assert.equal(lastRequest.body.InvoiceNumber, 'INV1');
  // Round 25 hotfix: SPIn AutoRental body uses 'AutoRental' wrapper, not 'RentalData'
  assert.equal(lastRequest.body.AutoRental.AgreementNumber, 'A1');
  assert.ok(lastRequest.body.Cart);
  assert.ok(lastRequest.body.Level3);
  assert.equal(lastRequest.body.CaptureSignature, true);
  assert.equal(lastRequest.body.GetExtendedData, true);
});

test('autoRentalAuth routes to v2/AutoRental/Auth', async () => {
  await spinClient.autoRentalAuth(
    { amount: 250, referenceId: 'A1', invoiceNumber: 'R1', rentalData: { x: 1 } },
    TENANT_CONFIG
  );
  assert.match(lastRequest.url, /v2\/AutoRental\/Auth$/);
  assert.equal(lastRequest.body.Amount, 250);
  // Round 25 hotfix: SPIn AutoRental body uses 'AutoRental' wrapper, not 'RentalData'
  assert.equal(lastRequest.body.AutoRental.x, 1);
});

test('autoRentalCapture routes to v2/AutoRental/Capture (amount optional)', async () => {
  await spinClient.autoRentalCapture({ referenceId: 'A1' }, TENANT_CONFIG);
  assert.match(lastRequest.url, /v2\/AutoRental\/Capture$/);
  assert.equal(lastRequest.body.Amount, undefined);

  await spinClient.autoRentalCapture({ referenceId: 'A2', amount: 100 }, TENANT_CONFIG);
  assert.equal(lastRequest.body.Amount, 100);
});

// ---------------------------------------------------------------------------
// buildLevel3FromReservation
// ---------------------------------------------------------------------------

test('buildLevel3FromReservation returns Cart + Level3.RentalData', () => {
  const reservation = {
    id: 'r1',
    pickupAt: new Date('2026-05-21T14:00:00Z'),
    returnAt: new Date('2026-05-24T14:00:00Z'),
    pickupLocation: { code: 'SJU', name: 'San Juan' },
    returnLocation: { code: 'SJU', name: 'San Juan' },
    vehicle: { plate: 'ABC123', classCode: 'SFAR' },
    customer: { firstName: 'M', lastName: 'Rivera' },
  };
  const agreement = { agreementNumber: 'AG-001', dailyRate: 75, totalDays: 3 };
  const charges = [
    { name: 'Base rate', quantity: 3, rate: 75, total: 225, selected: true },
    { name: 'CDW', quantity: 3, rate: 15, total: 45, selected: true },
    { name: 'Excluded', quantity: 1, rate: 99, total: 99, selected: false },
  ];
  const { Cart, Level3 } = buildLevel3FromReservation(reservation, agreement, charges);
  assert.equal(Cart.Items.length, 2, 'unselected charges filtered out');
  assert.equal(Cart.Total, 270);
  assert.equal(Cart.Items[0].CommodityCode, '4111');
  assert.equal(Level3.RentalData.AgreementNumber, 'AG-001');
  assert.equal(Level3.RentalData.PickupLocation, 'SJU');
  assert.equal(Level3.RentalData.VehicleClass, 'SFAR');
  assert.equal(Level3.RentalData.VehiclePlate, 'ABC123');
  assert.equal(Level3.RentalData.DriverFirstName, 'M');
  assert.equal(Level3.RentalData.DailyRate, 75);
  assert.equal(Level3.RentalData.TotalDays, 3);
});

test('buildLevel3FromReservation handles missing optional data', () => {
  const r = { id: 'r1' };
  const { Cart, Level3 } = buildLevel3FromReservation(r, {}, []);
  assert.equal(Cart.Items.length, 0);
  assert.equal(Cart.Total, 0);
  assert.equal(Level3.RentalData.AgreementNumber, 'r1', 'falls back to reservation.id');
  assert.equal(Level3.RentalData.PickupDate, null);
});

test('buildLevel3FromReservation accepts Prisma-Decimal-as-string', () => {
  const charges = [
    { name: 'Rate', quantity: '2', rate: '75.50', total: '151.00', selected: true },
  ];
  const { Cart } = buildLevel3FromReservation({ id: 'r' }, {}, charges);
  assert.equal(Cart.Items[0].Quantity, 2);
  assert.equal(Cart.Items[0].UnitPrice, 75.5);
  assert.equal(Cart.Items[0].Total, 151);
  assert.equal(Cart.Total, 151);
});

// ---------------------------------------------------------------------------
// htmlToTerminalText
// ---------------------------------------------------------------------------

test('htmlToTerminalText strips tags + decodes entities', () => {
  const html = '<h2>Section 1</h2><p>You &amp; the renter agree to&nbsp;all terms.</p>';
  const out = htmlToTerminalText(html);
  assert.match(out, /Section 1/);
  assert.match(out, /You & the renter/);
  assert.doesNotMatch(out, /<[^>]+>/, 'no tags remain');
});

test('htmlToTerminalText truncates to maxLen', () => {
  const long = '<p>' + 'a'.repeat(7000) + '</p>';
  const out = htmlToTerminalText(long, { maxLen: 100 });
  assert.equal(out.length, 100);
  assert.match(out, /\.\.\.$/);
});

test('htmlToTerminalText returns empty string on null/undefined', () => {
  assert.equal(htmlToTerminalText(null), '');
  assert.equal(htmlToTerminalText(''), '');
});

// ---------------------------------------------------------------------------
// extractContextAroundMarker
// ---------------------------------------------------------------------------

test('extractContextAroundMarker returns surrounding plain text', () => {
  const html = '<p>preamble text</p><h3>Section 4</h3><p>Initial here: {{INITIALS_S4}} please.</p>';
  const ctx = extractContextAroundMarker(html, 'INITIALS_S4', { window: 200 });
  assert.match(ctx, /Section 4/);
  assert.match(ctx, /Initial here/);
});

test('extractContextAroundMarker returns empty when marker absent', () => {
  assert.equal(extractContextAroundMarker('<p>no marker</p>', 'ANY'), '');
});
