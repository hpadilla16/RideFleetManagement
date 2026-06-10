'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { VehicleScanner } from '../../../components/inventory/VehicleScanner';
import { compressToDataUrl } from '../../../lib/image-compressor';

const PHOTO_SLOTS = [
  { key: 'front', label: 'Front' },
  { key: 'rear', label: 'Rear' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' },
  { key: 'odometer', label: 'Odometer' },
];

function vehicleLabel(v) {
  if (!v) return 'Vehicle';
  return [v.year, v.make, v.model].filter(Boolean).join(' ') || v.plate || v.internalNumber || 'Vehicle';
}

function expectedStatusChip(status) {
  switch (String(status || '').toUpperCase()) {
    case 'AVAILABLE': return { label: 'Available', tone: 'good' };
    case 'RESERVED': return { label: 'Reserved', tone: 'neutral' };
    case 'ON_RENT': return { label: 'Checked out', tone: 'warn' };
    case 'IN_MAINTENANCE': return { label: 'Maintenance', tone: 'neutral' };
    case 'OUT_OF_SERVICE': return { label: 'Out of service', tone: 'neutral' };
    default: return { label: status || '-', tone: 'neutral' };
  }
}

function isMaintenance(status) {
  const s = String(status || '').toUpperCase();
  return s === 'IN_MAINTENANCE' || s === 'OUT_OF_SERVICE';
}

const blankForm = {
  tiresOk: true, brakesOk: true, lightsOk: true, fluidsOk: true, cleanOk: true,
  mileageConfirmed: true, reportedMileage: '',
  scanMethod: null, manualReason: '', photos: {},
  note: '', maintenanceNote: '', reason: '', resolveNote: '',
};

export default function InventoryHelperPage() {
  return <AuthGate>{({ token, me, logout }) => <InventoryHelperInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function InventoryHelperInner({ token, me, logout }) {
  const [session, setSession] = useState(null);
  const [phase, setPhase] = useState('loading'); // loading | launch | start | overview | item
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api('/api/inventory/session/active', { bypassCache: true }, token)
      .then((s) => {
        if (!alive) return;
        if (s && s.id) { setSession(s); setPhase('launch'); }
        else { setSession(null); setPhase('start'); }
      })
      .catch((e) => { if (alive) { setMsg(e.message); setPhase('start'); } });
    return () => { alive = false; };
  }, [token]);

  const items = useMemo(() => (Array.isArray(session?.items) ? session.items : []), [session]);
  const done = items.filter((it) => it.state === 'CONFIRMED' || it.state === 'EXCEPTION').length;
  const openMismatches = items.filter((it) => it.mismatchType && !it.mismatchResolved).length;
  const selected = items.find((it) => it.id === selectedId) || null;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  const groups = useMemo(() => {
    const map = new Map();
    for (const it of items) {
      const name = it.vehicle?.homeLocation?.name || 'Unassigned';
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(it);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  async function startSession(wipeExisting) {
    try {
      setBusy(true); setMsg('');
      const out = await api('/api/inventory/session', { method: 'POST', body: JSON.stringify({ wipeExisting }) }, token);
      setSession(out.session); setPhase('overview');
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  async function post(path, body) {
    setBusy(true); setMsg('');
    try {
      const updated = await api(path, { method: 'POST', body: JSON.stringify(body || {}) }, token);
      setSession(updated);
      return updated;
    } catch (e) { setMsg(e.message); throw e; } finally { setBusy(false); }
  }

  function openItem(it) {
    setSelectedId(it.id);
    setForm({ ...blankForm, reportedMileage: it.expectedMileage != null ? String(it.expectedMileage) : '' });
    setPhase('item');
    setMsg('');
  }

  async function confirmAtLot() {
    if (!selected) return;
    const method = form.scanMethod;
    if (!method) { setMsg('Scan the vehicle (QR / VIN / plate) or use the manual fallback first.'); return; }
    if (method === 'MANUAL' && !form.manualReason.trim()) { setMsg('A reason is required to confirm manually.'); return; }
    const missingPhotos = PHOTO_SLOTS.filter((s) => !form.photos[s.key]);
    if (missingPhotos.length) { setMsg(`Take all ${PHOTO_SLOTS.length} photos (${missingPhotos.map((s) => s.label).join(', ')} missing).`); return; }
    try {
      await post(`/api/inventory/session/${session.id}/items/${selected.id}/confirm`, {
        locatedStatus: 'AT_LOT',
        confirmMethod: method,
        confirmReason: method === 'MANUAL' ? form.manualReason : null,
        photos: form.photos,
        tiresOk: form.tiresOk, brakesOk: form.brakesOk, lightsOk: form.lightsOk,
        fluidsOk: form.fluidsOk, cleanOk: form.cleanOk,
        mileageConfirmed: form.mileageConfirmed,
        reportedMileage: form.mileageConfirmed ? null : Number(form.reportedMileage),
        note: form.note || null,
      });
      setPhase('overview');
    } catch { /* msg set */ }
  }

  async function confirmOnRent() {
    if (!selected) return;
    try {
      await post(`/api/inventory/session/${session.id}/items/${selected.id}/confirm`, { locatedStatus: 'ON_RENT', note: form.note || null });
      setPhase('overview');
    } catch { /* msg set */ }
  }

  async function saveMaintenance() {
    if (!selected) return;
    if (!form.maintenanceNote.trim()) { setMsg('A status note is required.'); return; }
    try {
      await post(`/api/inventory/session/${session.id}/items/${selected.id}/maintenance-note`, { note: form.maintenanceNote });
      setPhase('overview');
    } catch { /* msg set */ }
  }

  async function markException() {
    if (!selected) return;
    if (!form.reason.trim()) { setMsg('A reason is required to mark an exception.'); return; }
    try {
      await post(`/api/inventory/session/${session.id}/items/${selected.id}/exception`, { reason: form.reason, note: form.note || null });
      setPhase('overview');
    } catch { /* msg set */ }
  }

  async function resolveMismatch() {
    if (!selected) return;
    if (!form.resolveNote.trim()) { setMsg('A note is required to resolve a mismatch.'); return; }
    try {
      await post(`/api/inventory/session/${session.id}/items/${selected.id}/resolve-mismatch`, { note: form.resolveNote });
      setPhase('overview');
    } catch { /* msg set */ }
  }

  async function complete() {
    try {
      await post(`/api/inventory/session/${session.id}/complete`, {});
      setMsg('Inventory completed.');
    } catch { /* msg set (e.g. gating) */ }
  }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const mergePhoto = (key, dataUrl) => setForm((f) => ({ ...f, photos: { ...f.photos, [key]: dataUrl } }));

  function itemStateIcon(it) {
    if (it.mismatchType && !it.mismatchResolved) return <span className="status-chip warn">Needs fixing</span>;
    if (it.state === 'CONFIRMED') return <span style={{ color: 'var(--ok, #16a34a)' }}>✓</span>;
    if (it.state === 'EXCEPTION') return <span className="status-chip warn">Exception</span>;
    return <span className="ui-muted">›</span>;
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="row-between">
          <div>
            <span className="eyebrow">Vehicles</span>
            <h2 className="page-title" style={{ marginTop: 6 }}>Inventory Helper</h2>
            <p className="ui-muted">Walk the lot and confirm every vehicle, step by step.</p>
          </div>
          {session && phase !== 'launch' && phase !== 'start' ? (
            <span className="status-chip neutral">{done} / {items.length} confirmed</span>
          ) : null}
        </div>
      </section>

      {msg ? <div className="glass card" style={{ marginBottom: 12 }}>{msg}</div> : null}

      {phase === 'loading' ? <div className="glass card">Loading…</div> : null}

      {phase === 'start' ? (
        <div className="glass card-lg section-card">
          <h3 style={{ marginTop: 0 }}>Start a fleet inventory</h3>
          <p className="ui-muted">This snapshots your whole fleet and walks you through confirming each vehicle.</p>
          <button type="button" className="button-primary" disabled={busy} onClick={() => startSession(false)}>
            {busy ? 'Starting…' : 'Start inventory'}
          </button>
        </div>
      ) : null}

      {phase === 'launch' && session ? (
        <div className="glass card-lg section-card">
          <h3 style={{ marginTop: 0 }}>Inventory in progress</h3>
          <p className="ui-muted">
            Started {session.startedAt ? new Date(session.startedAt).toLocaleString() : ''} — {done} of {items.length} vehicles confirmed.
          </p>
          <div className="inline-actions">
            <button type="button" className="button-primary" onClick={() => setPhase('overview')}>Continue where you left off</button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => startSession(true)} style={{ color: 'var(--danger, #dc2626)' }}>
              Wipe & start new
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'overview' && session ? (
        <>
          <section className="glass card-lg section-card" style={{ marginBottom: 12 }}>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <strong>Progress</strong>
              <span className="ui-muted">{done} / {items.length} confirmed</span>
            </div>
            <div style={{ height: 6, background: 'rgba(0,0,0,0.08)', borderRadius: 999 }}>
              <div style={{ width: `${pct}%`, height: 6, background: 'var(--ok, #16a34a)', borderRadius: 999 }} />
            </div>
            {openMismatches > 0 ? (
              <div className="surface-note" style={{ marginTop: 12 }}>
                {openMismatches} vehicle(s) need fixing before you can complete the inventory.
              </div>
            ) : null}
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <button type="button" className="button-primary" disabled={busy} onClick={complete}>Complete inventory</button>
            </div>
          </section>

          {groups.map(([locName, locItems]) => (
            <section key={locName} className="glass card-lg section-card" style={{ marginBottom: 12 }}>
              <div className="row-between" style={{ marginBottom: 6 }}>
                <strong>{locName}</strong>
                <span className="status-chip neutral">{locItems.length}</span>
              </div>
              <div className="table-shell">
                <table>
                  <thead>
                    <tr><th>Unit</th><th>Plate</th><th>Status</th><th>State</th><th></th></tr>
                  </thead>
                  <tbody>
                    {locItems.map((it) => {
                      const chip = expectedStatusChip(it.expectedStatus);
                      return (
                        <tr key={it.id}>
                          <td>{it.vehicle?.internalNumber || '-'}</td>
                          <td>{it.vehicle?.plate || '-'}</td>
                          <td><span className={`status-chip ${chip.tone}`}>{chip.label}</span></td>
                          <td>{itemStateIcon(it)}</td>
                          <td><button type="button" className="btn-ghost btn-sm" onClick={() => openItem(it)}>Open</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      ) : null}

      {phase === 'item' && selected ? (
        <ItemPanel
          item={selected}
          form={form}
          set={set}
          mergePhoto={mergePhoto}
          busy={busy}
          onBack={() => { setPhase('overview'); setMsg(''); }}
          onConfirmAtLot={confirmAtLot}
          onConfirmOnRent={confirmOnRent}
          onSaveMaintenance={saveMaintenance}
          onMarkException={markException}
          onResolveMismatch={resolveMismatch}
        />
      ) : null}
    </AppShell>
  );
}

function Check({ label, value, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: 8 }}>
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function ItemPanel({ item, form, set, mergePhoto, busy, onBack, onConfirmAtLot, onConfirmOnRent, onSaveMaintenance, onMarkException, onResolveMismatch }) {
  const v = item.vehicle || {};
  const chip = expectedStatusChip(item.expectedStatus);
  const isMismatch = item.mismatchType && !item.mismatchResolved;
  const maintenance = isMaintenance(item.expectedStatus);
  const onRent = String(item.expectedStatus || '').toUpperCase() === 'ON_RENT';

  return (
    <section className="glass card-lg section-card">
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div>
          <button type="button" className="btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 6 }}>← Back to fleet</button>
          <h3 style={{ margin: 0 }}>{v.internalNumber || vehicleLabel(v)}</h3>
          <span className="ui-muted">{v.plate || '-'} · <span className={`status-chip ${chip.tone}`}>{chip.label}</span></span>
        </div>
      </div>

      {isMismatch ? (
        <div className="surface-note" style={{ marginBottom: 14 }}>
          This vehicle is marked checked-out but looks like it should be checked in. Fix it (check-in), or resolve with a note —
          the mismatch will stay tracked on the dashboard until it's truly fixed.
          <div className="inline-actions" style={{ marginTop: 10 }}>
            {item.reservationId ? (
              <Link href={`/reservations/${item.reservationId}/checkin-wizard`} className="legal-link-pill">Go to check-in</Link>
            ) : null}
          </div>
          <div style={{ marginTop: 10 }}>
            <label className="label">Resolve with note</label>
            <textarea value={form.resolveNote} onChange={(e) => set({ resolveNote: e.target.value })} placeholder="e.g. Customer extended by phone, agreement not updated yet" style={{ width: '100%', minHeight: 70 }} />
            <button type="button" className="button-primary" disabled={busy} onClick={onResolveMismatch} style={{ marginTop: 8 }}>Save note & flag for reconcile</button>
          </div>
        </div>
      ) : null}

      {!isMismatch && maintenance ? (
        <div>
          <p className="ui-muted" style={{ marginTop: 0 }}>Locked in {chip.label.toLowerCase()} — no photos or checklist needed. Add a current status note.</p>
          <label className="label">Status note (required)</label>
          <textarea value={form.maintenanceNote} onChange={(e) => set({ maintenanceNote: e.target.value })} placeholder="e.g. Transmission in shop, ETA Friday. Keys with service desk." style={{ width: '100%', minHeight: 90 }} />
          <div className="inline-actions" style={{ marginTop: 10 }}>
            <button type="button" className="button-primary" disabled={busy} onClick={onSaveMaintenance}>Confirm status</button>
          </div>
        </div>
      ) : null}

      {!isMismatch && onRent ? (
        <div>
          <p className="ui-muted" style={{ marginTop: 0 }}>This vehicle is checked out (on rent). Confirm it's accounted for (no photos or checklist needed).</p>
          <label className="label">Note (optional)</label>
          <input type="text" value={form.note} onChange={(e) => set({ note: e.target.value })} style={{ width: '100%' }} />
          <div className="inline-actions" style={{ marginTop: 10 }}>
            <button type="button" className="button-primary" disabled={busy} onClick={onConfirmOnRent}>Confirm checked out</button>
          </div>
        </div>
      ) : null}

      {!isMismatch && !maintenance && !onRent ? (
        <div>
          <label className="label">1 · Identify the vehicle (scan required)</label>
          {form.scanMethod ? (
            <div className="surface-note" style={{ marginBottom: 12 }}>
              {form.scanMethod === 'MANUAL' ? 'Confirming manually.' : `Matched by ${form.scanMethod}.`}{' '}
              <button type="button" className="btn-ghost btn-sm" onClick={() => set({ scanMethod: null, manualReason: '' })}>Re-scan</button>
              {form.scanMethod === 'MANUAL' ? (
                <input type="text" value={form.manualReason} onChange={(e) => set({ manualReason: e.target.value })} placeholder="Why are you confirming without a scan?" style={{ width: '100%', marginTop: 8 }} />
              ) : null}
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <VehicleScanner
                expected={v}
                onMatched={(m) => { set({ scanMethod: m }); }}
                onManual={() => set({ scanMethod: 'MANUAL' })}
              />
            </div>
          )}

          <label className="label">2 · Photos (4 corners + odometer)</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 12 }}>
            {PHOTO_SLOTS.map((slot) => {
              const has = !!form.photos[slot.key];
              return (
                <label key={slot.key} style={{ aspectRatio: '1', borderRadius: 8, border: '0.5px solid rgba(0,0,0,0.15)', background: has ? 'rgba(22,163,74,0.08)' : 'rgba(0,0,0,0.03)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 11 }}>
                  <span style={{ fontWeight: 600, color: has ? 'var(--ok, #16a34a)' : 'inherit' }}>{has ? '✓' : '+'}</span>
                  <span className="ui-muted" style={{ fontSize: 10 }}>{slot.label}</span>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        const dataUrl = await compressToDataUrl(file, { maxWidth: 1600, quality: 0.8 });
                        mergePhoto(slot.key, dataUrl);
                      } catch { /* ignore bad image */ }
                    }}
                  />
                </label>
              );
            })}
          </div>

          <label className="label">3 · Verify condition</label>
          <div className="app-card-grid compact" style={{ marginBottom: 12 }}>
            <Check label="Tires" value={form.tiresOk} onChange={(x) => set({ tiresOk: x })} />
            <Check label="Brakes" value={form.brakesOk} onChange={(x) => set({ brakesOk: x })} />
            <Check label="Lights" value={form.lightsOk} onChange={(x) => set({ lightsOk: x })} />
            <Check label="Fluids" value={form.fluidsOk} onChange={(x) => set({ fluidsOk: x })} />
            <Check label="Cleaning" value={form.cleanOk} onChange={(x) => set({ cleanOk: x })} />
          </div>

          <label className="label">Mileage</label>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={form.mileageConfirmed} onChange={(e) => set({ mileageConfirmed: e.target.checked })} />
              Matches the {item.expectedMileage != null ? `${item.expectedMileage.toLocaleString()} mi` : 'value'} on file
            </label>
            {!form.mileageConfirmed ? (
              <input type="number" min="0" value={form.reportedMileage} onChange={(e) => set({ reportedMileage: e.target.value })} placeholder="Correct mileage" style={{ width: '100%', marginTop: 8 }} />
            ) : null}
          </div>

          <label className="label">Note (optional)</label>
          <input type="text" value={form.note} onChange={(e) => set({ note: e.target.value })} style={{ width: '100%', marginBottom: 12 }} />

          <div className="inline-actions">
            <button type="button" className="button-primary" disabled={busy} onClick={onConfirmAtLot}>Confirm vehicle</button>
          </div>
        </div>
      ) : null}

      <div style={{ borderTop: '0.5px solid rgba(0,0,0,0.1)', marginTop: 16, paddingTop: 12 }}>
        <label className="label">Can't locate this vehicle?</label>
        <input type="text" value={form.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="Reason (e.g. not on the lot, can't account for it)" style={{ width: '100%', marginBottom: 8 }} />
        <button type="button" className="btn-ghost" disabled={busy} onClick={onMarkException}>Mark as exception</button>
      </div>
    </section>
  );
}
