/**
 * Revenue by Vehicle Type — the DECISIONS (pure, no IO).
 *
 * Kept out of the .report.js for the same reason cash-flow and daily-business
 * are: importing the report file drags in the whole express router, so the
 * attribution rules could not be tested without booting the app. Everything
 * here is a judgement call about whose revenue a dollar is, and those are
 * exactly the parts worth pinning down with tests.
 *
 * ── WHAT COUNTS AS REVENUE ──────────────────────────────────────────────────
 * Borrowed wholesale from sales.report.js rather than re-decided: selected
 * charges only, TAX is not revenue, and a DEPOSIT is a hold that gets released
 * or applied to damage — never recognised as a sale. Two reports that disagree
 * about what a dollar is are worse than one report.
 *
 * ── WHICH TYPE GETS THE MONEY ───────────────────────────────────────────────
 * The vehicle actually on the agreement, not the class the customer booked:
 * the tenant is asking what their metal earned, and a Corolla sent out against
 * an intermediate booking earned its money as a Corolla. Two consequences,
 * both surfaced rather than smoothed over:
 *
 *   - A rental whose vehicle was swapped mid-way lands entirely on the FINAL
 *     vehicle's type. Splitting it would need a per-day allocation this does
 *     not guess at; RentalAgreementVehicleSwap holds the history if it ever
 *     needs to.
 *   - An agreement with no vehicle assigned cannot be attributed at all, so it
 *     goes to its own `unassigned` block and is shown. Revenue that belongs to
 *     no type is a data-entry finding the tenant wants, not a rounding error
 *     to hide.
 *
 * ── WHY REVENUE PER UNIT LEADS ──────────────────────────────────────────────
 * Total revenue per type mostly measures how many of that type you own: thirty
 * compacts out-earn four minivans and tell you nothing about what to buy next.
 * Revenue ÷ units in fleet is the number that answers the real question, so it
 * is what the table sorts on.
 */

// Kept identical to sales.report.js — see the note above.
export const TAX_CHARGE_TYPE = 'TAX';
export const DEPOSIT_CHARGE_TYPE = 'DEPOSIT';
export const EXCLUDED_AGREEMENT_STATUSES = ['CANCELLED', 'DRAFT'];

const DAY_MS = 24 * 60 * 60 * 1000;

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function money(v) {
  return Math.round(num(v) * 100) / 100;
}

