/**
 * M2-H8 (2026-08-17) — the wizard's 409 swallow rule.
 *
 * This one rule decides whether an agent at the counter ever SEES a failed
 * transition, so it gets a test of its own rather than living inline in a
 * 1000-line page component.
 *
 * The regression it exists to stop: H8 re-labelled a half-finished finalize as
 * 409 FINALIZE_INCOMPLETE (so RideOps gets a usable code instead of a raw
 * PRECHECKIN_REQUIRED on a visibly closed session). But the wizard does not
 * swallow 409s unconditionally — it refetches and compares step order, `at >=
 * want`. FINALIZE_INCOMPLETE is raised ONLY when the session is already AT
 * toStep, so that comparison is satisfied by construction and every one of
 * them would vanish without a toast. Before the re-label those failures were
 * 422s, which fell straight through to the toast: confusing, but visible.
 *
 * 2026-08-17 — the fix was a deny-list of one code, and it had a hole the
 * size of the defect it was written for. EVERY error the CLOSED cascade
 * raises arrives after the step has committed, so `at >= want` holds for all
 * of them; naming one code and swallowing the rest just moved the silence.
 * The winner path fell straight into it: a legitimate finalize that lost the
 * car to another rental threw a bare 409 VEHICLE_CONFLICT, which this rule
 * ate. The agent saw the finished-checkout screen over a rental that was
 * never handed over, and the customer got the contract anyway. The rule now
 * swallows an ALLOW-list, so an unforeseen 409 is loud by default.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldSwallowTransitionConflict, STEP_ORDER,
  resolveFinalizeFailureCopy, FINALIZE_FAILURE_REASONS, finalizeReasonKeys,
  isFinalizeComplete, closedCardState,
} from '@/lib/checkout-session';
import en from '../src/locales/en.json';
import es from '../src/locales/es.json';

/** Walk a dotted i18n key, returning undefined if any hop is missing. */
const lookup = (bundle, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), bundle);

const conflict = (code) => ({ status: 409, code, message: 'boom' });

describe('shouldSwallowTransitionConflict', () => {
  it('swallows the classic double-fire: session already AT the requested step', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'),
      fresh: { currentStep: 'TC_PENDING' },
      toStep: 'TC_PENDING',
    })).toBe(true);
  });

  it('swallows when the session is already PAST the requested step', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'),
      fresh: { currentStep: 'PAID' },
      toStep: 'TC_PENDING',
    })).toBe(true);
  });

  it('does NOT swallow a genuine conflict from behind the requested step', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('ENTRY_GUARD'),
      fresh: { currentStep: 'TC_PENDING' },
      toStep: 'PAID',
    })).toBe(false);
  });

  // The point of the file.
  it('NEVER swallows FINALIZE_INCOMPLETE, even though the step comparison passes', () => {
    const fresh = { currentStep: 'CLOSED' };
    const toStep = 'CLOSED';

    // The step rule on its own would hide it — same step, so at === want.
    expect(STEP_ORDER.indexOf(fresh.currentStep)).toBe(STEP_ORDER.indexOf(toStep));
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'), fresh, toStep,
    })).toBe(true);

    // ...but this code has to reach the agent: the checkout is closed while
    // the reservation is still CONFIRMED, the contract DRAFT, the car unmarked.
    expect(shouldSwallowTransitionConflict({
      err: conflict('FINALIZE_INCOMPLETE'), fresh, toStep,
    })).toBe(false);
  });

  // The winner-path hole, at the wizard. The backend now labels this
  // FINALIZE_INCOMPLETE, so in production this exact payload is gone — but the
  // rule has to be right on its own, because it is the last thing standing
  // between a failed finalize and a screen that says everything worked.
  it('NEVER swallows a bare VEHICLE_CONFLICT on a closed session', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('VEHICLE_CONFLICT'),
      fresh: { currentStep: 'CLOSED' },
      toStep: 'CLOSED',
    })).toBe(false);
  });

  // The property that makes this rule safe going forward: a 409 nobody
  // anticipated is TOASTED, not hidden. On a step that moves money, a legal
  // document and a car, an agent dismissing one confusing toast costs far less
  // than a silence nobody can see.
  it('does not swallow a 409 code it has never heard of', () => {
    for (const code of ['SOME_FUTURE_GUARD', 'STALE_VERSION', undefined]) {
      expect(shouldSwallowTransitionConflict({
        err: conflict(code),
        fresh: { currentStep: 'CLOSED' },
        toStep: 'CLOSED',
      })).toBe(false);
    }
  });

  // ...and the allow-list is not just ILLEGAL_TRANSITION. Losing the CAS race
  // three times is a real 409, but the fresh row proves the work landed, so
  // toasting it would be noise.
  it('swallows CONCURRENT_MODIFICATION once the fresh row is at the step', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('CONCURRENT_MODIFICATION'),
      fresh: { currentStep: 'CLOSED' },
      toStep: 'CLOSED',
    })).toBe(true);
    // But not from behind it — there the request genuinely did not happen.
    expect(shouldSwallowTransitionConflict({
      err: conflict('CONCURRENT_MODIFICATION'),
      fresh: { currentStep: 'PAID' },
      toStep: 'CLOSED',
    })).toBe(false);
  });

  it('leaves non-409s alone (they were always toasted)', () => {
    for (const status of [400, 404, 422, 500]) {
      expect(shouldSwallowTransitionConflict({
        err: { status, code: 'PRECHECKIN_REQUIRED' },
        fresh: { currentStep: 'CLOSED' },
        toStep: 'CLOSED',
      })).toBe(false);
    }
  });

  it('does not swallow when the fresh step is unknown/missing', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'), fresh: null, toStep: 'CLOSED',
    })).toBe(false);
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'), fresh: { currentStep: 'CANCELLED' }, toStep: 'CLOSED',
    })).toBe(false);
  });
});

