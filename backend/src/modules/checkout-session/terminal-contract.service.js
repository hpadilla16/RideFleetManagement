/**
 * terminal-contract.service.js — signing the rental agreement on a Dejavoo QD2.
 *
 * Step 2 of the US checkout. Six clauses, one at a time, then one signature.
 *
 * ── WHY THIS LIVES IN checkout-session AND NOT IN payment-gateway ───────────
 * It reads CheckoutSession, writes RentalAgreement + AgreementSectionInitial,
 * and must stamp `tcCompletedAt` with the SAME transaction shape as
 * terms-signing.service.js — otherwise the two signing paths drift, which is
 * the one failure this design cannot tolerate. All of that is checkout-session's
 * domain. The dependency direction in this codebase is checkout-session →
 * payment-gateway and never the reverse; putting the orchestrator in
 * payment-gateway would invert it and drag prisma, the state machine and the
 * terms content into the gateway layer.
 *
 * What DOES belong to the gateway lives there: `spinClient.userChoice` /
 * `.getSignature` (the wire), and `terminal-state.js` (the state vocabulary and
 * error classification, pure and terminal-shaped). This file is the sequencer.
 *
 * ── THE SHAPE HECTOR CHOSE (2026-09-04) ─────────────────────────────────────
 * Per clause: `/v2/Common/UserChoice` carrying the clause text with
 * "I agree / Acepto" vs "Decline / No acepto", recording WHICH option and WHEN,
 * per sectionKey. Then ONE `/v2/Common/GetSignature` for the contract.
 *
 * That shape is forced by what the terminal actually does, probed live on
 * 2026-09-04 against LAX / TPN 8160****4206:
 *   • `/v2/Common/Disclaimer` DISPLAYS ONLY. It returns 0000 immediately and
 *     the renter cannot initial or sign on it — at 61, 227 and 245 characters
 *     alike. The docs claim otherwise; the firmware disagrees. So it cannot
 *     carry a clause the renter has to ACCEPT.
 *   • `/v2/Common/GetSignature` captures ink but carries NO TEXT. Whatever was
 *     on screen is gone while the renter signs, so it cannot be the acceptance
 *     of a specific clause on its own.
 *   • `/v2/Common/UserChoice` shows text AND buttons together, and returns
 *     `SelectedOption` as the exact string we sent. That is the only op on the
 *     device where the renter agrees WHILE READING the clause rather than from
 *     memory in front of a blank box.
 *
 * ── ONE INK CAPTURE, SIX ACCEPTANCES ────────────────────────────────────────
 * The agreement shows, for each clause, its acceptance stamp AND the signature
 * — an initialled contract produced from one ink capture bound to all six
 * sections plus six individually timestamped acceptances. Six SEPARATE ink
 * captures (13 terminal calls instead of 7) is the alternative Hector was
 * offered; the persistence is built so that is a later SWITCH, not a rewrite —
 * see AgreementClauseAcceptance.inkDataUrl in schema.prisma and
 * `inkForSection()` below, which is the single branch that would change.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * This touches no money. It must still never leave a HALF-SIGNED AGREEMENT
 * THAT LOOKS COMPLETE. Two rules enforce that:
 *   1. Acceptance rows land per clause, as they happen, in their own table.
 *      They are progress, and progress is not a signature.
 *   2. AgreementSectionInitial rows and `tcCompletedAt` are written in ONE
 *      transaction, only after the ink is in hand, only when EVERY expected
 *      clause is accepted. There is no intermediate state in which the
 *      agreement's own tables say "signed" and it is not.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { CheckoutSessionError } from './checkout-session.errors.js';
import { sectionsForAgreement, TC_SECTIONS, DECLINED_INSURANCE_SECTION } from './terms-content.js';
import { appendEvent } from './state-machine.js';
import { analyzeSignatureInk } from '../../lib/signature-ink.js';
import { resolveContractMode, CONTRACT_MODES } from './checkout-contract-mode.js';
import { spinClient } from '../payment-gateway/spin-client.js';
import {
  resolveTenantTerminalConfig,
  toSpinClientConfig,
  isSpinDryRun,
  maskTpn,
} from '../payment-gateway/tenant-terminal-config.js';
import {
  TERMINAL_STATES,
  VERDICTS,
  classifyTerminalError,
  isSpinOk,
} from '../payment-gateway/terminal-state.js';

/**
 * THE option strings, in ONE place.
 *
 * The terminal echoes `SelectedOption` back VERBATIM (confirmed live
 * 2026-09-04). Every comparison and every persisted value flows from these two
 * constants, so an audit trail and a live prompt can never disagree about what
 * the button said — and changing the wording changes it on the device, in the
 * comparison, and in the record, in one edit.
 *
 * Bilingual in one string because the QD2 shows ONE label per button and LAX
 * serves both languages at the same counter. There is no per-renter language
 * signal at this point in the flow (Customer.locale is never written by
 * anything in backend/src — see terms-signing.service.js), so a language guess
 * here would be a guess printed on a legal record.
 */
