'use client';

/**
 * Saved custom report view (2026-07-26) — where staff live. Export Excel is
 * the primary action; the range picker is a ONE-OFF override (never saved).
 * Role-stripped columns surface as an amber banner, not a 403.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api, API_BASE } from '../../../../lib/client';

const PRESETS = [
  ['TODAY', 'Today'], ['THIS_WEEK', 'This week'], ['THIS_MONTH', 'This month'], ['LAST_MONTH', 'Last month']
];

function money(n) { return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function cell(value, type) {
  if (value == null || value === '') return '-';
  if (type === 'money') return money(value);
  if (type === 'date') return new Date(value).toLocaleString();
  if (type === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function SavedReport({ me, token, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const [report, setReport] = useState(null);
  const [result, setResult] = useState(null);
  const [preset, setPreset] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (presetOverride) => {
    setLoading(true);
    try {
      // Always fetch meta fresh — the closure's `report` is stale right after
      // an id-change reset, and one light GET per run is cheap.
      const meta = await api(`/api/reports/custom/${id}`, { bypassCache: true }, token);
      setReport(meta);
      const body = presetOverride ? { range: { preset: presetOverride } } : {};
      const out = await api(`/api/reports/custom/${id}/run`, { method: 'POST', body: JSON.stringify(body) }, token);
      setResult(out);
      setMsg('');
    } catch (e) { setMsg(e.message); } finally { setLoading(false); }
  };

  useEffect(() => {
    // Full reset on id change (QA: soft navigation A -> B showed B's rows
    // under A's name because `report` survived in the closure).
    setReport(null); setResult(null); setPreset('');
    load();
  }, [id, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => {
    if (!report) return '';
    const def = report.definition || {};
    const parts = [report.dataset.charAt(0).toUpperCase() + report.dataset.slice(1)];
    if (def.range?.preset) parts.push(def.range.preset.replace('_', ' ').toLowerCase());
    if (def.groupBy?.field) parts.push(`grouped by ${def.groupBy.bucket || def.groupBy.field}`);
    parts.push(`${(def.columns || []).length} columns`);
    return parts.join(' · ');
  }, [report]);

  const exportExcel = async () => {
    try {
      const qs = preset ? `?preset=${preset}` : '';
      const res = await fetch(`${API_BASE}/api/reports/custom/${id}/excel${qs}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(report?.name || 'report').replace(/[^a-z0-9-_ ]/gi, '')}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setMsg(e.message); }
  };

  const remove = async () => {
    if (!window.confirm('Delete this report? This cannot be undone.')) return;
    try {
      await api(`/api/reports/custom/${id}`, { method: 'DELETE' }, token);
      router.push('/reports-v2');
    } catch (e) { setMsg(e.message); }
  };

  const duplicate = async () => {
    try {
      const out = await api('/api/reports/custom', {
        method: 'POST',
        body: JSON.stringify({
          name: `${report.name} (copy)`, dataset: report.dataset,
          definition: report.definition, visibility: 'PRIVATE'
        })
      }, token);
      router.push(`/reports-v2/builder?id=${out.id}`);
    } catch (e) { setMsg(e.message); }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <span className="eyebrow">Report Builder</span>
            <h2 className="page-title" style={{ marginTop: 6 }}>{report?.name || 'Report'}</h2>
            <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{summary}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={preset} onChange={(e) => { setPreset(e.target.value); load(e.target.value || undefined); }}>
              <option value="">Saved range</option>
              {PRESETS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <button className="ios-action-btn" onClick={exportExcel}>Export Excel</button>
            {report?.canEdit ? <button className="button-subtle" onClick={() => router.push(`/reports-v2/builder?id=${id}`)}>Edit</button> : null}
            <button className="button-subtle" onClick={duplicate}>Duplicate</button>
            {report?.canEdit ? <button className="button-subtle" onClick={remove}>Delete</button> : null}
            <button className="button-subtle" onClick={() => router.push('/reports-v2')}>Back</button>
          </div>
        </div>

        {msg ? <div className="surface-note" style={{ color: '#b3261e' }}>{msg}</div> : null}
        {result?.hiddenColumns?.length ? (
          <div className="surface-note" style={{ background: '#fdf3e0', color: '#92600a' }}>
            {result.hiddenColumns.length} column{result.hiddenColumns.length > 1 ? 's' : ''} hidden for your role.
          </div>
        ) : null}
        {result?.unavailableColumns?.length ? (
          <div className="surface-note" style={{ background: '#fdf3e0', color: '#92600a' }}>
            This report uses a field that is no longer available: {result.unavailableColumns.join(', ')}.
          </div>
        ) : null}

        <div className="glass card" style={{ padding: 0 }}>
          <div style={{ padding: '0 16px 14px', overflowX: 'auto' }}>
            {loading ? <div className="surface-note" style={{ margin: 16 }}>Loading…</div>
              : result && result.rows.length ? (
                <table>
                  <thead><tr>{result.columns.map((c) => <th key={c.key} style={['money', 'number'].includes(c.type) ? { textAlign: 'right' } : {}}>{c.label}</th>)}</tr></thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>{row.map((v, j) => <td key={j} style={['money', 'number'].includes(result.columns[j].type) ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } : {}}>{cell(v, result.columns[j].type)}</td>)}</tr>
                    ))}
                    {result.mode === 'grouped' && result.totals ? (
                      <tr style={{ fontWeight: 700 }}>{result.totals.map((v, j) => <td key={j} style={j > 0 ? { textAlign: 'right' } : {}}>{j === 0 ? v : cell(v, result.columns[j]?.type)}</td>)}</tr>
                    ) : null}
                  </tbody>
                </table>
              ) : <div className="surface-note" style={{ margin: 16 }}>No data matches — try another range.</div>}
            {result?.truncated ? (
              <div className="label" style={{ textTransform: 'none', padding: '8px 2px', ...(result.mode === 'grouped' ? { color: '#92600a', fontWeight: 600 } : {}) }}>
                {result.mode === 'grouped'
                  ? '⚠ Totals are incomplete — over 5,000 rows matched. Narrow the range for accurate numbers.'
                  : `Showing first ${result.rowCount} rows — export for all.`}
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </AppShell>
  );
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <SavedReport token={token} me={me} logout={logout} />}</AuthGate>;
}
