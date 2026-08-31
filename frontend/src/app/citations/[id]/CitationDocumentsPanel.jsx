'use client';

/**
 * Supporting documents on a citation + the one-PDF export.
 *
 * These are documents filed AGAINST a citation — agency correspondence, proof
 * of payment, dispute letters. They are stored and exported, never sent for
 * automatic reading; the copy says so, because the operator uploading a
 * renter's signed acknowledgement is entitled to know where it goes.
 *
 * The payment-card prompt is a CONFIRMATION, not a block: the API answers 409
 * with code CARD_DATA_CONFIRMATION_REQUIRED, we show the warning, and
 * confirming re-posts the identical payload with acknowledgedCardWarning.
 * Nothing the operator wants to upload is ever refused outright.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, API_BASE } from '../../../lib/client';

const DOC_TYPES = [
  'AGENCY_NOTICE', 'PROOF_OF_PAYMENT', 'DISPUTE_LETTER', 'AGENCY_RESPONSE',
  'CUSTOMER_CORRESPONDENCE', 'RENTAL_DOCUMENT', 'OTHER',
];

// Mirrors ATTACHMENT_MIME_ALLOWLIST in the backend. Kept as an `accept` hint
// only — the server is the authority and re-checks every byte.
const ACCEPT = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/tiff',
  '.doc', '.docx', '.xls', '.xlsx', '.txt', '.eml',
].join(',');

const MAX_BYTES = 15 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsDataURL(file);
  });
}

function sizeLabel(n) {
  const b = Number(n || 0);
  if (!b) return '—';
  return b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

function dateLabel(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function CitationDocumentsPanel({ citationId, citationNo, token, onMessage }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [docType, setDocType] = useState('AGENCY_NOTICE');
  const [file, setFile] = useState(null);
  const [cardWarn, setCardWarn] = useState(null); // pending payload awaiting confirmation
  const fileRef = useRef(null);

  const say = useCallback((m) => { if (onMessage) onMessage(m); }, [onMessage]);

  const load = useCallback(async () => {
    try {
      const out = await api(`/api/citations/${citationId}/attachments`, {}, token);
      setRows(out?.rows || []);
    } catch (e) {
      setRows([]);
      say(e?.message || t('citationDocs.errLoad', { defaultValue: 'Could not load documents' }));
    }
  }, [citationId, token, say, t]);

  useEffect(() => { if (citationId) load(); }, [citationId, load]);

  const reset = () => {
    setLabel(''); setNotes(''); setDocType('AGENCY_NOTICE'); setFile(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // One place that actually posts, so the confirm path and the first attempt
  // send an identical payload apart from the acknowledgement flag.
  const post = async (payload) => {
    setBusy('UPLOAD');
    try {
      await api(
        `/api/citations/${citationId}/attachments`,
        { method: 'POST', body: JSON.stringify(payload) },
        token,
      );
      setCardWarn(null);
      reset();
      await load();
      say(t('citationDocs.filed', { label: payload.label, defaultValue: `Filed "${payload.label}".` }));
    } catch (e) {
      if (e?.code === 'CARD_DATA_CONFIRMATION_REQUIRED' || e?.requiresConfirmation) {
        // Not an error — the operator has to look at the document and decide.
        setCardWarn(payload);
        return;
      }
      say(e?.message || t('citationDocs.errUpload', { defaultValue: 'Upload failed' }));
    } finally {
      setBusy('');
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file) { say(t('citationDocs.errPickFile', { defaultValue: 'Choose a file first.' })); return; }
    if (!label.trim()) { say(t('citationDocs.errLabel', { defaultValue: 'Give the document a name.' })); return; }
    if (file.size > MAX_BYTES) {
      say(t('citationDocs.errTooBig', { size: (file.size / (1024 * 1024)).toFixed(1), defaultValue: 'That file is too big — the limit is 15MB.' }));
      return;
    }
    let dataUrl;
    try {
      dataUrl = await readAsDataUrl(file);
    } catch {
      say(t('citationDocs.errRead', { defaultValue: 'That file could not be read.' }));
      return;
    }
    await post({
      label: label.trim(),
      docType,
      notes: notes.trim() || undefined,
      fileName: file.name,
      file: dataUrl,
    });
  };

  const view = async (id) => {
    try {
      const out = await api(`/api/citations/attachments/${id}/download`, {}, token);
      if (out?.url) window.open(out.url, '_blank', 'noopener');
      else say(t('citationDocs.errOpen', { defaultValue: 'Could not open that document' }));
    } catch (e) {
      say(e?.message || t('citationDocs.errOpen', { defaultValue: 'Could not open that document' }));
    }
  };

  const archive = async (row) => {
    setBusy(row.id);
    try {
      await api(`/api/citations/attachments/${row.id}`, { method: 'DELETE' }, token);
      await load();
      say(t('citationDocs.archived', { label: row.label, defaultValue: `Archived "${row.label}".` }));
    } catch (e) {
      say(e?.message || t('citationDocs.errArchive', { defaultValue: 'Could not archive that document' }));
    } finally {
      setBusy('');
    }
  };

  const exportPdf = async () => {
    setBusy('EXPORT');
    say(t('citationDocs.exporting', { defaultValue: 'Building the file…' }));
    try {
      const res = await fetch(`${API_BASE}/api/citations/${citationId}/export/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        let m = t('citationDocs.errExport', { defaultValue: 'Could not build the citation file' });
        try { const j = await res.json(); if (j?.error) m = j.error; } catch { /* keep the generic message */ }
        say(m);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Citation-${String(citationNo || 'citation').replace(/[^A-Za-z0-9_-]+/g, '-')}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      say(t('citationDocs.exported', { defaultValue: 'Citation file downloaded.' }));
    } catch (e) {
      say(e?.message || t('citationDocs.errExport', { defaultValue: 'Could not build the citation file' }));
    } finally {
      setBusy('');
    }
  };

  const count = rows?.length || 0;

  return (
    <div className="cd-panel">
      <div className="cd-ph" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span>{t('citationDocs.title', { defaultValue: 'Supporting documents' })}</span>
        {count ? (
          <span className="cd-src">{t('citationDocs.count', { count, defaultValue: `${count} documents` })}</span>
        ) : null}
      </div>
      <div style={{ padding: '11px 15px 14px' }}>
        <p style={{ fontSize: 11, color: 'var(--hint)', margin: '0 0 11px' }}>
          {t('citationDocs.intro', { defaultValue: 'Correspondence, proof of payment and dispute paperwork filed against this citation. These are stored and exported only — they are never sent for automatic reading.' })}
        </p>

        {rows === null ? (
          <div style={{ fontSize: 12, color: 'var(--hint)' }}>{t('citationDocs.loading', { defaultValue: 'Loading…' })}</div>
        ) : count === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--hint)' }}>{t('citationDocs.empty', { defaultValue: 'No supporting documents on file for this citation yet.' })}</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--hint)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.4px' }}>
                <th style={{ textAlign: 'left', padding: '4px 0' }}>{t('citationDocs.colDocument', { defaultValue: 'Document' })}</th>
                <th style={{ textAlign: 'left', padding: '4px 0' }}>{t('citationDocs.colType', { defaultValue: 'Type' })}</th>
                <th style={{ textAlign: 'left', padding: '4px 0' }}>{t('citationDocs.colAdded', { defaultValue: 'Added' })}</th>
                <th style={{ textAlign: 'right', padding: '4px 0' }}>{t('citationDocs.colActions', { defaultValue: 'Actions' })}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '0.5px solid var(--bt)' }}>
                  <td style={{ padding: '7px 0' }}>
                    <div>{r.label}</div>
                    <div style={{ color: 'var(--hint)', fontSize: 11 }}>
                      {r.fileName || '—'}{r.sizeBytes ? ` · ${sizeLabel(r.sizeBytes)}` : ''}
                    </div>
                    {r.notes ? <div style={{ color: 'var(--hint)', fontSize: 11 }}>{r.notes}</div> : null}
                  </td>
                  <td style={{ padding: '7px 0' }}>
                    {t(`citationDocs.type.${r.docType}`, { defaultValue: r.docType })}
                  </td>
                  <td style={{ padding: '7px 0', color: 'var(--hint)' }}>{dateLabel(r.createdAt)}</td>
                  <td style={{ padding: '7px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button type="button" className="cd-lnk" style={{ background: 'none', border: 0 }} onClick={() => view(r.id)}>
                      {t('citationDocs.view', { defaultValue: 'View' })}
                    </button>
                    <button
                      type="button"
                      className="cd-lnk"
                      style={{ background: 'none', border: 0, marginLeft: 10 }}
                      disabled={busy === r.id}
                      onClick={() => archive(r)}
                    >
                      {t('citationDocs.archive', { defaultValue: 'Archive' })}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* ── The payment-card confirmation. A prompt, never a refusal. ── */}
        {cardWarn ? (
          <div style={{ marginTop: 12, border: '1px solid var(--warn-bd)', background: 'var(--warn-bg)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--warn)', marginBottom: 4 }}>
              {t('citationDocs.cardWarnTitle', { defaultValue: 'This may be a payment document' })}
            </div>
            <div style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 9 }}>
              {t('citationDocs.cardWarnBody', { defaultValue: 'Do not upload anything showing a full card number — mask all but the last 4 digits first. Continue?' })}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="cd-act b-disp"
                disabled={busy === 'UPLOAD'}
                onClick={() => post({ ...cardWarn, acknowledgedCardWarning: true })}
              >
                {t('citationDocs.cardWarnConfirm', { defaultValue: 'I have checked — upload' })}
              </button>
              <button type="button" className="cd-act" onClick={() => setCardWarn(null)}>
                {t('citationDocs.cancel', { defaultValue: 'Cancel' })}
              </button>
            </div>
          </div>
        ) : null}

        <form onSubmit={submit} style={{ marginTop: 13, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            style={{ fontSize: 12, padding: '7px 8px', borderRadius: 8, border: '0.5px solid var(--bs)', background: 'var(--card)', color: 'var(--text)' }}
          >
            {DOC_TYPES.map((v) => (
              <option key={v} value={v}>{t(`citationDocs.type.${v}`, { defaultValue: v })}</option>
            ))}
          </select>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('citationDocs.labelPlaceholder', { defaultValue: 'Document name' })}
            style={{ fontSize: 12, padding: '7px 9px', borderRadius: 8, border: '0.5px solid var(--bs)', background: 'var(--card)', color: 'var(--text)' }}
          />
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('citationDocs.notesPlaceholder', { defaultValue: 'Notes (optional)' })}
            style={{ fontSize: 12, padding: '7px 9px', borderRadius: 8, border: '0.5px solid var(--bs)', background: 'var(--card)', color: 'var(--text)' }}
          />
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ fontSize: 11 }}
          />
          <button type="submit" className="cd-ghost" disabled={busy === 'UPLOAD'}>
            {busy === 'UPLOAD'
              ? t('citationDocs.saving', { defaultValue: 'Uploading…' })
              : t('citationDocs.addDocument', { defaultValue: 'Add document' })}
          </button>
        </form>

        <div style={{ marginTop: 13, borderTop: '0.5px solid var(--bt)', paddingTop: 11 }}>
          <button type="button" className="cd-ghost" disabled={busy === 'EXPORT'} onClick={exportPdf}>
            {busy === 'EXPORT'
              ? t('citationDocs.exporting', { defaultValue: 'Building the file…' })
              : t('citationDocs.export', { defaultValue: 'Export citation file (PDF)' })}
          </button>
          <p style={{ fontSize: 11, color: 'var(--hint)', margin: '6px 0 0', textAlign: 'center' }}>
            {t('citationDocs.exportHint', { defaultValue: 'One PDF: a cover with the citation, vehicle, rental and renter, then every document that can be appended.' })}
          </p>
        </div>
      </div>
    </div>
  );
}

export default CitationDocumentsPanel;
