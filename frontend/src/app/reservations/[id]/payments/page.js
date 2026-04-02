'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

function normalizePaymentRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((p) => ({
    id: p.id,
    paidAt: p.paidAt,
    method: p.method,
    amount: Number(p.amount || 0),
    reference: p.reference || '',
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

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
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
  const [saving, setSaving] = useState(false);
  const [cardChargeAmount, setCardChargeAmount] = useState('');
  const [holdAmount, setHoldAmount] = useState('');
  const [actionBusy, setActionBusy] = useState('');

  const load = async () => {
    const [r, payments, pricingOut] = await Promise.all([
      api(`/api/reservations/${id}`, { bypassCache: true }, token),
      api(`/api/reservations/${id}/payments`, { bypassCache: true }, token).catch(() => []),
      api(`/api/reservations/${id}/pricing`, { bypassCache: true }, token).catch(() => null)
    ]);
    setRow(r);
    setPaymentRows(normalizePaymentRows(payments));
    setPricing(pricingOut);
  };

  useEffect(() => { if (id) load(); }, [id]);

  const payments = useMemo(() => paymentRows, [paymentRows]);
  const totalFromQuery = useMemo(() => Number(searchParams?.get('total') || 0), [searchParams]);
  const total = useMemo(() => {
    const fromPricing = Number(pricing?.totals?.total || 0);
    const fromRow = Number(deriveTotalFromReservationRow(row).toFixed(2));
    return Number(Math.max(totalFromQuery, fromPricing, fromRow).toFixed(2));
  }, [row, pricing?.totals?.total, totalFromQuery]);
  const paid = useMemo(() => Number(payments.reduce((s, p) => s + Number(p.amount || 0), 0).toFixed(2)), [payments]);
  const unpaid = useMemo(() => Math.max(0, Number((total - paid).toFixed(2))), [total, paid]);
  const paymentCount = payments.length;
  const dueNowLabel = unpaid > 0 ? 'Payment Still Needed' : 'Paid In Full';
  const securityDepositHold = useMemo(() => deriveSecurityDepositHold(row), [row]);
  const cardOnFileReady = !!(row?.customer?.authnetCustomerProfileId && row?.customer?.authnetPaymentProfileId);

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
      if (!(v > 0)) return setMsg('Enter a valid amount');
      if (v - unpaid > 0.009) return setMsg(`Amount exceeds unpaid balance ($${unpaid.toFixed(2)})`);
      setSaving(true);
      await api(`/api/reservations/${id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: v,
          method,
          reference: String(reference || `OTC-${Date.now()}`),
          origin: 'OTC'
        })
      }, token);
      await load();
      setAmount('');
      setReference('');
      setMsg('Payment recorded');
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  const runPaymentAction = async (path, { body, successMessage, busyKey } = {}) => {
    try {
      setActionBusy(busyKey || path);
      setMsg('');
      const response = await api(path, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined
      }, token);
      await load();
      setMsg(typeof successMessage === 'function' ? successMessage(response) : (successMessage || 'Action completed'));
    } catch (e) {
      setMsg(String(e.message || e));
    } finally {
      setActionBusy('');
    }
  };

  const chargeSavedCard = async () => {
    const v = Number(cardChargeAmount || 0);
    if (!(v > 0)) return setMsg('Enter a valid card charge amount');
    await runPaymentAction(`/api/reservations/${id}/payments/charge-card-on-file`, {
      body: { amount: v },
      successMessage: `Charged card on file: $${v.toFixed(2)}`,
      busyKey: 'charge-card'
    });
  };

  const captureHold = async () => {
    const v = Number(holdAmount || securityDepositHold.amount || 0);
    if (!(v > 0)) return setMsg('Enter a valid security deposit amount');
    await runPaymentAction(`/api/reservations/${id}/agreement/security-deposit/capture`, {
      body: { amount: v },
      successMessage: `Security deposit hold authorized: $${v.toFixed(2)}`,
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

  const saveCardOnFile = async (paymentId) => {
    await runPaymentAction(`/api/reservations/${id}/payments/${paymentId}/save-card-on-file`, {
      body: {},
      successMessage: 'Customer card saved on file',
      busyKey: `save-card-${paymentId}`
    });
  };

  const reconcileAuthNetPayment = async () => {
    await runPaymentAction(`/api/reservations/${id}/payments/reconcile-authorizenet`, {
      body: { amount: unpaid > 0 ? unpaid : undefined },
      successMessage: (response) => {
        const amountPosted = Number(response?.amount || unpaid || 0);
        const referencePosted = String(response?.reference || '').trim();
        const savedCard = !!response?.savedCardOnFile;
        return `Authorize.Net payment reconciled${amountPosted > 0 ? `: $${amountPosted.toFixed(2)}` : ''}${referencePosted ? ` | ${referencePosted}` : ''}${savedCard ? ' | card saved on file' : ''}`;
      },
      busyKey: 'reconcile-authnet'
    });
  };

  const refundPayment = async (payment) => {
    const max = Number(payment?.amount || 0);
    const input = window.prompt('Refund amount', max > 0 ? max.toFixed(2) : '0.00');
    if (input == null) return;
    const amountToRefund = Number(input || 0);
    if (!(amountToRefund > 0)) return setMsg('Enter a valid refund amount');
    await runPaymentAction(`/api/reservations/${id}/payments/${payment.id}/refund`, {
      body: { amount: amountToRefund },
      successMessage: `Refund posted: $${amountToRefund.toFixed(2)}`,
      busyKey: `refund-${payment.id}`
    });
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Payments Snapshot</span>
              <h3 style={{ margin: 0 }}>{row?.reservationNumber || `Reservation ${id}`}</h3>
              <p className="ui-muted">
                Review the full payment picture before recording over-the-counter collections or sending the guest back into the portal.
              </p>
            </div>
            <span className={`status-chip ${unpaid > 0 ? 'warn' : 'good'}`}>{dueNowLabel}</span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Estimated Total</span>
              <strong>${total.toFixed(2)}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Collected</span>
              <strong>${paid.toFixed(2)}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Unpaid Balance</span>
              <strong>${unpaid.toFixed(2)}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Payments Logged</span>
              <strong>{paymentCount}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Security Deposit Hold</span>
              <strong>{securityDepositHold.amount > 0 ? `$${securityDepositHold.amount.toFixed(2)}` : '$0.00'}</strong>
              <span className="ui-muted">
                {securityDepositHold.releasedAt
                  ? 'Released'
                  : securityDepositHold.captured
                    ? 'Authorized'
                    : securityDepositHold.amount > 0
                      ? 'Pending authorization'
                      : 'Not required'}
              </span>
            </div>
          </div>
        </div>

        <div className="row-between">
          <h2>Reservation Payments</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={reconcileAuthNetPayment} disabled={!!actionBusy}>
              {actionBusy === 'reconcile-authnet' ? 'Reconciling...' : 'Reconcile Latest AuthNet Payment'}
            </button>
            <button onClick={() => router.push(`/reservations/${id}`)}>Back</button>
          </div>
        </div>
        {msg ? <div className="label" style={{ marginBottom: 8 }}>{msg}</div> : null}
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Total: ${total.toFixed(2)}</div>
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Total Payments: ${paid.toFixed(2)}</div>
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0, marginBottom: 10 }}>Unpaid Balance: ${unpaid.toFixed(2)}</div>
        {securityDepositHold.amount > 0 ? (
          <div className="surface-note" style={{ marginBottom: 12 }}>
            <strong>Security Deposit Hold:</strong> ${securityDepositHold.amount.toFixed(2)}{' '}
            {securityDepositHold.releasedAt
              ? `released on ${new Date(securityDepositHold.releasedAt).toLocaleString()}`
              : securityDepositHold.captured
                ? `authorized${securityDepositHold.capturedAt ? ` on ${new Date(securityDepositHold.capturedAt).toLocaleString()}` : ''}`
                : 'still pending authorization'}
            {securityDepositHold.reference ? ` | Ref ${securityDepositHold.reference}` : ''}
          </div>
        ) : null}

        <div className="grid3" style={{ marginBottom: 10 }}>
          <div className="stack"><label className="label">Amount</label><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="stack"><label className="label">Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="ZELLE">Zelle</option>
              <option value="ATH_MOVIL">ATH Movil</option>
              <option value="BANK_TRANSFER">Bank Transfer</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div className="stack"><label className="label">Reference</label><input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        </div>
        <button onClick={addPayment} disabled={saving}>{saving ? 'Saving...' : 'Record OTC Payment'}</button>

        <div className="grid3" style={{ marginTop: 16, marginBottom: 10 }}>
          <div className="stack">
            <label className="label">Charge Saved Card</label>
            <input type="number" min="0" step="0.01" value={cardChargeAmount} onChange={(e) => setCardChargeAmount(e.target.value)} />
            <span className="ui-muted">{cardOnFileReady ? 'Customer already has an Authorize.Net card profile on file.' : 'Save a card from an Authorize.Net payment before charging on file.'}</span>
          </div>
          <div className="stack">
            <label className="label">Security Deposit Hold</label>
            <input type="number" min="0" step="0.01" value={holdAmount} onChange={(e) => setHoldAmount(e.target.value)} />
            <span className="ui-muted">
              {securityDepositHold.captured
                ? `Authorized${securityDepositHold.reference ? ` | Ref ${securityDepositHold.reference}` : ''}`
                : 'Places an auth-only hold on the saved card at pickup.'}
            </span>
          </div>
          <div className="stack" style={{ alignSelf: 'end' }}>
            <button onClick={chargeSavedCard} disabled={!cardOnFileReady || !!actionBusy}>
              {actionBusy === 'charge-card' ? 'Charging...' : 'Charge Card On File'}
            </button>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {!securityDepositHold.captured ? (
                <button onClick={captureHold} disabled={!cardOnFileReady || !!actionBusy}>
                  {actionBusy === 'capture-hold' ? 'Authorizing...' : 'Authorize Hold'}
                </button>
              ) : (
                <button onClick={releaseHold} disabled={!!actionBusy}>
                  {actionBusy === 'release-hold' ? 'Releasing...' : 'Release Hold'}
                </button>
              )}
            </div>
          </div>
        </div>

        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Date</th><th>Method</th><th>Amount</th><th>Reference</th><th>Actions</th></tr></thead>
          <tbody>
            {payments.length ? payments.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.paidAt).toLocaleString()}</td>
                <td>{p.method}</td>
                <td>${Number(p.amount || 0).toFixed(2)}</td>
                <td>{p.reference}</td>
                <td>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {Number(p.amount || 0) > 0 ? (
                      <button onClick={() => refundPayment(p)} disabled={!!actionBusy}>
                        {actionBusy === `refund-${p.id}` ? 'Refunding...' : 'Refund'}
                      </button>
                    ) : null}
                    {String(p.reference || '').toUpperCase().startsWith('AUTHNET:') ? (
                      <button onClick={() => saveCardOnFile(p.id)} disabled={cardOnFileReady || !!actionBusy}>
                        {cardOnFileReady ? 'Card Saved' : actionBusy === `save-card-${p.id}` ? 'Saving Card...' : 'Save Card To File'}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            )) : <tr><td colSpan={5}>No payments yet</td></tr>}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
