/**
 * terminal-state.js — the agent-facing vocabulary for "what is the QD2 doing,
 * and what do I do about it".
 *
 * Design decision D4 (design/mockups/us-terminal-checkout-NOTES.md §2): a web
 * form fails one way — the request errored. A terminal fails eleven ways, and
 * the agent's correct action differs in each. Today the wizard renders
 * `err?.message || 'Sale failed'` — a raw gateway string, in a queue, to
 * someone who has thirty seconds. This module is what turns that into an
 * instruction.
 *
 * PURE. No prisma, no spin client, no I/O. It takes what the SPIn client
 * already throws and answers with a state + a verdict. That is what lets it be
 * tested without a terminal and reused by the sale path later.
 *
 * ── THE FIVE VERDICTS ───────────────────────────────────────────────────────
 *   WAIT      — the terminal is working; do nothing but watch (and count down).
 *   RETRY     — safe to send the same thing again.
 *   FALL_BACK — the terminal is not going to finish this checkout; move the
 *               contract AND the payment to the web flow, together.
 *   STOP      — no software action helps. A human decides.
 *   CONTINUE  — it worked.
 *
 * ── THE RULE THE MATRIX ENCODES ─────────────────────────────────────────────
 * A failure whose money condition is KNOWN gets a button. A failure whose money
 * condition is UNKNOWN gets a status query first and no button at all. Every
 * operation in THIS module carries no money (UserChoice, GetSignature), so
 * every verdict here is safe to act on immediately — which is precisely why the
 * contract is the right first slice. The rule is stated anyway, because this
 * module is where the sale path should classify from when phase 2 lands, and
 * the sale timeout cell is the one that double-charges a renter.
 *
 * ── ERROR CODES, FROM THE LIVE PROBE (2026-09-04, LAX, TPN 8160****4206) ────
 *   2201 — the gateway rejected the payload or the credentials. The terminal
 *          NEVER SAW IT: nothing on screen, nothing in the Dejavoo portal.
 *          Re-sending an identical payload cannot help. This is the
 *          2026-05-30 lesson recorded in spin-client.js.
 *   2001 — the terminal is not connected to the proxy. Power, Wi-Fi, or the
 *          device is asleep.
 *   2008 — "Terminal in use, please wait 30 sec", and the BODY CARRIES
 *          `DelayBeforeNextRequest`. That is a real number the gateway is
 *          telling us; the countdown the agent sees is that number, not a
 *          guess and not a fixed 30.
 */

/** The five verdicts. Exactly one per state. */
export const VERDICTS = Object.freeze({
  WAIT: 'WAIT',
  RETRY: 'RETRY',
  FALL_BACK: 'FALL_BACK',
  STOP: 'STOP',
  CONTINUE: 'CONTINUE',
});

/**
 * The state vocabulary. Names match us-terminal-states.html §1 so the built
 * screen and the approved mockup use one word for one thing.
 */
export const TERMINAL_STATES = Object.freeze({
  IDLE: 'IDLE',
  PROMPTING: 'PROMPTING',
  CUSTOMER_READING: 'CUSTOMER_READING',
  CAPTURING_SIGNATURE: 'CAPTURING_SIGNATURE',
  SIGNED: 'SIGNED',
  DECLINED_BY_RENTER: 'DECLINED_BY_RENTER',
  TIMED_OUT: 'TIMED_OUT',
  BUSY: 'BUSY',
  TERMINAL_OFFLINE: 'TERMINAL_OFFLINE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  GATEWAY_REJECTED: 'GATEWAY_REJECTED',
});

/** state → verdict. The whole table, in one place, so it cannot drift. */
export const STATE_VERDICT = Object.freeze({
  [TERMINAL_STATES.IDLE]: VERDICTS.CONTINUE,
  [TERMINAL_STATES.PROMPTING]: VERDICTS.WAIT,
  [TERMINAL_STATES.CUSTOMER_READING]: VERDICTS.WAIT,
  [TERMINAL_STATES.CAPTURING_SIGNATURE]: VERDICTS.WAIT,
  [TERMINAL_STATES.SIGNED]: VERDICTS.CONTINUE,
  [TERMINAL_STATES.DECLINED_BY_RENTER]: VERDICTS.STOP,
  [TERMINAL_STATES.TIMED_OUT]: VERDICTS.RETRY,
  [TERMINAL_STATES.BUSY]: VERDICTS.WAIT,
  [TERMINAL_STATES.TERMINAL_OFFLINE]: VERDICTS.FALL_BACK,
  [TERMINAL_STATES.NOT_CONFIGURED]: VERDICTS.STOP,
  [TERMINAL_STATES.GATEWAY_REJECTED]: VERDICTS.FALL_BACK,
});

export function verdictFor(state) {
  return STATE_VERDICT[state] || VERDICTS.STOP;
}

/** SPIn status codes this module reasons about by number. */
export const SPIN_STATUS = Object.freeze({
  OK: '0000',
  TERMINAL_NOT_CONNECTED: '2001',
  TERMINAL_BUSY: '2008',
  GATEWAY_REJECTED: '2201',
  // 1000 arrives as Message "Canceled" with DetailedMessage "Service Busy".
  // Proven live at LAX 2026-09-04: a Void sent 19 s after an approved Sale got
  // this while the terminal was still closing out the sale. It is a BUSY, not
  // a refusal — the request was well formed and the gateway echoed the amounts
  // and the RRN back. Treating it as terminal is how a rollback gives up on a
  // charge it was supposed to reverse.
  SERVICE_BUSY: '1000',
});

