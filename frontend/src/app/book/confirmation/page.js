'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

function fmtMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

export default function PublicBookingConfirmationPage() {
  const [confirmation, setConfirmation] = useState(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = sessionStorage.getItem('fleet_public_booking_confirmation');
    if (!raw) return;
    try {
      setConfirmation(JSON.parse(raw));
    } catch {}
  }, []);

  const title = confirmation?.bookingType === 'CAR_SHARING'
    ? `Trip ${confirmation?.trip?.tripCode || ''} created`
    : `Reservation ${confirmation?.reservation?.reservationNumber || ''} created`;

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
              <div className="surface-note">
                {confirmation.nextActions?.warning
                  ? confirmation.nextActions.warning
                  : confirmation.nextActions?.emailSent
                    ? 'Customer info request email was sent successfully.'
                    : 'Manual pre-check-in link generated successfully.'}
              </div>
              {confirmation.nextActions?.link ? (
                <div className="inline-actions">
                  <a href={confirmation.nextActions.link} target="_blank" rel="noreferrer">
                    <button type="button">Open Pre-check-in Link</button>
                  </a>
                </div>
              ) : null}
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
