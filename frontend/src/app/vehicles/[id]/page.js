'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { diagramFor, DIAGRAM_VIEWBOX, DIAGRAM_W, DIAGRAM_H, VIEW_LABELS } from '../../../components/vehicleDiagrams';

const DAMAGE_VIEWS = ['LEFT', 'RIGHT', 'FRONT', 'REAR', 'INTERIOR'];

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

function mileageSourceLabel(source) {
  switch (String(source || '').toUpperCase()) {
    case 'CHECKOUT': return 'Check-out';
    case 'CHECKIN': return 'Check-in';
    case 'MANUAL': return 'Manual adjustment';
    case 'TELEMATICS': return 'Telematics';
    case 'IMPORT': return 'Imported';
    default: return source || '-';
  }
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
  const [mileageForm, setMileageForm] = useState({ open: false, mileage: '', note: '', saving: false });
  // Vehicle Profile pack (2026-06-10): inventory-photo history + registration
  // document + tenant rotation rule for the Value tile.
  const [invPhotos, setInvPhotos] = useState({ sessions: [], sessionId: null, photos: {}, loading: true });
  const [regDoc, setRegDoc] = useState({ url: null, uploading: false });
  const [rotationRule, setRotationRule] = useState('TIME');
  const regFileInputRef = useRef(null);
  // 2026-06-11 (pedido de Hector): Edit Vehicle vive EN el perfil — modal
  // local, save → PATCH → cierra → loadVehicle() refresca. Antes navegaba a
  // /vehicles?edit= y el agente quedaba varado en la lista.
  const [editModal, setEditModal] = useState({ open: false, saving: false, form: null });
  const [editLists, setEditLists] = useState({ vehicleTypes: [], locations: [] });
  // Fase C (2026-06-11) — damage history (hard-approved customer reports).
  const [damage, setDamage] = useState({ active: [], fixed: [], diagramType: 'sedan', loading: true });
  const [damageView, setDamageView] = useState('LEFT');
  const [fixModal, setFixModal] = useState(null); // { report, photo, saving }
  const fixFileRef = useRef(null);

  const loadDamage = async () => {
    try {
      const out = await api(`/api/customer-inspections/vehicle/${id}`, { bypassCache: true }, token);
      setDamage({
        active: out?.active || [],
        fixed: out?.fixed || [],
        diagramType: out?.vehicle?.diagramType || 'sedan',
        loading: false,
      });
    } catch {
      setDamage((c) => ({ ...c, loading: false }));
    }
  };
  useEffect(() => { if (id) loadDamage(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id, token]);

  const markFixed = async () => {
    if (!fixModal?.report || !fixModal.photo) return;
    setFixModal((c) => ({ ...c, saving: true }));
    try {
      await api(`/api/customer-inspections/reports/${fixModal.report.id}/fix`, {
        method: 'POST',
        body: JSON.stringify({ photoDataUrl: fixModal.photo }),
      }, token);
      setFixModal(null);
      setMsg('Damage marked as fixed');
      await loadDamage();
    } catch (e2) {
      setFixModal((c) => ({ ...c, saving: false }));
      setMsg(e2?.message || 'Failed to mark fixed');
    }
  };

  const openEditModal = async () => {
    if (!row) return;
    setEditModal({
      open: true,
      saving: false,
      form: {
        internalNumber: row.internalNumber || '',
        plate: row.plate || '',
        tollTagNumber: row.tollTagNumber || '',
        tollStickerNumber: row.tollStickerNumber || '',
        vin: row.vin || '',
        make: row.make || '',
        model: row.model || '',
        color: row.color || '',
        year: row.year || '',
        mileage: row.mileage ?? '',
        fuelTankCapacityGallons: row.fuelTankCapacityGallons ?? '',
        registrationExpiresAt: row.registrationExpiresAt ? String(row.registrationExpiresAt).slice(0, 10) : '',
        acquisitionCost: row.acquisitionCost ?? '',
        acquisitionDate: row.acquisitionDate ? String(row.acquisitionDate).slice(0, 10) : '',
        depreciationAnnualPct: row.depreciationAnnualPct ?? '',
        targetFleetMonths: row.targetFleetMonths ?? '',
        targetFleetMiles: row.targetFleetMiles ?? '',
        status: row.status || 'AVAILABLE',
        vehicleTypeId: row.vehicleTypeId || '',
        homeLocationId: row.homeLocationId || '',
        fleetMode: row.fleetMode || 'RENTAL_ONLY',
        programCategory: row.programCategory || 'BOTH',
      },
    });
    if (!editLists.vehicleTypes.length) {
      try {
        const [types, locs] = await Promise.all([
          api('/api/vehicle-types', {}, token).catch(() => []),
          api('/api/locations', {}, token).catch(() => []),
        ]);
        setEditLists({
          vehicleTypes: Array.isArray(types) ? types : (types?.vehicleTypes || []),
          locations: Array.isArray(locs) ? locs : (locs?.locations || []),
        });
      } catch { /* selects degrade to current values */ }
    }
  };

  const setEditField = (key, value) => setEditModal((c) => ({ ...c, form: { ...c.form, [key]: value } }));

  const saveEditModal = async (e) => {
    e.preventDefault();
    const f = editModal.form;
    if (!f) return;
    try {
      setEditModal((c) => ({ ...c, saving: true }));
      await api(`/api/vehicles/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...f,
          year: f.year ? Number(f.year) : null,
          mileage: f.mileage ? Number(f.mileage) : 0,
          fuelTankCapacityGallons: f.fuelTankCapacityGallons ? Number(f.fuelTankCapacityGallons) : null,
          registrationExpiresAt: f.registrationExpiresAt || null,
          acquisitionCost: f.acquisitionCost ? Number(f.acquisitionCost) : null,
          acquisitionDate: f.acquisitionDate || null,
          depreciationAnnualPct: f.depreciationAnnualPct ? Number(f.depreciationAnnualPct) : null,
          targetFleetMonths: f.targetFleetMonths ? Number(f.targetFleetMonths) : null,
          targetFleetMiles: f.targetFleetMiles ? Number(f.targetFleetMiles) : null,
          homeLocationId: f.homeLocationId || null,
        }),
      }, token);
      setEditModal({ open: false, saving: false, form: null });
      setMsg('Vehicle updated');
      await loadVehicle();
    } catch (err) {
      setEditModal((c) => ({ ...c, saving: false }));
      setMsg(err?.message || 'Update failed');
    }
  };

  const loadVehicle = async () => {
    const out = await api(`/api/vehicles/${id}`, {}, token);
    setRow(out);
  };

  const loadInventoryPhotos = async (sessionId = null) => {
    setInvPhotos((c) => ({ ...c, loading: true }));
    try {
      const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const out = await api(`/api/vehicles/${id}/inventory-photos${q}`, {}, token);
      setInvPhotos({ sessions: out?.sessions || [], sessionId: out?.sessionId || null, photos: out?.photos || {}, loading: false });
    } catch {
      setInvPhotos({ sessions: [], sessionId: null, photos: {}, loading: false });
    }
  };

  const uploadRegistrationDoc = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        setRegDoc((c) => ({ ...c, uploading: true }));
        await api(`/api/vehicles/${id}/registration-document`, {
          method: 'POST',
          body: JSON.stringify({ dataUrl: reader.result })
        }, token);
        const out = await api(`/api/vehicles/${id}/registration-document`, {}, token).catch(() => null);
        setRegDoc({ url: out?.url || null, uploading: false });
        setMsg('Registration document uploaded');
      } catch (e2) {
        setRegDoc((c) => ({ ...c, uploading: false }));
        setMsg(e2?.message || 'Upload failed');
      }
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (!id) return;
    loadVehicle()
      .catch((error) => setMsg(error.message));
  }, [id, token]);

  useEffect(() => {
    if (!id) return;
    loadInventoryPhotos();
    api('/api/settings/fleet-rotation', {}, token)
      .then((out) => setRotationRule(out?.rule === 'MILEAGE' ? 'MILEAGE' : 'TIME'))
      .catch(() => {});
  }, [id, token]);

  useEffect(() => {
    if (!id || !row?.registrationDocumentUrl) return;
    api(`/api/vehicles/${id}/registration-document`, {}, token)
      .then((out) => setRegDoc((c) => ({ ...c, url: out?.url || null })))
      .catch(() => {});
  }, [id, token, row?.registrationDocumentUrl]);

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
  const mileageHistory = Array.isArray(row?.mileageHistory) ? row.mileageHistory : [];
  const lastMileageEntry = row?.lastMileageEntry || null;
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

  const saveManualMileage = async () => {
    const value = Number(mileageForm.mileage);
    if (!Number.isFinite(value) || value < 0) {
      setMsg('Enter a valid mileage (0 or greater)');
      return;
    }
    try {
      setMileageForm((current) => ({ ...current, saving: true }));
      setMsg('');
      await api(`/api/vehicles/${id}/mileage`, {
        method: 'POST',
        body: JSON.stringify({ mileage: value, note: mileageForm.note || null })
      }, token);
      await loadVehicle();
      setMileageForm({ open: false, mileage: '', note: '', saving: false });
      setMsg('Mileage updated');
    } catch (error) {
      setMileageForm((current) => ({ ...current, saving: false }));
      setMsg(error.message);
    }
  };

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
                <Link href={`/reservations/${activeReservation.id}/checkin-wizard`} className="legal-link-pill">Go To Check-In</Link>
              </>
            ) : null}
            {!activeReservation && nextReservation ? (
              <Link href={`/reservations/${nextReservation.id}`} className="legal-link-pill">Open Next Reservation</Link>
            ) : null}
            <button type="button" className="button-subtle" onClick={printQr} disabled={!qrDataUrl}>Print QR Label</button>
          </div>
        </div>

        {msg ? <div className="glass card error">{msg}</div> : null}

        {mileageForm.open ? (
          <div
            role="dialog"
            aria-modal="true"
            style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', padding: 16 }}
            onClick={() => { if (!mileageForm.saving) setMileageForm({ open: false, mileage: '', note: '', saving: false }); }}
          >
            <div className="glass card-lg" style={{ maxWidth: 420, width: '100%' }} onClick={(e) => e.stopPropagation()}>
              <h2 style={{ marginTop: 0 }}>Adjust mileage</h2>
              <p className="ui-muted" style={{ marginTop: 0 }}>
                This logs a manual entry in the history and becomes the vehicle's current mileage. It does not erase previous entries.
              </p>
              <div className="stack" style={{ marginBottom: 10 }}>
                <label className="label">Mileage</label>
                <input
                  type="number"
                  min="0"
                  value={mileageForm.mileage}
                  onChange={(e) => setMileageForm((current) => ({ ...current, mileage: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="stack" style={{ marginBottom: 14 }}>
                <label className="label">Note (optional)</label>
                <input
                  type="text"
                  placeholder="e.g. fixing a typo from check-in"
                  value={mileageForm.note}
                  onChange={(e) => setMileageForm((current) => ({ ...current, note: e.target.value }))}
                />
              </div>
              <div className="inline-actions" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn-ghost" disabled={mileageForm.saving} onClick={() => setMileageForm({ open: false, mileage: '', note: '', saving: false })}>
                  Cancel
                </button>
                <button type="button" className="button-primary" disabled={mileageForm.saving} onClick={saveManualMileage}>
                  {mileageForm.saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {fixModal?.report ? (
          <div className="modal-backdrop" onClick={() => { if (!fixModal.saving) setFixModal(null); }}>
            <div className="rent-modal glass" onClick={(e) => e.stopPropagation()}>
              <h3>Damage · {fixModal.report.description || 'No description'}</h3>
              <p className="ui-muted" style={{ fontSize: 13, marginTop: 0 }}>
                {VIEW_LABELS[fixModal.report.view]} view · hard approved {formatDateTime(fixModal.report.approvedAt)}
                {fixModal.report.reservationNumber ? ` · from #${fixModal.report.reservationNumber}` : ''}
              </p>
              {fixModal.report.photoUrl ? (
                <a href={fixModal.report.photoUrl} target="_blank" rel="noreferrer">
                  <img src={fixModal.report.photoUrl} alt="damage" style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 10, marginBottom: 12 }} />
                </a>
              ) : null}
              <p style={{ fontWeight: 600, fontSize: 14, margin: '0 0 8px' }}>Was this fixed?</p>
              <input ref={fixFileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => setFixModal((c) => (c ? { ...c, photo: reader.result } : c));
                  reader.readAsDataURL(file);
                }} />
              <button type="button" className="btn-sm" style={{ width: '100%', marginBottom: 8 }} disabled={fixModal.saving} onClick={() => fixFileRef.current?.click()}>
                {fixModal.photo ? '✓ Repair photo attached — retake' : 'Take photo of the repair (required)'}
              </button>
              {fixModal.photo ? <img src={fixModal.photo} alt="repair" style={{ width: '100%', maxHeight: 160, objectFit: 'cover', borderRadius: 8, marginBottom: 8 }} /> : null}
              <div className="row-between">
                <button type="button" disabled={fixModal.saving} onClick={() => setFixModal(null)}>Cancel</button>
                <button type="button" className="button-primary" disabled={!fixModal.photo || fixModal.saving} onClick={markFixed}>
                  {fixModal.saving ? 'Saving…' : 'Yes — mark as fixed'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {editModal.open && editModal.form ? (
          <div className="modal-backdrop" onClick={() => { if (!editModal.saving) setEditModal({ open: false, saving: false, form: null }); }}>
            <div className="rent-modal glass" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '85vh', overflowY: 'auto' }}>
              <h3>Edit Vehicle | {row?.internalNumber}</h3>
              <form className="stack" onSubmit={saveEditModal}>
                <div className="grid2">
                  <input required placeholder="Unit ID" value={editModal.form.internalNumber} onChange={(e) => setEditField('internalNumber', e.target.value)} />
                  <input placeholder="License Plate" value={editModal.form.plate} onChange={(e) => setEditField('plate', e.target.value)} />
                </div>
                <div className="grid2">
                  <input placeholder="Toll Tag Number" value={editModal.form.tollTagNumber} onChange={(e) => setEditField('tollTagNumber', e.target.value)} />
                  <input placeholder="Toll Sticker Number" value={editModal.form.tollStickerNumber} onChange={(e) => setEditField('tollStickerNumber', e.target.value)} />
                </div>
                <div className="grid2">
                  <input placeholder="VIN" value={editModal.form.vin} onChange={(e) => setEditField('vin', e.target.value)} />
                  <input placeholder="Make" value={editModal.form.make} onChange={(e) => setEditField('make', e.target.value)} />
                </div>
                <div className="grid2">
                  <input placeholder="Model" value={editModal.form.model} onChange={(e) => setEditField('model', e.target.value)} />
                  <input placeholder="Color" value={editModal.form.color} onChange={(e) => setEditField('color', e.target.value)} />
                </div>
                <div className="grid2">
                  <input placeholder="Year" value={editModal.form.year} onChange={(e) => setEditField('year', e.target.value)} />
                  <input placeholder="Mileage" value={editModal.form.mileage} onChange={(e) => setEditField('mileage', e.target.value)} />
                </div>
                <div className="grid2">
                  <input type="number" step="0.1" min="5" max="60" placeholder="Fuel tank capacity (gal)" value={editModal.form.fuelTankCapacityGallons} onChange={(e) => setEditField('fuelTankCapacityGallons', e.target.value)} />
                  <select value={editModal.form.status} onChange={(e) => setEditField('status', e.target.value)}>
                    {['AVAILABLE', 'RESERVED', 'ON_RENT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <label className="label" style={{ marginBottom: 0 }}>Registration expires</label>
                <input type="date" value={editModal.form.registrationExpiresAt} onChange={(e) => setEditField('registrationExpiresAt', e.target.value)} />
                <label className="label" style={{ marginBottom: 0 }}>Value tracker (optional)</label>
                <div className="grid2">
                  <input type="number" min="0" step="0.01" placeholder="Acquisition cost ($)" value={editModal.form.acquisitionCost} onChange={(e) => setEditField('acquisitionCost', e.target.value)} />
                  <input type="date" title="Acquisition date" value={editModal.form.acquisitionDate} onChange={(e) => setEditField('acquisitionDate', e.target.value)} />
                </div>
                <div className="grid2">
                  <input type="number" min="0" max="99" step="0.5" placeholder="Depreciation %/yr" value={editModal.form.depreciationAnnualPct} onChange={(e) => setEditField('depreciationAnnualPct', e.target.value)} />
                  <input type="number" min="1" placeholder="Target months in fleet" value={editModal.form.targetFleetMonths} onChange={(e) => setEditField('targetFleetMonths', e.target.value)} />
                </div>
                <input type="number" min="1" placeholder="Target miles (rotation by mileage)" value={editModal.form.targetFleetMiles} onChange={(e) => setEditField('targetFleetMiles', e.target.value)} />
                <div className="grid2">
                  <select value={editModal.form.vehicleTypeId} onChange={(e) => setEditField('vehicleTypeId', e.target.value)}>
                    <option value={editModal.form.vehicleTypeId}>{row?.vehicleType?.name || 'Vehicle type'}</option>
                    {editLists.vehicleTypes.filter((vt) => vt.id !== editModal.form.vehicleTypeId).map((vt) => <option key={vt.id} value={vt.id}>{vt.name}</option>)}
                  </select>
                  <select value={editModal.form.homeLocationId} onChange={(e) => setEditField('homeLocationId', e.target.value)}>
                    <option value="">Home location</option>
                    {editLists.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    {editModal.form.homeLocationId && !editLists.locations.some((l) => l.id === editModal.form.homeLocationId)
                      ? <option value={editModal.form.homeLocationId}>{row?.homeLocation?.name || 'Current location'}</option>
                      : null}
                  </select>
                </div>
                <div className="grid2">
                  <select value={editModal.form.fleetMode} onChange={(e) => setEditField('fleetMode', e.target.value)}>
                    <option value="RENTAL_ONLY">RENTAL_ONLY</option>
                    <option value="CAR_SHARING_ONLY">CAR_SHARING_ONLY</option>
                    <option value="BOTH">BOTH</option>
                  </select>
                  <select value={editModal.form.programCategory} onChange={(e) => setEditField('programCategory', e.target.value)}>
                    <option value="BOTH">Flexible (rental and loaner)</option>
                    <option value="RENTAL_ONLY">Rental only</option>
                    <option value="LOANER_ONLY">Loaner only</option>
                  </select>
                </div>
                <div className="row-between">
                  <button type="button" disabled={editModal.saving} onClick={() => setEditModal({ open: false, saving: false, form: null })}>Cancel</button>
                  <button type="submit" disabled={editModal.saving}>{editModal.saving ? 'Saving…' : 'Save Vehicle'}</button>
                </div>
              </form>
            </div>
          </div>
        ) : null}

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
                        <Link href={`/reservations/${activeReservation.id}/checkin-wizard`} className="legal-link-pill">Check In Vehicle</Link>
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
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="status-chip neutral">{row.vehicleType?.name || row.vehicleType?.code || 'No type'}</span>
                    <button type="button" className="btn-sm" onClick={openEditModal}>
                      Edit vehicle
                    </button>
                  </span>
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
                  <div className="info-tile">
                    <span className="label">Fuel Tank</span>
                    <strong>{row.fuelTankCapacityGallons ? `${Number(row.fuelTankCapacityGallons)} gal` : 'Not set'}</strong>
                    {!row.fuelTankCapacityGallons && <span className="ui-muted">Fuel fees assume 15 gal until set</span>}
                  </div>
                  <div className="info-tile">
                    <span className="label">Mileage</span>
                    <strong>{(row.mileage ?? 0).toLocaleString()} mi</strong>
                    <span className="ui-muted">
                      {lastMileageEntry
                        ? `${mileageSourceLabel(lastMileageEntry.source)}${lastMileageEntry.reservationNumber ? ` · ${lastMileageEntry.reservationNumber}` : ''} · ${formatDateTime(lastMileageEntry.recordedAt)}`
                        : 'No mileage entries yet.'}
                    </span>
                    <button type="button" className="btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setMileageForm({ open: true, mileage: String(row.mileage ?? ''), note: '', saving: false })}>
                      Adjust mileage
                    </button>
                  </div>
                  <div className="info-tile"><span className="label">Color</span><strong>{row.color || '-'}</strong></div>
                  <div className="info-tile">
                    <span className="label">Registration</span>
                    {(() => {
                      if (!row.registrationExpiresAt) return <strong>Not set</strong>;
                      const exp = new Date(row.registrationExpiresAt);
                      const days = Math.ceil((exp.getTime() - Date.now()) / 86400000);
                      const text = exp.toLocaleDateString();
                      if (days < 0) return <><strong style={{ color: '#DC2626' }}>{text}</strong><span className="ui-muted">Expired {Math.abs(days)} day{Math.abs(days) === 1 ? '' : 's'} ago</span></>;
                      if (days <= 30) return <><strong style={{ color: '#D97706' }}>{text}</strong><span className="ui-muted">Expires in {days} day{days === 1 ? '' : 's'}</span></>;
                      return <><strong>{text}</strong><span className="ui-muted">{days} days left</span></>;
                    })()}
                    <span style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {regDoc.url ? <a href={regDoc.url} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">View document</a> : null}
                      <button type="button" className="btn-sm" disabled={regDoc.uploading} onClick={() => regFileInputRef.current?.click()}>
                        {regDoc.uploading ? 'Uploading…' : (regDoc.url ? 'Replace document' : 'Upload document')}
                      </button>
                      <input ref={regFileInputRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={(e) => { uploadRegistrationDoc(e.target.files?.[0]); e.target.value = ''; }} />
                    </span>
                  </div>
                  <div className="info-tile">
                    <span className="label">Value</span>
                    {(() => {
                      const cost = Number(row.acquisitionCost || 0);
                      const pct = row.depreciationAnnualPct == null ? null : Number(row.depreciationAnnualPct);
                      if (!cost || pct == null || !row.acquisitionDate) {
                        return <><strong>Not set</strong><span className="ui-muted">Set cost, % and date in Edit vehicle</span></>;
                      }
                      const months = Math.max(0, (Date.now() - new Date(row.acquisitionDate).getTime()) / (86400000 * 30.4375));
                      const value = cost * Math.pow(1 - pct / 100, months / 12);
                      const ready = rotationRule === 'MILEAGE'
                        ? (row.targetFleetMiles ? (row.mileage ?? 0) >= row.targetFleetMiles : null)
                        : (row.targetFleetMonths ? months >= row.targetFleetMonths : null);
                      const target = rotationRule === 'MILEAGE'
                        ? (row.targetFleetMiles ? `${(row.mileage ?? 0).toLocaleString()} / ${Number(row.targetFleetMiles).toLocaleString()} mi` : null)
                        : (row.targetFleetMonths ? `${Math.round(months)} / ${row.targetFleetMonths} months in fleet` : null);
                      return (
                        <>
                          <strong>${Math.round(value).toLocaleString()}</strong>
                          <span className="ui-muted">−{Math.round((1 - value / cost) * 100)}% of ${Math.round(cost).toLocaleString()} · {pct}%/yr</span>
                          {target ? (
                            <span className="ui-muted" style={ready ? { color: '#D97706', fontWeight: 600 } : undefined}>
                              {target}{ready ? ' · READY TO ROTATE' : ''}
                            </span>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>
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
                  <h2>Inventory Photos</h2>
                  {invPhotos.sessions.length > 1 ? (
                    <select
                      value={invPhotos.sessionId || ''}
                      onChange={(e) => loadInventoryPhotos(e.target.value)}
                      style={{ maxWidth: 240 }}
                    >
                      {invPhotos.sessions.map((s, idx) => (
                        <option key={s.sessionId} value={s.sessionId}>
                          {new Date(s.capturedAt).toLocaleDateString()}{idx === 0 ? ' (latest)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="status-chip neutral">{invPhotos.sessions.length} session{invPhotos.sessions.length === 1 ? '' : 's'}</span>
                  )}
                </div>
                <p className="ui-muted" style={{ marginTop: 0 }}>
                  Photos captured during fleet inventories (Inventory Helper). Separate from rental check-out/check-in inspections.
                </p>
                {invPhotos.loading ? (
                  <div className="surface-note">Loading inventory photos…</div>
                ) : Object.keys(invPhotos.photos).length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
                    {Object.entries(invPhotos.photos).map(([key, url]) => {
                      const first = Array.isArray(url) ? url[0] : url;
                      if (!first || typeof first !== 'string') return null;
                      return (
                        <a key={key} href={first} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
                          <img src={first} alt={key} style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 8 }} />
                          <span className="ui-muted" style={{ fontSize: 12, textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</span>
                        </a>
                      );
                    })}
                  </div>
                ) : (
                  <div className="surface-note">No inventory photos for this vehicle yet — they appear after its first Inventory Helper session.</div>
                )}
              </section>

              <section className="glass card-lg section-card">
                <div className="row-between">
                  <h2>Damage History</h2>
                  <span className="status-chip neutral">{damage.active.length} active · {damage.fixed.length} fixed</span>
                </div>
                <p className="ui-muted" style={{ marginTop: 0 }}>
                  Hard-approved customer damage reports. Active dots must be repaired (photo required) to leave the diagram — fixed ones stay in the history below.
                </p>
                {damage.loading ? (
                  <div className="surface-note">Loading damage history…</div>
                ) : damage.active.length === 0 && damage.fixed.length === 0 ? (
                  <div className="surface-note">No hard-approved damages on this vehicle.</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', border: '1px solid #E5E7EB', borderRadius: 999, overflow: 'hidden', marginBottom: 10, maxWidth: 480 }}>
                      {DAMAGE_VIEWS.map((v) => {
                        const n = damage.active.filter((r) => r.view === v).length;
                        return (
                          <button key={v} type="button" onClick={() => setDamageView(v)} style={{
                            flex: 1, fontSize: 12, padding: '7px 2px', border: 'none', borderRadius: 0,
                            background: v === damageView ? '#5b3df5' : 'transparent',
                            color: v === damageView ? '#FFFFFF' : '#6B7280', cursor: 'pointer',
                          }}>
                            {VIEW_LABELS[v]}{n ? ` · ${n}` : ''}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, alignItems: 'start' }}>
                      <svg viewBox={DIAGRAM_VIEWBOX} style={{ width: '100%', background: '#F6F4FE', borderRadius: 14 }} xmlns="http://www.w3.org/2000/svg">
                        <g dangerouslySetInnerHTML={{ __html: diagramFor(damage.diagramType, damageView) }} />
                        <g>
                          {damage.active.filter((r) => r.view === damageView).map((r, i) => (
                            <g key={r.id} style={{ cursor: 'pointer' }} onClick={() => setFixModal({ report: r, photo: null, saving: false })}>
                              <circle cx={(r.xPct / 100) * DIAGRAM_W} cy={(r.yPct / 100) * DIAGRAM_H} r="10" fill="#E24B4A" stroke="#FFFFFF" strokeWidth="2" />
                              <text x={(r.xPct / 100) * DIAGRAM_W} y={(r.yPct / 100) * DIAGRAM_H + 3.5} textAnchor="middle" fill="#FFFFFF" fontSize="11" fontWeight="600">{i + 1}</text>
                            </g>
                          ))}
                        </g>
                      </svg>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {damage.active.length === 0 ? (
                          <div className="surface-note">No active damages — all repaired.</div>
                        ) : (
                          <>
                            <span className="ui-muted" style={{ fontSize: 12 }}>Tap a red dot (or a row) to see the damage and mark it fixed.</span>
                            {damage.active.map((r) => (
                              <button key={r.id} type="button" className="btn-ghost" style={{ textAlign: 'left', padding: 10, border: '1px solid #E5E7EB', borderRadius: 8 }} onClick={() => setFixModal({ report: r, photo: null, saving: false })}>
                                <strong style={{ fontSize: 13 }}>{r.description || 'Damage'}</strong>
                                <span className="ui-muted" style={{ display: 'block', fontSize: 12 }}>
                                  {VIEW_LABELS[r.view]} view · approved {formatDateTime(r.approvedAt)}{r.reservationNumber ? ` · #${r.reservationNumber}` : ''}
                                </span>
                              </button>
                            ))}
                          </>
                        )}
                        {damage.fixed.length ? (
                          <details style={{ marginTop: 4 }}>
                            <summary className="ui-muted" style={{ cursor: 'pointer', fontSize: 13 }}>Fixed history ({damage.fixed.length})</summary>
                            {damage.fixed.map((r) => (
                              <div key={r.id} style={{ padding: '8px 0', borderBottom: '0.5px solid #E5E7EB', fontSize: 12 }}>
                                <strong>{r.description || 'Damage'}</strong> · {VIEW_LABELS[r.view]} view
                                <span className="ui-muted"> · fixed {formatDateTime(r.fixedAt)}</span>
                                <span style={{ marginLeft: 6 }}>
                                  {r.photoUrl ? <a href={r.photoUrl} target="_blank" rel="noreferrer">damage photo</a> : null}
                                  {r.photoUrl && r.fixedPhotoUrl ? ' · ' : ''}
                                  {r.fixedPhotoUrl ? <a href={r.fixedPhotoUrl} target="_blank" rel="noreferrer">repair photo</a> : null}
                                </span>
                              </div>
                            ))}
                          </details>
                        ) : null}
                      </div>
                    </div>
                  </>
                )}
              </section>

              <section className="glass card-lg section-card">
                <div className="row-between">
                  <h2>Mileage History</h2>
                  <span className="status-chip neutral">{mileageHistory.length} entries</span>
                </div>
                <p className="ui-muted" style={{ marginTop: 0 }}>
                  The vehicle's current mileage is always the latest recorded entry. Every check-out, check-in, and manual adjustment shows up here.
                </p>
                {mileageHistory.length ? (
                  <div className="table-shell">
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Mileage</th>
                          <th>Source</th>
                          <th>Reservation</th>
                          <th>Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mileageHistory.map((entry, index) => (
                          <tr key={entry.id}>
                            <td>
                              {formatDateTime(entry.recordedAt)}
                              {index === 0 && entry.mileage === row.mileage ? <span className="status-chip good" style={{ marginLeft: 6 }}>Current</span> : null}
                            </td>
                            <td><strong>{(entry.mileage ?? 0).toLocaleString()} mi</strong></td>
                            <td><span className="status-chip neutral">{mileageSourceLabel(entry.source)}</span></td>
                            <td>{entry.reservationNumber || '-'}</td>
                            <td>{entry.note || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="surface-note">This vehicle has no mileage entries yet. They'll be recorded automatically on the next check-out or check-in, or you can adjust it manually.</div>
                )}
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
                                  <Link href={`/reservations/${reservation.id}/checkin-wizard`} className="legal-link-pill">Check In</Link>
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
