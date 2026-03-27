'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { API_BASE } from '../../../lib/client';

function fmtMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function publicLocationLabel(location) {
  return [location?.name, location?.city, location?.state].filter(Boolean).join(' · ') || 'Location';
}

function publicPickupSpotLabel(pickupSpot, fallbackLocation = null) {
  if (pickupSpot?.label) {
    const address = [pickupSpot?.city, pickupSpot?.state].filter(Boolean).join(', ');
    const anchor = pickupSpot?.anchorLocation?.name ? ` · Ops hub ${pickupSpot.anchorLocation.name}` : '';
    return `${pickupSpot.label}${address ? ` · ${address}` : ''}${anchor}`;
  }
  return fallbackLocation ? publicLocationLabel(fallbackLocation) : 'Location';
}

function pickupSpotHint(pickupSpot) {
  return [pickupSpot?.address1, pickupSpot?.city, pickupSpot?.state, pickupSpot?.postalCode].filter(Boolean).join(' · ');
}

function fulfillmentModeLabel(mode) {
  const value = String(mode || 'PICKUP_ONLY').toUpperCase();
  if (value === 'DELIVERY_ONLY') return 'Delivery only';
  if (value === 'PICKUP_OR_DELIVERY') return 'Pickup or delivery';
  return 'Pickup only';
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

function BreakdownRow({ label, value, strong = false }) {
  return (
    <div className="row-between" style={{ gap: 12 }}>
      <span>{label}</span>
      <strong style={strong ? { fontSize: 16 } : undefined}>{value}</strong>
    </div>
  );
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
  const primaryActionLink = portalStatus?.nextStep?.link || customerInfoAction?.link || signatureAction?.link || paymentAction?.link || '';
  const primaryActionLabel = portalStatus?.nextStep?.label || 'Continue guest workflow';
  const pricing = confirmation?.pricingBreakdown || null;
  const estimatedTotal = confirmation?.bookingType === 'CAR_SHARING'
    ? Number(pricing?.guestTotal ?? confirmation?.trip?.quotedTotal ?? 0)
    : Number(pricing?.reservationEstimate ?? confirmation?.reservation?.estimatedTotal ?? 0);
  const dueNow = confirmation?.bookingType === 'CAR_SHARING'
    ? Math.max(0, Number(portalStatus?.payment?.balanceDue ?? 0))
    : Number(pricing?.depositDueNow ?? portalStatus?.payment?.balanceDue ?? 0);

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
                <span className="hero-pill">Email follow-up sent</span>
              </div>
            </div>
            <div className="glass card section-card">
              <div className="section-title">What Happens Next</div>
              <div className="stack">
                <div className="surface-note">1. Guest verifies their email and opens pre-check-in</div>
                <div className="surface-note">2. Signature and payment requests follow</div>
                <div className="surface-note">3. Ops completes checkout, inspections, pickup, and return inside the normal workflow</div>
              </div>
            </div>
          </div>
        </section>

        {confirmation ? (
          <>
          <section className="app-banner">
            <div className="row-between" style={{ marginBottom: 0 }}>
              <div className="stack" style={{ gap: 6 }}>
                <span className="eyebrow">Confirmation Snapshot</span>
                <h2 style={{ margin: 0 }}>{confirmation.bookingType === 'CAR_SHARING' ? 'Guest trip ready to continue' : 'Guest reservation ready to continue'}</h2>
                <p className="ui-muted">
                  The guest should verify their email, open the secure next-step link, and continue through pre-check-in, signature, and payment.
                </p>
              </div>
              <span className={`status-chip ${primaryActionLink ? 'good' : 'neutral'}`}>
                {primaryActionLink ? 'Next step ready' : 'Awaiting next step'}
              </span>
            </div>
            <div className="app-card-grid compact">
              <div className="info-tile">
                <span className="label">Booking Type</span>
                <strong>{confirmation.bookingType === 'CAR_SHARING' ? 'Car Sharing' : 'Rental'}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Estimated Total</span>
                <strong>{fmtMoney(estimatedTotal)}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Due Now</span>
                <strong>{fmtMoney(dueNow)}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Guest Email</span>
                <strong>{confirmation.customer?.email || '-'}</strong>
              </div>
            </div>
          </section>
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
                  <span className="label">Email</span>
                  <strong>{confirmation.customer?.email || '-'}</strong>
                </div>
                <div className="metric-card">
                  <span className="label">Reference</span>
                  <strong>{confirmation.trip?.tripCode || confirmation.reservation?.reservationNumber || '-'}</strong>
                </div>
              </div>

              {confirmation.bookingType === 'CAR_SHARING' ? (
                <div className="surface-note" style={{ display: 'grid', gap: 8 }}>
                  <strong>Pickup Plan</strong>
                  <div>
                    Pickup spot: {publicPickupSpotLabel(confirmation.trip?.pickupSpot, confirmation.trip?.location)}
                  </div>
                  <div>
                    Fulfillment: {fulfillmentModeLabel(confirmation.trip?.fulfillmentMode)}
                    {confirmation.trip?.deliveryRadiusMiles ? ` · ${confirmation.trip.deliveryRadiusMiles} mi radius` : ''}
                  </div>
                  {pickupSpotHint(confirmation.trip?.pickupSpot) ? (
                    <div>{pickupSpotHint(confirmation.trip?.pickupSpot)}</div>
                  ) : null}
                  {confirmation.trip?.deliveryNotes ? (
                    <div>{confirmation.trip.deliveryNotes}</div>
                  ) : null}
                  {confirmation.trip?.vehicleLabel ? (
                    <div>Vehicle: <strong>{confirmation.trip.vehicleLabel}</strong></div>
                  ) : null}
                </div>
              ) : null}

              {pricing ? (
                <div className="surface-note" style={{ display: 'grid', gap: 10 }}>
                  <strong>Price Breakdown</strong>
                  {confirmation.bookingType === 'CAR_SHARING' ? (
                    <>
                      <BreakdownRow
                        label={`Vehicle subtotal (${pricing.tripDays || 0} day${Number(pricing.tripDays || 0) === 1 ? '' : 's'})`}
                        value={fmtMoney(pricing.tripSubtotal)}
                      />
                      <BreakdownRow label="Host vehicle fees" value={fmtMoney(pricing.hostChargeFees)} />
                      <BreakdownRow label="Mandatory trip fee" value={fmtMoney(pricing.guestTripFee)} />
                      <BreakdownRow label="Estimated taxes" value={fmtMoney(pricing.taxes)} />
                      <BreakdownRow label="Base trip total" value={fmtMoney(pricing.baseTripTotal)} />
                      <BreakdownRow label="Vehicle add-ons" value={fmtMoney(pricing.additionalServicesTotal)} />
                      <BreakdownRow label="Estimated total" value={fmtMoney(pricing.guestTotal)} strong />
                    </>
                  ) : (
                    <>
                      <BreakdownRow
                        label={`Base rental (${pricing.tripDays || 0} day${Number(pricing.tripDays || 0) === 1 ? '' : 's'} at ${fmtMoney(pricing.dailyRate)}/day)`}
                        value={fmtMoney(pricing.baseSubtotal)}
                      />
                      <BreakdownRow label="Estimated taxes" value={fmtMoney(pricing.estimatedTaxes)} />
                      <BreakdownRow label="Base reservation total" value={fmtMoney(pricing.baseReservationTotal)} />
                      <BreakdownRow label="Additional services" value={fmtMoney(pricing.additionalServicesTotal)} />
                      <BreakdownRow label="Insurance" value={fmtMoney(pricing.insuranceTotal)} />
                      <BreakdownRow label="Estimated reservation total" value={fmtMoney(pricing.reservationEstimate)} strong />
                      <BreakdownRow label="Due now for pre-check-in" value={fmtMoney(pricing.depositDueNow)} strong />
                      {Number(pricing.securityDeposit || 0) > 0 ? (
                        <BreakdownRow label="Refundable security deposit" value={fmtMoney(pricing.securityDeposit)} />
                      ) : null}
                    </>
                  )}
                </div>
              ) : (
                <div className="surface-note">
                  {confirmation.bookingType === 'CAR_SHARING'
                    ? `Trip total ${fmtMoney(confirmation.trip?.quotedTotal)} · Host earnings ${fmtMoney(confirmation.trip?.hostEarnings)} · Platform fee ${fmtMoney(confirmation.trip?.platformFee)}`
                    : `Reservation estimate ${fmtMoney(confirmation.reservation?.estimatedTotal)} · Status ${confirmation.reservation?.status || '-'}`
                  }
                </div>
              )}

              {confirmation.additionalServices?.length ? (
                <div className="surface-note">
                  <strong>{confirmation.bookingType === 'RENTAL' ? 'Additional Services' : 'Vehicle Add-Ons'}</strong>
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

              {confirmation.bookingType === 'RENTAL' && pricing ? (
                <div className="surface-note">
                  The pre-check-in and payment steps may show only the amount due now, such as the booking deposit. The full reservation estimate for this trip is{' '}
                  <strong>{fmtMoney(pricing.reservationEstimate)}</strong>.
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

              {primaryActionLink ? (
                <div className="inline-actions">
                  <a href={primaryActionLink} target="_blank" rel="noreferrer">
                    <button type="button">{primaryActionLabel}</button>
                  </a>
                </div>
              ) : null}

              <div className="surface-note">
                Verify the guest email <strong>{confirmation.customer?.email || '-'}</strong>. The pre-check-in link and the remaining trip steps are sent there.
              </div>
              <div className="surface-note">
                {customerInfoAction?.warning
                  ? customerInfoAction.warning
                  : customerInfoAction?.emailSent
                    ? 'Pre-check-in email was sent successfully. Ask the guest to check inbox and spam if needed.'
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
          </>
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
