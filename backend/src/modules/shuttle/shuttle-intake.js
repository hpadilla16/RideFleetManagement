/**
 * Shuttle intake — the pure decisions (Phase 3, 2026-08-25; approved mockup
 * Screen 7). No Prisma, no IO: testable in the DB-free chain. The route
 * (public POST /:token/request) owns IO.
 *
 * THE FLAG IS THE CONTRACT: intake is enforced ONLY when the location's
 * config says { intakeJson: { enabled: true } }. Everything else — flag
 * absent, false, garbage — must behave byte-for-byte like the pre-Phase-3
 * endpoint, because VozIA, Valet and every already-printed QR link call it
 * without the new fields. A sede opts in from Settings; nobody is opted in
 * by a deploy.
 */

/** Server-side defaults — the party cap matches the historical Math.min(50)
 *  clamp in shuttle-requests.service so flag-off behavior cannot drift. */
export const PARTY_SIZE_CAP_DEFAULT = 50;
export const BAGS_CAP_DEFAULT = 20;
/** Hard bounds on the CONFIGURABLE caps themselves — a fat-fingered 5000 in
 *  Settings must not turn the public endpoint into a numbers playground. */
export const CAP_MIN = 1;
export const CAP_MAX = 200;

const intNum = (v) => {
  // null/'' coerce to 0 under Number() — absent must stay absent, not zero.
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/**
 * Read a ShuttleTrackerConfig row's intake knobs. Tolerant of the Json
 * column's shapes (same rule as configVehicleIds): anything unreadable is
 * the DEFAULTS with enabled=false — the fail-safe direction, since disabled
 * means "old behavior", never a broken endpoint.
 *
 * @returns {{ enabled: boolean, partySizeCap: number, bagsCap: number }}
 */
export function parseIntakeConfig(config) {
  const raw = config?.intakeJson;
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cap = (v, fallback) => {
    const n = intNum(v);
    return n !== null && n >= CAP_MIN && n <= CAP_MAX ? n : fallback;
  };
  return {
    // Strictly opt-in, like every shuttle flag: anything but true is false.
    enabled: obj.enabled === true,
    partySizeCap: cap(obj.partySizeCap, PARTY_SIZE_CAP_DEFAULT),
    bagsCap: cap(obj.bagsCap, BAGS_CAP_DEFAULT),
  };
}

/**
 * Validate + normalize the intake knobs a Settings PUT sends. Returns the
 * clean object to store (or null to clear), or { error } — same shape idiom
 * as validateZoneInput.
 */
export function validateIntakeInput(body) {
  if (body == null) return { ok: true, intake: null };
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'intake must be an object' };
  const enabled = body.enabled === true;
  const partySizeCap = body.partySizeCap == null ? PARTY_SIZE_CAP_DEFAULT : intNum(body.partySizeCap);
  const bagsCap = body.bagsCap == null ? BAGS_CAP_DEFAULT : intNum(body.bagsCap);
  if (partySizeCap === null || partySizeCap < CAP_MIN || partySizeCap > CAP_MAX) {
    return { ok: false, error: `intake.partySizeCap must be an integer between ${CAP_MIN} and ${CAP_MAX}` };
  }
  if (bagsCap === null || bagsCap < CAP_MIN || bagsCap > CAP_MAX) {
    return { ok: false, error: `intake.bagsCap must be an integer between ${CAP_MIN} and ${CAP_MAX}` };
  }
  return { ok: true, intake: { enabled, partySizeCap, bagsCap } };
}

/**
 * Validate one public request body against the location's intake config.
 *
 * Flag OFF — the legacy contract, unchanged: partySize passes through raw
 * (the service's historical clamp handles it), bags is accepted when it
 * happens to be a valid integer 0..bagsCap and silently dropped otherwise
 * (an old page not sending it must not break, a hand-crafted "bags": 1e9
 * must not store).
 *
 * Flag ON — Screen 7's REQUIRED step: partySize integer 1..partySizeCap and
 * bags integer 0..bagsCap, else a 400 with a human error. Nothing else about
 * the body's meaning changes — identity still comes from the token.
 *
 * @returns {{ ok: true, values: { partySize, bags } } | { ok: false, error: string }}
 */
export function validateIntake(body = {}, intakeCfg = parseIntakeConfig(null)) {
  const partyRaw = body?.partySize;
  const bagsRaw = body?.bags;

  if (!intakeCfg.enabled) {
    const bags = intNum(bagsRaw);
    return {
      ok: true,
      values: {
        partySize: partyRaw, // untouched — the service's legacy clamp decides
        bags: bags !== null && bags >= 0 && bags <= intakeCfg.bagsCap ? bags : null,
      },
    };
  }

  const partySize = intNum(partyRaw);
  if (partySize === null || partySize < 1 || partySize > intakeCfg.partySizeCap) {
    return { ok: false, error: `partySize is required (1..${intakeCfg.partySizeCap})` };
  }
  const bags = intNum(bagsRaw);
  if (bags === null || bags < 0 || bags > intakeCfg.bagsCap) {
    return { ok: false, error: `bags is required (0..${intakeCfg.bagsCap})` };
  }
  return { ok: true, values: { partySize, bags } };
}
