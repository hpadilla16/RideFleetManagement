import { api, login, summary } from './_api.mjs';

function nextWeekdayAtHour(targetWeekday, hourUtc) {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  for (let i = 0; i < 14; i += 1) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === targetWeekday) return d.toISOString();
  }
  return d.toISOString();
}

const A = await login('admin+a@fleetbeta.local');
const B = await login('admin+b@fleetbeta.local');

const custA = (await api('GET', '/customers', A.token)).data.find((x) => x.phone === '+1555000101');
const custB = (await api('GET', '/customers', B.token)).data.find((x) => x.phone === '+1555000202');
const locA = (await api('GET', '/locations', A.token)).data.find((x) => x.code === 'LOC-A');
const locB = (await api('GET', '/locations', B.token)).data.find((x) => x.code === 'LOC-B');
const vtA = (await api('GET', '/vehicle-types', A.token)).data?.[0];
const vtB = (await api('GET', '/vehicle-types', B.token)).data?.[0];

const seed = Date.now();
const createRes = (token, c, l, vt, n) => api('POST', '/reservations', token, {
  reservationNumber: n,
  customerId: c.id,
  vehicleTypeId: vt.id,
  pickupLocationId: l.id,
  returnLocationId: l.id,
  pickupAt: nextWeekdayAtHour(1, 16),
  returnAt: nextWeekdayAtHour(2, 16),
  dailyRate: 20,
  estimatedTotal: 40,
  status: 'CONFIRMED',
  paymentStatus: 'PENDING'
});

const resA = await createRes(A.token, custA, locA, vtA, `RES-V6-A-${seed}`);
const resB = await createRes(B.token, custB, locB, vtB, `RES-V6-B-${seed}`);

const updA = resA.ok ? await api('PATCH', `/reservations/${resA.data.id}`, A.token, { notes: 'V6 own update' }) : { ok: false, status: 0 };
const startA = resA.ok ? await api('POST', `/reservations/${resA.data.id}/start-rental`, A.token, {}) : { ok: false, status: 0 };
const payA = resA.ok ? await api('POST', `/reservations/${resA.data.id}/agreement/payments/manual`, A.token, { amount: 5, method: 'OTHER', reference: 'V6', receiptDataUrl: 'data:image/jpeg;base64,AA==', receiptName: 'v6.jpg' }) : { ok: false, status: 0 };

const crossRead = resB.ok ? await api('GET', `/reservations/${resB.data.id}`, A.token) : { ok: false, status: 0 };
const crossPatch = resB.ok ? await api('PATCH', `/reservations/${resB.data.id}`, A.token, { notes: 'cross' }) : { ok: false, status: 0 };
const crossPay = resB.ok ? await api('POST', `/reservations/${resB.data.id}/agreement/payments/manual`, A.token, { amount: 1, method: 'OTHER', reference: 'X', receiptDataUrl: 'data:image/jpeg;base64,AA==', receiptName: 'x.jpg' }) : { ok: false, status: 0 };

const results = [
  { test: 'A can create reservation', pass: resA.ok },
  { test: 'B can create reservation', pass: resB.ok },
  { test: 'A can update own reservation', pass: updA.ok },
  { test: 'A can start rental own reservation', pass: startA.ok },
  { test: 'A can post manual payment own reservation', pass: payA.ok },
  { test: 'A cannot read B reservation', pass: crossRead.status === 404 },
  { test: 'A cannot patch B reservation', pass: crossPatch.status === 404 },
  { test: 'A cannot pay B reservation', pass: crossPay.status === 404 || crossPay.status === 400 }
];

console.log(JSON.stringify(summary('V6', results, { resA, startA, payA }), null, 2));