'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { API_BASE } from '../../../lib/client';

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

export default function PublicBookingConfirmationPage() {
  const [confirmation, setConfirmation] = useState(null);
  const [portalStatus, setPortalStatus] = useState(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = sessionStorage.getItem('fleet_public_booking_confirmation');
    if (!raw) return;
    try {
      setConfirmation(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    const customerInfoLink = resolvePortalAction(confirmation, 'customerInfo')?.link;
    const token = tokenFromLink(customerInfoLink);
    if (!token) {
      setPortalStatus(null);
      return;
    }

    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/public/customer-info/${encodeURIComponent(token)}`, {
          method: 'GET',
          cache: 'no-store'
        });
        if (!res.ok) return;
        const json = await res.json();
        if (!ignore) setPortalStatus(json?.portal || null);
      } catch {
        if (!ignore) setPortalStatus(null);
      }
    })();

    return () => {
      ignore = true;
    };
  }, [confirmation]);

  const title = confirmation?.bookingType === 'CAR_SHARING'
    ? `Trip ${confirmation?.trip?.tripCode || ''} created`
    : `Reservation ${confirmation?.reservation?.reservationNumber || ''} created`;
  const customerInfoAction = resolvePortalAction(confirmation, 'customerInfo');
  const signatureAction = resolvePortalAction(confirmation, 'signature');
  const paymentAction = resolvePortalAction(confirmation, 'payment');
  const customerInfoLive = timelineStatus(portalStatus, 'customerInfo');
  const signatureLive = timelineStatus(portalStatus, 'signature');
  const paymentLive = timelineStatus(portalStatus, 'payment');

  return (
    <main style={{ minHeight: '100vh', padding: '22px clamp(16px, 3vw, 34px) 42px' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'grid', gap: 18 }}>
        <section className="glass card-lg page-hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <span className="eyebrow">Booking Confirmed</span>
              <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 52px)', lineHeight: 1.03 }}>
                {confirmation ? title : 'Booking request received'}
              </h1>
              <p>
                {confirmation
                  ? 'The booking is now live in the platform and the guest can continue through pre-check-in, signature, payment, and trip operations.'
                  : 'We could not find a recent booking payload in this browser session. You can return to public booking and create a fresh request.'}
              </p>
              <div className="hero-meta">
                <span className="hero-pill">Reservation workflow linked</span>
                <span className="hero-pill">Customer next step ready</span>
                <span className="hero-pill">Sprint 6 booking flow</span>
              </div>
            </div>
            <div className="glass card section-card">
              <div className="section-title">What Happens Next</div>
              <div className="stack">
                <div className="surface-note">1. Customer opens pre-check-in</div>
                <div className="surface-note">2. Signature and payment requests follow</div>
                <div className="surface-note">3. Ops can complete checkout, inspections, and return inside the normal workflow</div>
              </div>
            </div>
          </div>
        </section>

        {confirmation ? (
          <section className="split-panel">
            <div className="glass card-lg section-card">
              <div className="section-title">Booking Summary</div>
              <div className="metric-grid">
                <div className="metric-card">
                  <span className="label">Type</span>
                  <strong>{confirmation.bookingType === 'CAR_SHARING' ? 'Car Sharing' : 'Rental'}</strong>
                </div>
                <div className="metric-card">
                  <span className="label">Customer</span>
                  <strong>{`${confirmation.customer?.firstName || ''} ${confirmation.customer?.lastName || ''}`.trim() || 'Guest'}</strong>
                </div>
                <div className="metric-card">
                  <span className="label">Tenant</span>
                  <strong>{confirmation.tenant?.name || '-'}</strong>
                </div>
                <div className="metric-card">
                  <span className="label">Reference</span>
                  <strong>{confirmation.trip?.tripCode || confirmation.reservation?.reservationNumber || '-'}</strong>
                </div>
              </div>
              <div className="surface-note">
                {confirmation.bookingType === 'CAR_SHARING'
                  ? `Trip total ${fmtMoney(confirmation.trip?.quotedTotal)} · Host earnings ${fmtMoney(confirmation.trip?.hostEarnings)} · Platform fee ${fmtMoney(confirmation.trip?.platformFee)}`
                  : `Reservation estimate ${fmtMoney(confirmation.reservation?.estimatedTotal)} · Status ${confirmation.reservation?.status || '-'}`
                }
              </div>
              {confirmation.bookingType === 'RENTAL' && confirmation.additionalServices?.length ? (
                <div className="surface-note">
                  <strong>Additional Services</strong>
                  <div className="stack" style={{ marginTop: 10 }}>
                    {confirmation.additionalServices.map((service) => (
                      <div key={service.serviceId || service.name} className="row-between" style={{ gap: 12 }}>
                        <span>{service.name} x {service.quantity}</span>
                        <strong>{fmtMoney(service.total)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {confirmation.bookingType === 'RENTAL' && confirmation.insuranceSelection ? (
                <div className="surface-note">
                  <strong>Insurance Decision</strong>
                  <div style={{ marginTop: 10 }}>
                    {confirmation.insuranceSelection.type === 'PLAN'
                      ? `${confirmation.insuranceSelection.name} · ${fmtMoney(confirmation.insuranceSelection.total)}`
                      : `Customer declined company insurance, will use their own policy${confirmation.insuranceSelection.ownPolicyNumber ? ` (${confirmation.insuranceSelection.ownPolicyNumber})` : ''}, and accepted responsibility and liability.`}
                  </div>
                </div>
              ) : null}
              {confirmation.reservation ? (
                <div className="surface-note">
                  Reservation workflow: <strong>{confirmation.reservation.reservationNumber}</strong>
                  <br />
                  This is the operational record that ops will use for checkout, check-in, inspections, and agreement flow.
                </div>
              ) : null}
            </div>

            <div className="glass card-lg section-card">
              <div className="section-title">Customer Next Step</div>
              {portalStatus ? (
                <div className="stack" style={{ gap: 10 }}>
                  {[customerInfoLive, signatureLive, paymentLive].filter(Boolean).map((item) => {
                    const tone = statusTone(item.status);
                    return (
                      <div key={item.key} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                        <div className="row-between" style={{ gap: 12, alignItems: 'center' }}>
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
                    Live progress: <strong>{portalStatus.progress?.completedSteps || 0}/{portalStatus.progress?.totalSteps || 0}</strong>
                    {' '}completed. Next action: <strong>{portalStatus.progress?.nextAction || 'Continue the customer workflow.'}</strong>
                  </div>
                </div>
              ) : null}
              <div className="surface-note">
                {customerInfoAction?.warning
                  ? customerInfoAction.warning
                  : customerInfoAction?.emailSent
                    ? 'Customer info request email was sent successfully.'
                    : 'Manual pre-check-in link generated successfully.'}
              </div>
              <div className="stack" style={{ gap: 10 }}>
                {customerInfoAction?.link ? (
                  <div className="inline-actions">
                    <a href={customerInfoAction.link} target="_blank" rel="noreferrer">
                      <button type="button">Open Pre-check-in</button>
                    </a>
                  </div>
                ) : null}
                {signatureAction?.link ? (
                  <div className="inline-actions">
                    <a href={signatureAction.link} target="_blank" rel="noreferrer">
                      <button type="button" className="button-subtle">Open Signature Step</button>
                    </a>
                  </div>
                ) : null}
                {paymentAction?.link ? (
                  <div className="inline-actions">
                    <a href={paymentAction.link} target="_blank" rel="noreferrer">
                      <button type="button" className="button-subtle">Open Payment Step</button>
                    </a>
                  </div>
                ) : null}
              </div>
              <div className="surface-note">
                Recommended order: Pre-check-in, then signature, then payment.
              </div>
              <div className="inline-actions">
                <Link href="/book">
                  <button type="button" className="button-subtle">Create Another Booking</button>
                </Link>
              </div>
            </div>
          </section>
        ) : (
          <section className="glass card-lg section-card">
            <div className="surface-note">
              No confirmation payload is currently available in this browser session.
            </div>
            <div className="inline-actions">
              <Link href="/book">
                <button type="button">Back to Booking</button>
              </Link>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