/**
 * The other half of "does the agent learn the truth?".
 *
 * shouldSwallowTransitionConflict decides whether a failed finalize is SHOWN.
 * resolveFinalizeFailureCopy decides whether it is UNDERSTOOD — and it is what
 * the CLOSED card puts where "Checkout complete ✓ / Agreement built. Email
 * queued." used to sit, over a reservation that was never handed over.
 */
describe('resolveFinalizeFailureCopy', () => {
  // Exhaustive against the guards that raise inside the CLOSED cascade: the
  // vehicle pair, the pre-check-in gate, and all four age-rule statuses.
  const REASONS = [
    'VEHICLE_CONFLICT', 'NO_VEHICLE_ASSIGNED', 'PRECHECKIN_REQUIRED',
    'AGE_RULES_DOB_REQUIRED', 'AGE_RULES_DOB_IMPLAUSIBLE',
    'AGE_RULES_UNDER_MIN', 'AGE_RULES_ABOVE_MAX',
  ];

  it('translates every reason the backend can hang off FINALIZE_INCOMPLETE', () => {
    expect(Object.keys(FINALIZE_FAILURE_REASONS).sort()).toEqual([...REASONS].sort());
    for (const reason of REASONS) {
      const copy = resolveFinalizeFailureCopy({ reason, message: 'raw backend prose' });
      expect(copy.translated, reason).toBe(true);
      // The raw message survives as a detail line — it carries the specifics
      // the map cannot (which reservation holds the car, which bound broke).
      expect(copy.detail, reason).toBe('raw backend prose');
    }
  });

  it('resolves every key it emits in BOTH bundles', () => {
    // The app boots in English (lib/i18n.js), so a key that exists only in
    // es.json would render as a raw dotted path at the counter — worse than
    // the English sentence it replaced.
    const keys = [
      'checkoutClosed.genericTitle', 'checkoutClosed.genericBody',
      'checkoutClosed.failedTitle', 'checkoutClosed.voidedTitle', 'checkoutClosed.voidedBody',
      'checkoutClosed.halfTitle', 'checkoutClosed.halfBody',
      'checkoutClosed.pendingTitle', 'checkoutClosed.pendingBody',
      'checkoutClosed.unknownTitle', 'checkoutClosed.unknownBody',
      'checkoutClosed.okTitle', 'checkoutClosed.okBody', 'checkoutClosed.back',
      'checkoutClosed.retry', 'checkoutClosed.retrying', 'checkoutClosed.retryHint',
      'checkoutClosed.verify', 'checkoutClosed.goToReservation',
      'checkoutClosed.factReservationYes', 'checkoutClosed.factReservationNo',
      'checkoutClosed.factAgreementYes', 'checkoutClosed.factAgreementNo',
      'checkoutClosed.factVehicleYes', 'checkoutClosed.factVehicleNo',
      'checkoutClosed.factEmailNo',
      ...REASONS.flatMap((r) => Object.values(finalizeReasonKeys(r))),
    ];
    for (const key of keys) {
      expect(lookup(en, key), `en: ${key}`).toBeTruthy();
      expect(lookup(es, key), `es: ${key}`).toBeTruthy();
    }
  });

  it('falls back to the raw backend message for a reason it does not know', () => {
    // The whole point of the fallback: a guard added to the backend later must
    // reach the agent as-is rather than disappear into friendly copy. Same bet
    // BENIGN_CONFLICT_CODES makes about unforeseen 409s.
    const copy = resolveFinalizeFailureCopy({
      reason: 'SOME_GUARD_ADDED_NEXT_QUARTER',
      message: 'Checkout is closed but its finalize did not complete: brand new guard',
    });
    expect(copy.translated).toBe(false);
    expect(copy.bodyText).toBe('Checkout is closed but its finalize did not complete: brand new guard');
  });

  it('never names a recovery the app does not actually offer', () => {
    // Two dead recoveries have already reached this screen's copy, so the rule
    // gets a test rather than a comment:
    //
    //   "swap vehicles"  — ensureNoVehicleConflict's message ends with it, but
    //                      swapLocked includes CLOSED and swapVehicle demands
    //                      CHECKED_OUT, so the button is greyed out. The
    //                      backend message is RideOps' contract and stays as
    //                      it is; OUR copy must not repeat its dead advice.
    //   "finalize it from the reservation"
    //                    — POST /rental-agreements/:id/finalize exists, but no
    //                      frontend calls it and the reservation page has no
    //                      such control. Sending an agent to look for it, in
    //                      the one state where a car is already out on a draft
    //                      contract, is the same defect wearing new words.
    //
    // Anything added here has to be reachable from the UI the agent is on.
    for (const bundle of [en, es]) {
      const copy = JSON.stringify(bundle.checkoutClosed).toLowerCase();
      expect(copy).not.toContain('swap');
      expect(copy).not.toMatch(/final(ize|iza|ízalo|izalo)\s+(it\s+)?(from|desde)/);
    }
  });

  it('never promises a retry in the copy itself', () => {
    // Whether a retry can work depends on the reservation's status, which the
    // copy cannot see. The card appends that sentence only when it is really
    // offering the button, so no reason body may carry one of its own.
    for (const bundle of [en, es]) {
      for (const r of Object.values(bundle.checkoutClosed.reasons)) {
        expect(`${r.title} ${r.body}`.toLowerCase()).not.toMatch(/retry|reintent/);
      }
    }
  });

  it('flags the two age bounds as terminal, so the card can drop a retry that cannot work', () => {
    // A retry re-runs the finalize cascade, which is right for a car that got
    // taken or a gate that can still be filled in. An age bound is not that.
    expect(resolveFinalizeFailureCopy({ reason: 'AGE_RULES_UNDER_MIN' }).terminal).toBe(true);
    expect(resolveFinalizeFailureCopy({ reason: 'AGE_RULES_ABOVE_MAX' }).terminal).toBe(true);
    // Everything else IS retryable, including the unknown-reason fallback —
    // defaulting an unrecognised guard to "give up" would strand the agent.
    expect(resolveFinalizeFailureCopy({ reason: 'VEHICLE_CONFLICT' }).terminal).toBe(false);
    expect(resolveFinalizeFailureCopy({ reason: 'WAT', message: 'x' }).terminal).toBe(false);
    expect(resolveFinalizeFailureCopy({}).terminal).toBe(false);
  });

  it('says only that the close did not finish when the reason is gone (the F5 case)', () => {
    // After a refresh there is no error object left. Server truth still says
    // the finalize failed, so the card says that much and no more — guessing a
    // reason here would re-introduce the confident-but-wrong screen.
    const copy = resolveFinalizeFailureCopy({});
    expect(copy.translated).toBe(false);
    expect(copy.titleKey).toBe('checkoutClosed.genericTitle');
    expect(copy.bodyText).toBeNull();
    expect(copy.detail).toBeNull();
  });
});