export const CONTRACT_CHOICE = Object.freeze({
  ACCEPT: 'I agree / Acepto',
  DECLINE: 'Decline / No acepto',
});

/** The array sent as `ChoiceOptions`, in the order the renter sees them. */
export const CONTRACT_CHOICE_OPTIONS = Object.freeze([
  CONTRACT_CHOICE.ACCEPT,
  CONTRACT_CHOICE.DECLINE,
]);

/**
 * `Title` is documented as capped at 250 characters on UserChoice.
 *
 * Our longest canonical clause body is 245, and the 245-character
 * `insurance_coverage` clause is what was proven live. That is a 5-character
 * margin, which is why `assertClausesFitTerminal` exists and why the clause
 * body is sent ALONE — no "4 / 6" prefix, no label. Progress and the clause
 * name live on the AGENT's ladder, where there is room for them; spending five
 * of the remaining characters on a prefix would push a per-tenant override over
 * the cap for the sake of information the renter can get by looking up.
 */
export const USER_CHOICE_TITLE_MAX = 250;

/**
 * Refuse to start rather than truncate.
 *
 * Two ways a clause ends up over the cap, and the agent needs a different
 * sentence for each:
 *
 *   • A per-tenant OVERRIDE (Location.termsSectionsJson). LAX already replaces
 *     `deposit_post_charges` with California wording, and nothing validates the
 *     length of what an operator pastes in there. Fixable by editing the
 *     override, so the message says so.
 *   • The CANONICAL text. `declined_insurance` is 274 characters and does NOT
 *     fit — measured, not assumed. That clause only appears when the renter
 *     declined counter insurance, so a declined-insurance checkout cannot be
 *     signed on the terminal today. Nobody at the counter can fix that by
 *     editing a setting, so the message sends them to the phone instead of
 *     asking them to shorten a legal text they do not own.
 *
 * Either way it is a refusal, never a truncation: silently cutting a clause
 * changes what was agreed, and the renter would be pressing "I agree" on a
 * sentence that stops mid-word.
 */
export function assertClausesFitTerminal(sections, { canonicalKeys = null } = {}) {
  const tooLong = (sections || [])
    .map((s) => ({ key: s.key, label: s.label, length: String(s.body || '').trim().length }))
    .filter((s) => s.length > USER_CHOICE_TITLE_MAX);
  if (!tooLong.length) return;
  const detail = tooLong.map((s) => `${s.key} (${s.length} chars)`).join(', ');
  const allCanonical = canonicalKeys
    ? tooLong.every((s) => canonicalKeys.has(s.key))
    : false;
  throw new CheckoutSessionError(
    allCanonical
      ? `The standard acknowledgement text for ${detail} is longer than the ${USER_CHOICE_TITLE_MAX} characters the terminal can display, `
        + 'so this contract has to be signed on the renter\'s phone. Use the fallback.'
      : `This location's acknowledgement text is too long for the terminal (max ${USER_CHOICE_TITLE_MAX} characters): ${detail}. `
        + 'Shorten it in the location\'s terms overrides, or sign this contract on the renter\'s phone.',
    409, 'CLAUSE_TOO_LONG_FOR_TERMINAL',
  );
}

