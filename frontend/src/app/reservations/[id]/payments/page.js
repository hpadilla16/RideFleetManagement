'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import {
  normalizeCapabilities,
  capabilityFlags,
  autoReconcileArmed,
  parseReference,
  refundKind
} from './payments-capabilities';

function normalizePaymentRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((p) => ({
    id: p.id,
    paidAt: p.paidAt,
    method: p.method,
    amount: Number(p.amount || 0),
    reference: p.reference || '',
    status: String(p.status || '').toUpperCase(),
    source: 'db'
  }));
}

function deriveTotalFromReservationRow(row) {
  const direct = [
    row?.total,
    row?.totalAmount,
    row?.amountDue,
    row?.grandTotal,
    row?.chargesTotal,
  ].map((v) => Number(v || 0)).find((v) => v > 0);
  if (direct) return Number(direct.toFixed(2));

  const pickup = row?.pickupAt ? new Date(row.pickupAt) : null;
  const ret = row?.returnAt ? new Date(row.returnAt) : null;
  const hasDates = pickup instanceof Date && !Number.isNaN(pickup?.getTime?.()) && ret instanceof Date && !Number.isNaN(ret?.getTime?.());
  const days = hasDates ? Math.max(1, Math.ceil((ret - pickup) / (1000 * 60 * 60 * 24))) : 1;
  const daily = Number(row?.dailyRate || 0);
  const fee = Number(row?.serviceFee || 0);
  const taxRate = Number(row?.taxRate || 0) / 100;
  const base = daily * days;
  const tax = Number(((base + fee) * taxRate).toFixed(2));
  const computed = Number((base + fee + tax).toFixed(2));
  return computed > 0 ? computed : 0;
}

function deriveSecurityDepositHold(row) {
  const agreement = row?.rentalAgreement || null;
  const amount = Number(agreement?.securityDepositAmount || 0);
  return {
    amount: Number.isFinite(amount) ? amount : 0,
    captured: !!agreement?.securityDepositCaptured,
    capturedAt: agreement?.securityDepositCapturedAt || null,
    releasedAt: agreement?.securityDepositReleasedAt || null,
    reference: agreement?.securityDepositReference || ''
  };
}

// Derive Spin (Dejavoo) card-on-file + deposit hold state for the
// operational tools. agreement.cardOnFileLast4 + cardOnFileCapturedAt
// signal that step 3 of the checkout wizard captured an iPOS token. The
// token itself is NEVER sent to the frontend — all charges run server-side.
//
// This is RESERVATION-LEVEL EVIDENCE, deliberately independent of the tenant
// capabilities fetch: a legacy reservation with a Spin card on file keeps its
// release/re-auth tools even if the tenant's gateway later changed.
function deriveSpinState(row) {
  const agreement = row?.rentalAgreement || null;
  const hasCardOnFile = !!(agreement?.cardOnFileLast4 || agreement?.cardOnFileCapturedAt);
  const depositHoldActive = !!(agreement?.depositHoldId && !agreement?.depositHoldVoidedAt);
  return {
    hasCardOnFile,
    brand: agreement?.cardOnFileBrand || '',
    last4: agreement?.cardOnFileLast4 || '',
    capturedAt: agreement?.cardOnFileCapturedAt || null,
    depositHoldActive,
    depositHoldId: agreement?.depositHoldId || '',
    depositHoldAmount: Number(agreement?.depositHoldAmount || agreement?.securityDepositAmount || 0),
    depositHoldVoidedAt: agreement?.depositHoldVoidedAt || null,
    isManualHold: String(agreement?.depositHoldId || '').startsWith('MANUAL-')
  };
}

const money = (v) => `$${Number(v || 0).toFixed(2)}`;

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
);
const DotsIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
);

