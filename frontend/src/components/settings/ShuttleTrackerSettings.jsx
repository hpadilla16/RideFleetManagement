'use client';

/**
 * Shuttle tracker — per-location settings card (Settings → Locations editor).
 *
 * Self-contained on purpose: settings/page.js is 7,600 lines, so this owns its
 * own load/save against /api/shuttle-tracker/config instead of threading state
 * through the location editor. Saving the location and saving the tracker are
 * independent — an admin can flip the tracker without touching the location.
 *
 * The vehicle picker lists the tenant's fleet; the ids chosen here are the
 * ONLY vehicles the public page will ever resolve (whitelist, enforced
 * server-side on both write and read).
 */
import { useEffect, useState } from 'react';
import { api, readStoredToken } from '../../lib/client';

const MODES = [
  { value: 'OFF', label: 'Off — no tracker page' },
  { value: 'ON_DEMAND', label: 'On demand — customers can request the shuttle' },
  { value: 'NON_STOP', label: 'Non-stop loop — watch only, runs on a headway' },
];

export function ShuttleTrackerSettings({ locationId }) {
  const [config, setConfig] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | saving | error
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!locationId) return;
    let alive = true;
    (async () => {
      setStatus('loading');
      try {
        const token = readStoredToken();
        const [cfg, fleet] = await Promise.all([
          api(`/api/shuttle-tracker/config?locationId=${encodeURIComponent(locationId)}`, {}, token),
          api('/api/vehicles?limit=2000', {}, token),
        ]);
        if (!alive) return;
        setConfig(cfg);
        setVehicles(Array.isArray(fleet?.rows) ? fleet.rows : (Array.isArray(fleet) ? fleet : []));
        setStatus('ready');
      } catch (err) {
        if (!alive) return;
        setMessage(err?.message || 'Could not load tracker settings');
        setStatus('error');
      }
    })();
    return () => { alive = false; };
  }, [locationId]);

  const save = async () => {
    setStatus('saving');
    setMessage('');
    try {
      const saved = await api('/api/shuttle-tracker/config', {
        method: 'PUT',
        body: JSON.stringify({
          locationId,
          mode: config.mode,
          vehicleIds: config.vehicleIds,
          headwayMinutes: Number(config.headwayMinutes) || 10,
        }),
      }, readStoredToken());
      setConfig(saved);
      setStatus('ready');
      setMessage('Saved');
      setTimeout(() => setMessage(''), 2500);
    } catch (err) {
      setStatus('ready');
      setMessage(err?.message || 'Save failed');
    }
  };

  const toggleVehicle = (id) => {
    setConfig((c) => ({
      ...c,
      vehicleIds: c.vehicleIds.includes(id) ? c.vehicleIds.filter((v) => v !== id) : [...c.vehicleIds, id],
    }));
  };

  if (!locationId) return null;
  if (status === 'loading') return <div className="ui-muted" style={{ fontSize: 12 }}>Loading shuttle tracker…</div>;
  if (status === 'error') return <div className="ui-muted" style={{ fontSize: 12 }}>Shuttle tracker: {message}</div>;

  const on = config.mode !== 'OFF';
  // Owner decision (2026-08-25): the picker lists ONLY vehicles marked
  // SHUTTLE_ONLY — the whole point of the program category is that dedicated
  // shuttles are not rental inventory, and a 200-unit fleet in this list was
  // noise. Vehicles ALREADY selected on this config stay visible regardless
  // (a legacy config pointing at a not-yet-recategorized van must not have its
  // selection silently hidden).
  const shuttleVehicles = vehicles.filter(
    (v) => v.programCategory === 'SHUTTLE_ONLY' || config.vehicleIds.includes(v.id)
  );
  const plate = (v) => v.plate || v.licensePlate || '';
  const vehicleLabel = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ') + (plate(v) ? ` · ${plate(v)}` : '');

  return (
    <>
      <div className="label">Shuttle Tracker (customer live map)</div>
      <div className="stack">
        <label className="label">Mode</label>
        <select value={config.mode} onChange={(e) => setConfig({ ...config, mode: e.target.value })}>
          {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <div className="ui-muted" style={{ fontSize: 12 }}>
          When on, customers picking up here automatically receive a personal, expiring tracker link by email and SMS 24h before pickup. There is no shared URL — every link is tied to one reservation.
        </div>
      </div>
      {on && (
        <>
          <div className="grid2">
            <div className="stack">
              <label className="label">Headway (minutes between passes)</label>
              <input type="number" min="1" max="120" value={config.headwayMinutes} onChange={(e) => setConfig({ ...config, headwayMinutes: e.target.value })} />
            </div>
            <div className="ui-muted" style={{ alignSelf: 'end', fontSize: 12 }}>
              Shown to waiting customers as &quot;The shuttle passes about every N minutes&quot;. Keep it honest — it is a promise.
            </div>
          </div>
          <div className="stack">
            <label className="label">Shuttle vehicles</label>
            <div className="ui-muted" style={{ fontSize: 12 }}>
              The units checked here are the only ones the public map will ever show.
            </div>
            <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 8 }}>
              {shuttleVehicles.length === 0 && (
                <div className="ui-muted" style={{ fontSize: 12 }}>
                  No vehicles are marked as shuttles yet. Set a vehicle&apos;s program to
                  &quot;Shuttle only&quot; in Vehicles and it will appear here. / Marca un
                  vehículo como &quot;Solo shuttle&quot; en Vehículos y aparecerá aquí.
                </div>
              )}
              {shuttleVehicles.map((v) => (
                <label key={v.id} className="label" style={{ display: 'block', fontWeight: 400 }}>
                  <input type="checkbox" checked={config.vehicleIds.includes(v.id)} onChange={() => toggleVehicle(v.id)} /> {vehicleLabel(v)}
                </label>
              ))}
            </div>
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="primary" onClick={save} disabled={status === 'saving'}>
          {status === 'saving' ? 'Saving…' : 'Save shuttle tracker'}
        </button>
        {message && (
          <span style={{ fontSize: 12, color: message === 'Saved' ? 'var(--muted, #6a6376)' : '#b3261e' }}>
            {message}
          </span>
        )}
      </div>
    </>
  );
}