/**
 * Which of these clause bodies are still the canonical text (i.e. no branch
 * override replaced them)? Used only to pick the right sentence above.
 */
function canonicalKeySet(sections) {
  const canonical = new Map(
    [...TC_SECTIONS, DECLINED_INSURANCE_SECTION].map((s) => [s.key, s.body.trim()]),
  );
  const out = new Set();
  for (const s of sections || []) {
    if (canonical.get(s.key) === String(s.body || '').trim()) out.add(s.key);
  }
  return out;
}

/** The exact text sent to the terminal for one clause. Trimmed, never cut. */
export function clauseTitle(section) {
  return String(section?.body || '').trim();
}

/**
 * Was this the accept option?
 *
 * EXACT string match against what we sent, and nothing else. An unrecognized or
 * absent `SelectedOption` is NOT acceptance — a clause acceptance is a legal
 * record and it needs the affirmative value, never the mere absence of an
 * error. A call that succeeds but answers with something we did not offer means
 * we do not know what the renter pressed, and "we do not know" is not "yes".
 */
export function isAcceptChoice(selectedOption) {
  return selectedOption === CONTRACT_CHOICE.ACCEPT;
}

/** Steps from which the terminal contract may be driven. */
const CONTRACT_STEPS = ['TC_PENDING'];

async function loadContext(sessionId, { requireStep = true } = {}) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);
  const session = await prisma.checkoutSession.findUnique({
    where: { id: sessionId },
    include: {
      reservation: {
        select: { id: true, reservationNumber: true, tenantId: true, pickupLocationId: true },
      },
      agreement: {
        select: {
          id: true,
          agreementNumber: true,
          declinedInsurance: true,
          tcSignedAt: true,
          // The BRANCH's clause overrides, read off the AGREEMENT — the same
          // choice terms-signing.service.js documents at length. The agreement
          // is the document of record and reservationsService.update can move
          // Reservation.pickupLocationId afterwards with no sync back, so
          // reading the reservation here would let one signed document show two
          // branches' wording.
          pickupLocation: { select: { id: true, termsSectionsJson: true } },
        },
      },
    },
  });
  if (!session) throw new CheckoutSessionError('Session not found', 404);
  if (!session.agreement) {
    throw new CheckoutSessionError('No agreement linked to this session', 409);
  }
  if (requireStep && !CONTRACT_STEPS.includes(session.currentStep)) {
    throw new CheckoutSessionError(
      `Cannot sign from currentStep=${session.currentStep} (need one of: ${CONTRACT_STEPS.join(', ')})`,
      409, 'WRONG_STEP',
    );
  }
  return session;
}

function sectionsFor(session) {
  const ag = session.agreement;
  return sectionsForAgreement({
    declinedInsurance: !!ag.declinedInsurance,
    sectionOverrides: ag.pickupLocation?.termsSectionsJson,
  });
}

/**
 * Resolve which terminal this counter's contract runs on.
 *
 * Same resolver, same pickup location and the same fail-closed refusal as the
 * charge path (spin-charge.service.loadTenantSpinConfig). It carries no money,
 * but pointing a contract prompt at another branch's device puts a renter's
 * clauses on a screen nobody is standing in front of — and it means the
 * fallback to phone never gets offered, because from here it would look like
 * the renter is simply slow to answer.
 */
