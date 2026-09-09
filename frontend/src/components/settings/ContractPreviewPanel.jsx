'use client';

/**
 * ContractPreviewPanel — the contract a sede would print, before anybody rents
 * (2026-09-09).
 *
 * Hector: "me puedes poner pa ver un empty template de un contrato para ver lo
 * en los settings".
 *
 * THE POINT IS NOT THE DOCUMENT, IT IS WHERE IT CAME FROM. Terms resolve
 * through a cascade — this branch, then the tenant, then the built-in document
 * — and a branch with no override renders EXACTLY the same HTML as a branch
 * whose lookup failed. So the source banner sits above the page and the
 * coverage table sits beside it: a screen that only rendered the contract would
 * look reassuring while showing the wrong company's terms.
 *
 * The template is deliberately UNSIGNED: initials render as blank lines, which
 * is the same document that goes to a counter for signing.
 *
 * The HTML is rendered inside a sandboxed iframe, not injected into this page.
 * It is operator-authored and stored per branch, and a stray tag or script in
 * it must not be able to reach the settings screen around it.
 *
 * Backend contract:
 *   GET /api/settings/terms-coverage -> { tenantName, tenantHasBase, tcVersion, locations[] }
 *   GET /api/settings/terms-preview?locationId= -> { html, source, sourceLabel, ... }
 *   PUT /api/settings/branch-terms { locationId, termsHtml?, termsRiderHtml? }
 *
 * Editing is behind a toggle rather than always open: this screen is opened to
 * CHECK a contract far more often than to rewrite one, and a textarea holding a
 * legal document is not something to put under an idle cursor.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/client';

const SOURCE_TONE = {
  LOCATION: { bg: '#dcfce7', fg: '#166534', label: 'Branch' },
  TENANT: { bg: '#fef3c7', fg: '#92400e', label: 'Tenant' },
  CANONICAL: { bg: '#e5e7eb', fg: '#374151', label: 'Built-in' },
};

function Pill({ source, children, title }) {
  const t = SOURCE_TONE[source] || SOURCE_TONE.CANONICAL;
  return (
    <span
      title={title}
      style={{ background: t.bg, color: t.fg, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}
    >
      {children ?? t.label}
    </span>
  );
}

export default function ContractPreviewPanel({ token, me, isSuper, isAdmin, scopedSettingsPath }) {
  const canAccess = Boolean(isSuper || isAdmin || me);
  const scoped = useMemo(() => scopedSettingsPath || ((p) => p), [scopedSettingsPath]);

  const [coverage, setCoverage] = useState(null);
  const [locationId, setLocationId] = useState('');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draftBase, setDraftBase] = useState('');
  const [draftRider, setDraftRider] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState('');

  const loadCoverage = useCallback(async () => {
    try {
      const res = await api(scoped('/api/settings/terms-coverage'), { bypassCache: true }, token);
      setCoverage(res);
      const first = (res?.locations || [])[0];
      if (first && !locationId) setLocationId(first.id);
    } catch (e) {
      setError(e?.message || 'Could not load the branches');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, token]);

  const loadPreview = useCallback(async (id) => {
    setLoading(true);
    setError('');
    try {
      const qs = id ? `?locationId=${encodeURIComponent(id)}` : '';
      setPreview(await api(scoped(`/api/settings/terms-preview${qs}`), { bypassCache: true }, token));
    } catch (e) {
      setError(e?.message || 'Could not render the contract');
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [scoped, token]);

  useEffect(() => { if (canAccess) loadCoverage(); }, [canAccess, loadCoverage]);
  useEffect(() => { if (canAccess && locationId) loadPreview(locationId); }, [canAccess, locationId, loadPreview]);

  // The editor works on the branch's OWN fields, never on the rendered
  // cascade output: opening the tenant's contract in the box and saving it
  // would silently promote a fallback into a branch override.
  const startEditing = useCallback(async () => {
    setError('');
    setSaveNote('');
    try {
      const res = await api(scoped(`/api/settings/branch-terms-raw?locationId=${encodeURIComponent(locationId)}`), { bypassCache: true }, token)
        .catch(() => null);
      setDraftBase(res?.termsHtml ?? '');
      setDraftRider(res?.termsRiderHtml ?? '');
    } catch {
      setDraftBase('');
      setDraftRider('');
    }
    setEditing(true);
  }, [scoped, token, locationId]);

  const save = async () => {
    setSaving(true);
    setError('');
    setSaveNote('');
    try {
      const res = await api(scoped('/api/settings/branch-terms'), {
        method: 'PUT',
        body: JSON.stringify({ locationId, termsHtml: draftBase, termsRiderHtml: draftRider }),
      }, token);
      const removed = Object.values(res?.impact || {})
        .flatMap((i) => (i?.removedTags || []).map((r) => `${r.tag} x${r.removed}`));
      setSaveNote(
        res?.cleared?.length
          ? `Saved. Cleared: ${res.cleared.join(', ')} — this branch now falls back.`
          : `Saved.${removed.length ? ` Filtered out: ${removed.join(', ')}.` : ''}`,
      );
      setEditing(false);
      await loadCoverage();
      await loadPreview(locationId);
    } catch (e) {
      setError(e?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const openInTab = () => {
    if (!preview?.html) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(preview.html);
    w.document.close();
  };

  if (!canAccess) return null;

  return (
    <section className="glass card section-card">
      <div className="stack" style={{ gap: 6 }}>
        <h3 style={{ margin: 0 }}>Contract preview</h3>
        <div className="ui-muted">
          The rental contract this branch would print today, unsigned — initials render as blank
          lines, exactly as it reaches the counter. Terms fall back <strong>branch → tenant →
          built-in document</strong>, and a branch with no terms of its own renders the same page as
          one whose terms failed to load, so the banner below always says which one you are reading.
        </div>
      </div>

      <div className="inline-actions" style={{ marginTop: 12, gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="ui-muted">Branch</span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ minWidth: 240 }}>
            {(coverage?.locations || []).map((l) => (
              <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => loadPreview(locationId)} disabled={loading}>
          {loading ? 'Rendering…' : 'Refresh'}
        </button>
        <button type="button" className="button-subtle" onClick={openInTab} disabled={!preview?.html}>
          Open in a new tab
        </button>
        {editing ? (
          <button type="button" className="button-subtle" onClick={() => { setEditing(false); setSaveNote(''); }} disabled={saving}>
            Cancel
          </button>
        ) : (
          <button type="button" className="button-subtle" onClick={startEditing} disabled={!locationId}>
            Edit this branch&apos;s terms
          </button>
        )}
      </div>

      {error ? <div style={{ marginTop: 12, color: '#991b1b' }}>{error}</div> : null}

      {preview ? (
        <div
          style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 10,
            border: '1px solid rgba(0,0,0,0.08)', background: 'rgba(0,0,0,0.02)',
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          }}
        >
          <Pill source={preview.source} />
          <span>{preview.sourceLabel}</span>
          {preview.hasRider ? (
            <Pill source="LOCATION" title="Local clauses appended after the base contract">+ branch rider</Pill>
          ) : null}
          <span className="ui-muted" style={{ fontSize: 12, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
            {preview.lengths?.rendered?.toLocaleString()} characters rendered
          </span>
        </div>
      ) : null}

      {saveNote ? <div style={{ marginTop: 10, color: '#166534' }}>{saveNote}</div> : null}

      {editing ? (
        <div style={{ marginTop: 14 }}>
          <div className="ui-muted" style={{ fontSize: 12, marginBottom: 8 }}>
            This edits <strong>this branch&apos;s own</strong> terms, not what is rendered above. Leave
            a box empty to have the branch fall back to the tenant, or to the built-in document.
            Scripts, styles, iframes, forms and event handlers are stripped on save; headings, lists,
            tables and the <code>lang</code> markup that carries the bilingual text are kept.
          </div>
          <label className="stack" style={{ gap: 4 }}>
            <span className="ui-muted">Base contract (HTML)</span>
            <textarea
              value={draftBase}
              onChange={(e) => setDraftBase(e.target.value)}
              rows={14}
              spellCheck={false}
              style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              placeholder="Empty = fall back to the tenant, then the built-in document"
            />
          </label>
          <label className="stack" style={{ gap: 4, marginTop: 10 }}>
            <span className="ui-muted">Branch rider — local clauses appended after the base</span>
            <textarea
              value={draftRider}
              onChange={(e) => setDraftRider(e.target.value)}
              rows={8}
              spellCheck={false}
              style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              placeholder="Optional"
            />
          </label>
          <div className="inline-actions" style={{ marginTop: 10 }}>
            <button type="button" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save this branch’s terms'}
            </button>
          </div>
        </div>
      ) : null}

      {preview?.html ? (
        <div style={{ marginTop: 12, border: '1px solid rgba(0,0,0,0.12)', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          <iframe
            title="Contract preview"
            // Sandboxed with no allow-scripts: this is operator-authored HTML
            // stored per branch, and it must not be able to reach the settings
            // page around it.
            sandbox=""
            srcDoc={preview.html}
            style={{ width: '100%', height: 620, border: 0, display: 'block' }}
          />
        </div>
      ) : null}

      {coverage ? (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: '0 0 6px' }}>Which branches have their own contract</h4>
          <div className="ui-muted" style={{ fontSize: 12, marginBottom: 6 }}>
            {coverage.tenantHasBase
              ? `${coverage.tenantName} has tenant-level terms, so a branch without its own prints those.`
              : `${coverage.tenantName} has no tenant-level terms, so a branch without its own prints the built-in document (${coverage.tcVersion}).`}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(0,0,0,0.1)' }}>
                  <th style={{ padding: '6px 8px' }}>Branch</th>
                  <th style={{ padding: '6px 8px' }}>Prints</th>
                  <th style={{ padding: '6px 8px' }}>Own terms</th>
                  <th style={{ padding: '6px 8px' }}>Rider</th>
                  <th style={{ padding: '6px 8px' }} />
                </tr>
              </thead>
              <tbody>
                {(coverage.locations || []).map((l) => (
                  <tr key={l.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                    <td style={{ padding: '6px 8px' }}><strong>{l.code}</strong> <span className="ui-muted">{l.name}</span></td>
                    <td style={{ padding: '6px 8px' }}><Pill source={l.source} /></td>
                    <td style={{ padding: '6px 8px' }}>{l.hasOwnBase ? 'yes' : <span className="ui-muted">no</span>}</td>
                    <td style={{ padding: '6px 8px' }}>{l.hasRider ? 'yes' : <span className="ui-muted">—</span>}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <button type="button" className="button-subtle" onClick={() => setLocationId(l.id)}>
                        Preview
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