/** Themed refund dialog — replaces window.prompt; validates against the row max. */
function RefundDialog({ payment, busy, onCancel, onApply }) {
  const { t } = useTranslation();
  const max = Number(payment?.amount || 0);
  const [value, setValue] = useState(max > 0 ? max.toFixed(2) : '0.00');
  const [error, setError] = useState('');
  const kind = refundKind(payment?.reference);
  const apply = () => {
    const v = Number(value || 0);
    if (!(v > 0) || v - max > 0.009) {
      setError(t('viewPayments.dialog.refundInvalid', 'Enter a valid refund amount (up to {{max}})', { max: money(max) }));
      return;
    }
    onApply(v);
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="tq-dialog" role="dialog" aria-modal="true">
        <h3>{t('viewPayments.dialog.refundTitle', 'Refund payment')}</h3>
        <p>
          {t('viewPayments.dialog.refundBody', '{{method}} payment of {{amount}}. The refund cannot exceed the original amount.', { method: payment?.method || '', amount: money(max) })}
          {' '}
          {kind === 'card'
            ? t('viewPayments.dialog.refundCardBody', 'This sends a real refund to the card through the processor.')
            : t('viewPayments.dialog.refundRecordBody', 'This posts a negative bookkeeping row — no card movement.')}
        </p>
        <label className="label">{t('viewPayments.dialog.refundAmount', 'Refund amount')}</label>
        <input type="number" min="0" step="0.01" max={max} value={value} autoFocus onChange={(e) => { setValue(e.target.value); setError(''); }} />
        {error ? <div className="label" style={{ color: 'var(--danger-tx)', textTransform: 'none', letterSpacing: 0, marginTop: 6 }}>{error}</div> : null}
        <div className="row">
          <button type="button" className="button-subtle" onClick={onCancel} disabled={busy}>{t('viewPayments.dialog.cancel', 'Cancel')}</button>
          <button type="button" onClick={apply} disabled={busy}>
            {busy ? t('viewPayments.dialog.working', 'Working…') : t('viewPayments.dialog.refundSubmit', 'Refund')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Themed void dialog — replaces window.confirm + window.prompt; reason required. */
function VoidDialog({ payment, busy, onCancel, onApply }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="tq-dialog" role="dialog" aria-modal="true">
        <h3>{t('viewPayments.dialog.voidTitle', 'Void payment · no refund')} · {money(payment?.amount)}</h3>
        <p>{t('viewPayments.dialog.voidBody', 'This is a BOOKKEEPING correction only. It does not move money and does not refund the customer’s card — use Refund for a real refund. The payment will be marked VOID and removed from the collected/balance totals.')}</p>
        <label className="label">{t('viewPayments.dialog.voidReason', 'Reason (required)')}</label>
        <textarea rows={3} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} />
        <div className="row">
          <button type="button" className="button-subtle" onClick={onCancel} disabled={busy}>{t('viewPayments.dialog.cancel', 'Cancel')}</button>
          <button
            type="button"
            className="button-subtle"
            style={{ color: 'var(--danger-tx)', borderColor: 'var(--danger-bd)' }}
            onClick={() => onApply(reason)}
            disabled={busy || !reason.trim()}
          >
            {busy ? t('viewPayments.dialog.working', 'Working…') : t('viewPayments.dialog.voidSubmit', 'Void payment')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Themed confirm for SPIn release / re-authorize — replaces window.confirm. */
function SpinConfirmDialog({ dialog, busy, onCancel, onConfirm }) {
  const { t } = useTranslation();
  const isRelease = dialog.kind === 'spin-release';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="tq-dialog" role="dialog" aria-modal="true">
        <h3>
          {isRelease
            ? t('viewPayments.dialog.spinReleaseTitle', 'Release the deposit hold?')
            : t('viewPayments.dialog.spinReauthTitle', 'Re-authorize the deposit?')}
        </h3>
        <p>
          {isRelease
            ? (dialog.isManualHold
              ? t('viewPayments.dialog.spinReleaseManualBody', 'Manual hold — releasing only updates Ride Fleet records (no terminal void).')
              : t('viewPayments.dialog.spinReleaseBody', 'This voids the authorization on the customer’s card.'))
            : t('viewPayments.dialog.spinReauthBody', 'This will VOID the existing {{oldAmount}} hold and place a new {{newAmount}} hold on the same card.', { oldAmount: money(dialog.oldAmount), newAmount: money(dialog.newAmount) })}
        </p>
        <div className="row">
          <button type="button" className="button-subtle" onClick={onCancel} disabled={busy}>{t('viewPayments.dialog.cancel', 'Cancel')}</button>
          <button type="button" onClick={onConfirm} disabled={busy}>
            {busy
              ? t('viewPayments.dialog.working', 'Working…')
              : isRelease
                ? t('viewPayments.dialog.spinReleaseSubmit', 'Release hold')
                : t('viewPayments.dialog.spinReauthSubmit', 'Re-authorize')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Themed send-payment-link dialog — the universal collect action. */
function SendLinkDialog({ customerEmail, busy, onCancel, onSend }) {
  const { t } = useTranslation();
  const [extra, setExtra] = useState('');
  const hasEmail = !!String(customerEmail || '').trim();
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="tq-dialog" role="dialog" aria-modal="true">
        <h3>{t('viewPayments.dialog.sendLinkTitle', 'Send payment link')}</h3>
        <p>{t('viewPayments.dialog.sendLinkBody', 'Emails the customer a secure link to pay online.')}</p>
        {hasEmail ? (
          <p><strong>{t('viewPayments.dialog.sendLinkTo', 'Send to')}:</strong> {customerEmail}</p>
        ) : (
          <p style={{ color: 'var(--danger-tx)' }}>{t('viewPayments.dialog.sendLinkNoEmail', 'No customer email on file — add one on the reservation first.')}</p>
        )}
        <label className="label">{t('viewPayments.dialog.sendLinkExtra', 'Additional recipients (optional, comma separated)')}</label>
        <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="name@example.com" />
        <div className="row">
          <button type="button" className="button-subtle" onClick={onCancel} disabled={busy}>{t('viewPayments.dialog.cancel', 'Cancel')}</button>
          <button
            type="button"
            onClick={() => onSend(extra.split(',').map((x) => x.trim()).filter(Boolean))}
            disabled={busy || (!hasEmail && !extra.trim())}
          >
            {busy ? t('viewPayments.dialog.sendLinkSending', 'Sending…') : t('viewPayments.dialog.sendLinkSubmit', 'Send link')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Processor chip + honestly-truncated mono ref + copy affordance. */
function ReferenceCell({ reference, onCopied }) {
  const parsed = parseReference(reference);
  if (!parsed.value) return <span className="vp-refcell"><span className="rv">—</span></span>;
  const toneClass = parsed.tone === 'warn' ? ' proc--warn' : parsed.tone === 'ok' ? ' proc--ok' : parsed.tone === 'neutral' ? ' proc--neutral' : '';
  const copy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(String(reference || ''));
        onCopied?.();
      }
    } catch {}
  };
  return (
    <span className="vp-refcell">
      {parsed.label ? <span className={`proc${toneClass}`}>{parsed.label}</span> : null}
      <span className="rv" title={String(reference || '')}>{parsed.value}</span>
      <button type="button" className="copy" onClick={copy} title="Copy"><CopyIcon /></button>
    </span>
  );
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { t } = useTranslation();
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [row, setRow] = useState(null);
  const [paymentRows, setPaymentRows] = useState([]);
  const [pricing, setPricing] = useState(null);
  const [msg, setMsg] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [cardLast4, setCardLast4] = useState('');
  const [saving, setSaving] = useState(false);
  const [cardChargeAmount, setCardChargeAmount] = useState('');
  const [holdAmount, setHoldAmount] = useState('');
  const [actionBusy, setActionBusy] = useState('');
  const [reconcileRef, setReconcileRef] = useState('');
  // Themed dialogs replace window.prompt/window.confirm on the money path:
  // { kind:'refund', payment } | { kind:'void', payment } |
  // { kind:'spin-release', ... } | { kind:'spin-reauth', ... } | { kind:'send-link' }
  const [dialog, setDialog] = useState(null);
  const autoReconcileAttemptsRef = useRef(0);
  const autoReconcileKeyRef = useRef('');

  // Tenant payment capabilities (booleans only, from the additive
  // GET /api/settings/payment-capabilities). This is what makes the page
  // gateway-aware: an iPOS tenant renders ZERO Authorize.Net furniture.
  // FAIL OPEN: if the fetch errors the page must not brick — capabilities stay
  // null, gateway-specific controls hide, universal controls (OTC recording,
  // history, send-link) keep working, and a quiet backoff retry runs.
  const [caps, setCaps] = useState(null);
  const capsRetryRef = useRef(0);
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    let timer = null;
    const fetchCaps = async () => {
      try {
        const out = await api('/api/settings/payment-capabilities', {}, token);
        if (cancelled) return;
        const normalized = normalizeCapabilities(out);
        if (!normalized) throw new Error('unexpected capabilities shape');
        capsRetryRef.current = 0;
        setCaps(normalized);
      } catch {
        if (cancelled) return;
        // Quiet retry: 5s → 10s → 20s → 40s → 60s cap, max 6 attempts.
        if (capsRetryRef.current < 6) {
          const delayMs = Math.min(5000 * Math.pow(2, capsRetryRef.current), 60000);
          capsRetryRef.current += 1;
          timer = window.setTimeout(fetchCaps, delayMs);
        }
      }
    };
    fetchCaps();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [token]);
  const { gwAuthnet, gwIpos, gwLinkOnly, known: capsKnown } = capabilityFlags(caps);

  // The exact warning string we set when the reservation re-fetch can't
  // refresh the row. Kept as a constant so the success path can clear
  // ONLY this message — leaving any action-feedback messages (e.g.
  // "Payment posted successfully") untouched. Codex bot finding on
  // PR #24: previously this warning could stick across the auto-refresh
  // interval and misrepresent state to staff.
  const STALE_RESERVATION_WARNING = 'Reservation data could not be refreshed. Showing the last known state.';

  const load = async () => {
    // Sentry root-cause finding (2026-04-28 22:00 EDT): the first call
    // here used to lack a .catch(), so a network blip while the user was
    // navigating into the payments page caused an unhandled rejection of
    // the whole Promise.all. The other two already had per-call catches.
    // Now: the first call falls back to the existing row state on
    // failure (so a transient drop doesn't blank out a previously-loaded
    // reservation), and the whole function is wrapped in try/catch so a
    // truly broken state surfaces a visible message rather than silently
    // hanging.
    try {
      const [r, payments, pricingOut] = await Promise.all([
        api(`/api/reservations/${id}`, { bypassCache: true }, token).catch(() => null),
        api(`/api/reservations/${id}/payments`, { bypassCache: true }, token).catch(() => []),
        api(`/api/reservations/${id}/pricing`, { bypassCache: true }, token).catch(() => null)
      ]);
      if (r) setRow(r);
      setPaymentRows(normalizePaymentRows(payments));
      if (pricingOut !== null) setPricing(pricingOut);
      if (!r) {
        setMsg(STALE_RESERVATION_WARNING);
      } else {
        // Successful reservation fetch — clear the stale warning if it
        // was previously set, but leave any other message (action
        // feedback, success notices) alone so a recovered transient
        // blip doesn't paper over unrelated user-facing context.
        setMsg((current) => (current === STALE_RESERVATION_WARNING ? '' : current));
      }
    } catch (error) {
      // Defense in depth — Promise.all shouldn't reject now that all three
      // calls catch their own errors, but keep this so any future caller
      // refactor can't reintroduce the unhandled-rejection class of bug.
      setMsg(error?.message || 'Unable to load payments page data');
    }
  };

  useEffect(() => {
    if (!id) return;
    // Fire-and-forget is intentional — load() now swallows errors and
    // surfaces them via setMsg. Wrapping the call here defends against
    // any future change to load() that re-introduces a throw path.
    load().catch(() => {});
  }, [id]);

  const payments = useMemo(() => paymentRows, [paymentRows]);
  const totalFromQuery = useMemo(() => Number(searchParams?.get('total') || 0), [searchParams]);
  // 2026-06-08: when a rental agreement exists, RentalAgreement.total/paidAmount/
  // balance are the source of truth — the agreement total already includes
  // post-check-in fees (fuel/cleaning/late) that the rental-only estimatedTotal/
  // pricing total (and the ?total= query param) miss, and paidAmount includes
  // agreement-level payments (e.g. franchise-prepaid rentals) that aren't in the
  // reservation payments table. This keeps Total/Collected/Unpaid here aligned
  // with the reservation detail's agreement balance. Falls back to the
  // rental-only computation before an agreement exists.
  const agreementTotals = row?.rentalAgreement || null;
  const hasAgreementTotals = !!(agreementTotals?.id) && agreementTotals?.total != null;
  const total = useMemo(() => {
    if (hasAgreementTotals) return Number(Number(agreementTotals.total || 0).toFixed(2));
    const fromPricing = Number(pricing?.totals?.total || 0);
    const fromRow = Number(deriveTotalFromReservationRow(row).toFixed(2));
    return Number(Math.max(totalFromQuery, fromPricing, fromRow).toFixed(2));
  }, [row, pricing?.totals?.total, totalFromQuery, hasAgreementTotals, agreementTotals]);
  // 2026-06-06: "Collected" counts REAL captured money only. AUTH_HOLD is a
  // security-deposit authorization (not settled funds) — excluded from paid so
  // the snapshot/"Paid In Full" badge doesn't mask a real unpaid balance. Holds
  // are still listed separately in the payments table below.
  const paid = useMemo(() => {
    if (hasAgreementTotals) return Number(Number(agreementTotals.paidAmount || 0).toFixed(2));
    return Number(payments
      .filter((p) => String(p.method || '').toUpperCase() !== 'AUTH_HOLD' && String(p.status || '').toUpperCase() !== 'VOID')
      .reduce((s, p) => s + Number(p.amount || 0), 0).toFixed(2));
  }, [payments, hasAgreementTotals, agreementTotals]);
  const unpaid = useMemo(() => {
    if (hasAgreementTotals) return Math.max(0, Number(Number(agreementTotals.balance || 0).toFixed(2)));
    return Math.max(0, Number((total - paid).toFixed(2)));
  }, [total, paid, hasAgreementTotals, agreementTotals]);
  const paymentCount = payments.length;
  const securityDepositHold = useMemo(() => deriveSecurityDepositHold(row), [row]);
  const cardOnFileReady = !!(row?.customer?.authnetCustomerProfileId && row?.customer?.authnetPaymentProfileId);
  const spinState = useMemo(() => deriveSpinState(row), [row]);

  // Spin operational tools — form state for the three actions.
  const [spinChargeAmount, setSpinChargeAmount] = useState('');
  const [spinChargeNotes, setSpinChargeNotes] = useState('');
  const [spinReleaseReason, setSpinReleaseReason] = useState('');
  const [spinReauthAmount, setSpinReauthAmount] = useState('');

  useEffect(() => {
    if (!cardChargeAmount && unpaid > 0) {
      setCardChargeAmount(unpaid.toFixed(2));
    }
  }, [unpaid, cardChargeAmount]);

  useEffect(() => {
    if (!holdAmount && securityDepositHold.amount > 0) {
      setHoldAmount(securityDepositHold.amount.toFixed(2));
    }
  }, [securityDepositHold.amount, holdAmount]);

  // Prefill Spin "Charge card on file" with the unpaid balance and the
  // re-auth amount with the existing hold amount (or configured deposit
  // amount if no hold yet). Both leave manual entries alone.
  useEffect(() => {
    if (!spinChargeAmount && unpaid > 0) {
      setSpinChargeAmount(unpaid.toFixed(2));
    }
  }, [unpaid, spinChargeAmount]);

  useEffect(() => {
    if (!spinReauthAmount) {
      const target = spinState.depositHoldAmount || securityDepositHold.amount;
      if (target > 0) setSpinReauthAmount(target.toFixed(2));
    }
  }, [spinState.depositHoldAmount, securityDepositHold.amount, spinReauthAmount]);

  // When the agent flips Method to AUTH_HOLD, prefill Amount with the
  // configured security-deposit amount (typical workflow: swipe card for
  // the deposit, record the auth code). Doesn't clobber a manual entry.
  useEffect(() => {
    if (method === 'AUTH_HOLD' && !amount && securityDepositHold.amount > 0) {
      setAmount(securityDepositHold.amount.toFixed(2));
    }
  }, [method, amount, securityDepositHold.amount]);

  useEffect(() => {
    if (!id || unpaid <= 0) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      load().catch(() => {});
    }, 10000);
    return () => window.clearInterval(timer);
  }, [id, unpaid]);

  const addPayment = async () => {
    try {
      const v = Number(amount || 0);
      if (!(v > 0)) return setMsg(t('viewPayments.msg.invalidAmount', 'Enter a valid amount'));
      // AUTH_HOLD bypasses the unpaid-balance cap — it's a security deposit
      // authorization swipe, NOT a settled payment against the rental fees.
      // The hold amount can (and usually does) exceed the rental balance.
      if (method !== 'AUTH_HOLD' && v - unpaid > 0.009) return setMsg(t('viewPayments.msg.exceedsBalance', 'Amount exceeds unpaid balance ({{amount}})', { amount: money(unpaid) }));
      // Last 4 of card is required when method is CARD — audit trail for
      // counter card swipes, matches the auth code shown on the merchant slip.
      if (method === 'CARD') {
        const digits = String(cardLast4 || '').replace(/\D/g, '');
        if (digits.length !== 4) return setMsg(t('viewPayments.msg.last4Required', 'Last 4 digits of card are required for card payments'));
      }
      // AUTH_HOLD = security deposit authorization swipe. The auth code is
      // the only audit trail (no settled funds, no AuthNet transId), so the
      // Reference field must be populated.
      if (method === 'AUTH_HOLD' && !String(reference || '').trim()) {
        return setMsg(t('viewPayments.msg.authCodeRequired', 'Auth code is required in Reference for Auth Hold payments'));
      }
      // Bundle the last4 into the reference string so it shows on the payment
      // history (e.g. "****1234 · auth A8K2X9"). Stored alongside the reference.
      const refParts = [];
      if (method === 'CARD' && cardLast4) refParts.push(`****${String(cardLast4).replace(/\D/g, '').slice(-4)}`);
      if (reference) refParts.push(reference);
      const referenceFinal = refParts.join(' · ') || `OTC-${Date.now()}`;
      setSaving(true);
      await api(`/api/reservations/${id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: v,
          method,
          reference: referenceFinal,
          origin: 'OTC'
        })
      }, token);
      await load();
      setAmount('');
      setReference('');
      setCardLast4('');
      setMsg(t('viewPayments.msg.recorded', 'Payment recorded'));
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  const runPaymentAction = async (path, { body, successMessage, busyKey, silent = false } = {}) => {
    try {
      setActionBusy(busyKey || path);
      if (!silent) setMsg('');
      const response = await api(path, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined
      }, token);
      await load();
      if (!silent) {
        setMsg(typeof successMessage === 'function' ? successMessage(response) : (successMessage || 'Action completed'));
      }
      return response;
    } catch (e) {
      if (!silent) setMsg(String(e.message || e));
      throw e;
    } finally {
      setActionBusy('');
    }
  };

  const chargeSavedCard = async () => {
    const v = Number(cardChargeAmount || 0);
    if (!(v > 0)) return setMsg(t('viewPayments.msg.invalidAmount', 'Enter a valid amount'));
    await runPaymentAction(`/api/reservations/${id}/payments/charge-card-on-file`, {
      body: { amount: v },
      successMessage: `Charged card on file: ${money(v)}`,
      busyKey: 'charge-card'
    });
  };

  const captureHold = async () => {
    const v = Number(holdAmount || securityDepositHold.amount || 0);
    if (!(v > 0)) return setMsg(t('viewPayments.msg.invalidAmount', 'Enter a valid amount'));
    await runPaymentAction(`/api/reservations/${id}/agreement/security-deposit/capture`, {
      body: { amount: v },
      successMessage: `Security deposit hold authorized: ${money(v)}`,
      busyKey: 'capture-hold'
    });
  };

  const releaseHold = async () => {
    await runPaymentAction(`/api/reservations/${id}/agreement/security-deposit/release`, {
      body: {},
      successMessage: 'Security deposit hold released',
      busyKey: 'release-hold'
    });
  };

  // ── Spin (Dejavoo) operational tool handlers ──────────────────────
  // These hit the server-side endpoints that operate against the saved iPOS
  // token + deposit hold reference. The token never leaves the server. The
  // unpaid-balance auto-prefill makes the typical "settle the remaining
  // balance" flow a single click.
  const spinChargeOnFile = async () => {
    const v = Number(spinChargeAmount || 0);
    if (!(v > 0)) return setMsg(t('viewPayments.msg.invalidAmount', 'Enter a valid amount'));
    await runPaymentAction(`/api/reservations/${id}/agreement/spin/charge-card-on-file`, {
      body: { amount: v, notes: spinChargeNotes || undefined },
      successMessage: `Spin card-on-file charged: ${money(v)}`,
      busyKey: 'spin-charge'
    });
    setSpinChargeAmount('');
    setSpinChargeNotes('');
  };

  const requestSpinRelease = () => {
    const reason = String(spinReleaseReason || '').trim();
    if (!reason) return setMsg('Enter a reason for releasing the deposit hold');
    setDialog({ kind: 'spin-release', isManualHold: spinState.isManualHold });
  };

  const spinReleaseDeposit = async () => {
    const reason = String(spinReleaseReason || '').trim();
    if (!reason) return;
    await runPaymentAction(`/api/reservations/${id}/agreement/spin/release-deposit`, {
      body: { reason },
      successMessage: 'Spin deposit hold released',
      busyKey: 'spin-release'
    });
    setSpinReleaseReason('');
    setDialog(null);
  };

  const requestSpinReauth = () => {
    const v = Number(spinReauthAmount || 0);
    if (!(v > 0)) return setMsg(t('viewPayments.msg.invalidAmount', 'Enter a valid amount'));
    if (spinState.depositHoldActive) {
      setDialog({ kind: 'spin-reauth', oldAmount: spinState.depositHoldAmount, newAmount: v });
      return;
    }
    spinReauthDeposit();
  };

  const spinReauthDeposit = async () => {
    const v = Number(spinReauthAmount || 0);
    if (!(v > 0)) return;
    await runPaymentAction(`/api/reservations/${id}/agreement/spin/reauth-deposit`, {
      body: { amount: v },
      successMessage: `Spin deposit re-authorized: ${money(v)}`,
      busyKey: 'spin-reauth'
    });
    setDialog(null);
  };

  const saveCardOnFile = async (paymentId) => {
    await runPaymentAction(`/api/reservations/${id}/payments/${paymentId}/save-card-on-file`, {
      body: {},
      successMessage: 'Customer card saved on file',
      busyKey: `save-card-${paymentId}`
    });
  };

  const reconcileAuthNetPayment = async () => {
    await runPaymentAction(`/api/reservations/${id}/payments/reconcile-authorizenet`, {
      body: {
        amount: unpaid > 0 ? unpaid : undefined,
        reference: String(reconcileRef || '').trim() || undefined
      },
      successMessage: (response) => {
        const amountPosted = Number(response?.amount || unpaid || 0);
        const referencePosted = String(response?.reference || '').trim();
        const savedCard = !!response?.savedCardOnFile;
        return `Authorize.Net payment reconciled${amountPosted > 0 ? `: ${money(amountPosted)}` : ''}${referencePosted ? ` | ${referencePosted}` : ''}${savedCard ? ' | card saved on file' : ''}`;
      },
      busyKey: 'reconcile-authnet'
    });
    setReconcileRef('');
  };

  const silentReconcileAuthNetPayment = async () => {
    try {
      await runPaymentAction(`/api/reservations/${id}/payments/reconcile-authorizenet`, {
        body: {
          amount: unpaid > 0 ? unpaid : undefined
        },
        busyKey: 'reconcile-authnet',
        silent: true
      });
      setMsg(t('viewPayments.msg.autoReconciled', 'Authorize.Net payment detected and posted automatically.'));
      return true;
    } catch (e) {
      const message = String(e?.message || e || '');
      if (/No recent Authorize\.Net payment found|not yet captured/i.test(message)) {
        return false;
      }
      setMsg(message || 'Unable to auto-reconcile Authorize.Net payment');
      return false;
    }
  };

  const refundPayment = async (payment, amountToRefund) => {
    if (!(amountToRefund > 0)) return;
    await runPaymentAction(`/api/reservations/${id}/payments/${payment.id}/refund`, {
      body: { amount: amountToRefund },
      successMessage: `Refund posted: ${money(amountToRefund)}`,
      busyKey: `refund-${payment.id}`
    });
    setDialog(null);
  };

  // ADMIN-only. Bookkeeping void: marks an erroneous payment VOID so it drops out
  // of the collected/balance math. This does NOT move money — no refund to the card.
  // For a real card refund use the "Refund" action instead.
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(String(me?.role || '').toUpperCase());

  // Payment Actions capability (2026-07-25).
  //
  // MIRRORS requireCapability('paymentActions') in backend/src/middleware/auth.js
  // EXACTLY: SUPER_ADMIN bypasses, everyone else needs an explicit `true`.
  // Deliberately NOT isModuleEnabled() from lib/moduleAccess — that helper is
  // `!== false` (fail-open) and would light buttons up for a user the backend
  // then 403s.
  //
  // me.moduleAccess already carries the anti-self-lockout carve-out, because the
  // session is built from getEffectiveModuleAccessForUser -> the same editable
  // config the People screen renders. So an admin never sees their own buttons
  // greyed out while the backend would have allowed them.
  //
  // THIS IS UX COURTESY, NOT THE DEFENSE. The gate is the backend. A stale
  // session (30s TTL), a race, or a deep link can still produce a 403 — which is
  // why the server message was made human-readable too.
  const canPaymentActions =
    String(me?.role || '').toUpperCase() === 'SUPER_ADMIN' || me?.moduleAccess?.paymentActions === true;
  const gatedProps = canPaymentActions ? {} : { disabled: true, title: t('viewPayments.lock.hint', 'Requires Payment Actions') };

  const voidPaymentNoRefund = async (payment, reason) => {
    if (!isAdmin) return setMsg('Admin role required to void a payment');
    if (!String(reason || '').trim()) return setMsg(t('viewPayments.dialog.voidReasonRequired', 'A reason is required to void a payment'));
    await runPaymentAction(`/api/reservations/${id}/payments/${payment.id}/void-no-refund`, {
      body: { reason: String(reason).trim() },
      successMessage: 'Payment voided (no refund) — balance updated',
      busyKey: `void-${payment.id}`
    });
    setDialog(null);
  };

  // ── Send payment link (universal collect action) ──────────────────
  // The server side already exists and is gateway-routed: /request-payment +
  // /send-request-email kind=payment land the customer on /customer/pay,
  // which mints against the TENANT's gateway (Stripe / Square / iPOS HPP /
  // Auth.Net hosted page). iPOS mints fail closed when unconfigured.
  const sendPaymentLink = async (extraEmails) => {
    try {
      setActionBusy('send-link');
      const out = await api(`/api/reservations/${id}/send-request-email`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'payment', extraEmails })
      }, token);
      if (out?.emailSent === false) {
        let copied = '';
        try {
          if (out?.link && navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(out.link);
            copied = t('viewPayments.msg.copiedSuffix', ' and copied to clipboard');
          }
        } catch {}
        setMsg(t('viewPayments.msg.linkNotSent', 'Payment link email could not be sent. Link generated{{copied}}.', { copied }));
      } else {
        const to = out?.sentTo?.join(', ') || String(row?.customer?.email || '').trim();
        setMsg(t('viewPayments.msg.linkSent', 'Payment link sent to {{to}}', { to }));
      }
      setDialog(null);
      await load();
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setActionBusy('');
    }
  };

  useEffect(() => {
    if (!id) return;
    const nextKey = `${id}:${paymentCount}:${unpaid.toFixed(2)}`;
    if (autoReconcileKeyRef.current !== nextKey) {
      autoReconcileKeyRef.current = nextKey;
      autoReconcileAttemptsRef.current = 0;
    }
  }, [id, paymentCount, unpaid]);

  // beta.116: el auto-reconcile contra Authorize.Net queda LIMITADO.
  // Antes: hasta 12 intentos cada 15s para CUALQUIER reserva con balance,
  // reseteado en cada visita a la página -> loops de 400 en los logs de prod
  // (12x en 3 min reportado por el log-monitor). Ahora:
  //  - Solo reservas de website (WEB-...), que es donde el pago llega async.
  //  - Backoff exponencial 15s -> 30s -> 60s -> 120s (cap), max 6 intentos.
  //  - El boton manual "Reconcile" sigue disponible (Auth.Net tenants).
  //
  // 2026-08-30 (view-payments redesign): ADEMÁS gated por el gateway del
  // tenant. Antes disparaba llamadas reales a Authorize.Net para CUALQUIER
  // reserva WEB- con balance — un loop de 400s garantizado para tenants iPOS
  // como IRC. autoReconcileArmed() exige capabilities.gateway==='authorizenet';
  // capabilities desconocidas (fetch en curso o fallido) NUNCA arman el loop.
  const AUTO_RECONCILE_MAX_ATTEMPTS = 6;
  const isWebReservation = String(row?.reservationNumber || '').toUpperCase().startsWith('WEB-');
  const reconcileArmed = autoReconcileArmed({ caps, isWebReservation, unpaid });

  useEffect(() => {
    if (!id || unpaid <= 0 || actionBusy) return undefined;
    if (!reconcileArmed) return undefined;
    if (autoReconcileAttemptsRef.current >= AUTO_RECONCILE_MAX_ATTEMPTS) return undefined;

    const runAutoReconcile = async () => {
      autoReconcileAttemptsRef.current += 1;
      const reconciled = await silentReconcileAuthNetPayment();
      if (reconciled) {
        autoReconcileAttemptsRef.current = AUTO_RECONCILE_MAX_ATTEMPTS;
      }
    };

    const attempt = autoReconcileAttemptsRef.current;
    const delayMs = attempt === 0
      ? 1200
      : Math.min(15000 * Math.pow(2, attempt - 1), 120000);

    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'hidden') return;
      runAutoReconcile().catch(() => {});
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [id, unpaid, actionBusy, paymentCount, reconcileArmed]);

  // ── Derived render state ──────────────────────────────────────────
  const dueNowLabel = unpaid > 0
    ? t('viewPayments.chips.balanceDue', 'Balance due')
    : t('viewPayments.chips.paidInFull', 'Paid in full');
  const totalLabel = hasAgreementTotals
    ? t('viewPayments.snapshot.agreementTotal', 'Agreement total')
    : t('viewPayments.snapshot.estimatedTotal', 'Estimated total');
  const gatewayChipLabel = capsKnown
    ? t(`viewPayments.gateway.${caps.gateway}`, caps.gateway ? caps.gateway : t('viewPayments.gateway.unknown', 'Payment processor'))
    : null;
  const customerEmail = String(row?.customer?.email || '').trim();
  const linkExpiresAt = row?.paymentRequestTokenExpiresAt ? new Date(row.paymentRequestTokenExpiresAt) : null;
  const linkLive = !!(linkExpiresAt && !Number.isNaN(linkExpiresAt.getTime()) && linkExpiresAt.getTime() > Date.now());
  // The collect zone identity follows the TENANT gateway; reservation-level
  // SPIn evidence additionally keeps legacy charge tools reachable below.
  const collectMode = gwAuthnet ? 'authnet' : gwIpos ? 'spin' : gwLinkOnly ? 'linkonly' : 'universal';
  const showSpinCharge = spinState.hasCardOnFile; // evidence gate, tenant-independent
  const depositStatusText = securityDepositHold.releasedAt
    ? t('viewPayments.deposit.releasedOn', 'released {{when}}', { when: new Date(securityDepositHold.releasedAt).toLocaleString() })
    : securityDepositHold.captured
      ? t('viewPayments.deposit.authorizedOn', 'authorized {{when}}', { when: securityDepositHold.capturedAt ? new Date(securityDepositHold.capturedAt).toLocaleString() : '' })
      : t('viewPayments.deposit.pendingAuth', 'still pending authorization');

  const lockHint = (
    <span className="capability-lock-hint">🔒 {t('viewPayments.lock.hint', 'Requires Payment Actions')}</span>
  );

  const spinChargeBlock = showSpinCharge ? (
    <div className={canPaymentActions ? undefined : 'capability-locked'}>
      <div className="vp-cof">
        <span className="cardic">{(spinState.brand || 'CARD').slice(0, 6).toUpperCase()}</span>
        <div>
          <b>{spinState.brand ? `${spinState.brand} ` : ''}<span className="mono">···· {spinState.last4 || '----'}</span></b>
          {spinState.capturedAt ? (
            <div className="mono">{t('viewPayments.collect.capturedAt', 'captured {{when}}', { when: new Date(spinState.capturedAt).toLocaleString() })}</div>
          ) : null}
        </div>
        <div className="meta">{t('viewPayments.collect.spinCofMeta', 'SPIn card on file · token stays server-side')}</div>
      </div>
      <div className="vp-fgrid">
        <div className="stack">
          <label className="label">{t('viewPayments.collect.amount', 'Amount')}</label>
          <input
            type="number" min="0" step="0.01"
            value={spinChargeAmount}
            onChange={(e) => setSpinChargeAmount(e.target.value)}
            disabled={!canPaymentActions}
            placeholder={unpaid > 0 ? unpaid.toFixed(2) : '0.00'}
          />
        </div>
        <div className="stack">
          <label className="label">{t('viewPayments.collect.note', 'Note (optional)')}</label>
          <input
            value={spinChargeNotes}
            onChange={(e) => setSpinChargeNotes(e.target.value)}
            disabled={!canPaymentActions}
            placeholder={t('viewPayments.collect.notePlaceholder', 'e.g. toll reimbursement, late fee')}
          />
        </div>
        <div className="full vp-btn-row">
          <button onClick={spinChargeOnFile} {...gatedProps} disabled={!canPaymentActions || !!actionBusy}>
            {actionBusy === 'spin-charge'
              ? t('viewPayments.collect.charging', 'Charging…')
              : (<>{t('viewPayments.collect.chargeSpin', 'Charge card on file')} <span className="vp-amt">{money(Number(spinChargeAmount || 0) || unpaid)}</span></>)}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        {/* ── Header: identity + processor + status ────────────────── */}
        <div className="app-banner">
          <div className="vp-titlerow">
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">{t('viewPayments.title', 'Payments')}</span>
              <h3 style={{ margin: 0 }}>{row?.reservationNumber || `Reservation ${id}`}</h3>
              <p className="ui-muted" style={{ margin: 0 }}>{t('viewPayments.subtitle', 'Review the full payment picture, collect the balance, and record over-the-counter payments.')}</p>
            </div>
            <div className="right">
              {gatewayChipLabel ? (
                <span className="vp-gwchip" data-testid="gateway-chip">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>
                  {gatewayChipLabel}
                </span>
              ) : null}
              <span className={`status-chip ${unpaid > 0 ? 'warn' : 'good'}`}>{dueNowLabel}</span>
              <button className="button-subtle" onClick={() => router.push(`/reservations/${id}`)}>{t('viewPayments.back', 'Back')}</button>
            </div>
          </div>
          {/* ── Snapshot band: each number exactly once ─────────────── */}
          <div className="vp-kpis" style={{ marginTop: 14 }}>
            <div className="kpi">
              <span className="klab">{totalLabel}</span>
              <span className="kval">{money(total)}</span>
              {hasAgreementTotals ? <span className="kfoot">{t('viewPayments.snapshot.inclFees', 'incl. post-check-in fees')}</span> : null}
            </div>
            <div className="kpi">
              <span className="klab">{t('viewPayments.snapshot.collected', 'Collected')}</span>
              <span className="kval">{money(paid)}</span>
              <span className="kfoot">{t('viewPayments.snapshot.recorded', '{{count}} recorded', { count: paymentCount })} · {t('viewPayments.snapshot.holdsExcluded', 'holds excluded')}</span>
            </div>
            <div className="kpi vp-kpi--due">
              <span className="klab">{t('viewPayments.snapshot.balanceDue', 'Balance due')}</span>
              <span className="kval">{money(unpaid)}</span>
            </div>
            <div className="kpi">
              <span className="klab">{t('viewPayments.snapshot.depositHold', 'Deposit hold')}</span>
              <span className="kval">{money(spinState.depositHoldActive ? spinState.depositHoldAmount : securityDepositHold.amount)}</span>
              <span className="kfoot">
                {spinState.depositHoldActive ? (
                  <span className="chip chip--ok"><i className="led" />{t('viewPayments.chips.active', 'Active')}{spinState.isManualHold ? ` · ${t('viewPayments.chips.manual', 'MANUAL')}` : ''}</span>
                ) : securityDepositHold.releasedAt ? (
                  <span className="chip chip--neutral">{t('viewPayments.chips.released', 'Released')}</span>
                ) : securityDepositHold.captured ? (
                  <span className="chip chip--ok"><i className="led" />{t('viewPayments.chips.active', 'Active')}</span>
                ) : securityDepositHold.amount > 0 ? (
                  <span className="chip chip--warn"><i className="led" />{t('viewPayments.chips.pendingAuth', 'Pending authorization')}</span>
                ) : (
                  <span className="chip chip--neutral">{t('viewPayments.chips.notRequired', 'Not required')}</span>
                )}
              </span>
            </div>
          </div>
        </div>

        {msg ? <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{msg}</div> : null}

        {/* Payment Actions notice — ONE per screen, above the affected zones,
            so it is read before anything is clicked. Recording a terminal
            payment stays available and is deliberately prominent: it is what
            backs the promise the text makes. */}
        {!canPaymentActions ? (
          <div className="surface-note">
            <strong>{t('viewPayments.lock.notice', 'Payment Actions is turned off for your account. You can still record a payment taken on the card terminal. To charge or refund a card, ask an admin.')}</strong>
          </div>
        ) : null}

        {/* ── Work zones: Collect (make money move) / Record (write down) ── */}
        <div className="vp-zones">
          {/* COLLECT */}
          <section className="vp-zcard" data-testid="collect-zone">
            <div className="vp-zhead">
              <h3>{t('viewPayments.collect.title', 'Collect the balance')}</h3>
              {!canPaymentActions ? lockHint : <span className="chip chip--brand">{t('viewPayments.chips.paymentActions', 'Payment Actions')}</span>}
            </div>

            {collectMode === 'spin' ? (
              <>
                <p className="vp-zdesc">{t('viewPayments.collect.spinDesc', 'Card-not-present charge against the token captured at checkout — no second tap on the terminal.')}</p>
                {showSpinCharge ? spinChargeBlock : (
                  <p className="vp-zdesc">{t('viewPayments.collect.noCofSpin', 'No card on file yet — a card is captured at checkout, or send a payment link.')}</p>
                )}
              </>
            ) : null}

            {collectMode === 'authnet' ? (
              <>
                <p className="vp-zdesc">{t('viewPayments.collect.authnetDesc', "Charges the customer's saved Authorize.Net card profile.")}</p>
                <div className={canPaymentActions ? undefined : 'capability-locked'}>
                  {cardOnFileReady ? (
                    <div className="vp-cof">
                      <span className="cardic">CARD</span>
                      <div><b>{t('viewPayments.collect.authnetCofMeta', 'Authorize.Net card on file')}</b></div>
                    </div>
                  ) : (
                    <p className="vp-zdesc">{t('viewPayments.collect.noCofAuthnet', 'Save a card from an Authorize.Net payment before charging on file.')}</p>
                  )}
                  <div className="vp-fgrid">
                    <div className="stack">
                      <label className="label">{t('viewPayments.collect.amount', 'Amount')}</label>
                      <input type="number" min="0" step="0.01" value={cardChargeAmount} onChange={(e) => setCardChargeAmount(e.target.value)} disabled={!canPaymentActions} />
                    </div>
                    <div className="stack" style={{ justifyContent: 'flex-end' }}>
                      <button onClick={chargeSavedCard} {...gatedProps} disabled={!canPaymentActions || !cardOnFileReady || !!actionBusy}>
                        {actionBusy === 'charge-card'
                          ? t('viewPayments.collect.charging', 'Charging…')
                          : (<>{t('viewPayments.collect.chargeAuthnet', 'Charge saved card')} <span className="vp-amt">{money(Number(cardChargeAmount || 0) || unpaid)}</span></>)}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {collectMode === 'linkonly' ? (
              <div className="vp-honest">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></svg>
                {t('viewPayments.collect.linkOnlyDesc', 'This processor supports payment links only — no card-on-file actions from this page.')}
              </div>
            ) : null}

            {collectMode === 'universal' ? (
              <p className="vp-zdesc">{t('viewPayments.collect.noGatewayDesc', 'Send the customer a secure payment link, or record a payment taken at the counter.')}</p>
            ) : null}

            {/* Legacy serviceability: SPIn evidence keeps its charge tool even
                when the tenant's gateway is no longer ipos. */}
            {collectMode !== 'spin' && showSpinCharge ? spinChargeBlock : null}

            {/* Send payment link — the universal collect verb (gateway-routed
                server-side; iPOS mints fail closed when unconfigured). */}
            <div className="vp-btn-row" style={{ marginTop: 12 }}>
              <span className={canPaymentActions ? undefined : 'capability-locked'}>
                <button className="button-subtle" onClick={() => setDialog({ kind: 'send-link' })} {...gatedProps} disabled={!canPaymentActions || !!actionBusy}>
                  {t('viewPayments.collect.sendLink', 'Send payment link')}
                </button>
              </span>
            </div>
            {gwIpos && caps?.ipos?.enabled && caps.ipos.linkReady === false ? (
              <p className="vp-zdesc" style={{ marginTop: 8, color: 'var(--warn-tx)' }}>
                {t('viewPayments.collect.linkNotReady', 'Payment links are not set up for this account yet — an admin can add the iPOS ecom token in Settings.')}
              </p>
            ) : null}

            {/* Honest status lines — only when they can be true. */}
            {linkLive ? (
              <div className="vp-watchline">
                <span className="pulse" />
                {t('viewPayments.collect.linkSent', 'Payment link live · expires {{when}}', { when: linkExpiresAt.toLocaleString() })}
              </div>
            ) : null}
            {reconcileArmed ? (
              <div className="vp-watchline">
                <span className="pulse" />
                {t('viewPayments.collect.watchAuthnet', 'Website reservation — checking Authorize.Net for a recent hosted payment while this page is open.')}
              </div>
            ) : null}

            {/* The old permanent transId tip, packaged as a disclosure.
                Authorize.Net tenants only — this can never succeed elsewhere. */}
            {gwAuthnet ? (
              <details className="vp-disclose">
                <summary>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                  {t('viewPayments.collect.disclosure', 'Find a missing Authorize.Net payment')}
                </summary>
                <div className="din">
                  <p className="dnote">{t('viewPayments.collect.disclosureBody', "Customer paid on the hosted page but it isn't listed? Paste the transId from the Authorize.Net receipt, or leave it blank to pull their most recent payment.")}</p>
                  <div className="stack" style={{ flex: 1, minWidth: 200 }}>
                    <label className="label">{t('viewPayments.collect.transId', 'Transaction ID (optional)')}</label>
                    <input value={reconcileRef} onChange={(e) => setReconcileRef(e.target.value)} placeholder="e.g. 120058491022" />
                  </div>
                  <span className={canPaymentActions ? undefined : 'capability-locked'}>
                    <button className="button-subtle" onClick={reconcileAuthNetPayment} {...gatedProps} disabled={!canPaymentActions || !!actionBusy}>
                      {actionBusy === 'reconcile-authnet' ? t('viewPayments.collect.reconciling', 'Reconciling…') : t('viewPayments.collect.reconcile', 'Reconcile payment')}
                    </button>
                  </span>
                </div>
              </details>
            ) : null}
          </section>

          {/* RECORD — always available, never capability-locked (standing rule). */}
          <section className="vp-zcard" data-testid="record-zone">
            <div className="vp-zhead">
              <h3>{t('viewPayments.record.title', 'Record a payment')}</h3>
              <span className="chip chip--neutral">{t('viewPayments.chips.alwaysAvailable', 'Always available')}</span>
            </div>
            <p className="vp-zdesc">{t('viewPayments.record.desc', 'Money that already changed hands — cash, ATH Móvil, a slip from the card terminal. No gateway call.')}</p>
            <div className="vp-fgrid">
              <div className="stack">
                <label className="label">{t('viewPayments.record.amount', 'Amount')}</label>
                <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="stack">
                <label className="label">{t('viewPayments.record.method', 'Method')}</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {['CASH', 'CHECK', 'CARD', 'ZELLE', 'ATH_MOVIL', 'BANK_TRANSFER', 'AUTH_HOLD', 'OTHER'].map((m) => (
                    <option key={m} value={m}>{t(`viewPayments.record.methods.${m}`, m)}</option>
                  ))}
                </select>
              </div>
              {method === 'CARD' ? (
                <div className="stack">
                  <label className="label">{t('viewPayments.record.last4', 'Last 4 of card')} <span style={{ color: 'var(--danger-tx)' }}>*</span></label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    pattern="[0-9]{4}"
                    value={cardLast4}
                    onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="4242"
                  />
                  <span className="ui-muted">{t('viewPayments.record.last4Help', 'Required for card · audit trail for counter swipes')}</span>
                </div>
              ) : null}
              <div data-tour="payment-reference" className="stack">
                <label className="label">{t('viewPayments.record.reference', 'Reference')}{method === 'AUTH_HOLD' ? <span style={{ color: 'var(--danger-tx)' }}> *</span> : null}</label>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder={method === 'CARD' ? t('viewPayments.record.authCodeOptional', 'Auth code (optional)') : method === 'AUTH_HOLD' ? t('viewPayments.record.authCodeRequired', 'Auth code (required)') : ''}
                />
              </div>
              {method === 'AUTH_HOLD' ? (
                <div className="full surface-note">
                  {t('viewPayments.record.authHoldNote', "Auth hold: records a security-deposit authorization on the customer's card. Funds are NOT settled — only the auth code is on file. Enter the auth code in Reference so the outstanding balance reflects rental fees only.")}
                </div>
              ) : null}
              <div className="full vp-btn-row" style={{ justifyContent: 'flex-end' }}>
                <button onClick={addPayment} disabled={saving || (method === 'CARD' && String(cardLast4).replace(/\D/g, '').length !== 4)}>
                  {saving ? t('viewPayments.record.saving', 'Saving…') : t('viewPayments.record.submit', 'Record payment')}
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* ── Deposit band(s) ──────────────────────────────────────── */}
        {(spinState.depositHoldActive || spinState.hasCardOnFile) ? (
          <div className={`vp-depband${canPaymentActions ? '' : ' capability-locked'}`} data-testid="deposit-band-spin">
            <span className="dic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3 4 6v6c0 4.4 3.4 8.5 8 9.5 4.6-1 8-5.1 8-9.5V6Z" /></svg></span>
            <div className="dmain">
              <b>
                {t('viewPayments.deposit.title', 'Security deposit hold')}
                {spinState.depositHoldActive ? (
                  <span className="chip chip--ok" style={{ marginLeft: 6 }}><i className="led" />{t('viewPayments.chips.active', 'Active')}</span>
                ) : null}
                {spinState.isManualHold ? (
                  <span className="chip chip--warn" style={{ marginLeft: 6 }}>{t('viewPayments.chips.manual', 'MANUAL')}</span>
                ) : null}
                {!canPaymentActions ? <span style={{ marginLeft: 8 }}>{lockHint}</span> : null}
              </b>
              {spinState.depositHoldActive ? (
                <span>
                  {t('viewPayments.deposit.holdOnCard', 'Authorization on {{card}}', { card: spinState.last4 ? `${spinState.brand || ''} ····${spinState.last4}` : t('viewPayments.deposit.savedCard', 'the saved card') })}
                  {' · '}{t('viewPayments.deposit.refLabel', 'Ref {{ref}}', { ref: spinState.depositHoldId })}
                  {' · '}
                  {spinState.isManualHold
                    ? t('viewPayments.deposit.manualReleaseHelp', 'Manual hold — releasing only updates Ride Fleet records (no terminal void).')
                    : t('viewPayments.deposit.spinReleaseHelp', 'Voids the SPIn authorization on the customer’s card.')}
                </span>
              ) : (
                <span>{t('viewPayments.deposit.placeHoldHelp', 'No active hold on file. Places one against the saved card.')}</span>
              )}
            </div>
            <span className="dmoney">{money(spinState.depositHoldActive ? spinState.depositHoldAmount : (Number(spinReauthAmount) || spinState.depositHoldAmount || securityDepositHold.amount))}</span>
            <div className="dactions">
              {spinState.depositHoldActive ? (
                <>
                  <div className="stack">
                    <label className="label">{t('viewPayments.deposit.releaseReason', 'Release reason')} <span style={{ color: 'var(--danger-tx)' }}>*</span></label>
                    <input
                      value={spinReleaseReason}
                      onChange={(e) => setSpinReleaseReason(e.target.value)}
                      disabled={!canPaymentActions}
                      placeholder={t('viewPayments.deposit.releaseReasonPh', 'e.g. clean return, no damages')}
                    />
                  </div>
                  <button className="button-subtle" onClick={requestSpinRelease} {...gatedProps} disabled={!canPaymentActions || !!actionBusy || !spinReleaseReason.trim()}>
                    {actionBusy === 'spin-release' ? t('viewPayments.deposit.releasing', 'Releasing…') : t('viewPayments.deposit.releaseHold', 'Release hold')}
                  </button>
                </>
              ) : null}
              {spinState.hasCardOnFile ? (
                <>
                  <div className="stack">
                    <label className="label">
                      {spinState.depositHoldActive
                        ? t('viewPayments.deposit.newAmount', 'Re-authorize · new amount')
                        : t('viewPayments.deposit.amount', 'Amount')}
                    </label>
                    <input
                      type="number" min="0" step="0.01"
                      value={spinReauthAmount}
                      onChange={(e) => setSpinReauthAmount(e.target.value)}
                      disabled={!canPaymentActions}
                    />
                  </div>
                  <button className="button-subtle" onClick={requestSpinReauth} {...gatedProps} disabled={!canPaymentActions || !!actionBusy}>
                    {actionBusy === 'spin-reauth'
                      ? (spinState.depositHoldActive ? t('viewPayments.deposit.reauthorizing', 'Re-authorizing…') : t('viewPayments.deposit.authorizing', 'Authorizing…'))
                      : (spinState.depositHoldActive ? t('viewPayments.deposit.reauthorize', 'Re-authorize deposit') : t('viewPayments.deposit.placeHold', 'Authorize deposit hold'))}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {gwAuthnet ? (
          <div className={`vp-depband${canPaymentActions ? '' : ' capability-locked'}`} data-testid="deposit-band-authnet">
            <span className="dic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3 4 6v6c0 4.4 3.4 8.5 8 9.5 4.6-1 8-5.1 8-9.5V6Z" /></svg></span>
            <div className="dmain">
              <b>
                {t('viewPayments.deposit.title', 'Security deposit hold')}
                {securityDepositHold.captured && !securityDepositHold.releasedAt ? (
                  <span className="chip chip--ok" style={{ marginLeft: 6 }}><i className="led" />{t('viewPayments.chips.active', 'Active')}</span>
                ) : securityDepositHold.amount > 0 && !securityDepositHold.releasedAt ? (
                  <span className="chip chip--warn" style={{ marginLeft: 6 }}><i className="led" />{t('viewPayments.chips.pendingAuth', 'Pending authorization')}</span>
                ) : null}
                {!canPaymentActions ? <span style={{ marginLeft: 8 }}>{lockHint}</span> : null}
              </b>
              <span>
                {securityDepositHold.amount > 0 || securityDepositHold.captured
                  ? <>{depositStatusText}{securityDepositHold.reference ? ` · ${t('viewPayments.deposit.refLabel', 'Ref {{ref}}', { ref: securityDepositHold.reference })}` : ''}</>
                  : t('viewPayments.deposit.configured', 'Places an auth-only hold on the saved card at pickup')}
              </span>
            </div>
            <span className="dmoney">{money(Number(holdAmount) || securityDepositHold.amount)}</span>
            <div className="dactions">
              {!securityDepositHold.captured ? (
                <>
                  <div className="stack">
                    <label className="label">{t('viewPayments.deposit.amount', 'Amount')}</label>
                    <input type="number" min="0" step="0.01" value={holdAmount} onChange={(e) => setHoldAmount(e.target.value)} disabled={!canPaymentActions} />
                  </div>
                  <button className="button-subtle" onClick={captureHold} {...gatedProps} disabled={!canPaymentActions || !cardOnFileReady || !!actionBusy}>
                    {actionBusy === 'capture-hold' ? t('viewPayments.deposit.authorizing', 'Authorizing…') : t('viewPayments.deposit.authorizeHold', 'Authorize hold')}
                  </button>
                </>
              ) : (
                <button className="button-subtle" onClick={releaseHold} {...gatedProps} disabled={!canPaymentActions || !!actionBusy}>
                  {actionBusy === 'release-hold' ? t('viewPayments.deposit.releasing', 'Releasing…') : t('viewPayments.deposit.releaseHold', 'Release hold')}
                </button>
              )}
            </div>
          </div>
        ) : null}

        {/* Deposit info strip for tenants with no gateway hold tools on this
            page (stripe/square/unknown) — status still visible, no dead buttons. */}
        {!gwAuthnet && !spinState.depositHoldActive && !spinState.hasCardOnFile && securityDepositHold.amount > 0 ? (
          <div className="vp-depband" data-testid="deposit-band-info">
            <span className="dic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3 4 6v6c0 4.4 3.4 8.5 8 9.5 4.6-1 8-5.1 8-9.5V6Z" /></svg></span>
            <div className="dmain">
              <b>{t('viewPayments.deposit.title', 'Security deposit hold')}</b>
              <span>{depositStatusText}{securityDepositHold.reference ? ` · ${t('viewPayments.deposit.refLabel', 'Ref {{ref}}', { ref: securityDepositHold.reference })}` : ''}</span>
            </div>
            <span className="dmoney">{money(securityDepositHold.amount)}</span>
          </div>
        ) : null}

        {/* ── History — the audit surface, one overflow per row ───── */}
        <div className="vp-hist" data-testid="payment-history">
          <div className="vp-hist-head">
            <h3>{t('viewPayments.history.title', 'Payment history')}</h3>
            <span className="cnt">{paymentCount}</span>
            {!canPaymentActions ? <span style={{ marginLeft: 'auto' }}>{lockHint}</span> : null}
          </div>
          <div className="tbl-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('viewPayments.history.when', 'When')}</th>
                  <th>{t('viewPayments.history.method', 'Method')}</th>
                  <th>{t('viewPayments.history.reference', 'Reference')}</th>
                  <th style={{ textAlign: 'right' }}>{t('viewPayments.history.amount', 'Amount')}</th>
                  <th aria-label={t('viewPayments.rowActions.more', 'More actions')} />
                </tr>
              </thead>
              <tbody>
                {payments.length ? payments.map((p) => {
                  const isVoid = p.status === 'VOID';
                  const isNegative = Number(p.amount || 0) < 0;
                  const canRefund = Number(p.amount || 0) > 0 && !isVoid;
                  const canVoid = isAdmin && p.method !== 'AUTH_HOLD' && !isVoid;
                  const canSaveCard = gwAuthnet && String(p.reference || '').toUpperCase().startsWith('AUTHNET:') && !isVoid;
                  const rKind = refundKind(p.reference);
                  const hasMenu = canRefund || canVoid || canSaveCard || !!p.reference;
                  return (
                    <tr key={p.id} className={isVoid ? 'vp-void' : undefined}>
                      <td><div className="when"><b>{new Date(p.paidAt).toLocaleString()}</b></div></td>
                      <td>
                        <span className={`vp-mchip${p.method === 'AUTH_HOLD' ? ' hold' : ''}`}>
                          {t(`viewPayments.record.methods.${p.method}`, p.method)}
                          {p.method === 'AUTH_HOLD' ? ` · ${t('viewPayments.chips.hold', 'Hold · not settled')}` : ''}
                        </span>
                        {isVoid ? (
                          <span className="chip chip--danger" style={{ marginLeft: 6 }}>{t('viewPayments.chips.voidChip', 'VOID')}</span>
                        ) : null}
                      </td>
                      <td><ReferenceCell reference={p.reference} onCopied={() => setMsg(t('viewPayments.rowActions.refCopied', 'Reference copied'))} /></td>
                      <td className={`money-cell${isNegative ? ' neg' : ''}`}>{isNegative ? `−${money(Math.abs(p.amount))}` : money(p.amount)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {hasMenu ? (
                          <details className="tq-menu">
                            <summary title={t('viewPayments.rowActions.more', 'More actions')}><DotsIcon /></summary>
                            <div className="tq-menu-pop" style={{ minWidth: 250 }}>
                              {canRefund ? (
                                <button
                                  type="button"
                                  disabled={!canPaymentActions || !!actionBusy}
                                  title={canPaymentActions ? undefined : t('viewPayments.lock.hint', 'Requires Payment Actions')}
                                  onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); setDialog({ kind: 'refund', payment: p }); }}
                                >
                                  {rKind === 'card' ? t('viewPayments.rowActions.refundCard', 'Refund to card') : t('viewPayments.rowActions.refundRecord', 'Record refund')}
                                  <small>{rKind === 'card' ? t('viewPayments.rowActions.refundCardDesc', 'Real refund via the processor (void if unsettled)') : t('viewPayments.rowActions.refundRecordDesc', 'Posts a negative row — no card movement')}</small>
                                </button>
                              ) : null}
                              {canSaveCard ? (
                                <button
                                  type="button"
                                  disabled={!canPaymentActions || cardOnFileReady || !!actionBusy}
                                  title={canPaymentActions ? undefined : t('viewPayments.lock.hint', 'Requires Payment Actions')}
                                  onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); saveCardOnFile(p.id); }}
                                >
                                  {cardOnFileReady ? t('viewPayments.rowActions.cardSaved', 'Card already on file') : t('viewPayments.rowActions.saveCard', 'Save card to file')}
                                  {!cardOnFileReady ? <small>{t('viewPayments.rowActions.saveCardDesc', 'Creates the Authorize.Net profile from this transaction')}</small> : null}
                                </button>
                              ) : null}
                              {p.reference ? (
                                <button
                                  type="button"
                                  onClick={async (e) => {
                                    e.currentTarget.closest('details')?.removeAttribute('open');
                                    try {
                                      if (navigator?.clipboard?.writeText) {
                                        await navigator.clipboard.writeText(String(p.reference));
                                        setMsg(t('viewPayments.rowActions.refCopied', 'Reference copied'));
                                      }
                                    } catch {}
                                  }}
                                >
                                  {t('viewPayments.rowActions.copyRef', 'Copy reference')}
                                  <small>{p.reference}</small>
                                </button>
                              ) : null}
                              {canVoid ? (
                                <Fragment>
                                  <div className="sep" />
                                  <button
                                    type="button"
                                    className="danger"
                                    disabled={!!actionBusy}
                                    onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); setDialog({ kind: 'void', payment: p }); }}
                                  >
                                    {t('viewPayments.rowActions.voidPayment', 'Void · no refund')}
                                    <small>{t('viewPayments.rowActions.voidDesc', 'Admin only · bookkeeping correction, money does not move')}</small>
                                  </button>
                                </Fragment>
                              ) : null}
                            </div>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  );
                }) : <tr><td colSpan={5}>{t('viewPayments.history.empty', 'No payments yet')}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="vp-foot">
            <span>{t('viewPayments.history.foot', 'Holds excluded from Collected · voids excluded from balance')}</span>
          </div>
        </div>
      </section>

      {/* ── Themed dialogs (no window.prompt / window.confirm) ─────── */}
      {dialog?.kind === 'refund' ? (
        <RefundDialog
          payment={dialog.payment}
          busy={actionBusy === `refund-${dialog.payment.id}`}
          onCancel={() => setDialog(null)}
          onApply={(v) => refundPayment(dialog.payment, v)}
        />
      ) : null}
      {dialog?.kind === 'void' ? (
        <VoidDialog
          payment={dialog.payment}
          busy={actionBusy === `void-${dialog.payment.id}`}
          onCancel={() => setDialog(null)}
          onApply={(reason) => voidPaymentNoRefund(dialog.payment, reason)}
        />
      ) : null}
      {dialog?.kind === 'spin-release' || dialog?.kind === 'spin-reauth' ? (
        <SpinConfirmDialog
          dialog={dialog}
          busy={actionBusy === 'spin-release' || actionBusy === 'spin-reauth'}
          onCancel={() => setDialog(null)}
          onConfirm={() => (dialog.kind === 'spin-release' ? spinReleaseDeposit() : spinReauthDeposit())}
        />
      ) : null}
      {dialog?.kind === 'send-link' ? (
        <SendLinkDialog
          customerEmail={customerEmail}
          busy={actionBusy === 'send-link'}
          onCancel={() => setDialog(null)}
          onSend={sendPaymentLink}
        />
      ) : null}
    </AppShell>
  );
}
