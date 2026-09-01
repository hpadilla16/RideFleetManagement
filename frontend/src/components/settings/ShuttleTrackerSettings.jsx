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
 *
 * TENANT SCOPE (2026-08-26): every call goes through the SAME
 * `scopedSettingsPath` the rest of the settings page uses, so a SUPER_ADMIN
 * who picked a tenant at the top of Settings reads and writes THAT tenant's
 * config. Without it the backend resolved the tenant from the super's own
 * token, 404'd on every location, and this card collapsed into a single grey
 * line of body text — an hour of live debugging. The prop is optional and
 * defaults to identity so the component still works if mounted bare.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, readStoredToken } from '../../lib/client';

const MODES = [
  { value: 'OFF', label: 'Off — no tracker page' },
  { value: 'ON_DEMAND', label: 'On demand — customers can request the shuttle' },
  { value: 'NON_STOP', label: 'Non-stop loop — watch only, runs on a headway' },
];

// Mirrors CAP_MIN / CAP_MAX in backend/src/modules/shuttle/shuttle-intake.js —
// the server rejects anything outside, so the inputs must not invite it.
const CAP_MIN = 1;
const CAP_MAX = 200;
const INTAKE_DEFAULTS = { enabled: false, partySizeCap: 50, bagsCap: 20 };

