'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function reservationCustomerName(reservation) {
  return [reservation?.customer?.firstName, reservation?.customer?.lastName].filter(Boolean).join(' ') || reservation?.customer?.email || '-';
}

function activeAvailabilityBlock(vehicle) {
  const now = Date.now();
  return (Array.isArray(vehicle?.availabilityBlocks) ? vehicle.availabilityBlocks : []).find((block) => {
    const releasedAt = block?.releasedAt ? new Date(block.releasedAt).getTime() : null;
    const blockedFrom = block?.blockedFrom ? new Date(block.blockedFrom).getTime() : now;
    const availableFrom = block?.availableFrom ? new Date(block.availableFrom).getTime() : null;
    return !releasedAt && blockedFrom <= now && availableFrom && availableFrom > now;
  }) || null;
}

function blockTypeLabel(value) {
  switch (String(value || '').toUpperCase()) {
    case 'MAINTENANCE_HOLD': return 'Maintenance Hold';
    case 'OUT_OF_SERVICE_HOLD': return 'Out Of Service';
    default: return 'Migration Hold';
  }
}

function reservationTone(status) {
  switch (String(status || '').toUpperCase()) {
    case 'CHECKED_OUT': return 'warn';
    case 'CHECKED_IN': return 'neutral';
    case 'CONFIRMED': return 'good';
    case 'NEW': return 'neutral';
    default: return 'neutral';
  }
}

function inspectionSnapshot(agreement) {
  const inspections = Array.isArray(agreement?.inspections) ? agreement.inspections : [];
  const checkout = inspections.find((item) => String(item?.phase || '').toUpperCase() === 'CHECKOUT');
  const checkin = inspections.find((item) => String(item?.phase || '').toUpperCase() === 'CHECKIN');
  return {
    checkout: checkout?.capturedAt || null,
    checkin: checkin?.capturedAt || null
  };
}

function vehicleDisplayName(row) {
  return [row?.year, row?.make, row?.model].filter(Boolean).join(' ') || row?.plate || row?.internalNumber || 'Vehicle';
}