/**
 * Is this failure worth waiting out and retrying?
 *
 * ONLY these two. A 2201 means the gateway refused the payload — retrying an
 * identical payload cannot help, and retrying a MONEY call on a guess is how
 * a customer gets charged twice. Anything not named here is not retried.
 */
export function isBusyFailure(err) {
  const code = statusCodeOf(err);
  if (code === SPIN_STATUS.TERMINAL_BUSY || code === SPIN_STATUS.SERVICE_BUSY) return true;
  // 1000 is also used for genuine cancellations; only the busy detail qualifies.
  const detail = String(err?.spinResponse?.GeneralResponse?.DetailedMessage || '').toLowerCase();
  return code === SPIN_STATUS.SERVICE_BUSY && detail.includes('busy');
}

/** Default seconds to wait on a 2008 that arrives with no delay in the body. */
export const DEFAULT_BUSY_DELAY_SECONDS = 30;

function statusCodeOf(err) {
  const direct = err?.spinStatusCode;
  if (direct !== undefined && direct !== null && direct !== '') return String(direct);
  const fromBody = err?.spinResponse?.GeneralResponse?.StatusCode;
  if (fromBody !== undefined && fromBody !== null && fromBody !== '') return String(fromBody);
  return '';
}

/**
 * Pull the gateway's own countdown off a busy response.
 *
 * The field is what the gateway ANSWERED, so we honour it rather than hardcode
 * 30: a terminal mid-signature legitimately needs longer than one mid-menu, and
 * an agent told "wait 30" who then gets a second 2008 stops believing the
 * screen. Read from several shapes because the proxy has been seen to place it
 * at the top level and inside GeneralResponse. A value we cannot read falls
 * back to the documented 30 rather than to zero — zero would mean "retry now",
 * which is the one answer we know is wrong.
 *
 * Exported for the tests that pin the countdown.
 */
export function busyDelaySeconds(payload) {
  const candidates = [
    payload?.DelayBeforeNextRequest,
    payload?.delayBeforeNextRequest,
    payload?.GeneralResponse?.DelayBeforeNextRequest,
    payload?.spinResponse?.DelayBeforeNextRequest,
    payload?.spinResponse?.GeneralResponse?.DelayBeforeNextRequest,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    // A negative or absurd value is a malformed answer, not an instruction.
    if (Number.isFinite(n) && n > 0 && n <= 600) return Math.ceil(n);
  }
  return DEFAULT_BUSY_DELAY_SECONDS;
}

/**
 * Classify a thrown SPIn error (or a CheckoutSessionError carrying
 * TERMINAL_NOT_CONFIGURED) into { state, verdict, retryAfterSeconds, code }.
 *
 * Unknown failures classify as TERMINAL_OFFLINE → FALL_BACK, deliberately. The
 * alternative default is RETRY, and re-sending into a terminal whose condition
 * we cannot name is how an agent burns four minutes at a counter with a queue.
 * FALL_BACK always has an answer: the renter's own phone.
 */
export function classifyTerminalError(err) {
  const base = { code: '', retryAfterSeconds: null, message: String(err?.message || '') };

  // Raised BEFORE any provider call, by the terminal-config resolver.
  if (err?.code === 'TERMINAL_NOT_CONFIGURED') {
    return { ...base, state: TERMINAL_STATES.NOT_CONFIGURED, verdict: VERDICTS.STOP, code: '409' };
  }

  // The client's own AbortController fired (130 s). Nothing was signed.
  if (err?.spinTimeout) {
    return { ...base, state: TERMINAL_STATES.TIMED_OUT, verdict: VERDICTS.RETRY };
  }

  const code = statusCodeOf(err);
  if (code === SPIN_STATUS.TERMINAL_BUSY) {
    return {
      ...base,
      state: TERMINAL_STATES.BUSY,
      verdict: VERDICTS.WAIT,
      code,
      retryAfterSeconds: busyDelaySeconds(err?.spinResponse ?? err),
    };
  }
  if (code === SPIN_STATUS.TERMINAL_NOT_CONNECTED) {
    return { ...base, state: TERMINAL_STATES.TERMINAL_OFFLINE, verdict: VERDICTS.FALL_BACK, code };
  }
  if (code === SPIN_STATUS.GATEWAY_REJECTED) {
    // Never RETRY. The gateway refused the payload before the terminal saw it;
    // an identical resend gets an identical refusal, and the renter is standing
    // there while the agent finds that out three times.
    return { ...base, state: TERMINAL_STATES.GATEWAY_REJECTED, verdict: VERDICTS.FALL_BACK, code };
  }

  return { ...base, state: TERMINAL_STATES.TERMINAL_OFFLINE, verdict: VERDICTS.FALL_BACK, code };
}

/**
 * Did this response actually succeed?
 *
 * Match on ResultCode / StatusCode, NEVER on the message text. Confirmed live
 * 2026-09-04: UserChoice answers "Success" while Disclaimer and GetSignature
 * answer "OK" on the very same terminal, so any code that keys off the message
 * would treat one of the three as a failure.
 */
export function isSpinOk(response) {
  const gr = response?.GeneralResponse || {};
  if (String(gr.StatusCode || '') === SPIN_STATUS.OK) return true;
  const rc = gr.ResultCode;
  return rc === 0 || String(rc ?? '') === '0';
}