async function loadTerminal(session) {
  const tenantId = session.reservation?.tenantId || null;
  const locationId = session.reservation?.pickupLocationId || null;
  // The agent's pick for a multi-terminal counter (LAX Counter 1 / Counter 2).
  // Null resolves by location exactly as before; a stale pick is refused by
  // the resolver (REGISTER_LOCATION_MISMATCH), never silently substituted.
  const registerId = session.terminalRegisterId || null;
  const resolved = await resolveTenantTerminalConfig(tenantId, { locationId, registerId });
  if (resolved.source === 'NONE' && !isSpinDryRun()) {
    logger.error('[terminal-contract] refusing to prompt — no terminal resolved for this counter', {
      sessionId: session.id, tenantId, locationId, registerId, reason: resolved.reason,
    });
    throw new CheckoutSessionError(
      resolved.reason === 'REGISTER_LOCATION_MISMATCH' || resolved.reason === 'NO_REGISTER_FOR_ID'
        ? 'The terminal picked for this checkout is no longer available at this pickup location. Pick a terminal again.'
        : 'No payment terminal is configured for this pickup location, so the contract cannot be signed on a terminal. '
          + 'Configure it in Settings → Payment Gateway, or switch this checkout to the renter\'s phone.',
      409, 'TERMINAL_NOT_CONFIGURED',
    );
  }
  return {
    tenantConfig: toSpinClientConfig(resolved),
    maskedTpn: resolved.maskedTpn || maskTpn(''),
    registerId: resolved.registerId || null,
    registerName: resolved.registerName || '',
    source: resolved.source,
  };
}

async function readAcceptances(agreementId) {
  return prisma.agreementClauseAcceptance.findMany({
    where: { agreementId },
    orderBy: { acceptedAt: 'asc' },
  });
}

/**
 * Build the agent's ladder: every clause in order, with what is known about it.
 *
 * `nextSectionKey` is the resume anchor and the whole of the resumability
 * story: it is the FIRST clause with no accepted row, computed from the
 * database on every read. A session whose process died mid-sequence, a browser
 * that was closed, a second agent picking the checkout up — all of them get the
 * same answer, because none of them is remembering anything.
 */
export function buildLadder(sections, acceptances) {
  const byKey = new Map((acceptances || []).map((a) => [a.sectionKey, a]));
  const clauses = (sections || []).map((s, i) => {
    const rec = byKey.get(s.key) || null;
    return {
      index: i + 1,
      key: s.key,
      label: s.label,
      body: s.body,
      accepted: !!rec?.accepted,
      declined: !!rec && !rec.accepted,
      choiceOption: rec?.choiceOption || null,
      acceptedAt: rec?.acceptedAt || null,
    };
  });
  const declined = clauses.find((c) => c.declined) || null;
  const next = clauses.find((c) => !c.accepted) || null;
  return {
    total: clauses.length,
    acceptedCount: clauses.filter((c) => c.accepted).length,
    clauses,
    declinedSectionKey: declined?.key || null,
    nextSectionKey: declined ? null : (next?.key || null),
    allAccepted: clauses.length > 0 && clauses.every((c) => c.accepted),
  };
}

/**
 * GET — everything the agent screen needs, in one read.
 *
 * Also the mode gate: a session whose location is on PHONE gets
 * `mode: 'PHONE'` and the wizard renders the QR flow it always has. The switch
 * is answered by the server so the client cannot render a terminal ladder for a
 * counter that has no terminal.
 */
async function getState({ sessionId }) {
  const session = await loadContext(sessionId, { requireStep: false });
  const ag = session.agreement;
  const { mode, source } = await resolveContractMode(session.reservation?.tenantId, {
    locationId: session.reservation?.pickupLocationId || null,
  });
  const sections = sectionsFor(session);
  const acceptances = await readAcceptances(ag.id);
  const ladder = buildLadder(sections, acceptances);

  // Only measured when the terminal is actually in play — a PHONE tenant must
  // never be told their clause text is too long for a device they do not use.
  let clauseLengthError = null;
  if (mode === CONTRACT_MODES.TERMINAL) {
    try { assertClausesFitTerminal(sections, { canonicalKeys: canonicalKeySet(sections) }); } catch (err) { clauseLengthError = err.message; }
  }

  return {
    sessionId: session.id,
    currentStep: session.currentStep,
    tcCompletedAt: session.tcCompletedAt,
    agreementNumber: ag.agreementNumber,
    mode,
    modeSource: source,
    ...ladder,
    signatureCaptured: !!ag.tcSignedAt,
    clauseLengthError,
    acceptOption: CONTRACT_CHOICE.ACCEPT,
    declineOption: CONTRACT_CHOICE.DECLINE,
  };
}

