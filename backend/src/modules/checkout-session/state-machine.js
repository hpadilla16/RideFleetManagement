/**
 * Checkout session state machine.
 *
 * Each row in CheckoutSession is a state on the wizard. Transitions
 * follow a strict directed graph — any out-of-order POST to
 * /api/checkout-sessions/:id/transition is rejected with a 409. The
 * legal-transitions table is the single source of truth for what an
 * agent / customer can do at each step.
 *
 *   CONFIRMING ──► TC_PENDING ──► TC_SIGNED ──► PAYMENT_PENDING ──► PAID
 *                                                                    │
 *                                                                    ▼
 *                                                   INSPECTION_HANDOFF
 *                                                                    │
 *                                                                    ▼
 *                                          INSPECTION_IN_PROGRESS
 *                                                                    │
 *                                                                    ▼
 *                                           CUSTOMER_SIGN_PENDING
 *                                                                    │
 *                                                                    ▼
 *                                                          FINALIZING
 *                                                                    │
 *                                                                    ▼
 *                                                             CLOSED
 *
 * Any non-terminal step can also transition to CANCELLED (agent
 * abandons or system aborts). CLOSED and CANCELLED are terminal.
 *
 * Each transition has:
 *   • required field(s) that must already be populated on the session
 *     (e.g. PAYMENT_PENDING → PAID requires paymentCompletedAt to be
 *     stamped by the Spin charge handler before we accept the
 *     transition)
 *   • optional fields to stamp on commit
 *
 * The actor (agent / system / customer) is supplied by the caller and
 * appended to the events JSON log so abuse can be traced.
 */

export const CHECKOUT_STEPS = [
  'CONFIRMING',
  'TC_PENDING',
  'TC_SIGNED',
  'PAYMENT_PENDING',
  'PAID',
  'INSPECTION_HANDOFF',
  'INSPECTION_IN_PROGRESS',
  'CUSTOMER_SIGN_PENDING',
  'FINALIZING',
  'CLOSED',
  'CANCELLED',
];

const TERMINAL_STATES = new Set(['CLOSED', 'CANCELLED']);

// Forward transitions. CANCELLED is a permitted exit from any non-terminal
// step, handled separately via canCancelFrom().
const FORWARD = {
  CONFIRMING:             ['TC_PENDING'],
  TC_PENDING:             ['TC_SIGNED'],
  TC_SIGNED:              ['PAYMENT_PENDING'],
  PAYMENT_PENDING:        ['PAID'],
  PAID:                   ['INSPECTION_HANDOFF'],
  INSPECTION_HANDOFF:     ['INSPECTION_IN_PROGRESS'],
  INSPECTION_IN_PROGRESS: ['CUSTOMER_SIGN_PENDING'],
  CUSTOMER_SIGN_PENDING:  ['FINALIZING'],
  FINALIZING:             ['CLOSED'],
  CLOSED:                 [],
  CANCELLED:              [],
};

// Step → field that must already be set on the session row before we
// accept the transition INTO that step. Guards against the wizard
// trying to mark TC_SIGNED before the customer's phone actually
// confirmed, or PAID before the Spin webhook stamped the row.
const ENTRY_REQUIRES = {
  TC_SIGNED:              'tcCompletedAt',
  PAID:                   'paymentCompletedAt',
  CUSTOMER_SIGN_PENDING:  'inspectionCompletedAt',
  CLOSED:                 'customerSignedAt',
};

export function isTerminal(step) {
  return TERMINAL_STATES.has(step);
}

export function legalForwardTransitions(fromStep) {
  return FORWARD[fromStep] || [];
}

export function canTransition(fromStep, toStep) {
  if (fromStep === toStep) return false;
  if (isTerminal(fromStep)) return false;
  if (toStep === 'CANCELLED') return canCancelFrom(fromStep);
  return legalForwardTransitions(fromStep).includes(toStep);
}

export function canCancelFrom(step) {
  return !isTerminal(step);
}

export function entryRequirement(toStep) {
  return ENTRY_REQUIRES[toStep] || null;
}

/**
 * Append an event to the events JSON log. Returns the NEW events string
 * (we don't mutate). Caller is responsible for persisting.
 */
export function appendEvent(eventsJson, event) {
  let arr = [];
  try { arr = JSON.parse(eventsJson || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  arr.push({ ...event, at: event.at || new Date().toISOString() });
  return JSON.stringify(arr);
}

/**
 * Test helper — read events back out of the JSON column.
 */
export function readEvents(eventsJson) {
  try {
    const arr = JSON.parse(eventsJson || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
