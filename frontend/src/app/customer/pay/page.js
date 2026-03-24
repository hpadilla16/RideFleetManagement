'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { PortalFrame, portalStyles } from '../_components/PortalFrame';
import { PortalTimelineCard } from '../_components/PortalTimelineCard';

const PAYMENT_PORTAL_STATE_PREFIX = 'customer.payment.';

function paymentPortalStateKey(token) {
  return `${PAYMENT_PORTAL_STATE_PREFIX}${token}`;
}

function restorePaymentPortalState(token) {
  if (!token || typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(paymentPortalStateKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      success: typeof parsed.success === 'string' ? parsed.success : '',
      canceled: typeof parsed.canceled === 'string' ? parsed.canceled : '',
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      returnTransId: typeof parsed.returnTransId === 'string' ? parsed.returnTransId : ''
    };
  } catch {
    return null;
  }
}

export default function CustomerPayPage() {
  const [token, setToken] = useState('');
  const [success, setSuccess] = useState('');
  const [canceled, setCanceled] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [returnTransId, setReturnTransId] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [model, setModel] = useState(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const nextToken = p.get('token') || '';
    const stored = restorePaymentPortalState(nextToken);
    setToken(nextToken);
    setSuccess(p.get('success') || stored?.success || '');
    setCanceled(p.get('canceled') || stored?.canceled || '');
    setSessionId(p.get('session_id') || stored?.sessionId || '');
    setReturnTransId(p.get('transId') || p.get('x_trans_id') || p.get('transaction_id') || stored?.returnTransId || '');
  }, []);

  useEffect(() => {
    if (!token) return;
    try {
      if (success || canceled || sessionId || returnTransId) {
        sessionStorage.setItem(paymentPortalStateKey(token), JSON.stringify({
          success,
          canceled,
          sessionId,
          returnTransId
        }));
      } else {
        sessionStorage.removeItem(paymentPortalStateKey(token));
      }
    } catch {}
  }, [canceled, returnTransId, sessionId, success, token]);

  useEffect(() => {
    const run = async () => {
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/api/public/payment/${encodeURIComponent(token)}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || 'Unable to load payment page');
        setModel(j);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [token]);

  useEffect(() => {
    const autoConfirmReturn = async () => {
      if (!token || !success || !model) return;
      try {
        if (model.gateway === 'stripe') {
          if (!sessionId) return;
          const res = await fetch(`${API_BASE}/api/public/payment/${encodeURIComponent(token)}/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j?.error || 'Stripe confirmation failed');
          setModel((prev) => ({ ...(prev || {}), portal: j?.portal || prev?.portal || null }));
          setOk(`Payment recorded successfully: $${Number(j.paidAmount || 0).toFixed(2)}` + (j?.savedCardOnFile ? ' Card on file saved.' : ''));
          return;
        }
        setOk(`Payment return detected for ${String(model.gateway || '').toUpperCase()}. Verification must be completed through a server-side gateway callback or internal reconciliation.`);
        setError('');
      } catch (e) {
        setError(String(e.message || e));
      }
    };
    autoConfirmReturn();
  }, [token, success, sessionId, model, returnTransId]);

  const startCheckout = async () => {
    try {
      setError('');
      const res = await fetch(`${API_BASE}/api/public/payment/${encodeURIComponent(token)}/create-session`, { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Unable to start checkout');
      if (!j.checkoutUrl) throw new Error('Checkout URL missing');
      window.location.href = j.checkoutUrl;
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const paymentStatusLabel = model?.portal?.payment?.statusLabel || (Number(model?.amountDue || 0) > 0 ? 'Payment Pending' : 'Paid in Full');
  const balanceDue = Number(model?.portal?.payment?.balanceDue ?? model?.amountDue ?? 0);
  const fullyPaid = balanceDue <= 0;
  const nextPortalStep = model?.portal?.nextStep;
  const agreementDoc = (model?.portal?.documents || []).find((doc) => doc.key === 'agreement' && doc.available);
  const paidAmount = Number(model?.breakdown?.paidAmount || 0);
  const gatewayLabel = String(model?.gateway || '').toUpperCase() || '-';

  useEffect(() => {
    if (!token || !fullyPaid) return;
    try { sessionStorage.removeItem(paymentPortalStateKey(token)); } catch {}
  }, [fullyPaid, token]);

  const notices = (
    <div style={portalStyles.stack}>
      {loading ? <div style={{ ...portalStyles.notice, background: 'rgba(79, 70, 229, 0.08)', color: '#4338ca' }}>Loading your payment portal...</div> : null}
      {error ? <div style={{ ...portalStyles.notice, background: 'rgba(220, 38, 38, 0.12)', color: '#991b1b' }}>{error}</div> : null}
      {ok ? <div style={{ ...portalStyles.notice, background: 'rgba(22, 163, 74, 0.12)', color: '#166534' }}>{ok}</div> : null}
      {canceled ? <div style={{ ...portalStyles.notice, background: 'rgba(245, 158, 11, 0.15)', color: '#92400e' }}>Payment was canceled. You can try again.</div> : null}
    </div>
  );

  return (
    <PortalFrame
      eyebrow="Ride Fleet Self-Service"
      title="Complete Your Payment"
      subtitle="Review your balance, understand exactly what is due, and finish payment without calling the counter."
      aside={<PortalTimelineCard portal={model?.portal} reservation={model?.reservation} breakdown={model?.breakdown} currentStepKey="payment" currentStepLabel="Payment" />}
    >
      {notices}

      {!loading && model ? (
        <>
          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Payment Progress Snapshot</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Status</div>
                <div style={portalStyles.statValue}>{paymentStatusLabel}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Paid So Far</div>
                <div style={portalStyles.statValue}>${paidAmount.toFixed(2)}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Balance Due</div>
                <div style={portalStyles.statValue}>${balanceDue.toFixed(2)}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Gateway Ready</div>
                <div style={portalStyles.statValue}>{model.gatewayReady ? gatewayLabel : 'Needs setup'}</div>
              </div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>What You Are Paying Today</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Due Now</div>
                <div style={portalStyles.statValue}>${balanceDue.toFixed(2)}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Trip Total</div>
                <div style={portalStyles.statValue}>${Number(model.breakdown?.total || 0).toFixed(2)}</div>
              </div>
            </div>
            <div style={{ marginTop: 12, color: '#55456f', lineHeight: 1.6 }}>
              The amount due right now may only be part of the full reservation cost. The full estimate stays visible below so there is no confusion before you pay.
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Reservation Summary</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Reservation</div>
                <div style={portalStyles.statValue}>{model.reservation?.reservationNumber}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Customer</div>
                <div style={portalStyles.statValue}>{model.reservation?.customerName || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Amount Due</div>
                <div style={portalStyles.statValue}>${Number(model.amountDue || 0).toFixed(2)}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Payment Status</div>
                <div style={portalStyles.statValue}>{paymentStatusLabel}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Gateway</div>
                <div style={portalStyles.statValue}>{String(model.gateway || '').toUpperCase()}</div>
              </div>
            </div>
          </div>

          {model.breakdown ? (
            <div style={portalStyles.card}>
              <h2 style={portalStyles.cardTitle}>Payment Breakdown</h2>
              <div style={{ display: 'grid', gap: 10 }}>
                {(model.breakdown.lines || []).map((l, i) => (
                  <div key={i} style={{ ...portalStyles.statTile, display: 'grid', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <strong>{l.name}</strong>
                      <strong>{Number(l.total || 0) < 0 ? `-$${Math.abs(Number(l.total || 0)).toFixed(2)}` : `$${Number(l.total || 0).toFixed(2)}`}</strong>
                    </div>
                    <div style={{ fontSize: 13, color: '#746294' }}>
                      Qty {l.qty ?? '-'} at {typeof l.rate === 'number' ? `$${Number(l.rate).toFixed(2)}` : String(l.rate ?? '-')}
                    </div>
                  </div>
                ))}
                <div style={portalStyles.statGrid}>
                  <div style={portalStyles.statTile}>
                    <div style={portalStyles.statLabel}>Subtotal</div>
                    <div style={portalStyles.statValue}>${Number(model.breakdown.subtotal || 0).toFixed(2)}</div>
                  </div>
                  <div style={portalStyles.statTile}>
                    <div style={portalStyles.statLabel}>Tax</div>
                    <div style={portalStyles.statValue}>${Number(model.breakdown.tax || 0).toFixed(2)}</div>
                  </div>
                  <div style={portalStyles.statTile}>
                    <div style={portalStyles.statLabel}>Total</div>
                    <div style={portalStyles.statValue}>${Number(model.breakdown.total || 0).toFixed(2)}</div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Next Step</h2>
            {fullyPaid ? (
              <div style={{ display: 'grid', gap: 10, color: '#55456f', lineHeight: 1.6 }}>
                <div><strong>Your payment step is complete.</strong></div>
                <div>You can stay on this portal to review the timeline, download your receipt, and continue with any remaining reservation steps.</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {agreementDoc ? (
                    <a
                      href={`${API_BASE}${agreementDoc.downloadPath}`}
                      target="_blank"
                      rel="noreferrer"
                      style={portalStyles.secondaryButton}
                    >
                      Download Signed Agreement
                    </a>
                  ) : null}
                  {nextPortalStep?.key && nextPortalStep.key !== 'payment' && nextPortalStep.link ? (
                    <a href={nextPortalStep.link} target="_blank" rel="noreferrer" style={portalStyles.secondaryButton}>
                      Continue to {nextPortalStep.label}
                    </a>
                  ) : null}
                </div>
              </div>
            ) : !success ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <div style={{ color: '#55456f', lineHeight: 1.6 }}>
                  {balanceDue > 0
                    ? `When you continue, you will be redirected to the secure payment page to pay the remaining $${balanceDue.toFixed(2)}.`
                    : 'When you continue, you will be redirected to the secure payment page configured for this reservation.'}
                </div>
                <div>
                  <button onClick={startCheckout} disabled={!model.gatewayReady} style={portalStyles.button}>Pay Now</button>
                </div>
              </div>
            ) : model.gateway === 'stripe' ? (
              <div style={{ color: '#55456f', lineHeight: 1.6 }}>Payment return detected. Finalizing Stripe confirmation now.</div>
            ) : (
              <div style={{ display: 'grid', gap: 8, color: '#55456f', lineHeight: 1.6 }}>
                <div><strong>Payment return detected.</strong></div>
                <div>
                  Public confirmation is disabled for {String(model.gateway || '').toUpperCase()}.
                  {returnTransId ? ` Return reference detected: ${returnTransId}.` : ''}
                </div>
                <div>Ask staff to verify and post the payment through the internal workflow or a server-side callback.</div>
              </div>
            )}

            {!model.gatewayReady ? (
              <div style={{ ...portalStyles.notice, marginTop: 14, background: 'rgba(245, 158, 11, 0.15)', color: '#92400e' }}>
                Gateway not configured for {String(model.gateway || '').toUpperCase()}. Set the required backend credentials first.
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </PortalFrame>
  );
}
