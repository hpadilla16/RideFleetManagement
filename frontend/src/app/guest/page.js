'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { API_BASE, api } from '../../lib/client';

function fmtMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'completed') return { color: '#12633d', background: 'rgba(43, 174, 96, 0.14)' };
  if (value === 'active' || value === 'partial') return { color: '#10568b', background: 'rgba(48, 135, 214, 0.14)' };
  if (value === 'requested') return { color: '#7a4f08', background: 'rgba(255, 191, 71, 0.18)' };
  return { color: '#6f5b8f', background: 'rgba(111, 91, 143, 0.1)' };
}

function resolvePortalAction(confirmation, key) {
  const nextActions = confirmation?.nextActions;
  if (!nextActions) return null;
  if (nextActions[key]) return nextActions[key];
  if (key === 'customerInfo' && nextActions?.link) return nextActions;
  return null;
}

function tokenFromLink(link) {
  if (!link) return '';
  try {
    return new URL(link).searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function timelineStatus(portal, key) {
  return portal?.timeline?.find((item) => item.key === key) || null;
}

export default function GuestAppPage() {
  const [lookupState, setLookupState] = useState({ reference: '', email: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [portalStatus, setPortalStatus] = useState(null);

  const customerInfoAction = resolvePortalAction(result, 'customerInfo');
  const signatureAction = resolvePortalAction(result, 'signature');
  const paymentAction = resolvePortalAction(result, 'payment');
  const customerInfoLive = timelineStatus(portalStatus, 'customerInfo');
  const signatureLive = timelineStatus(portalStatus, 'signature');
  const paymentLive = timelineStatus(portalStatus, 'payment');

  const primaryAction = useMemo(() => {
    if (portalStatus?.nextStep?.link) return { label: portalStatus.nextStep.label, link: portalStatus.nextStep.link };
    return customerInfoAction?.link
      ? { label: 'Continue to Pre-check-in', link: customerInfoAction.link }
      : signatureAction?.link
        ? { label: 'Continue to Signature', link: signatureAction.link }
        : paymentAction?.link
          ? { label: 'Continue to Payment', link: paymentAction.link }
          : null;
  }, [customerInfoAction?.link, paymentAction?.link, portalStatus?.nextStep?.label, portalStatus?.nextStep?.link, signatureAction?.link]);

  async function loadPortalStatus(confirmation) {
    const token = tokenFromLink(resolvePortalAction(confirmation, 'customerInfo')?.link);
    if (!token) {
      setPortalStatus(null);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/public/customer-info/${encodeURIComponent(token)}`, {
        method: 'GET',
        cache: 'no-store'
      });
      if (!res.ok) {
        setPortalStatus(null);
        return;
      }
      const json = await res.json();
      setPortalStatus(json?.portal || null);
    } catch {
      setPortalStatus(null);
    }
  }

  async function runLookup() {
    setLoading(true);
    setError('');
    try {
      const payload = await api('/api/public/booking/lookup', {
        method: 'POST',
        body: JSON.stringify({
          reference: lookupState.reference,
          email: lookupState.email
        })
      });
      setResult(payload);
      await loadPortalStatus(payload);
    } catch (err) {
      setResult(null);
      setPortalStatus(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', padding: '22px clamp(16px, 3vw, 34px) 42px' }}>
      <div style={{ maxWidth: 1160, margin: '0 auto', display: 'grid', gap: 18 }}>
        <section className="glass card-lg page-hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <span className="eyebrow">Guest App Foundation</span>
              <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 54px)', lineHeight: 1.02 }}>
                Manage your booking, complete your steps, and stay on track from one guest surface.
              </h1>
              <p>
                Guests can find a rental reservation or car sharing trip, check live progress, and jump directly into
                pre-check-in, signature, or payment without calling the counter.
              </p>
              <div className="hero-meta">
                <span className="hero-pill">Guest resume flow</span>
                <span className="hero-pill">Live step status</span>
                <span className="hero-pill">Mobile-friendly portal</span>
              </div>
            </div>
            <div className="glass card section-card">
              <div className="section-title">What Guests Can Do</div>
              <div className="stack">
                <div className="surface-note">Look up a booking using the reservation or trip reference plus email.</div>
                <div className="surface-note">See the next required step in real time.</div>
                <div className="surface-note">Open pre-check-in, sign agreement, or finish payment from one place.</div>
              </div>
            </div>
          </div>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Find Your Booking</div>
              <p className="ui-muted">Use the same email that was used during booking. Works for rental and car sharing.</p>
            </div>
            <span className="status-chip neutral">Guest Access</span>
          </div>
          <div className="form-grid-2">
            <div>
              <div className="label">Reference</div>
              <input
                value={lookupState.reference}
                onChange={(event) => setLookupState((current) => ({ ...current, reference: event.target.value }))}
                placeholder="Reservation number or trip code"
              />
            </div>
            <div>
              <div className="label">Email</div>
              <input
                type="email"
                value={lookupState.email}
                onChange={(event) => setLookupState((current) => ({ ...current, email: event.target.value }))}
                placeholder="guest@email.com"
              />
            </div>
          </div>
          <div className="inline-actions">
            <button type="button" disabled={loading} onClick={runLookup}>
              {loading ? 'Finding Booking...' : 'Open Guest Booking'}
            </button>
            <Link href="/book">
              <button type="button" className="button-subtle">Create New Booking</button>
            </Link>
          </div>
          {error ? <div className="surface-note" style={{ color: '#991b1b' }}>{error}</div> : null}
        </section>

        {result ? (
          <section className="split-panel">
            <div className="glass card-lg section-card">
              <div className="section-title">Guest Booking Summary</div>
              <div className="metric-grid">
                <div className="metric-card">
                  <span className="label">Type</span>
                  <strong>{result.bookingType === 'CAR_SHARING' ? 'Car Sharing' : 'Rental'}</strong>
                </div>
                <div className="metric-card">
                  <span className="label">Reference</span>
                  <strong>{result.trip?.tripCode || result.reservation?.reservationNumber || '-'}</strong>
                </div>
                <div className="metric-card">
                  <span className="label">Customer</span>
                  <strong>{`${result.customer?.firstName || ''} ${result.customer?.lastName || ''}`.trim() || 'Guest'}</strong>
                </div>
                <div className="metric-card">
                  <span className="label">Tenant</span>
                  <strong>{result.tenant?.name || '-'}</strong>
                </div>
              </div>
              <div className="surface-note">
                {result.bookingType === 'CAR_SHARING'
                  ? `Trip total ${fmtMoney(result.trip?.quotedTotal)} · Host earnings ${fmtMoney(result.trip?.hostEarnings)} · Platform fee ${fmtMoney(result.trip?.platformFee)}`
                  : `Reservation estimate ${fmtMoney(result.reservation?.estimatedTotal)} · Status ${result.reservation?.status || '-'}`}
              </div>
              {primaryAction?.link ? (
                <div className="inline-actions">
                  <a href={primaryAction.link} target="_blank" rel="noreferrer">
                    <button type="button">{primaryAction.label}</button>
                  </a>
                </div>
              ) : null}
            </div>

            <div className="glass card-lg section-card">
              <div className="section-title">Live Guest Status</div>
              {portalStatus ? (
                <div className="stack">
                  {[customerInfoLive, signatureLive, paymentLive].filter(Boolean).map((item) => {
                    const tone = statusTone(item.status);
                    return (
                      <div key={item.key} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                        <div className="row-between" style={{ gap: 10, alignItems: 'center' }}>
                          <strong>{item.label}</strong>
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              minHeight: 28,
                              padding: '0 10px',
                              borderRadius: 999,
                              background: tone.background,
                              color: tone.color,
                              fontSize: 12,
                              fontWeight: 700,
                              textTransform: 'capitalize'
                            }}
                          >
                            {item.status}
                          </span>
                        </div>
                        <div style={{ color: '#55456f', lineHeight: 1.5 }}>{item.description || '-'}</div>
                      </div>
                    );
                  })}
                  <div className="surface-note">
                    Progress <strong>{portalStatus.progress?.completedSteps || 0}/{portalStatus.progress?.totalSteps || 0}</strong>.
                    {' '}Next action: <strong>{portalStatus.progress?.nextAction || 'Continue your guest workflow.'}</strong>
                  </div>
                </div>
              ) : (
                <div className="surface-note">Live portal status will appear here as soon as the guest flow is available.</div>
              )}
              <div className="inline-actions">
                {customerInfoAction?.link ? (
                  <a href={customerInfoAction.link} target="_blank" rel="noreferrer">
                    <button type="button" className="button-subtle">Pre-check-in</button>
                  </a>
                ) : null}
                {signatureAction?.link ? (
                  <a href={signatureAction.link} target="_blank" rel="noreferrer">
                    <button type="button" className="button-subtle">Signature</button>
                  </a>
                ) : null}
                {paymentAction?.link ? (
                  <a href={paymentAction.link} target="_blank" rel="noreferrer">
                    <button type="button" className="button-subtle">Payment</button>
                  </a>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