/**
 * Run ONE clause on the terminal and record the answer.
 *
 * One call, one clause, one row. The sequence is driven a clause at a time from
 * the agent's screen rather than as a server-side loop, for two reasons that
 * are the same reason: a six-call loop inside one HTTP request would hold the
 * connection for up to twelve minutes (six × the 120 s proxy window), and it
 * would give the agent nothing to look at and no way to intervene while the
 * renter is on clause 4. Per-clause calls are also what make the ladder honest
 * — it is driven by the terminal's own responses, not by a timer.
 *
 * A DECLINE stops the sequence. It is recorded, not swallowed: `accepted:false`
 * with the verbatim option string, so the reason the checkout stopped is on the
 * record. There is no retry path from here, because a decline is a conversation
 * with the agent — usually the renter wants to change their coverage, which
 * already has a supported path (`declinedInsurance`, which injects the
 * declined-insurance acknowledgement as a seventh clause).
 */
async function runClause({ sessionId, sectionKey = null, actorUserId = null }) {
  const session = await loadContext(sessionId);
  const ag = session.agreement;

  const { mode } = await resolveContractMode(session.reservation?.tenantId, {
    locationId: session.reservation?.pickupLocationId || null,
  });
  if (mode !== CONTRACT_MODES.TERMINAL) {
    throw new CheckoutSessionError(
      'This checkout is not configured to sign on a terminal.',
      409, 'CONTRACT_MODE_NOT_TERMINAL',
    );
  }

  const sections = sectionsFor(session);
  // Before touching the device: config that cannot work must fail here, where
  // the agent can read why, not as a truncated sentence on the renter's screen.
  assertClausesFitTerminal(sections, { canonicalKeys: canonicalKeySet(sections) });

  const acceptances = await readAcceptances(ag.id);
  const ladder = buildLadder(sections, acceptances);

  if (ladder.declinedSectionKey && ladder.declinedSectionKey !== sectionKey) {
    throw new CheckoutSessionError(
      `The renter declined "${ladder.declinedSectionKey}". Resolve that with them before continuing.`,
      409, 'CLAUSE_DECLINED',
    );
  }

  // No sectionKey means "the next one" — which is the resume. An explicit key
  // is the agent re-sending a clause that timed out on the device.
  const wantKey = sectionKey || ladder.nextSectionKey;
  if (!wantKey) {
    throw new CheckoutSessionError(
      'Every clause is already accepted — capture the signature.',
      409, 'ALL_CLAUSES_ACCEPTED',
    );
  }
  const section = sections.find((s) => s.key === wantKey);
  if (!section) {
    throw new CheckoutSessionError(`Unknown sectionKey: ${wantKey}`, 400);
  }

  const terminal = await loadTerminal(session);
  const title = clauseTitle(section);

  let response;
  try {
    response = await spinClient.userChoice(
      { title, options: [...CONTRACT_CHOICE_OPTIONS] },
      terminal.tenantConfig,
    );
  } catch (err) {
    const verdict = classifyTerminalError(err);
    logger.warn('[terminal-contract] clause prompt failed', {
      sessionId, agreementId: ag.id, sectionKey: wantKey,
      state: verdict.state, verdict: verdict.verdict, code: verdict.code,
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
    // NOTHING is persisted on a failure. The clause was not answered, so the
    // ladder still points at it and a resend resumes exactly here.
    const e = new CheckoutSessionError(err?.message || 'The terminal did not answer', 502, 'TERMINAL_ERROR');
    e.terminal = verdict;
    throw e;
  }

  const selectedOption = response?.SelectedOption ?? response?.selectedOption ?? null;
  const accepted = isAcceptChoice(selectedOption);

  // A successful call whose SelectedOption we do not recognize is NOT an
  // acceptance. Recorded as declined-with-the-raw-value so the record shows the
  // truth (including in dry-run, where the synthetic response carries no
  // SelectedOption at all and this is exactly what should happen).
  const stored = await prisma.agreementClauseAcceptance.upsert({
    where: { agreementId_sectionKey: { agreementId: ag.id, sectionKey: section.key } },
    create: {
      agreementId: ag.id,
      sectionKey: section.key,
      sectionLabel: section.label,
      sectionBody: title,
      choiceOption: selectedOption === null || selectedOption === undefined ? '' : String(selectedOption),
      accepted,
      acceptedAt: new Date(),
      capturedVia: 'TERMINAL',
      terminalTpn: terminal.maskedTpn,
      registerId: terminal.registerId,
    },
    update: {
      // A resend overwrites its OWN row — one answer per question, never two.
      sectionLabel: section.label,
      sectionBody: title,
      choiceOption: selectedOption === null || selectedOption === undefined ? '' : String(selectedOption),
      accepted,
      acceptedAt: new Date(),
      capturedVia: 'TERMINAL',
      terminalTpn: terminal.maskedTpn,
      registerId: terminal.registerId,
    },
  });

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      events: appendEvent(session.events, {
        kind: accepted ? 'TERMINAL_CLAUSE_ACCEPTED' : 'TERMINAL_CLAUSE_DECLINED',
        sectionKey: section.key,
        choiceOption: stored.choiceOption,
        terminalTpn: terminal.maskedTpn,
        actorUserId: actorUserId || null,
      }),
    },
  });

  logger.info('[terminal-contract] clause answered on the terminal', {
    sessionId, agreementId: ag.id, sectionKey: section.key,
    accepted, tpn: terminal.maskedTpn, registerId: terminal.registerId,
  });

  const nextLadder = buildLadder(sections, await readAcceptances(ag.id));
  return {
    sectionKey: section.key,
    accepted,
    choiceOption: stored.choiceOption,
    acceptedAt: stored.acceptedAt,
    // The call has returned, so the device is free either way. What differs is
    // whether there is anything left to send: an acceptance leaves the terminal
    // IDLE and the agent moving on, a decline stops the sequence.
    state: accepted ? TERMINAL_STATES.IDLE : TERMINAL_STATES.DECLINED_BY_RENTER,
    verdict: accepted ? VERDICTS.CONTINUE : VERDICTS.STOP,
    ...nextLadder,
  };
}