export function ShuttleTrackerSettings({ locationId, scopedSettingsPath }) {
  const [config, setConfig] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | saving | error
  const [message, setMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Identity fallback: mounted without the prop (tests, a future bare use) the
  // component keeps its old unscoped behavior instead of crashing.
  const scoped = useCallback(
    (path) => (typeof scopedSettingsPath === 'function' ? scopedSettingsPath(path) : path),
    [scopedSettingsPath],
  );

  useEffect(() => {
    if (!locationId) return;
    let alive = true;
    (async () => {
      setStatus('loading');
      setMessage('');
      try {
        const token = readStoredToken();
        const [cfg, fleet] = await Promise.all([
          api(scoped(`/api/shuttle-tracker/config?locationId=${encodeURIComponent(locationId)}`), {}, token),
          api(scoped('/api/vehicles?limit=2000'), {}, token),
        ]);
        if (!alive) return;
        setConfig({ ...cfg, intake: { ...INTAKE_DEFAULTS, ...(cfg?.intake || {}) } });
        setVehicles(Array.isArray(fleet?.rows) ? fleet.rows : (Array.isArray(fleet) ? fleet : []));
        setStatus('ready');
      } catch (err) {
        if (!alive) return;
        setMessage(err?.message || 'Could not load tracker settings');
        setStatus('error');
      }
    })();
    return () => { alive = false; };
  }, [locationId, scoped, reloadKey]);

  const setIntake = (patch) => setConfig((c) => ({ ...c, intake: { ...INTAKE_DEFAULTS, ...(c?.intake || {}), ...patch } }));

  // Empty string while typing must not become 0 (the server would 400 on a cap
  // below CAP_MIN); fall back to the default the GET normalizes to anyway.
  const capOrDefault = (value, fallback) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= CAP_MIN && n <= CAP_MAX ? n : fallback;
  };

  const save = async () => {
    setStatus('saving');
    setMessage('');
    try {
      const saved = await api(scoped('/api/shuttle-tracker/config'), {
        method: 'PUT',
        body: JSON.stringify({
          locationId,
          mode: config.mode,
          vehicleIds: config.vehicleIds,
          headwayMinutes: Number(config.headwayMinutes) || 10,
          intake: {
            enabled: config.intake?.enabled === true,
            partySizeCap: capOrDefault(config.intake?.partySizeCap, INTAKE_DEFAULTS.partySizeCap),
            bagsCap: capOrDefault(config.intake?.bagsCap, INTAKE_DEFAULTS.bagsCap),
          },
        }),
      }, readStoredToken());
      setConfig({ ...saved, intake: { ...INTAKE_DEFAULTS, ...(saved?.intake || {}) } });
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
  // A failed load used to render as a 12px grey sentence indistinguishable from
  // the helper text around it, so the card looked ABSENT rather than broken.
  // Bordered, titled, with a way out.
  if (status === 'error') {
    return (
      <div
        role="alert"
        data-testid="shuttle-tracker-error"
        style={{
          border: '1px solid #b3261e', borderRadius: 8, padding: 12,
          background: 'rgba(179, 38, 30, 0.06)', display: 'flex',
          flexDirection: 'column', gap: 8, alignItems: 'flex-start',
        }}
      >
        <div style={{ fontWeight: 600, color: '#b3261e' }}>
          Shuttle Tracker settings could not be loaded / No se pudieron cargar los ajustes del Shuttle Tracker
        </div>
        <div style={{ fontSize: 13 }}>{message || 'Unknown error'}</div>
        <div className="ui-muted" style={{ fontSize: 12 }}>
          If you are a super admin, pick the tenant at the top of Settings first — the tracker
          config is per tenant. / Si eres super admin, elige primero el tenant arriba en Ajustes.
        </div>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
          Retry / Reintentar
        </button>
      </div>
    );
  }

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

          {/* Phase 3 intake (Screen 7). Until now the ONLY way to flip this was
              an UPDATE on ShuttleTrackerConfig.intakeJson by hand. The knobs are
              the same three the GET returns and the PUT accepts. */}
          <div className="stack">
            <label className="label">Intake questions / Preguntas antes de pedir el shuttle</label>
            <label className="label" style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                data-testid="intake-enabled"
                checked={config.intake?.enabled === true}
                onChange={(e) => setIntake({ enabled: e.target.checked })}
              />{' '}
              Ask the customer before they request / Preguntar al cliente antes de pedir
            </label>
            <div className="ui-muted" style={{ fontSize: 12 }}>
              When ON, the customer must answer how many people are travelling and how many bags
              they have — and is offered the arrival-SMS opt-in — before the &quot;Send the shuttle&quot;
              button works. The driver sees party and bags on the pickup, so a 6-person family with
              8 bags never gets a car that cannot take them. When OFF nothing is asked and the page
              behaves exactly as before. / Cuando está activo, el cliente indica cuántas personas y
              cuántas maletas, y acepta (o no) el SMS de llegada, antes de poder pedir el shuttle.
              {config.mode === 'NON_STOP' && ' Solo aplica en modo "On demand" — este local está en circuito continuo. / Only applies in On-demand mode.'}
            </div>
            {config.intake?.enabled && (
              <div className="grid2">
                <div className="stack">
                  <label className="label">Max party size / Máximo de personas</label>
                  <input
                    type="number"
                    min={CAP_MIN}
                    max={CAP_MAX}
                    data-testid="intake-party-cap"
                    value={config.intake?.partySizeCap ?? ''}
                    onChange={(e) => setIntake({ partySizeCap: e.target.value === '' ? '' : Number(e.target.value) })}
                  />
                </div>
                <div className="stack">
                  <label className="label">Max bags / Máximo de maletas</label>
                  <input
                    type="number"
                    min={CAP_MIN}
                    max={CAP_MAX}
                    data-testid="intake-bags-cap"
                    value={config.intake?.bagsCap ?? ''}
                    onChange={(e) => setIntake({ bagsCap: e.target.value === '' ? '' : Number(e.target.value) })}
                  />
                </div>
                <div className="ui-muted" style={{ fontSize: 12, gridColumn: '1 / -1' }}>
                  Upper limits the customer may pick ({CAP_MIN}–{CAP_MAX}). Set them to what your
                  largest shuttle can actually carry. / Límites que el cliente puede elegir; ponlos
                  según lo que tu shuttle más grande pueda llevar de verdad.
                </div>
              </div>
            )}
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
