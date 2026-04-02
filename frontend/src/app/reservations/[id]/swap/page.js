'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

const FUEL_OPTIONS = ['0.000', '0.125', '0.250', '0.375', '0.500', '0.625', '0.750', '0.875', '1.000'];
const CONDITION_OPTIONS = ['GOOD', 'FAIR', 'POOR'];

const emptyInspection = {
  exterior: 'GOOD',
  interior: 'GOOD',
  tires: 'GOOD',
  lights: 'GOOD',
  windshield: 'GOOD',
  fuelLevel: '1.000',
  odometer: '',
  cleanliness: '5',
  damages: '',
  notes: ''
};

function vehicleLabel(vehicle) {
  if (!vehicle) return '-';
  return [[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' '), vehicle.plate || vehicle.internalNumber || '']
    .filter(Boolean)
    .join(' • ');
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function InspectionCard({ title, value, onChange }) {
  return (
    <section className="glass card stack">
      <div style={{ fontWeight: 700 }}>{title}</div>
      <div className="grid2">
        {['exterior', 'interior', 'tires', 'lights', 'windshield'].map((key) => (
          <div key={key} className="stack">
            <label className="label">{key[0].toUpperCase() + key.slice(1)}</label>
            <select value={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.value })}>
              {CONDITION_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
        ))}
        <div className="stack">
          <label className="label">Fuel</label>
          <select value={value.fuelLevel} onChange={(e) => onChange({ ...value, fuelLevel: e.target.value })}>
            {FUEL_OPTIONS.map((option, index) => <option key={option} value={option}>{index}/8</option>)}
          </select>
        </div>
        <div className="stack">
          <label className="label">Odometer</label>
          <input type="number" min="0" value={value.odometer} onChange={(e) => onChange({ ...value, odometer: e.target.value })} />
        </div>
        <div className="stack">
          <label className="label">Cleanliness (1-5)</label>
          <input type="number" min="1" max="5" value={value.cleanliness} onChange={(e) => onChange({ ...value, cleanliness: e.target.value })} />
        </div>
        <div className="stack">
          <label className="label">Damages</label>
          <input value={value.damages} onChange={(e) => onChange({ ...value, damages: e.target.value })} />
        </div>
      </div>
      <div className="stack">
        <label className="label">Notes</label>
        <textarea rows={3} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} />
      </div>
    </section>
  );
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const [row, setRow] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [note, setNote] = useState('');
  const [currentCheckin, setCurrentCheckin] = useState(emptyInspection);
  const [nextCheckout, setNextCheckout] = useState(emptyInspection);

  const choices = useMemo(() => {
    return (Array.isArray(vehicles) ? vehicles : []).filter((vehicle) => String(vehicle?.id || '') !== String(row?.vehicleId || ''));
  }, [vehicles, row?.vehicleId]);

  const selectedVehicle = choices.find((vehicle) => String(vehicle.id) === String(vehicleId)) || null;

  useEffect(() => {
    (async () => {
      try {
        const reservation = await api(`/api/reservations/${id}`, {}, token);
        setRow(reservation);
        const available = await api(`/api/reservations/${id}/available-vehicles`, {}, token);
        setVehicles(Array.isArray(available) ? available : []);
      } catch (e) {
        setMsg(String(e?.message || 'Unable to load vehicle swap'));
      }
    })();
  }, [id, token]);

  const submit = async () => {
    const nextVehicleId = String(vehicleId || '').trim();
    if (!nextVehicleId) return setMsg('Select the replacement vehicle');
    if (!currentCheckin.odometer) return setMsg('Current vehicle odometer is required');
    if (!nextCheckout.odometer) return setMsg('Replacement vehicle odometer is required');
    try {
      setSaving(true);
      setMsg('');
      await api(`/api/reservations/${id}/swap-vehicle`, {
        method: 'POST',
        body: JSON.stringify({
          vehicleId: nextVehicleId,
          note,
          currentCheckin,
          nextCheckout
        })
      }, token);
      router.push(`/reservations/${id}/inspection-report`);
    } catch (e) {
      setMsg(String(e?.message || 'Unable to swap vehicle'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Vehicle Swap</span>
              <h3 style={{ margin: 0 }}>{row?.reservationNumber || `Reservation ${id}`}</h3>
              <p className="ui-muted">
                Check the current vehicle back in, assign the replacement, and capture the new handoff in the inspection history.
              </p>
            </div>
            <span className="status-chip warn">Swap Workflow</span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Current Vehicle</span>
              <strong>{vehicleLabel(row?.vehicle)}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Replacement</span>
              <strong>{vehicleLabel(selectedVehicle) || 'Select vehicle'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Status</span>
              <strong>{row?.status || '-'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Customer</span>
              <strong>{[row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' ') || row?.customer?.email || '-'}</strong>
            </div>
          </div>
        </div>

        <div className="row-between">
          <h2>Swap Vehicle</h2>
          <button type="button" onClick={() => router.push(`/reservations/${id}`)}>Back</button>
        </div>
        {msg ? <div className="label" style={{ color: '#b91c1c' }}>{msg}</div> : null}

        <section className="glass card stack">
          <div className="grid2">
            <div className="stack">
              <label className="label">Replacement Vehicle</label>
              <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">Select available vehicle</option>
                {choices.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicleLabel(vehicle)}
                  </option>
                ))}
              </select>
            </div>
            <div className="stack">
              <label className="label">Swap Note</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for the swap, damage note, customer request, etc." />
            </div>
          </div>
        </section>

        <InspectionCard title="Current Vehicle Check-In" value={currentCheckin} onChange={setCurrentCheckin} />
        <InspectionCard title="Replacement Vehicle Check-Out" value={nextCheckout} onChange={setNextCheckout} />

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="ios-action-btn" type="button" disabled={saving} onClick={submit}>
            {saving ? 'Swapping...' : 'Complete Vehicle Swap'}
          </button>
        </div>
      </section>
    </AppShell>
  );
}
