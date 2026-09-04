/**
 * View Payments — tenant gateway capability helpers (2026-08-30 redesign).
 *
 * The page draws controls from the booleans-only
 * GET /api/settings/payment-capabilities response. These helpers are pure so
 * the capability→control matrix can be pinned by unit tests without rendering:
 * an iPOS tenant must never arm the Authorize.Net auto-reconcile loop, and a
 * failed capabilities fetch must degrade to universal controls only.
 */

/** Accept only a sane capabilities payload; anything else reads as unknown. */
export function normalizeCapabilities(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.gateway !== 'string') return null;
  const b = (v) => v === true;
  return {
    gateway: raw.gateway.toLowerCase(),
    authorizenet: { enabled: b(raw?.authorizenet?.enabled) },
    spin: { enabled: b(raw?.spin?.enabled) },
    ipos: { enabled: b(raw?.ipos?.enabled), linkReady: b(raw?.ipos?.linkReady) },
    stripe: { enabled: b(raw?.stripe?.enabled) },
    square: { enabled: b(raw?.square?.enabled) },
    payarc: { enabled: b(raw?.payarc?.enabled) },
    autocharge: { mode: raw?.autocharge?.mode === 'MANUAL' ? 'MANUAL' : 'AUTO' }
  };
}

/**
 * The gateway flags every render decision keys off. `known:false` (capabilities
 * not loaded / fetch failed) FAILS OPEN to universal controls only: OTC
 * recording, history and send-link render; gateway-specific furniture hides.
 * Reservation-level EVIDENCE gates (SPIn card on file, active hold, AUTHNET:
 * row references) are deliberately NOT represented here — evidence-backed
 * controls stay reachable regardless of tenant config, per the redesign notes
 * ("nothing deleted, only conditioned").
 */
export function capabilityFlags(caps) {
  const gateway = caps?.gateway || '';
  return {
    known: !!caps,
    gateway,
    gwAuthnet: gateway === 'authorizenet',
    gwIpos: gateway === 'ipos',
    gwLinkOnly: gateway === 'stripe' || gateway === 'square'
  };
}

/**
 * Should the silent Authorize.Net auto-reconcile loop arm at all?
 * Pre-redesign this fired real Authorize.Net calls for ANY WEB- reservation
 * with a balance — a guaranteed 400 loop for iPOS tenants like IRC. The
 * tenant gate is strict: unknown capabilities (loading or failed fetch) never
 * arm the loop; the manual reconcile control is Authorize.Net-only anyway.
 */
export function autoReconcileArmed({ caps, isWebReservation, unpaid }) {
  return caps?.gateway === 'authorizenet' && !!isWebReservation && Number(unpaid) > 0;
}

/** Machine reference prefixes, longest-match-first (SPIN_RELEASE before SPIN). */
const REFERENCE_PREFIXES = [
  { prefix: 'SPIN_RELEASE:', label: 'SPIN', tone: 'ok' },
  { prefix: 'IPOS:', label: 'IPOS', tone: 'brand' },
  { prefix: 'AUTHNET:', label: 'AUTHNET', tone: 'warn' },
  { prefix: 'SPIN:', label: 'SPIN', tone: 'ok' },
  { prefix: 'PAYARC:', label: 'PAYARC', tone: 'brand' },
  { prefix: 'REFUND:', label: 'REFUND', tone: 'neutral' }
];

/**
 * Split a stored payment reference into { prefix, label, tone, value }.
 * Human-typed references (last-4, auth codes, OTC-<ts>) come back with a null
 * prefix and the raw string as value.
 */
export function parseReference(reference) {
  const raw = String(reference || '').trim();
  for (const p of REFERENCE_PREFIXES) {
    if (raw.toUpperCase().startsWith(p.prefix)) {
      return { prefix: p.prefix.slice(0, -1), label: p.label, tone: p.tone, value: raw.slice(p.prefix.length) };
    }
  }
  return { prefix: null, label: null, tone: null, value: raw };
}

/**
 * What a refund of this row will actually DO, mirroring the backend's row
 * routing (rental-agreements/refund-rails.js): PAYARC:→PayArc API refund,
 * AUTHNET:→Auth.Net void/refund, IPOS_ (underscore — Transact CNP, not the
 * IPOS: HPP prefix)→Transact void by RRN, SPIn CARD rows (gateway column, set
 * server-side on terminal sales and card-on-file charges)→SPIn void/return,
 * anything else→negative bookkeeping row. The overflow label must say which,
 * so staff never expect a card movement the backend will not make.
 *
 * Accepts the payment row (preferred — the gateway column is row evidence
 * written by the server, not a client-side gateway guess) or a bare reference
 * string for back-compat.
 */
export function refundKind(paymentOrReference) {
  const p = typeof paymentOrReference === 'string' || paymentOrReference == null
    ? { reference: paymentOrReference }
    : paymentOrReference;
  const raw = String(p.reference || '').trim().toUpperCase();
  if (raw.startsWith('AUTHNET:') || raw.startsWith('PAYARC:')) return 'card';
  if (/^IPOS_/.test(raw)) return 'card';
  if (
    String(p.gateway || '').toUpperCase() === 'SPIN'
    && String(p.method || '').toUpperCase() === 'CARD'
  ) return 'card';
  return 'record';
}

/**
 * The confirmation line the refund dialog shows — processor + the row's own
 * reference/last-4 — so the agent confirms WHERE the money goes before it
 * moves. Pure for the same reason as everything else in this file.
 */
export function refundTarget(payment = {}) {
  const parsed = parseReference(payment.reference);
  const gw = String(payment.gateway || '').toUpperCase();
  const raw = String(payment.reference || '');
  const last4 = (/\*{4}\s?(\d{4})/.exec(raw) || [])[1] || null;
  const gateway = parsed.label
    || (gw === 'SPIN' ? 'SPIN' : gw || null)
    || (/^IPOS_/i.test(raw.trim()) ? 'IPOS' : null);
  // SPIn terminal sales store the AuthCode in `reference` and the SPIn
  // ReferenceId — the key the refund actually runs against — in the notes
  // ("Spin Sale · <refId>"). Confirm against the key that will move money,
  // mirroring the backend's refund-rails resolution.
  const spinSaleRef = gw === 'SPIN'
    ? (/Spin Sale\s*·\s*(\S+)/.exec(String(payment.notes || '')) || [])[1] || null
    : null;
  return {
    kind: refundKind(payment),
    gateway,
    last4,
    reference: spinSaleRef || parsed.value || raw || ''
  };
}