/**
 * Which ink goes on THIS section's AgreementSectionInitial row?
 *
 * The whole one-capture-vs-six-captures decision, in one function. Today the
 * per-clause column is always NULL and every section takes the single contract
 * signature. Turning per-clause ink on means capturing into
 * `AgreementClauseAcceptance.inkDataUrl` during runClause — and this function
 * already prefers it. Nothing else in the persistence changes, and nothing
 * already stored changes meaning.
 */
export function inkForSection(acceptance, contractSignatureDataUrl) {
  return acceptance?.inkDataUrl || contractSignatureDataUrl;
}

/**
 * Capture the contract signature and finalize.
 *
 * Everything that makes the agreement "signed" happens here, in ONE
 * transaction, and only when every expected clause is accepted:
 *   • AgreementSectionInitial for each section — the SAME rows, with the SAME
 *     columns, that the phone path writes. Each carries its OWN section's
 *     `signedAt`: the moment that clause was accepted on the terminal, not the
 *     moment the pen came off the screen. That is what makes the printed
 *     agreement read as an initialled contract rather than six copies of one
 *     timestamp.
 *   • RentalAgreement.tcSignature* — same columns, same meaning.
 *   • CheckoutSession.tcCompletedAt + a stateVersion bump — the SAME stamp the
 *     web path makes, which is what satisfies the state machine's
 *     ENTRY_REQUIRES guard for TC_SIGNED identically and is why there is no
 *     forked state to reconcile.
 */