/**
 * The verdict, and what the card is allowed to offer once it has one.
 *
 * These two rules are the reason the CLOSED screen can stop lying, so they get
 * tests rather than living inline in the page component — the same call
 * shouldSwallowTransitionConflict's own comment makes.
 */
const resv = (status, agreement, vehicle) => ({
  status,
  rentalAgreement: agreement === undefined ? null : { status: agreement },
  vehicle: { status: vehicle || 'AVAILABLE' },
});

describe('isFinalizeComplete', () => {
  it('needs the contract too, not just the reservation', () => {
    // The write that finalizes the contract is best-effort and does not abort
    // the cascade, so this tuple is live: reservation CHECKED_OUT, contract
    // still DRAFT, email withheld, and transition() answering 200 with no
    // error. Reading only the reservation calls it a success and prints
    // "contract finalized" over a draft — this ticket's own defect.
    expect(isFinalizeComplete(resv('CHECKED_OUT', 'DRAFT', 'ON_RENT'))).toBe(false);
    expect(isFinalizeComplete(resv('CHECKED_OUT', 'FINALIZED', 'ON_RENT'))).toBe(true);
  });

  it('is false while the reservation has not moved', () => {
    expect(isFinalizeComplete(resv('CONFIRMED', 'DRAFT'))).toBe(false);
    expect(isFinalizeComplete(resv('CANCELLED', 'DRAFT'))).toBe(false);
  });

  it('ignores vehicle status, which can legitimately lag a GOOD finalize', () => {
    // syncVehicleStatusForReservation SKIPS rather than fails for a locked
    // status like IN_MAINTENANCE, so a third clause here would invent
    // failures on healthy checkouts.
    expect(isFinalizeComplete(resv('CHECKED_OUT', 'FINALIZED', 'IN_MAINTENANCE'))).toBe(true);
  });

  it('does not throw on a half-loaded reservation', () => {
    expect(isFinalizeComplete(null)).toBe(false);
    expect(isFinalizeComplete({})).toBe(false);
  });
});