export function pct(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * Rental days billed on one agreement, floor 1.
 *
 * A same-day rental is one day of revenue, not zero — a zero would hand that
 * type an infinite revenue-per-day and park it at the top of the table for
 * ever. A partial day rounds up, the way a rental is actually billed.
 */
export function rentalDays(pickupAt, returnAt) {
  const a = new Date(pickupAt);
  const b = new Date(returnAt);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  return Math.max(1, Math.ceil((b - a) / DAY_MS));
}

/**
 * Revenue folded by MAKE + MODEL rather than by type.
 *
 * Hector: "que lo pueden especificar por vehicle model, por ejemplo si nada
 * más quieren ver los Volvo XC40." A type is a commercial class -- "Compact
 * SUV" -- and a tenant buying cars does not buy a class, they buy an XC40. Two
 * models inside one class can earn very differently, and the type table cannot
 * show that however it is sorted.
 *
 * Rows carry their type as well, because the same model can legitimately sit
 * in two classes across branches and collapsing that would hide it.
 */
export function aggregateByModel(charges, fleetCounts = new Map()) {
  const models = new Map();
  const seen = new Set();

  for (const c of charges) {
    const ra = c.rentalAgreement || {};
    const v = ra.vehicle || null;
    if (c.chargeType === TAX_CHARGE_TYPE || c.chargeType === DEPOSIT_CHARGE_TYPE) continue;

    const make = (v?.make || '').trim();
    const model = (v?.model || '').trim();
    // A vehicle with no make/model on file is its own visible bucket, for the
    // same reason an agreement with no vehicle is: it is a data-entry finding,
    // not a rounding error.
    const label = make || model ? `${make} ${model}`.trim() : 'Unspecified make/model';
    const typeCode = v?.vehicleType?.code || null;
    const key = `${label}||${typeCode || ''}`;

    if (!models.has(key)) {
      models.set(key, {
        make: make || null,
        model: model || null,
        label,
        typeCode,
        typeName: v?.vehicleType?.name || null,
        revenue: 0,
        rentals: 0,
        days: 0,
        units: 0,
      });
    }
    const row = models.get(key);
    row.revenue += num(c.total);

    if (ra.id && !seen.has(ra.id)) {
      seen.add(ra.id);
      row.rentals += 1;
      row.days += rentalDays(ra.pickupAt, ra.returnAt);
    }
  }

  // Fleet counts arrive keyed the same way the caller grouped them.
  for (const [key, row] of models) {
    row.units = num(fleetCounts.get(key));
  }

  const rows = [...models.values()].map((r) => ({
    ...r,
    revenue: money(r.revenue),
    avgPerRental: r.rentals ? money(r.revenue / r.rentals) : null,
    revenuePerDay: r.days ? money(r.revenue / r.days) : null,
    revenuePerUnit: r.units ? money(r.revenue / r.units) : null,
  }));

  const total = money(rows.reduce((acc, r) => acc + r.revenue, 0));
  for (const r of rows) r.sharePct = pct(r.revenue, total);
  rows.sort((a, b) => (b.revenuePerUnit ?? -1) - (a.revenuePerUnit ?? -1) || b.revenue - a.revenue);

  return {
    rows,
    totals: {
      revenue: total,
      rentals: rows.reduce((acc, r) => acc + r.rentals, 0),
      days: rows.reduce((acc, r) => acc + r.days, 0),
      modelCount: rows.length,
    },
  };
}

/**
 * Revenue folded by INDIVIDUAL CAR.
 *
 * Hector: "que rompa el revenue también por carro, no nada más por type —
 * vehicle id, license, vin, make, model, year and revenue generated."
 *
 * The deepest of the three views, and the only one that answers "is THIS car
 * paying for itself". A class average hides both the unit that never leaves
 * the lot and the one carrying the class.
 *
 * No fleet-count column here on purpose: the row IS one car, so revenue per
 * unit would just repeat revenue. What replaces it is days on rent, which is
 * the closest thing to utilisation this report can honestly compute from
 * charges alone.
 */
export function aggregateByVehicle(charges) {
  const cars = new Map();
  const seen = new Set();

  for (const c of charges) {
    if (c.chargeType === TAX_CHARGE_TYPE || c.chargeType === DEPOSIT_CHARGE_TYPE) continue;
    const ra = c.rentalAgreement || {};
    const v = ra.vehicle || null;
    // A charge with no vehicle cannot be attributed to a car at all. It is
    // reported by the by-type view's `unassigned` block; silently bucketing it
    // under some placeholder car would be worse than leaving it out of a view
    // whose unit of account is a single vehicle.
    if (!v?.id) continue;

    if (!cars.has(v.id)) {
      cars.set(v.id, {
        vehicleId: v.id,
        unit: v.internalNumber || null,
        plate: v.plate || null,
        vin: v.vin || null,
        make: v.make || null,
        model: v.model || null,
        year: v.year || null,
        typeCode: v.vehicleType?.code || null,
        typeName: v.vehicleType?.name || null,
        revenue: 0,
        rentals: 0,
        days: 0,
      });
    }
    const row = cars.get(v.id);
    row.revenue += num(c.total);
    if (ra.id && !seen.has(ra.id)) {
      seen.add(ra.id);
      row.rentals += 1;
      row.days += rentalDays(ra.pickupAt, ra.returnAt);
    }
  }

  const rows = [...cars.values()].map((r) => ({
    ...r,
    revenue: money(r.revenue),
    avgPerRental: r.rentals ? money(r.revenue / r.rentals) : null,
    revenuePerDay: r.days ? money(r.revenue / r.days) : null,
  }));

  const total = money(rows.reduce((acc, r) => acc + r.revenue, 0));
  for (const r of rows) r.sharePct = pct(r.revenue, total);
  rows.sort((a, b) => b.revenue - a.revenue);

  return {
    rows,
    totals: {
      revenue: total,
      rentals: rows.reduce((acc, r) => acc + r.rentals, 0),
      days: rows.reduce((acc, r) => acc + r.days, 0),
      vehicleCount: rows.length,
    },
  };
}

/** Key a vehicle the same way aggregateByModel does, so fleet counts line up. */
export function modelKey(vehicle) {
  const make = (vehicle?.make || '').trim();
  const model = (vehicle?.model || '').trim();
  const label = make || model ? `${make} ${model}`.trim() : 'Unspecified make/model';
  return `${label}||${vehicle?.vehicleType?.code || vehicle?.typeCode || ''}`;
}

/**
 * Fold charges into per-type rows.
 *
 * `charges` carry their parent agreement, so one pass builds both the money
 * and the per-agreement facts — a rental counts once however many charges it
 * happens to have, which is the easiest thing in this file to get wrong.
 */
export function aggregate(charges, fleetCounts = new Map()) {
  const types = new Map();
  const seenAgreements = new Set();
  let taxAmount = 0;
  let depositAmount = 0;

  for (const c of charges) {
    const ra = c.rentalAgreement || {};
    const vt = ra.vehicle?.vehicleType || null;
    const key = vt ? vt.id : '__unassigned__';

    if (!types.has(key)) {
      types.set(key, {
        typeId: vt?.id || null,
        code: vt?.code || null,
        name: vt?.name || 'Unassigned (no vehicle on the agreement)',
        revenue: 0,
        rentals: 0,
        days: 0,
        taxAmount: 0,
        depositAmount: 0,
      });
    }
    const row = types.get(key);
    const amount = num(c.total);

    if (c.chargeType === TAX_CHARGE_TYPE) {
      row.taxAmount += amount;
      taxAmount += amount;
      continue;
    }
    if (c.chargeType === DEPOSIT_CHARGE_TYPE) {
      row.depositAmount += amount;
      depositAmount += amount;
      continue;
    }
    row.revenue += amount;

    // Count the rental and its days ONCE. Reached only from a revenue charge,
    // so an agreement carrying nothing but tax never invents a rental.
    if (ra.id && !seenAgreements.has(ra.id)) {
      seenAgreements.add(ra.id);
      row.rentals += 1;
      row.days += rentalDays(ra.pickupAt, ra.returnAt);
    }
  }

  const rows = [...types.values()].map((r) => {
    const units = r.typeId ? num(fleetCounts.get(r.typeId)) : 0;
    return {
      ...r,
      revenue: money(r.revenue),
      taxAmount: money(r.taxAmount),
      depositAmount: money(r.depositAmount),
      units,
      avgPerRental: r.rentals ? money(r.revenue / r.rentals) : null,
      revenuePerDay: r.days ? money(r.revenue / r.days) : null,
      // Null rather than 0 when the type has no units on the books: "we own
      // none of these" and "these earned nothing per car" are different
      // statements and must not render the same.
      revenuePerUnit: units ? money(r.revenue / units) : null,
    };
  });

  const revenueTotal = money(rows.reduce((acc, r) => acc + r.revenue, 0));
  for (const r of rows) r.sharePct = pct(r.revenue, revenueTotal);

  const unassigned = rows.find((r) => !r.typeId) || null;
  const attributed = rows.filter((r) => r.typeId);

  // Revenue per unit first; a type with no units falls back on total revenue
  // rather than sorting above everything on a null.
  attributed.sort((a, b) => (b.revenuePerUnit ?? -1) - (a.revenuePerUnit ?? -1) || b.revenue - a.revenue);

  return {
    rows: attributed,
    unassigned,
    totals: {
      revenue: revenueTotal,
      taxAmount: money(taxAmount),
      depositAmount: money(depositAmount),
      rentals: rows.reduce((acc, r) => acc + r.rentals, 0),
      days: rows.reduce((acc, r) => acc + r.days, 0),
      typeCount: attributed.length,
    },
  };
}