export default function VehicleProfilePage() {
  return <AuthGate>{({ token, me, logout }) => <VehicleProfileInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function VehicleProfileInner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const shouldPrint = searchParams?.get('print') === '1';
  const printTriggeredRef = useRef(false);

  const [row, setRow] = useState(null);
  const [qrUrl, setQrUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!id) return;
    api(`/api/vehicles/${id}`, {}, token)
      .then((out) => setRow(out))
      .catch((error) => setMsg(error.message));
  }, [id, token]);

  useEffect(() => {
    if (typeof window === 'undefined' || !id) return;
    setQrUrl(`${window.location.origin}/vehicles/${id}`);
  }, [id]);

  useEffect(() => {
    if (!qrUrl) return;
    QRCode.toDataURL(qrUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
      color: {
        dark: '#211a38',
        light: '#0000'
      }
    })
      .then(setQrDataUrl)
      .catch((error) => setMsg(error.message));
  }, [qrUrl]);

  useEffect(() => {
    if (!shouldPrint || !row || !qrDataUrl || printTriggeredRef.current) return;
    printTriggeredRef.current = true;
    const timer = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(timer);
  }, [shouldPrint, row, qrDataUrl]);

  const currentBlock = useMemo(() => activeAvailabilityBlock(row), [row]);
  const activeReservation = row?.activeReservation || null;
  const nextReservation = row?.nextReservation || null;
  const recentReservations = Array.isArray(row?.recentReservations) ? row.recentReservations : [];
  const inspectionHistory = Array.isArray(row?.rentalAgreements) ? row.rentalAgreements : [];

  const statusSummary = useMemo(() => {
    if (activeReservation) {
      return {
        label: 'Checked Out',
        tone: 'warn',
        detail: `Return workflow tied to ${activeReservation.reservationNumber}`
      };
    }
    if (currentBlock) {
      return {
        label: blockTypeLabel(currentBlock.blockType),
        tone: String(currentBlock.blockType || '').toUpperCase() === 'MIGRATION_HOLD' ? 'neutral' : 'warn',
        detail: `Blocked until ${formatDateTime(currentBlock.availableFrom)}`
      };
    }
    if (nextReservation) {
      return {
        label: 'Next Delivery Scheduled',
        tone: 'good',
        detail: `${nextReservation.reservationNumber} at ${formatDateTime(nextReservation.pickupAt)}`
      };
    }
    return {
      label: row?.status || 'Available',
      tone: String(row?.status || '').toUpperCase() === 'AVAILABLE' ? 'good' : 'neutral',
      detail: 'No active return workflow right now'
    };
  }, [activeReservation, currentBlock, nextReservation, row?.status]);

  const printQr = () => {
    if (typeof window === 'undefined' || !row?.id) return;
    window.open(`/vehicles/${row.id}?print=1`, '_blank', 'noopener,noreferrer');
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="vehicle-profile-shell">
        <div className="glass card-lg qr-screen-only">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div className="stack" style={{ gap: 8 }}>
              <span className="eyebrow">Vehicle Profile</span>
              <h1 className="page-title" style={{ margin: 0 }}>{row ? vehicleDisplayName(row) : 'Vehicle profile'}</h1>
              <p className="ui-muted">
                Scan the QR on the unit to open this profile, review the active or next reservation, and jump straight into the return workflow when the car comes back.
              </p>
            </div>
            <span className={`status-chip ${statusSummary.tone}`}>{statusSummary.label}</span>
          </div>
          <div className="app-banner-list">
            <button type="button" className="button-subtle" onClick={() => router.push('/vehicles')}>Back To Vehicles</button>
            {activeReservation ? (
              <>
                <Link href={`/reservations/${activeReservation.id}`} className="legal-link-pill">Open Reservation</Link>
                <Link href={`/reservations/${activeReservation.id}/checkin`} className="legal-link-pill">Go To Check-In</Link>
              </>
            ) : null}
            {!activeReservation && nextReservation ? (
              <Link href={`/reservations/${nextReservation.id}`} className="legal-link-pill">Open Next Reservation</Link>
            ) : null}
            <button type="button" className="button-subtle" onClick={printQr} disabled={!qrDataUrl}>Print QR Label</button>
          </div>
        </div>

        {msg ? <div className="glass card error">{msg}</div> : null}

        {!row ? null : (
          <div className="vehicle-profile-grid">
            <div className="vehicle-profile-main">
              <section className="glass card-lg section-card">
                <div className="row-between">
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="eyebrow">Ops Snapshot</span>
                    <h2>What should the rental agent do now?</h2>
                  </div>
                  <span className={`status-chip ${statusSummary.tone}`}>{statusSummary.label}</span>
                </div>
                <div className="surface-note">{statusSummary.detail}</div>
                {activeReservation ? (
                  <div className="journey-stage-grid">
                    <article className="journey-stage is-active">
                      <span className="label">Return Workflow</span>
                      <strong>{activeReservation.reservationNumber}</strong>
                      <span className="ui-muted">{reservationCustomerName(activeReservation)}</span>
                      <span className="ui-muted">Return due {formatDateTime(activeReservation.returnAt)}</span>
                      <span className="ui-muted">Return at {activeReservation.returnLocation?.name || '-'}</span>
                      <div className="inline-actions">
                        <Link href={`/reservations/${activeReservation.id}/checkin`} className="legal-link-pill">Check In Vehicle</Link>
                        <Link href={`/reservations/${activeReservation.id}`} className="legal-link-pill">Open Reservation</Link>
                      </div>
                    </article>
                    <article className="journey-stage">
                      <span className="label">Agreement</span>
                      <strong>{activeReservation.rentalAgreement?.agreementNumber || 'Agreement pending'}</strong>
                      <span className="ui-muted">Agreement status: {activeReservation.rentalAgreement?.status || '-'}</span>
                      <span className="ui-muted">Balance: ${Number(activeReservation.rentalAgreement?.balance || 0).toFixed(2)}</span>
                    </article>
                  </div>
                ) : nextReservation ? (
                  <div className="journey-stage-grid">
                    <article className="journey-stage is-active">
                      <span className="label">Next Delivery</span>
                      <strong>{nextReservation.reservationNumber}</strong>
                      <span className="ui-muted">{reservationCustomerName(nextReservation)}</span>
                      <span className="ui-muted">Pickup {formatDateTime(nextReservation.pickupAt)}</span>
                      <span className="ui-muted">Pickup at {nextReservation.pickupLocation?.name || '-'}</span>
                      <div className="inline-actions">
                        <Link href={`/reservations/${nextReservation.id}`} className="legal-link-pill">Open Reservation</Link>
                      </div>
                    </article>
                    <article className="journey-stage">
                      <span className="label">Vehicle readiness</span>
                      <strong>{currentBlock ? 'Blocked' : 'Ready to prep'}</strong>
                      <span className="ui-muted">
                        {currentBlock
                          ? `${blockTypeLabel(currentBlock.blockType)} until ${formatDateTime(currentBlock.availableFrom)}`
                          : 'No active hold. Vehicle can be prepared for the next handoff.'}
                      </span>
                    </article>
                  </div>
                ) : (
                  <div className="surface-note">
                    No checked-out reservation and no upcoming assigned reservation are tied to this vehicle right now.
                  </div>
                )}
              </section>

              <section className="glass card-lg section-card">
                <div className="row-between">
                  <h2>Vehicle Details</h2>
                  <span className="status-chip neutral">{row.vehicleType?.name || row.vehicleType?.code || 'No type'}</span>
                </div>
                <div className="app-card-grid compact">
                  <div className="info-tile"><span className="label">Unit ID</span><strong>{row.internalNumber || '-'}</strong></div>
                  <div className="info-tile"><span className="label">Plate</span><strong>{row.plate || '-'}</strong></div>
                  <div className="info-tile"><span className="label">VIN</span><strong>{row.vin || '-'}</strong></div>
                  <div className="info-tile"><span className="label">Toll Tag</span><strong>{row.tollTagNumber || '-'}</strong></div>
                  <div className="info-tile"><span className="label">Toll Sticker</span><strong>{row.tollStickerNumber || '-'}</strong></div>
                  <div className="info-tile"><span className="label">Home Location</span><strong>{row.homeLocation?.name || '-'}</strong></div>
                  <div className="info-tile"><span className="label">Status</span><strong>{row.status || '-'}</strong></div>
                  <div className="info-tile"><span className="label">Fleet Mode</span><strong>{row.fleetMode || '-'}</strong></div>
                  <div className="info-tile"><span className="label">Mileage</span><strong>{row.mileage ?? 0}</strong></div>
                  <div className="info-tile"><span className="label">Color</span><strong>{row.color || '-'}</strong></div>
                </div>
                {currentBlock ? (
                  <div className="surface-note">
                    {blockTypeLabel(currentBlock.blockType)} from {formatDateTime(currentBlock.blockedFrom)} until {formatDateTime(currentBlock.availableFrom)}
                    {currentBlock.reason ? ` | ${currentBlock.reason}` : ''}
                  </div>
                ) : null}
              </section>

              <section className="glass card-lg section-card">
                <div className="row-between">
                  <h2>Reservation Timeline</h2>
                  <span className="status-chip neutral">{recentReservations.length} recent</span>
                </div>
                {recentReservations.length ? (
                  <div className="table-shell">
                    <table>
                      <thead>
                        <tr>
                          <th>Reservation</th>
                          <th>Status</th>
                          <th>Customer</th>
                          <th>Pickup</th>
                          <th>Return</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentReservations.map((reservation) => (
                          <tr key={reservation.id}>
                            <td>{reservation.reservationNumber}</td>
                            <td><span className={`status-chip ${reservationTone(reservation.status)}`}>{reservation.status}</span></td>
                            <td>{reservationCustomerName(reservation)}</td>
                            <td>{formatDateTime(reservation.pickupAt)}</td>
                            <td>{formatDateTime(reservation.returnAt)}</td>
                            <td>
                              <div className="inline-actions">
                                <Link href={`/reservations/${reservation.id}`} className="legal-link-pill">Open</Link>
                                {String(reservation.status || '').toUpperCase() === 'CHECKED_OUT' ? (
                                  <Link href={`/reservations/${reservation.id}/checkin`} className="legal-link-pill">Check In</Link>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="surface-note">This unit has no reservation history yet.</div>
                )}
              </section>

              <section className="glass card-lg section-card">
                <div className="row-between">
                  <h2>Inspection History</h2>
                  <span className="status-chip neutral">{inspectionHistory.length} agreements</span>
                </div>
                {inspectionHistory.length ? (
                  <div className="timeline-list">
                    {inspectionHistory.map((agreement) => {
                      const snapshot = inspectionSnapshot(agreement);
                      return (
                        <article key={agreement.id} className="timeline-item">
                          <div className="row-between" style={{ marginBottom: 0 }}>
                            <strong>{agreement.agreementNumber}</strong>
                            <span className="status-chip neutral">{agreement.reservation?.reservationNumber || 'Reservation'}</span>
                          </div>
                          <div className="ui-muted">
                            {agreement.reservation?.customer ? `${agreement.reservation.customer.firstName || ''} ${agreement.reservation.customer.lastName || ''}`.trim() : 'Customer pending'}
                          </div>
                          <div className="inline-actions">
                            <span className="badge">Checkout {snapshot.checkout ? 'Yes' : 'No'}</span>
                            <span className="badge">Check-In {snapshot.checkin ? 'Yes' : 'No'}</span>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="surface-note">No inspection history has been recorded for this vehicle yet.</div>
                )}
              </section>
            </div>

            <aside className="vehicle-profile-side">
              <section className="glass card-lg qr-label-shell qr-print-zone">
                <div className="qr-print-card">
                  <div className="qr-label-meta">
                    <span className="eyebrow">Vehicle QR Label</span>
                    <strong>{row.internalNumber}</strong>
                    <span>{vehicleDisplayName(row)}</span>
                    <span>{row.plate || 'Plate pending'}</span>
                  </div>
                  <div className="qr-art-frame">
                    {qrDataUrl ? <img src={qrDataUrl} alt={`QR code for ${row.internalNumber}`} className="qr-art" /> : <div className="surface-note">Generating QR...</div>}
                  </div>
                  <div className="qr-label-copy">
                    <strong>Scan to open vehicle profile</strong>
                    <span>Rental agent can review the unit, see the active or next reservation, and jump into the return workflow.</span>
                    {activeReservation ? <span>Active return: {activeReservation.reservationNumber}</span> : null}
                    {!activeReservation && nextReservation ? <span>Next handoff: {nextReservation.reservationNumber}</span> : null}
                  </div>
                  <div className="qr-screen-only inline-actions">
                    <button type="button" onClick={printQr} disabled={!qrDataUrl}>Print QR Label</button>
                    {qrUrl ? <a href={qrUrl} className="legal-link-pill">Open Direct Link</a> : null}
                  </div>
                </div>
              </section>
            </aside>
          </div>
        )}
      </section>
    </AppShell>
  );
}