describe('closedCardState', () => {
  it('offers a retry only where the backend will actually re-run the finalize', () => {
    // Mirrors selfHealOwns in checkout-session.service.js. Outside the
    // allow-list the backend declines with a server-side log and a plain 200,
    // so the button would change nothing while the copy promised an answer.
    for (const status of ['NEW', 'CONFIRMED']) {
      expect(closedCardState({ reservation: resv(status, 'DRAFT') }).showRetry, status).toBe(true);
    }
    for (const status of ['CANCELLED', 'NO_SHOW', 'PENDING_FRANCHISE_IMPORT', 'CHECKED_OUT']) {
      expect(closedCardState({ reservation: resv(status, 'DRAFT') }).showRetry, status).toBe(false);
    }
  });

  it('withholds the retry for a reason no retry can clear', () => {
    const state = closedCardState({ reservation: resv('CONFIRMED', 'DRAFT'), terminalReason: true });
    expect(state.retryCanWork).toBe(true);
    expect(state.showRetry).toBe(false);
  });

  it('flags the voided statuses so the card can say the close is over', () => {
    expect(closedCardState({ reservation: resv('CANCELLED', 'DRAFT') }).voided).toBe(true);
    expect(closedCardState({ reservation: resv('NO_SHOW', 'DRAFT') }).voided).toBe(true);
    expect(closedCardState({ reservation: resv('CONFIRMED', 'DRAFT') }).voided).toBe(false);
  });

  it('calls the half-finalize only when a contract really exists to be stuck', () => {
    // The cascade wraps its agreement work in `if (updated.agreementId)`, so a
    // session with no agreement can reach CHECKED_OUT with none — and the
    // half-finalize copy describes a draft that was never created.
    expect(closedCardState({ reservation: resv('CHECKED_OUT', 'DRAFT') }).halfFinalized).toBe(true);
    expect(closedCardState({ reservation: resv('CHECKED_OUT', undefined) }).halfFinalized).toBe(false);
    expect(closedCardState({ reservation: resv('CHECKED_OUT', 'FINALIZED') }).halfFinalized).toBe(false);
    expect(closedCardState({ reservation: resv('CONFIRMED', 'DRAFT') }).halfFinalized).toBe(false);
  });
});

