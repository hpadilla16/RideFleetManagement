'use client';

/**
 * Settings → Agreement clauses. Manages the per-tenant clause library that
 * backs the "cited clauses" section of incident reports. Admins can seed a
 * starter set, then add / edit / remove clauses.
 *
 * Endpoints (all under /api/incident-reports, ADMIN/OPS/AGENT):
 *   GET    /clauses
 *   POST   /clauses/seed
 *   POST   /clauses          { section, label, text, amountRange, category }
 *   PATCH  /clauses/:id
 *   DELETE /clauses/:id
 */

import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

const TYPES = ['', 'DAMAGE', 'SMOKING', 'CLEANING', 'POLICY_VIOLATION', 'TOLL', 'LATE_RETURN', 'OTHER'];
const EMPTY = { section: '', label: '', text: '', amountRange: '', category: '' };

export default function AgreementClausesPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const [clauses, setClauses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null); // id being edited

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  async function refresh() {
    setLoading(true); setError('');
    try { const rows = await api('/api/incident-reports/clauses'); setClauses(Array.isArray(rows) ? rows : []); }
    catch (e) { setError(e?.message || 'Failed to load clauses'); }
    finally { setLoading(false); }
  }
  async function seed() {
    setBusy(true); setError('');
    try { await api('/api/incident-reports/clauses/seed', { method: 'POST', body: JSON.stringify({}) }); await refresh(); }
    catch (e) { setError(e?.message || 'Seed failed'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!form.section.trim() || !form.label.trim() || !form.text.trim()) { setError('Section, label, and text are required.'); return; }
    setBusy(true); setError('');
    const body = JSON.stringify({ ...form, category: form.category || null, amountRange: form.amountRange || null });
    try {
      if (editing) await api(`/api/incident-reports/clauses/${editing}`, { method: 'PATCH', body });
      else await api('/api/incident-reports/clauses', { method: 'POST', body });
      setForm(EMPTY); setEditing(null); await refresh();
    } catch (e) { setError(e?.message || 'Save failed'); }
    finally { setBusy(false); }
  }
  async function remove(id) {
    if (!window.confirm('Delete this clause? Issued reports keep their snapshot; new reports won\'t see it.')) return;
    setBusy(true); setError('');
    try { await api(`/api/incident-reports/clauses/${id}`, { method: 'DELETE' }); await refresh(); }
    catch (e) { setError(e?.message || 'Delete failed'); }
    finally { setBusy(false); }
  }
  function startEdit(c) {
    setEditing(c.id);
    setForm({ section: c.section || '', label: c.label || '', text: c.text || '', amountRange: c.amountRange || '', category: c.category || '' });
  }

  return (
    <AppShell me={me} logout={logout}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <div className="row-between" style={{ alignItems: 'center', marginBottom: 8 }}>
          <div>
            <h2 style={{ margin: 0 }}>Agreement clauses</h2>
            <p className="ui-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              The clause library cited by incident reports. Snapshotted onto each report at issue time.
            </p>
          </div>
          {clauses.length === 0 && <button className="btn" onClick={seed} disabled={busy}>Seed default clauses</button>}
        </div>

        {error && <div style={{ color: '#b91c1c', fontSize: 13, margin: '8px 0' }}>{error}</div>}

        {/* Editor */}
        <div className="glass card-lg section-card" style={{ marginTop: 12, marginBottom: 16 }}>
          <strong style={{ fontSize: 14 }}>{editing ? 'Edit clause' : 'Add a clause'}</strong>
          <div className="app-card-grid compact" style={{ marginTop: 10 }}>
            <div style={{ maxWidth: 90 }}><label className="label">Section §</label><input type="text" value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} placeholder="6" /></div>
            <div><label className="label">Label</label><input type="text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Smoking fee" /></div>
            <div><label className="label">Amount range</label><input type="text" value={form.amountRange} onChange={(e) => setForm({ ...form, amountRange: e.target.value })} placeholder="$500 + tax" /></div>
            <div>
              <label className="label">Default type</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {TYPES.map((t) => <option key={t} value={t}>{t ? t.replace('_', ' ') : '—'}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label className="label">Clause text</label>
            <textarea rows={3} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} style={{ width: '100%', resize: 'vertical' }} placeholder="Renter agrees that smoking in a non-smoking vehicle incurs a cleaning and deodorizing fee…" />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            {editing && <button className="btn ghost" onClick={() => { setEditing(null); setForm(EMPTY); }}>Cancel</button>}
            <button className="btn" onClick={save} disabled={busy}>{editing ? 'Save changes' : 'Add clause'}</button>
          </div>
        </div>

        {/* List */}
        {loading && <p className="ui-muted" style={{ fontSize: 13 }}>Loading…</p>}
        {!loading && clauses.length === 0 && <p className="ui-muted" style={{ fontSize: 13 }}>No clauses yet. Seed the defaults or add one above.</p>}
        {clauses.map((c) => (
          <div key={c.id} className="glass card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', marginBottom: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14 }}><strong>§{c.section} {c.label}</strong>{c.amountRange ? <span className="ui-muted"> — {c.amountRange}</span> : null}{c.category ? <span className="ui-muted" style={{ fontSize: 12 }}> · {c.category.replace('_', ' ')}</span> : null}</div>
              <div className="ui-muted" style={{ fontSize: 12.5, marginTop: 2 }}>{c.text}</div>
            </div>
            <button className="btn ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => startEdit(c)}>Edit</button>
            <button className="btn ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => remove(c.id)}>Delete</button>
          </div>
        ))}
      </div>
    </AppShell>
  );
}
