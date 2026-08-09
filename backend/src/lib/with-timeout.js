/**
 * Race a promise against a hard deadline.
 *
 * THE RULE THIS ENCODES (2026-08-08 incident): no network call on a request
 * path may be unbounded. A try/catch does NOT cover this — a catch fires on
 * rejection, and the failure mode that took production down was a promise that
 * never settled at all. DigitalOcean maintenance on the managed Redis left the
 * singleton ioredis client reconnecting in a loop; `incr` HUNG instead of
 * rejecting, every non-SUPER_ADMIN request stalled in the rate limiter, and
 * nginx cut them at 60s. The database was completely idle the whole time — the
 * requests never reached it.
 *
 * A timeout is only half the fix. The caller must also decide what a timeout
 * MEANS, and for infrastructure that merely accelerates work (rate limiting,
 * throttles, job enqueues) the answer is always fail OPEN: let the request
 * through. A rate-limit hiccup must never be the reason a customer cannot
 * return a car.
 *
 * Lives here because it had already been written twice, in
 * tenant-rate-limit.js and verify-probe-throttle.js, and the next copy would
 * have drifted.
 *
 * @param {Promise} promise the operation to bound
 * @param {number} ms deadline in milliseconds
 * @param {string} [label] included in the error, so logs name the caller
 * @returns {Promise} settles with the promise, or rejects at the deadline
 */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export default withTimeout;