/**
 * The CALL SITE, pinned (2026-08-28).
 *
 * Everything above tests a pure function. Nothing above proves the wizard
 * actually CALLS it — and that gap is not theoretical. Merging main into this
 * branch conflicts in page.js, and main still carries the pre-H8 inline
 * `STEP_ORDER` / `at >= want` version of `advance()`. Resolving that hunk the
 * natural way — "take the side of the file main kept editing" — silently
 * restores the unconditional swallow, leaves `shouldSwallowTransitionConflict`
 * exported-but-unused, and every test above KEEPS PASSING. The exemption would
 * be gone from the only surface an agent ever looks at, with nothing red.
 *
 * So the wiring gets pinned by source, the same way checkout-payment-optional
 * pins its own wizard branch. Mounting the 2k-line page would need auth, a
 * router, the api client and QR codes to assert one `if`; this is the smallest
 * thing that goes red on the bad resolution.
 */
describe('the wizard actually delegates the swallow decision', () => {
  const WIZARD = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'app', 'reservations', '[id]', 'checkout-wizard-v2', 'page.js',
  );
  // TWO corpora, and an assertion's DIRECTION decides which one it gets, so
  // that neither can manufacture a false green (2026-09-01).
  //
  // A source-level pin reads prose as readily as code. QA proved the cost on
  // this very block: it applied the reversion the way a merge normally would —
  // new call site in, old line parked above it as
  // `// was: setClosedCheck(isFinalizeComplete(r) ? ...)` — and the positive
  // assertion below matched the COMMENT. Thirty green tests over this ticket's
  // original defect.
  //
  //   code() — comments stripped. Every POSITIVE match runs on it. Stripping
  //            only ever REMOVES text, and removing text can only make a
  //            `toMatch` fail, so an over-eager strip costs a false RED and
  //            never a false green. Prose is not evidence that the screen
  //            calls anything.
  //   src()  — the raw file, comments included. Every NEGATIVE match runs on
  //            it. Extra text can only make a `not.toMatch` fail, so the same
  //            argument runs the other way: a banned pattern is caught even
  //            where someone parked it in a comment.
  //
  // Same shape and same reasoning as ciWorkflowRunLines() in
  // backend/src/lib/npm-test-chain.test.mjs — a guard that reads comments is a
  // guard a comment can satisfy. That one strips whole lines only, because a
  // `#` inside a YAML `run:` body is shell and cutting there would truncate a
  // real command. Here the aggressive form is the safe one: page.js contains no
  // `://` at all, and even if it grew one, truncating a line only takes text
  // away from the corpus the positives run on.
  const src = () => readFileSync(WIZARD, 'utf8');
  const code = () => src()
    .replace(/\/\*[\s\S]*?\*\//g, (m) => (m.match(/\n/g) || []).join(''))
    .replace(/\/\/[^\n]*/g, '');
  // advance() is the only place a transition 409 is handled. Bounded on code()
  // because the ordering assertion below compares POSITIONS: a comment naming
  // setToast ahead of the real call would decide that test on prose too.
  const advanceBody = () => {
    const s = code();
    const start = s.indexOf('const advance = async (toStep, metadata)');
    expect(start, 'advance() not found in the wizard').toBeGreaterThan(-1);
    const end = s.indexOf('const pauseAndExit', start);
    expect(end, 'could not bound advance()').toBeGreaterThan(start);
    return s.slice(start, end);
  };

  it('imports shouldSwallowTransitionConflict from the lib', () => {
    expect(code()).toMatch(/import\s*\{[^}]*\bshouldSwallowTransitionConflict\b[^}]*\}\s*from\s*'[^']*lib\/checkout-session'/s);
  });

  it('asks the library, passing the error so FINALIZE_INCOMPLETE can be seen', () => {
    // `err` must be in the payload: the exemption keys off err.code, so a call
    // that only forwarded { fresh, toStep } would swallow it again.
    expect(advanceBody()).toMatch(
      /shouldSwallowTransitionConflict\(\{\s*err,\s*fresh,\s*toStep\s*\}\)/,
    );
  });

  it('keeps NO inline step-order comparison of its own', () => {
    const s = src();
    // The pre-H8 gate, in any of the shapes it has worn.
    expect(s).not.toMatch(/const STEP_ORDER\s*=\s*\[/);
    expect(s).not.toMatch(/at\s*>=\s*want/);
    expect(s).not.toMatch(/STEP_ORDER\.indexOf/);
  });

  // The same hole, for the two rules THIS branch extracted (2026-09-01, merge
  // of main). A reversion sweep over the merged tree found that swapping
  // `isFinalizeComplete(r)` back for an inline `r.status === 'CHECKED_OUT'`
  // -- this ticket's original defect, exactly -- left all 28 tests green: the
  // pure-function suites above prove the rule is RIGHT, never that the screen
  // ASKS it. The merge conflicted in the very import statement that binds
  // them, which is the same accident the block above was written for.

  it('asks the library for the CLOSED verdict instead of reading status inline', () => {
    // POSITIVE on code(): the call has to be in the SOURCE, not in a note
    // about the source. This is the assertion QA satisfied with a comment.
    expect(code()).toMatch(/setClosedCheck\(\s*isFinalizeComplete\(/);
    // NEGATIVE on src(): the two-clause verdict must not be re-inlined next to
    // the setter, and a commented-out copy is still a copy someone restores.
    //
    // The two word boundaries here are load-bearing, and they shipped once as
    // two literal 0x08 bytes: the assertion parsed, ran, and could not match
    // anything ever. Edit this line with an editor. A heredoc or `python -c`
    // turns that escape into a BACKSPACE.
    expect(src()).not.toMatch(/setClosedCheck\([^;]*\bstatus\b[^;]*===[^;]*'CHECKED_OUT'/);
  });

  it('asks the library what the CLOSED card may offer', () => {
    // POSITIVE on code(), NEGATIVE on src() — see the note on the corpora.
    expect(code()).toMatch(/closedCardState\(\{\s*reservation,\s*terminalReason:/);
    // The retry allow-list mirrors the backend's self-heal list and lives in
    // ONE place; a copy of it in the component is how the two drift apart,
    // and a commented-out copy is still a copy someone can restore.
    expect(src()).not.toMatch(/const\s+retryCanWork\s*=/);
    expect(src()).not.toMatch(/const\s+halfFinalized\s*=/);
  });

  it('reconciles the screen to server truth before toasting the error', () => {
    // On FINALIZE_INCOMPLETE the session really IS closed. The agent has to see
    // the closed session AND the reason the finalize did not finish.
    const body = advanceBody();
    const reconcile = body.search(/if\s*\(freshSession\)\s*setSession\(freshSession\)/);
    const toast = body.search(/setToast\(\{\s*kind:\s*'error'/);
    expect(reconcile, 'the reconcile-before-toast line is gone').toBeGreaterThan(-1);
    expect(toast, 'the error toast is gone').toBeGreaterThan(-1);
    expect(reconcile).toBeLessThan(toast);
  });
});