async function captureSignature({ sessionId, actorUserId = null }) {
  const session = await loadContext(sessionId);
  const ag = session.agreement;

  const { mode } = await resolveContractMode(session.reservation?.tenantId, {
    locationId: session.reservation?.pickupLocationId || null,
  });
  if (mode !== CONTRACT_MODES.TERMINAL) {
    throw new CheckoutSessionError(
      'This checkout is not configured to sign on a terminal.',
      409, 'CONTRACT_MODE_NOT_TERMINAL',
    );
  }

  const sections = sectionsFor(session);
  const acceptances = await readAcceptances(ag.id);
  const ladder = buildLadder(sections, acceptances);

  if (ladder.declinedSectionKey) {
    throw new CheckoutSessionError(
      `The renter declined "${ladder.declinedSectionKey}" — the contract cannot be signed as it stands.`,
      409, 'CLAUSE_DECLINED',
    );
  }
  if (!ladder.allAccepted) {
    const missing = ladder.clauses.filter((c) => !c.accepted).map((c) => c.key);
    throw new CheckoutSessionError(
      `Not every clause has been accepted yet: ${missing.join(', ')}`,
      409, 'CLAUSES_INCOMPLETE',
    );
  }

  const terminal = await loadTerminal(session);

  let response;
  try {
    response = await spinClient.getSignature(terminal.tenantConfig);
  } catch (err) {
    const verdict = classifyTerminalError(err);
    logger.warn('[terminal-contract] signature capture failed', {
      sessionId, agreementId: ag.id,
      state: verdict.state, verdict: verdict.verdict, code: verdict.code,
    });
    // Nothing persisted. Every accepted clause survives, so a retry — or the
    // phone fallback — resumes at the signature, not at clause 1.
    const e = new CheckoutSessionError(err?.message || 'The terminal did not return a signature', 502, 'TERMINAL_ERROR');
    e.terminal = verdict;
    throw e;
  }

  if (!isSpinOk(response)) {
    // Match on the codes, never the message: UserChoice answers "Success"
    // while Disclaimer and GetSignature answer "OK" on the same device.
    throw new CheckoutSessionError('The terminal did not return a signature', 502, 'TERMINAL_ERROR');
  }

  const signature = normalizeSignaturePayload(response?.Signature ?? response?.signature);
  if (!signature || signature.length < 200) {
    throw new CheckoutSessionError(
      'The terminal returned no signature image. Ask the renter to sign again.',
      502, 'SIGNATURE_MISSING',
    );
  }
  // A blank canvas is a valid PNG and passes every length check — the exact
  // failure that put a white box over a real T&C stroke on RA-20260701152550.
  // The phone path rejects it here; so does this one, on the same analyzer,
  // fail-open for formats the analyzer cannot read.
  const ink = analyzeSignatureInk(signature);
  if (ink.analyzable && !ink.hasInk) {
    throw new CheckoutSessionError(
      'The signature came back blank — ask the renter to sign again.',
      400, 'SIGNATURE_BLANK',
    );
  }

  const acceptanceByKey = new Map(acceptances.map((a) => [a.sectionKey, a]));
  const now = new Date();

  const initialWrites = sections.map((s) => {
    const rec = acceptanceByKey.get(s.key);
    const dataUrl = inkForSection(rec, signature);
    // Each section's OWN signedAt — when that clause was accepted.
    const signedAt = rec?.acceptedAt || now;
    return prisma.agreementSectionInitial.upsert({
      where: { agreementId_sectionKey: { agreementId: ag.id, sectionKey: s.key } },
      create: {
        agreementId: ag.id,
        sectionKey: s.key,
        sectionLabel: s.label,
        initialDataUrl: dataUrl,
        signedAt,
        // No customerIp: the renter signed on the counter's own device, so the
        // only IP available is the branch's. Recording that as the signer's IP
        // would be a fabricated provenance fact on a legal record. The device
        // is identified instead, on the acceptance rows (masked TPN + register).
        customerIp: null,
      },
      update: {
        initialDataUrl: dataUrl,
        signedAt,
      },
    });
  });

  await prisma.$transaction([
    ...initialWrites,
    prisma.rentalAgreement.update({
      where: { id: ag.id },
      data: {
        tcSignatureDataUrl: signature,
        tcSignedAt: now,
        tcSignerName: null,
        tcCustomerIp: null,
      },
    }),
    prisma.checkoutSession.update({
      where: { id: session.id },
      data: {
        tcCompletedAt: now,
        // Same reason terms-signing.service.js bumps it: this is a REAL writer
        // of a versioned field, and an H6 client holding an expectedVersion
        // snapshot would otherwise pass its guard believing nothing changed.
        stateVersion: { increment: 1 },
        events: appendEvent(session.events, {
          kind: 'TC_SIGNED_ON_TERMINAL',
          terminalTpn: terminal.maskedTpn,
          registerId: terminal.registerId,
          actorUserId: actorUserId || null,
        }),
      },
    }),
  ]);

  logger.info('[terminal-contract] T&C completed on the terminal', {
    sessionId, agreementId: ag.id, sections: sections.length, tpn: terminal.maskedTpn,
  });

  return {
    ok: true,
    state: TERMINAL_STATES.SIGNED,
    verdict: VERDICTS.CONTINUE,
    sections: sections.length,
    tcCompletedAt: now,
  };
}

