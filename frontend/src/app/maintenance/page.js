'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

export default function MaintenancePage() {
  return <AuthGate>{({ token, me, logout }) => <MaintenanceInner token={token} me={me} logout={logout} />}</AuthGate>;
}

const money = (v) => `$${Number(Number(v || 0).toFixed(2)).toFixed(2)}`;
const dateLabel = (v) => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(); };
const ageDays = (v) => { if (!v) return '—'; const d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000); return `${d}d`; };
const vehLabel = (v) => (v ? `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim() + (v.plate ? ` · ${v.plate}` : '') : '—');

const STATUS_TONE = { OPEN: '#f59e0b', IN_PROGRESS: '#3b82f6', COMPLETED: '#22c55e', CANCELLED: '#6b7280' };
const SOURCE_LABEL = { SCHEDULED: 'Scheduled', DAMAGE: 'Damage', INCIDENT: 'Incident', MANUAL: 'Manual' };
const SERVICE_LABEL = { LOF: 'Oil + filter', TIRE_ROTATION: 'Tire rotation', BRAKES: 'Brakes', INSPECTION: 'Inspection', OTHER: 'Other' };

function MaintenanceInner({ token, me, logout }) {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [tab, setTab] = useState('board'); // board | due
  const [summary, setSummary] = useState(null);
  const [board, setBoard] = useState([]);
  const [due, setDue] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState(null); // RO detail
  const [vehicles, setVehicles] = useState([]);
  const [newRO, setNewRO] = useState(null); // { vehicleId, source, vendor }
  const [line, setLine] = useState({ type: 'PART', description: '', qty: '1', unitCost: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const locQS = locationId ? `&locationId=${encodeURIComponent(locationId)}` : '';

  async function reload() {
    try {
      const [s, b, d] = await Promise.all([
        api(`/api/maintenance/summary?_=1${locQS}`, { bypassCache: true }, token),
        api(`/api/maintenance/board?_=1${locQS}${statusFilter ? `&status=${statusFilter}` : ''}`, { bypassCache: true }, token),
        api(`/api/maintenance/due?_=1${locQS}`, { bypassCache: true }, token),
      ]);
      setSummary(s);
      setBoard(Array.isArray(b?.repairOrders) ? b.repairOrders : []);
      setDue(Array.isArray(d?.items) ? d.items : []);
    } catch (e) { setMsg(String(e?.message || e)); }
  }

  useEffect(() => {
    api('/api/locations', {}, token).then((d) => {
      const list = Array.isArray(d) ? d : (d?.locations || []);
      setLocations(list.map((l) => ({ id: l.id, code: l.code, name: l.name })));
    }).catch(() => {});
  }, [token]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [locationId, statusFilter]);

  async function openRO(id) {
    try { setSelected(await api(`/api/repair-orders/${id}?_=1`, { bypassCache: true }, token)); }
    catch (e) { setMsg(String(e?.message || e)); }
  }
  async function refreshSelected() { if (selected) await openRO(selected.id); await reload(); }

  async function createRO() {
    if (!newRO?.vehicleId) { setMsg('Pick a vehicle'); return; }
    setBusy(true);
    try {
      const ro = await api('/api/repair-orders', { method: 'POST', body: JSON.stringify(newRO) }, token);
      setNewRO(null); await reload(); setSelected(ro); setMsg(`Created ${ro.label}`);
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }
  async function addLine() {
    if (!line.description.trim()) { setMsg('Line description required'); return; }
    setBusy(true);
    try {
      const ro = await api(`/api/repair-orders/${selected.id}/lines`, { method: 'POST', body: JSON.stringify({ ...line, qty: Number(line.qty) || 1, unitCost: Number(line.unitCost) || 0 }) }, token);
      setSelected(ro); setLine({ type: 'PART', description: '', qty: '1', unitCost: '' }); await reload();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }
  async function delLine(lineId) {
    try { setSelected(await api(`/api/repair-orders/${selected.id}/lines/${lineId}`, { method: 'DELETE' }, token)); await reload(); }
    catch (e) { setMsg(String(e?.message || e)); }
  }
  async function act(path, okMsg) {
    setBusy(true);
    try { const ro = await api(`/api/repair-orders/${selected.id}/${path}`, { method: 'POST' }, token); setSelected(ro); setMsg(okMsg); await reload(); }
    catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }
  async function createFromDue(item) {
    setBusy(true);
    try {
      const ro = await api('/api/repair-orders', { method: 'POST', body: JSON.stringify({ vehicleId: item.vehicleId, source: 'SCHEDULED', notes: `${SERVICE_LABEL[item.serviceType] || item.serviceType} due` }) }, token);
      await reload(); setSelected(ro); setTab('board'); setMsg(`Created ${ro.label}`);
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }
  async function openNewRO() {
    if (!vehicles.length) {
      try { const d = await api('/api/vehicles', {}, token); const list = Array.isArray(d) ? d : (d?.vehicles || []); setVehicles(list.map((v) => ({ id: v.id, plate: v.plate, make: v.make, model: v.model, year: v.year }))); } catch { /* ignore */ }
    }
    setNewRO({ vehicleId: '', source: 'MANUAL', vendor: '' });
  }

  const kpis = useMemo(() => ([
    { label: 'Open ROs', value: summary?.openRepairOrders ?? '—' },
    { label: 'Due / overdue', value: summary ? `${summary.dueSoon} (${summary.overdue} late)` : '—' },
    { label: 'Vehicles down', value: summary?.vehiclesDown ?? '—' },
    { label: 'Fleet down', value: summary != null ? `${summary.fleetDownPct}%` : '—' },
    { label: 'Cost MTD', value: summary != null ? money(summary.costMTD) : '—' },
  ]), [summary]);

  return (
    <AppShell me={me} logout={logout}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0 }}>Maintenance</h1>
          <div style={{ opacity: 0.7, fontSize: 13 }}>Repair orders, scheduled service & damages — by location</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code || l.name}</option>)}
          </select>
          <button onClick={openNewRO}>+ New repair order</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: 10, margin: '14px 0' }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ border: '1px solid rgba(128,128,128,0.25)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, opacity: 0.65 }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button onClick={() => setTab('board')} style={{ opacity: tab === 'board' ? 1 : 0.6 }}>Repair orders</button>
        <button onClick={() => setTab('due')} style={{ opacity: tab === 'due' ? 1 : 0.6 }}>Maintenance due{due.length ? ` (${due.length})` : ''}</button>
        {tab === 'board' && (
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ marginLeft: 'auto' }}>
            <option value="">All statuses</option>
            <option value="OPEN">Open</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        )}
      </div>

      {msg ? <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>{msg}</div> : null}

      {tab === 'board' ? (
        <Table head={['RO #', 'Vehicle', 'Source', 'Location', 'Status', 'Cost', 'Age', '']}>
          {board.map((ro) => (
            <tr key={ro.id} style={{ cursor: 'pointer' }} onClick={() => openRO(ro.id)}>
              <td><strong>{ro.label}</strong></td>
              <td>{vehLabel(ro.vehicle)}</td>
              <td>{SOURCE_LABEL[ro.source] || ro.source}</td>
              <td>{ro.location?.code || '—'}</td>
              <td><Pill color={STATUS_TONE[ro.status]}>{ro.status}</Pill></td>
              <td>{money(ro.totals?.total)}</td>
              <td>{ageDays(ro.openedAt)}</td>
              <td style={{ textAlign: 'right' }}>›</td>
            </tr>
          ))}
          {board.length === 0 && <tr><td colSpan={8} style={{ opacity: 0.6, padding: 14 }}>No repair orders.</td></tr>}
        </Table>
      ) : (
        <Table head={['Vehicle', 'Service', 'State', 'Odometer gap', 'Next due', '']}>
          {due.map((it) => (
            <tr key={it.id}>
              <td>{vehLabel(it.vehicle)}</td>
              <td>{SERVICE_LABEL[it.serviceType] || it.serviceType}</td>
              <td><Pill color={it.overdue ? '#ef4444' : '#f59e0b'}>{it.state}</Pill></td>
              <td>{it.dueByMiles != null ? `${it.dueByMiles >= 0 ? '+' : ''}${it.dueByMiles} mi` : '—'}</td>
              <td>{it.nextDueMiles != null ? `${it.nextDueMiles} mi` : dateLabel(it.nextDueAt)}</td>
              <td style={{ textAlign: 'right' }}><button disabled={busy} onClick={() => createFromDue(it)}>Create RO</button></td>
            </tr>
          ))}
          {due.length === 0 && <tr><td colSpan={6} style={{ opacity: 0.6, padding: 14 }}>Nothing due. 🎉</td></tr>}
        </Table>
      )}

      {newRO && (
        <Modal title="New repair order" onClose={() => setNewRO(null)}>
          <Field label="Vehicle">
            <select value={newRO.vehicleId} onChange={(e) => setNewRO({ ...newRO, vehicleId: e.target.value })}>
              <option value="">Select…</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{vehLabel(v)}</option>)}
            </select>
          </Field>
          <Field label="Source">
            <select value={newRO.source} onChange={(e) => setNewRO({ ...newRO, source: e.target.value })}>
              {['MANUAL', 'SCHEDULED', 'DAMAGE', 'INCIDENT'].map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
            </select>
          </Field>
          <Field label="Vendor / shop"><input value={newRO.vendor} onChange={(e) => setNewRO({ ...newRO, vendor: e.target.value })} /></Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button disabled={busy} onClick={createRO}>Create</button>
            <button className="button-subtle" onClick={() => setNewRO(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {selected && (
        <Modal title={`${selected.label} · ${vehLabel(selected.vehicle)}`} onClose={() => setSelected(null)}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
            <span><Pill color={STATUS_TONE[selected.status]}>{selected.status}</Pill></span>
            <span>Source: {SOURCE_LABEL[selected.source] || selected.source}</span>
            <span>Location: {selected.location?.code || '—'}</span>
            <span>Odometer: {selected.odometerAtOpen != null ? `${selected.odometerAtOpen} mi` : '—'}</span>
            <span>Opened: {dateLabel(selected.openedAt)}</span>
            {selected.vendor ? <span>Vendor: {selected.vendor}</span> : null}
          </div>

          <Table head={['Type', 'Description', 'Qty', 'Unit', 'Amount', '']}>
            {(selected.lines || []).map((l) => (
              <tr key={l.id}>
                <td>{l.type}</td><td>{l.description}</td><td>{l.qty}</td><td>{money(l.unitCost)}</td><td>{money(l.amount)}</td>
                <td style={{ textAlign: 'right' }}>{selected.status === 'OPEN' || selected.status === 'IN_PROGRESS' ? <button className="button-subtle" onClick={() => delLine(l.id)}>✕</button> : null}</td>
              </tr>
            ))}
            {(selected.lines || []).length === 0 && <tr><td colSpan={6} style={{ opacity: 0.6, padding: 10 }}>No lines yet.</td></tr>}
          </Table>
          <div style={{ textAlign: 'right', fontSize: 13, margin: '6px 2px' }}>
            Subtotal {money(selected.totals?.subtotal)} · Tax {money(selected.totals?.tax)} · <strong>Total {money(selected.totals?.total)}</strong>
          </div>

          {(selected.status === 'OPEN' || selected.status === 'IN_PROGRESS') && (
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 60px 80px auto', gap: 6, alignItems: 'end', marginTop: 8 }}>
              <Field label="Type"><select value={line.type} onChange={(e) => setLine({ ...line, type: e.target.value })}>{['PART', 'LABOR', 'OTHER', 'TAX'].map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Description"><input value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} /></Field>
              <Field label="Qty"><input value={line.qty} onChange={(e) => setLine({ ...line, qty: e.target.value })} /></Field>
              <Field label="Unit $"><input value={line.unitCost} onChange={(e) => setLine({ ...line, unitCost: e.target.value })} /></Field>
              <button disabled={busy} onClick={addLine}>+ Add</button>
            </div>
          )}

          {Array.isArray(selected.damageReports) && selected.damageReports.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <div style={{ opacity: 0.7, marginBottom: 4 }}>Linked damages ({selected.damageReports.length}) — set to FIXED on complete:</div>
              {selected.damageReports.map((d) => <div key={d.id} style={{ opacity: 0.85 }}>• {d.view} · {d.status} {d.description ? `— ${d.description}` : ''}</div>)}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            {selected.status !== 'COMPLETED' && selected.status !== 'CANCELLED' && (
              <>
                <button disabled={busy} onClick={() => act('complete', 'Completed')}>Complete</button>
                <button className="button-danger" disabled={busy} onClick={() => act('cancel', 'Cancelled')}>Cancel RO</button>
              </>
            )}
            <button className="button-subtle" onClick={() => setSelected(null)} style={{ marginLeft: 'auto' }}>Close</button>
          </div>
        </Modal>
      )}
    </AppShell>
  );
}

function Table({ head, children }) {
  return (
    <div className="maint-table" style={{ overflowX: 'auto', border: '1px solid rgba(128,128,128,0.2)', borderRadius: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={{ textAlign: i === head.length - 1 ? 'right' : 'left', padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,0.2)', opacity: 0.7, fontWeight: 600 }}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
      <style jsx global>{`.maint-table td{padding:8px 10px;border-bottom:1px solid rgba(128,128,128,0.12)}.maint-table tbody tr:last-child td{border-bottom:none}`}</style>
    </div>
  );
}
function Pill({ color, children }) {
  return <span style={{ background: `${color}22`, color, border: `1px solid ${color}55`, borderRadius: 20, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>{children}</span>;
}
function Field({ label, children }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}><span style={{ opacity: 0.65 }}>{label}</span>{children}</label>;
}
function Modal({ title, children, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 14px', zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--card-bg, #1b1830)', color: 'inherit', border: '1px solid rgba(128,128,128,0.3)', borderRadius: 14, padding: 18, width: 'min(680px, 96vw)', maxHeight: '86vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="button-subtle" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
