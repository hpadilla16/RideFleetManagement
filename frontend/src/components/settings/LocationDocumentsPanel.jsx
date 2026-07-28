'use client';

/**
 * Business documents per location (2026-07-28). Permits, registrations,
 * insurance, licences — the paperwork a branch needs to trade legally.
 *
 * Two jobs: file the document with the date it stops being valid, and make it
 * retrievable later. Expiry is computed by the server on every read, so what
 * this screen shows is always current — there is no cached status to go stale.
 *
 * Files open through a short-lived signed URL; nothing is ever exposed at a
 * permanent link.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/client';

const DOC_TYPES = ['PERMIT', 'REGISTRATION', 'INSURANCE', 'LICENSE', 'TAX', 'LEASE', 'OTHER'];
const MAX_BYTES = 15 * 1024 * 1024;

const STATUS_TONE = {
  VALID: 'ok',
  EXPIRING: 'warn',
  EXPIRED: 'danger',
  NO_EXPIRY: 'neutral',
};

function statusText(doc) {
  if (doc.expiryStatus === 'NO_EXPIRY') return 'No expiry';
  if (doc.expiryStatus === 'EXPIRED') {
    const d = Math.abs(Number(doc.daysLeft || 0));
    return d === 0 ? 'Expired today' : `Expired ${d}d ago`;
  }
  const d = Number(doc.daysLeft || 0);
  if (doc.expiryStatus === 'EXPIRING') return d === 0 ? 'Expires today' : `${d}d left`;
  return 'Valid';
}

const EMPTY_FORM = { docType: 'PERMIT', label: '', expiresAt: '', issuedAt: '', notes: '' };

export function LocationDocumentsPanel({ token, locations = [] }) {
  const [locationId, setLocationId] = useState('');
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState(null);      // { dataUrl, name, size }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!locationId && locations.length) setLocationId(locations[0].id);
  }, [locations, locationId]);

  const reload = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    setError('');
    try {
      const res = await api(`/api/locations/${locationId}/documents`, { bypassCache: true }, token);
      setDocs(Array.isArray(res) ? res : []);
    } catch (e) {
      setError(e?.message || 'Could not load documents');
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [locationId, token]);

  useEffect(() => { reload(); }, [reload]);

  function pickFile(e) {
    const f = e.target.files?.[0];
    setMsg('');
    if (!f) { setFile(null); return; }
    if (f.size > MAX_BYTES) {
      setError(`That file is ${(f.size / 1024 / 1024).toFixed(1)}MB — the limit is 15MB.`);
      setFile(null);
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = () => setFile({ dataUrl: String(reader.result), name: f.name, size: f.size });
    reader.onerror = () => setError('That file could not be read.');
    reader.readAsDataURL(f);
  }

  async function upload(e) {
    e.preventDefault();
    if (!file) { setError('Choose a file first.'); return; }
    if (!form.label.trim()) { setError('Give the document a name.'); return; }
    setBusy(true);
    setError('');
    try {
      await api(`/api/locations/${locationId}/documents`, {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          label: form.label.trim(),
          expiresAt: form.expiresAt || null,
          issuedAt: form.issuedAt || null,
          file: file.dataUrl,
          fileName: file.name,
        }),
      }, token);
      setMsg(`Filed “${form.label.trim()}”.`);
      setForm(EMPTY_FORM);
      setFile(null);
      await reload();
    } catch (e2) {
      setError(e2?.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function open(doc) {
    try {
      const res = await api(`/api/locations/documents/${doc.id}/url`, { bypassCache: true }, token);
      if (res?.url) window.open(res.url, '_blank', 'noopener');
    } catch (e) {
      setError(e?.message || 'Could not open that document');
    }
  }

  async function archive(doc) {
    setBusy(true);
    try {
      await api(`/api/locations/documents/${doc.id}`, { method: 'DELETE' }, token);
      setMsg(`Archived “${doc.label}”. It stays on file for audits.`);
      await reload();
    } catch (e) {
      setError(e?.message || 'Could not archive that document');
    } finally {
      setBusy(false);
    }
  }

  const needsAttention = docs.filter((d) => d.expiryStatus === 'EXPIRING' || d.expiryStatus === 'EXPIRED');

  return (
    <div className="stack" style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Business documents</h3>
        {needsAttention.length > 0 ? (
          <span className="chip chip--warn">{needsAttention.length} need renewal</span>
        ) : null}
        <div style={{ flex: 1 }} />
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ maxWidth: 260 }}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
        </select>
      </div>
      <p className="ui-muted" style={{ marginTop: -4 }}>
        Permits, registrations, insurance and licences for this branch. Add the date each one stops
        being valid and the dashboard will warn you 30 days ahead.
      </p>

      {error ? <div className="chip chip--danger">{error}</div> : null}
      {msg ? <div className="chip chip--brand">{msg}</div> : null}

      <form className="stack" onSubmit={upload}>
        <div className="grid2">
          <select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })}>
            {DOC_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
          </select>
          <input
            required placeholder="Document name (e.g. City business permit)"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
        </div>
        <div className="grid2">
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <span className="ui-muted">Issued (optional)</span>
            <input type="date" value={form.issuedAt} onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <span className="ui-muted">Valid until (leave blank if it never expires)</span>
            <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </label>
        </div>
        <input placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input type="file" accept=".pdf,image/*" onChange={pickFile} />
          {file ? <span className="ui-muted" style={{ fontSize: 13 }}>{file.name} · {(file.size / 1024).toFixed(0)} KB</span> : null}
          <button type="submit" disabled={busy || !locationId}>{busy ? 'Saving…' : 'Add document'}</button>
        </div>
      </form>

      <table>
        <thead>
          <tr><th>Type</th><th>Document</th><th>Valid until</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={5} className="ui-muted">Loading…</td></tr>
          ) : docs.length === 0 ? (
            <tr><td colSpan={5} className="ui-muted">No documents on file for this branch yet.</td></tr>
          ) : docs.map((d) => (
            <tr key={d.id}>
              <td>{d.docType.charAt(0) + d.docType.slice(1).toLowerCase()}</td>
              <td>
                <div>{d.label}</div>
                {d.notes ? <div className="ui-muted" style={{ fontSize: 12 }}>{d.notes}</div> : null}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{d.expiresAt ? String(d.expiresAt).slice(0, 10) : '—'}</td>
              <td>
                <span className={`chip chip--${STATUS_TONE[d.expiryStatus] || 'neutral'}`}>{statusText(d)}</span>
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button type="button" onClick={() => open(d)}>View</button>{' '}
                <button type="button" onClick={() => archive(d)} disabled={busy}>Archive</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default LocationDocumentsPanel;