/**
 * GetSignature returns base64 PNG bytes (measured live: 20,336 characters,
 * ~15 KB). AgreementSectionInitial.initialDataUrl and
 * RentalAgreement.tcSignatureDataUrl hold DATA URLS — that is what every
 * renderer (`<img src=...>` in the PDF, the agreement screen) expects. Wrapping
 * happens here so a terminal-captured signature is byte-for-byte the same KIND
 * of artifact as a phone-captured one, and no renderer has to learn a second
 * format. A payload that is already a data URL passes through untouched.
 */
export function normalizeSignaturePayload(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('data:')) return s;
  return `data:image/png;base64,${s}`;
}

/**
 * Hand this checkout back to the renter's phone.
 *
 * D5: the fallback moves as a UNIT. Three independent fallbacks produce a
 * checkout signed on the terminal, paid by link, holding no deposit, with
 * nobody noticing until the car comes back damaged. This function does the
 * CONTRACT half and records the decision on the session; the payment half is
 * the existing HPP link path, and the agent screen offers them behind one
 * control so they are never chosen separately.
 *
 * The clauses already accepted on the terminal are NOT discarded. The phone
 * flow reads AgreementSectionInitial to decide what is left — which the
 * terminal path has not written yet, by design — so the carry-over is done by
 * `mintPhoneFallback` handing the phone flow the accepted set, and by
 * `terminalAcceptedSectionKeys` below, which terms-signing consults. The renter
 * resumes at the clause that failed, not at clause 1.
 */
async function switchToPhone({ sessionId, actorUserId = null, reason = null }) {
  const session = await loadContext(sessionId);
  const ag = session.agreement;
  const acceptances = await readAcceptances(ag.id);
  const carried = acceptances.filter((a) => a.accepted).map((a) => a.sectionKey);

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      events: appendEvent(session.events, {
        kind: 'CONTRACT_FELL_BACK_TO_PHONE',
        reason: reason || null,
        clausesCarriedOver: carried,
        actorUserId: actorUserId || null,
      }),
    },
  });

  logger.info('[terminal-contract] falling back to the phone signing flow', {
    sessionId, agreementId: ag.id, carriedOver: carried.length, reason: reason || null,
  });

  return { ok: true, carriedOverSectionKeys: carried };
}

/**
 * Which sections did the renter already accept on the terminal?
 *
 * Consumed by the phone signing flow so a fallback resumes at the clause that
 * failed. Deliberately a QUERY and not a write: converting terminal
 * acceptances into AgreementSectionInitial rows at fallback time would mean
 * writing initials for which no ink exists — the half-signed-looks-complete
 * failure this whole design is built to avoid.
 */
export async function terminalAcceptedSectionKeys(agreementId) {
  if (!agreementId) return [];
  const rows = await prisma.agreementClauseAcceptance.findMany({
    where: { agreementId, accepted: true },
    select: { sectionKey: true },
  });
  return rows.map((r) => r.sectionKey);
}

export const terminalContractService = {
  getState,
  runClause,
  captureSignature,
  switchToPhone,
  terminalAcceptedSectionKeys,
};
