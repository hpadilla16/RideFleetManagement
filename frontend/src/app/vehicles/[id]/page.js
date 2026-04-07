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
    case 'WASH_HOLD': return 'Wash Buffer';
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

function statusTone(value) {
  switch (String(value || '').toUpperCase()) {
    case 'READY':
    case 'ONLINE':
      return 'good';
    case 'WATCH':
      return 'neutral';
    case 'ATTENTION':
    case 'BLOCKED':
    case 'STALE':
    case 'NO_SIGNAL':
      return 'warn';
    default:
      return 'neutral';
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

function telematicsProviderLabel(provider) {
  switch (String(provider || '').toUpperCase()) {
    case 'ZUBIE': return 'Zubie';
    case 'SAMSARA': return 'Samsara';
    case 'GEOTAB': return 'Geotab';
    case 'AZUGA': return 'Azuga';
    default: return 'Generic';
  }
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
  const [savingTelematics, setSavingTelematics] = useState('');
  const [telematicsProviders, setTelematicsProviders] = useState([]);
  const [telematicsConfig, setTelematicsConfig] = useState(null);
  const [deviceForm, setDeviceForm] = useState({ provider: 'ZUBIE', externalDeviceId: '', label: '', serialNumber: '' });
  const [eventForm, setEventForm] = useState({ eventType: 'PING', odometer: '', fuelPct: '', speedMph: '', latitude: '', longitude: '', engineOn: false });

  const loadVehicle = async () => {
    const out = await api(`/api/vehicles/${id}`, {}, token);
    setRow(out);
  };

  useEffect(() => {
    if (!id) return;
    loadVehicle()
      .catch((error) => setMsg(error.message));
  }, [id, token]);

  useEffect(() => {
    api('/api/vehicles/telematics/providers', {}, token)
      .then((out) => setTelematicsProviders(Array.isArray(out) ? out : []))
      .catch(() => setTelematicsProviders([]));
  }, [token]);

  useEffect(() => {
    if (!row?.tenantId && !me?.tenantId) return;
    const query = me?.role === 'SUPER_ADMIN' && row?.tenantId ? `?tenantId=${encodeURIComponent(row.tenantId)}` : '';
    api(`/api/settings/telematics${query}`, {}, token)
      .then((out) => setTelematicsConfig(out || null))
      .catch(() => setTelematicsConfig(null));
  }, [token, me?.role, me?.tenantId, row?.tenantId]);

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
  const operationalSignals = row?.operationalSignals || null;
  const telematicsDevices = Array.isArray(row?.telematicsDevices) ? row.telematicsDevices : [];
  const latestTelematicsEvent = row?.latestTelematicsEvent || null;
  const canManageTelematics = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(String(me?.role || '').toUpperCase());
  const selectedTelematicsProvider = telematicsProviders.find((provider) => provider.code === String(deviceForm.provider || '').toUpperCase()) || null;
  const telematicsFeatureReady = telematicsConfig?.ready !== false;

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

  const saveTelematicsDevice = async () => {
    try {
      setSavingTelematics('device');
      setMsg('');
      await api(`/api/vehicles/${id}/telematics/devices`, {
        method: 'POST',
        body: JSON.stringify(deviceForm)
      }, token);
      await loadVehicle();
      setDeviceForm((current) => ({ ...current, externalDeviceId: '', label: '', serialNumber: '' }));
      setMsg('Telematics device linked to vehicle');
    } catch (error) {
      setMsg(error.message);
    } finally {
      setSavingTelematics('');
    }
  };

  const logTelematicsPing = async () => {
    try {
      setSavingTelematics('event');
      setMsg('');
      await api(`/api/vehicles/${id}/telematics/events`, {
        method: 'POST',
        body: JSON.stringify({
          ...eventForm,
          odometer: eventForm.odometer === '' ? null : Number(eventForm.odometer),
          fuelPct: eventForm.fuelPct === '' ? null : Number(eventForm.fuelPct),
          speedMph: eventForm.speedMph === '' ? null : Number(eventForm.speedMph),
          latitude: eventForm.latitude === '' ? null : Number(eventForm.latitude),
          longitude: eventForm.longitude === '' ? null : Number(eventForm.longitude)
        })
      }, token);
      await loadVehicle();
      setMsg('Telematics event logged');
    } catch (error) {
      setMsg(error.message);
    } finally {
      setSavingTelematics('');
    }
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
                  <h2>Operational Intelligence</h2>
                  <span className={`status-chip ${statusTone(operationalSignals?.status)}`}>{operationalSignals?.status || 'NO DATA'}</span>
                </div>
                <div className="app-card-grid compact">
                  <div className="info-tile">
                    <span className="label">Turn-Ready Score</span>
                    <strong>{operationalSignals?.turnReady?.score ?? '-'}</strong>
                    <span className="ui-muted">{operationalSignals?.turnReady?.summary || 'Turn-readiness has not been scored yet.'}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Turn-Ready Status</span>
                    <strong>{operationalSignals?.turnReady?.status || 'NO DATA'}</strong>
                    <span className="ui-muted">{operationalSignals?.turnReady?.activeBlockLabel ? `Current blocker: ${operationalSignals.turnReady.activeBlockLabel}.` : 'No active hold is reducing turn readiness right now.'}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Inspection Readiness</span>
                    <strong>{operationalSignals?.inspection?.status || 'NO DATA'}</strong>
                    <span className="ui-muted">{operationalSignals?.inspection?.summary || 'No inspection signal available yet.'}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Latest Inspection</span>
                    <strong>{operationalSignals?.inspection?.latestPhase || '-'}</strong>
                    <span className="ui-muted">{formatDateTime(operationalSignals?.inspection?.latestAt)}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Photo Coverage</span>
                    <strong>{operationalSignals?.inspection?.photoCoverage?.captured || 0}/{operationalSignals?.inspection?.photoCoverage?.required || 8}</strong>
                    <span className="ui-muted">Required inspection photo set completion.</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Condition Flags</span>
                    <strong>{operationalSignals?.inspection?.conditionAttentionCount || 0}</strong>
                    <span className="ui-muted">{operationalSignals?.inspection?.damageReported ? 'Damage was reported on the latest inspection.' : 'No latest damage note on file.'}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Damage Triage</span>
                    <strong>{operationalSignals?.inspection?.damageTriage?.severity || 'NONE'}</strong>
                    <span className="ui-muted">{operationalSignals?.inspection?.damageTriage?.summary || 'Damage triage has not flagged this unit.'}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Next Damage Action</span>
                    <strong>{operationalSignals?.inspection?.damageTriage?.confidence || 'LOW'} confidence</strong>
                    <span className="ui-muted">{operationalSignals?.inspection?.damageTriage?.recommendedAction || 'No damage action is currently recommended.'}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Telematics</span>
                    <strong>{operationalSignals?.telematics?.status || 'NO DEVICE'}</strong>
                    <span className="ui-muted">{operationalSignals?.telematics?.summary || 'No telematics feed linked yet.'}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Last Signal</span>
                    <strong>{formatDateTime(operationalSignals?.telematics?.lastEventAt || operationalSignals?.telematics?.lastSeenAt)}</strong>
                    <span className="ui-muted">{operationalSignals?.telematics?.provider || 'Provider pending'}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Fuel Status</span>
                    <strong>{operationalSignals?.telematics?.fuelStatus || 'UNKNOWN'}</strong>
                    <span className="ui-muted">{operationalSignals?.telematics?.fuelPct == null ? 'No live fuel reading yet.' : `Latest reading ${operationalSignals.telematics.fuelPct}%`}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">GPS Status</span>
                    <strong>{operationalSignals?.telematics?.gpsStatus || 'UNKNOWN'}</strong>
                    <span className="ui-muted">{operationalSignals?.telematics?.latitude != null && operationalSignals?.telematics?.longitude != null ? `${operationalSignals.telematics.latitude}, ${operationalSignals.telematics.longitude}` : 'Latest update did not include coordinates.'}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Odometer Feed</span>
                    <strong>{operationalSignals?.telematics?.odometerStatus || 'UNKNOWN'}</strong>
                    <span className="ui-muted">{operationalSignals?.telematics?.odometer == null ? 'No live mileage reported yet.' : `Latest live odometer ${operationalSignals.telematics.odometer}`}</span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Battery</span>
                    <strong>{operationalSignals?.telematics?.batteryStatus || 'UNKNOWN'}</strong>
                    <span className="ui-muted">{operationalSignals?.telematics?.batteryPct == null ? 'No battery reading reported.' : `Latest battery ${operationalSignals.telematics.batteryPct}%`}</span>
                  </div>
                </div>
                {operationalSignals?.attentionReasons?.length ? (
                  <div className="timeline-list" style={{ marginTop: 12 }}>
                    {operationalSignals.attentionReasons.map((reason) => (
                      <div key={reason} className="surface-note" style={{ background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>{reason}</div>
                    ))}
                  </div>
                ) : null}
                {operationalSignals?.turnReady?.reasons?.length ? (
                  <div className="timeline-list" style={{ marginTop: 12 }}>
                    {operationalSignals.turnReady.reasons.map((reason) => (
                      <div key={reason} className="surface-note">{reason}</div>
                    ))}
                  </div>
                ) : null}
                {operationalSignals?.turnReady?.blockers?.length ? (
                  <div className="timeline-list" style={{ marginTop: 12 }}>
                    {operationalSignals.turnReady.blockers.map((reason) => (
                      <div key={reason} className="surface-note" style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>{reason}</div>
                    ))}
                  </div>
                ) : null}
                {operationalSignals?.telematics?.alerts?.length ? (
                  <div className="timeline-list" style={{ marginTop: 12 }}>
                    {operationalSignals.telematics.alerts.map((reason) => (
                      <div key={reason} className="surface-note">{reason}</div>
                    ))}
                  </div>
                ) : null}
              </section>

              <section className="glass card-lg section-card">
                <div className="row-between">
                  <h2>Telematics</h2>
                  <span className={`status-chip ${statusTone(operationalSignals?.telematics?.status)}`}>{operationalSignals?.telematics?.status || 'NO DEVICE'}</span>
                </div>
                <div className="app-card-grid compact">
                  <div className="info-tile"><span className="label">Provider</span><strong>{operationalSignals?.telematics?.provider || '-'}</strong></div>
                  <div className="info-tile"><span className="label">Device</span><strong>{operationalSignals?.telematics?.deviceLabel || operationalSignals?.telematics?.externalDeviceId || '-'}</strong></div>
                  <div className="info-tile"><span className="label">Odometer</span><strong>{operationalSignals?.telematics?.odometer ?? '-'}</strong></div>
                  <div className="info-tile"><span className="label">Odometer Status</span><strong>{operationalSignals?.telematics?.odometerStatus || 'UNKNOWN'}</strong></div>
                  <div className="info-tile"><span className="label">Fuel %</span><strong>{operationalSignals?.telematics?.fuelPct ?? '-'}</strong></div>
                  <div className="info-tile"><span className="label">Fuel Status</span><strong>{operationalSignals?.telematics?.fuelStatus || 'UNKNOWN'}</strong></div>
                  <div className="info-tile"><span className="label">Battery %</span><strong>{operationalSignals?.telematics?.batteryPct ?? '-'}</strong></div>
                  <div className="info-tile"><span className="label">Battery Status</span><strong>{operationalSignals?.telematics?.batteryStatus || 'UNKNOWN'}</strong></div>
                  <div className="info-tile"><span className="label">Speed MPH</span><strong>{operationalSignals?.telematics?.speedMph ?? '-'}</strong></div>
                  <div className="info-tile"><span className="label">Movement</span><strong>{operationalSignals?.telematics?.movementStatus || 'UNKNOWN'}</strong></div>
                  <div className="info-tile"><span className="label">GPS</span><strong>{operationalSignals?.telematics?.gpsStatus || 'UNKNOWN'}</strong></div>
                  <div className="info-tile"><span className="label">Coordinates</span><strong>{operationalSignals?.telematics?.latitude != null && operationalSignals?.telematics?.longitude != null ? `${operationalSignals.telematics.latitude}, ${operationalSignals.telematics.longitude}` : '-'}</strong></div>
                </div>
                {operationalSignals?.telematics?.recommendedAction ? (
                  <div className="surface-note" style={{ marginTop: 12 }}>{operationalSignals.telematics.recommendedAction}</div>
                ) : null}
                {telematicsConfig && !telematicsFeatureReady ? (
                  <div className="surface-note" style={{ marginTop: 12, background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>
                    Telematics is currently disabled for this tenant or not included in the current package.
                  </div>
                ) : null}
                {telematicsDevices.length ? (
                  <div className="timeline-list" style={{ marginTop: 12 }}>
                    {telematicsDevices.map((device) => (
                      <article key={device.id} className="timeline-item">
                        <div className="row-between" style={{ marginBottom: 0 }}>
                          <strong>{device.label || device.externalDeviceId}</strong>
                          <span className={`status-chip ${device.isActive ? 'good' : 'neutral'}`}>{device.isActive ? 'Active' : 'Inactive'}</span>
                        </div>
                        <div className="ui-muted">{device.providerLabel || telematicsProviderLabel(device.provider)} | Serial {device.serialNumber || '-'}</div>
                        <div className="ui-muted">Last seen {formatDateTime(device.lastSeenAt)}</div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="surface-note" style={{ marginTop: 12 }}>No telematics device is linked to this vehicle yet.</div>
                )}
                {latestTelematicsEvent ? (
                  <div className="surface-note" style={{ marginTop: 12 }}>
                    Latest event {latestTelematicsEvent.eventType} at {formatDateTime(latestTelematicsEvent.eventAt)} | Odometer {latestTelematicsEvent.odometer ?? '-'} | Fuel {latestTelematicsEvent.fuelPct ?? '-'}%
                  </div>
                ) : null}
                {canManageTelematics ? (
                  <div className="stack" style={{ marginTop: 14, gap: 12 }}>
                    <div className="glass card" style={{ padding: 12 }}>
                      <div className="section-title" style={{ fontSize: 15, marginBottom: 8 }}>Link Telematics Device</div>
                      <div className="app-card-grid compact">
                        <div className="stack">
                          <label className="label">Provider</label>
                          <select value={deviceForm.provider} onChange={(e) => setDeviceForm((current) => ({ ...current, provider: e.target.value }))}>
                            {(telematicsProviders.length ? telematicsProviders : [{ code: 'ZUBIE', label: 'Zubie', recommended: true }, { code: 'GENERIC', label: 'Generic', recommended: false }]).map((provider) => (
                              <option key={provider.code} value={provider.code}>
                                {provider.label}{provider.recommended ? ' | Recommended' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="stack">
                          <label className="label">External Device ID</label>
                          <input value={deviceForm.externalDeviceId} onChange={(e) => setDeviceForm((current) => ({ ...current, externalDeviceId: e.target.value }))} />
                        </div>
                        <div className="stack">
                          <label className="label">Label</label>
                          <input value={deviceForm.label} onChange={(e) => setDeviceForm((current) => ({ ...current, label: e.target.value }))} />
                        </div>
                        <div className="stack">
                          <label className="label">Serial Number</label>
                          <input value={deviceForm.serialNumber} onChange={(e) => setDeviceForm((current) => ({ ...current, serialNumber: e.target.value }))} />
                        </div>
                      </div>
                      {selectedTelematicsProvider ? (
                        <div
                          className="surface-note"
                          style={{
                            marginTop: 10,
                            background: String(selectedTelematicsProvider.code || '').toUpperCase() === 'ZUBIE' ? '#eff6ff' : undefined,
                            borderColor: String(selectedTelematicsProvider.code || '').toUpperCase() === 'ZUBIE' ? '#bfdbfe' : undefined,
                            color: String(selectedTelematicsProvider.code || '').toUpperCase() === 'ZUBIE' ? '#1d4ed8' : undefined
                          }}
                        >
                          <strong>{selectedTelematicsProvider.label}</strong>
                          {' | '}
                          {selectedTelematicsProvider.notes || 'Telematics provider placeholder.'}
                        </div>
                      ) : null}
                      <div className="inline-actions" style={{ marginTop: 10 }}>
                        <button type="button" onClick={saveTelematicsDevice} disabled={savingTelematics === 'device' || !telematicsFeatureReady}>
                          {savingTelematics === 'device' ? 'Linking...' : 'Link Device'}
                        </button>
                      </div>
                    </div>

                    {!telematicsFeatureReady ? (
                      <div className="surface-note">
                        Telematics management is off for this tenant right now. Turn it on in Settings before linking devices or logging events.
                      </div>
                    ) : null}

                    <div className="glass card" style={{ padding: 12 }}>
                      <div className="section-title" style={{ fontSize: 15, marginBottom: 8 }}>Log Telematics Ping</div>
                      <div className="app-card-grid compact">
                        <div className="stack">
                          <label className="label">Event Type</label>
                          <input value={eventForm.eventType} onChange={(e) => setEventForm((current) => ({ ...current, eventType: e.target.value }))} />
                        </div>
                        <div className="stack">
                          <label className="label">Odometer</label>
                          <input type="number" min="0" value={eventForm.odometer} onChange={(e) => setEventForm((current) => ({ ...current, odometer: e.target.value }))} />
                        </div>
                        <div className="stack">
                          <label className="label">Fuel %</label>
                          <input type="number" min="0" max="100" step="0.01" value={eventForm.fuelPct} onChange={(e) => setEventForm((current) => ({ ...current, fuelPct: e.target.value }))} />
                        </div>
                        <div className="stack">
                          <label className="label">Speed MPH</label>
                          <input type="number" min="0" step="0.01" value={eventForm.speedMph} onChange={(e) => setEventForm((current) => ({ ...current, speedMph: e.target.value }))} />
                        </div>
                        <div className="stack">
                          <label className="label">Latitude</label>
                          <input type="number" step="0.000001" value={eventForm.latitude} onChange={(e) => setEventForm((current) => ({ ...current, latitude: e.target.value }))} />
                        </div>
                        <div className="stack">
                          <label className="label">Longitude</label>
                          <input type="number" step="0.000001" value={eventForm.longitude} onChange={(e) => setEventForm((current) => ({ ...current, longitude: e.target.value }))} />
                        </div>
                      </div>
                      <label className="label" style={{ marginTop: 10 }}><input type="checkbox" checked={eventForm.engineOn} onChange={(e) => setEventForm((current) => ({ ...current, engineOn: e.target.checked }))} /> Engine on</label>
                      <div className="inline-actions" style={{ marginTop: 10 }}>
                        <button type="button" onClick={logTelematicsPing} disabled={savingTelematics === 'event' || !telematicsFeatureReady || telematicsConfig?.allowManualEventIngest === false}>
                          {savingTelematics === 'event' ? 'Logging...' : 'Log Ping'}
                        </button>
                      </div>
                    </div>
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
