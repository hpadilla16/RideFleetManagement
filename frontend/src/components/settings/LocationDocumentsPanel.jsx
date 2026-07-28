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
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';

const DOC_TYPES = ['PERMIT', 'REGISTRATION', 'INSURANCE', 'LICENSE', 'TAX', 'LEASE', 'OTHER'];
const MAX_BYTES = 15 * 1024 * 1024;

const STATUS_TONE = {
  VALID: 'ok',
  EXPIRING: 'warn',
  EXPIRED: 'danger',
  NO_EXPIRY: 'neutral',
};

// Localised because it is the sentence the operator actually acts on.
function makeStatusText(t) {
  return (doc) => {
    if (doc.expiryStatus === 'NO_EXPIRY') return t('locationDocs.stNoExpiry');
    if (doc.expiryStatus === 'EXPIRED') {
      const d = Math.abs(Number(doc.daysLeft || 0));
      return d === 0 ? t('locationDocs.stExpiredToday') : t('locationDocs.stExpiredAgo', { days: d });
    }
    const d = Number(doc.daysLeft || 0);
    if (doc.expiryStatus === 'EXPIRING') {
      return d === 0 ? t('locationDocs.stExpiresToday') : t('locationDocs.stDaysLeft', { days: d });
    }
    return t('locationDocs.stValid');
  };
}

const EMPTY_FORM = { docType: 'PERMIT', label: '', expiresAt: '', issuedAt: '', notes: '' };

export function LocationDocumentsPanel({ token, locations = [] }) {
  const { t } = useTranslation();
  const statusText = makeStatusText(t);
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
      setError(e?.message || t('locationDocs.errLoad'));
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
      setError(t('locationDocs.errTooBig', { size: (f.size / 1024 / 1024).toFixed(1) }));
      setFile(null);
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = () => setFile({ dataUrl: String(reader.result), name: f.name, size: f.size });
    reader.onerror = () => setError(t('locationDocs.errRead'));
    reader.readAsDataURL(f);
  }

  async function upload(e) {
    e.preventDefault();
    if (!file) { setError(t('locationDocs.errPickFile')); return; }
    if (!form.label.trim()) { setError(t('locationDocs.errName')); return; }
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
      setMsg(t('locationDocs.filed', { label: form.label.trim() }));
      setForm(EMPTY_FORM);
      setFile(null);
      await reload();
    } catch (e2) {
      setError(e2?.message || t('locationDocs.errUpload'));
    } finally {
      setBusy(false);
    }
  }

  async function open(doc) {
    try {
      const res = await api(`/api/locations/documents/${doc.id}/url`, { bypassCache: true }, token);
      if (res?.url) window.open(res.url, '_blank', 'noopener');
    } catch (e) {
      setError(e?.message || t('locationDocs.errOpen'));
    }
  }

  async function archive(doc) {
    setBusy(true);
    try {
      await api(`/api/locations/documents/${doc.id}`, { method: 'DELETE' }, token);
      setMsg(t('locationDocs.archived', { label: doc.label }));
      await reload();
    } catch (e) {
      setError(e?.message || t('locationDocs.errArchive'));
    } finally {
      setBusy(false);
    }
  }

  const needsAttention = docs.filter((d) => d.expiryStatus === 'EXPIRING' || d.expiryStatus === 'EXPIRED');

  return (
    <div className="stack" style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{t('locationDocs.title')}</h3>
        {needsAttention.length > 0 ? (
          <span className="chip chip--warn">{t('locationDocs.needRenewal', { count: needsAttention.length })}</span>
        ) : null}
        <div style={{ flex: 1 }} />
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ maxWidth: 260 }}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
        </select>
      </div>
      <p className="ui-muted" style={{ marginTop: -4 }}>
        {t('locationDocs.intro', { days: 30 })}
      </p>

      {error ? <div className="chip chip--danger">{error}</div> : null}
      {msg ? <div className="chip chip--brand">{msg}</div> : null}

      <form className="stack" onSubmit={upload}>
        <div className="grid2">
          <select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })}>
            {DOC_TYPES.map((code) => <option key={code} value={code}>{t(`locationDocs.type.${code}`)}</option>)}
          </select>
          <input
            required placeholder={t('locationDocs.namePlaceholder')}
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
        </div>
        <div className="grid2">
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <span className="ui-muted">{t('locationDocs.issued')}</span>
            <input type="date" value={form.issuedAt} onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <span className="ui-muted">{t('locationDocs.validUntil')}</span>
            <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </label>
        </div>
        <input placeholder={t('locationDocs.notesPlaceholder')} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input type="file" accept=".pdf,image/*" onChange={pickFile} />
          {file ? <span className="ui-muted" style={{ fontSize: 13 }}>{file.name} · {(file.size / 1024).toFixed(0)} KB</span> : null}
          <button type="submit" disabled={busy || !locationId}>{busy ? t('locationDocs.saving') : t('locationDocs.addDocument')}</button>
        </div>
      </form>

      <table>
        <thead>
          <tr>
            <th>{t('locationDocs.colType')}</th>
            <th>{t('locationDocs.colDocument')}</th>
            <th>{t('locationDocs.colValidUntil')}</th>
            <th>{t('locationDocs.colStatus')}</th>
            <th>{t('locationDocs.colActions')}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={5} className="ui-muted">{t('locationDocs.loading')}</td></tr>
          ) : docs.length === 0 ? (
            <tr><td colSpan={5} className="ui-muted">{t('locationDocs.empty')}</td></tr>
          ) : docs.map((d) => (
            <tr key={d.id}>
              <td>{t(`locationDocs.type.${d.docType}`, { defaultValue: d.docType })}</td>
              <td>
                <div>{d.label}</div>
                {d.notes ? <div className="ui-muted" style={{ fontSize: 12 }}>{d.notes}</div> : null}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{d.expiresAt ? String(d.expiresAt).slice(0, 10) : '—'}</td>
              <td>
                <span className={`chip chip--${STATUS_TONE[d.expiryStatus] || 'neutral'}`}>{statusText(d)}</span>
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button type="button" onClick={() => open(d)}>{t('locationDocs.view')}</button>{' '}
                <button type="button" onClick={() => archive(d)} disabled={busy}>{t('locationDocs.archive')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default LocationDocumentsPanel;
