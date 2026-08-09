/**
 * How short a rental is allowed to be.
 *
 * THE RULE (Hector, 2026-08-09): "nada menos de 24 horas al menos que haiga
 * hourly rate configurado." A day is the floor, and the ONLY thing that lifts
 * it is an hourly price actually configured for what is being rented.
 *
 * Two knobs already exist in the price book and both must agree:
 *   Rate.useHourlyRates   the plan is allowed to sell by the hour
 *   RateRow.hourly        the class has a per-hour price above zero
 * A plan with the flag on and no price is not sellable by the hour; neither is
 * a priced row on a plan that never turned it on. RateRow.minHourly, when set,
 * is the shortest rental that plan will take.
 *
 * WHY THIS IS A MODULE AND NOT AN `if` IN THE FORM: the old minimum lived
 * ONLY in the browser, as a `min` attribute computed as pickup + 1 day. The
 * backend never enforced it — a 6-hour rental prices fine through
 * resolveForRental and bills as one day via Math.ceil. So the rule was
 * simultaneously too strict (a desktop agent could type past the min; an
 * iPhone's date picker clamps hard, which is how an International agent ended
 * up unable to save at all) and too weak (nothing stopped an API caller).
 * One definition, used by the form to shape the picker and by the API to
 * refuse.
 */

/** A day, in hours — the floor when nothing sells by the hour. */
export const DEFAULT_MINIMUM_HOURS = 24;

/**
 * Can this plan+class actually be sold by the hour?
 * @param {{useHourlyRates?: boolean}} plan
 * @param {{hourly?: number|string, minHourly?: number}} row
 */
export function sellsByHour(plan = {}, row = {}) {
  return !!plan?.useHourlyRates && Number(row?.hourly || 0) > 0;
}

/**
 * The shortest rental allowed, in hours.
 *
 * @param {Array<{plan: object, row: object}>} offerings every plan+class pair
 *        that could price this rental (location + date filtered by the caller)
 * @returns {{minimumHours: number, hourly: boolean}}
 */
export function rentalMinimum(offerings = []) {
  const hourlyOnes = (Array.isArray(offerings) ? offerings : [])
    .filter((o) => sellsByHour(o?.plan, o?.row));

  if (!hourlyOnes.length) return { minimumHours: DEFAULT_MINIMUM_HOURS, hourly: false };

  // Several plans can cover one class. Take the most permissive, because the
  // engine will quote whichever is cheapest anyway — refusing a booking one
  // plan would happily sell is the same "too strict" failure as before.
  const mins = hourlyOnes.map((o) => {
    const declared = Number(o?.row?.minHourly || 0);
    return declared > 0 ? declared : 1;
  });
  return { minimumHours: Math.max(1, Math.min(...mins)), hourly: true };
}

/**
 * Is this pickup→return span long enough?
 * @returns {{ok: boolean, minimumHours: number, hours: number, hourly: boolean}}
 */
export function checkRentalSpan({ pickupAt, returnAt, offerings = [] }) {
  const { minimumHours, hourly } = rentalMinimum(offerings);
  const start = new Date(pickupAt);
  const end = new Date(returnAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, minimumHours, hours: 0, hourly };
  }
  const hours = (end.getTime() - start.getTime()) / 3600000;
  // Round to the minute before comparing: a picker that lands a hair under a
  // whole hour must not be refused for a rounding artifact.
  const rounded = Math.round(hours * 60) / 60;
  return { ok: rounded >= minimumHours, minimumHours, hours: rounded, hourly };
}

/** The refusal, in the words an agent can act on. */
export function rentalSpanMessage({ minimumHours, hourly }) {
  if (hourly) {
    return `This location rents by the hour, but the minimum is ${minimumHours} hour${minimumHours === 1 ? '' : 's'}.`;
  }
  return 'Rentals are a minimum of 24 hours. To rent for less, an hourly rate has to be configured for this vehicle class.';
}
