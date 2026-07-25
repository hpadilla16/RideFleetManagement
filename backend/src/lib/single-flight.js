/**
 * In-process single-flight: collapse concurrent async work that shares a key
 * onto ONE execution, and hand every caller the same result.
 *
 * B5 Phase 1 (2026-07-24): the payment verify→post→deposit sequence is keyed
 * on the payment reference. The webhook and the status poll can fire within
 * milliseconds of each other; without this, both pass the "already posted?"
 * read before either writes and the reservation gets a double payment row AND
 * a double PreAuth (two live holds on the customer's card). This is the
 * in-process arm of that defense — the DB-level partial unique index on
 * gateway references is the arm that survives multi-worker/multi-process.
 * Both are required: neither alone is sufficient.
 *
 * Deliberately NOT a distributed lock. Single-process collapse + a DB unique
 * constraint (P2002 → treat as duplicate) is the same belt-and-braces pattern
 * the idempotency middleware uses; a Redis lock would add a failure mode on
 * the money path for no additional guarantee.
 */

const inFlight = new Map();

/**
 * Run `fn` under `key`. A second call with the same key while the first is
 * still running does NOT start a second execution — it awaits the first and
 * receives its resolution (or its rejection).
 *
 * SHARED-REJECTION SEMANTICS (review R5): joined callers share the LEADER's
 * outcome, including its failure. If the leader's verify→post hits a transient
 * gateway/DB error, every caller that joined that flight rejects too — none of
 * them retries independently inside this call. That is the safe default on a
 * money path (a stampede of retries against a half-completed post is worse),
 * and it self-heals: the gateway redelivers the webhook and the kiosk keeps
 * polling, so the next attempt starts a FRESH flight against the now-current
 * DB state. Callers must therefore treat a rejection as "not yet", never as
 * "definitively failed".
 *
 * An empty key THROWS rather than silently running unprotected — an unkeyed
 * call would look guarded while providing no collapse at all.
 */
export function singleFlight(key, fn) {
  const k = String(key || '');
  if (!k) throw new Error('singleFlight requires a non-empty key');

  const running = inFlight.get(k);
  if (running) return running;

  const promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      // Only clear if we're still the owner (a later call may have re-armed).
      if (inFlight.get(k) === promise) inFlight.delete(k);
    });
  inFlight.set(k, promise);
  return promise;
}

/** Test/diagnostic helper — how many keys are currently executing. */
export function singleFlightSize() {
  return inFlight.size;
}
