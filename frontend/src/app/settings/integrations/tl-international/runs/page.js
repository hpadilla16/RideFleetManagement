'use client';

/**
 * TL International - Run history page (Surface 3, task 24 phase 1).
 *
 * Full sync run audit log. SUPER_ADMIN gated.
 *
 * Backend:
 *   GET /api/admin/integrations/tl-international/runs?limit=&tenantId=
 *       -> { runs: [...] }
 */

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../../../components/AuthGate';
import { AppShell } from '../../../../../components/AppShell';
import { api } from '../../../../../lib/client';

function fmtTimestamp(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function durationMs(start, end) {
  if (!start || !end) return null;
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  return e - s;
}

function fmtDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = Math.round(sec - min * 60);
  return `${min}m ${s}s`;
}

function StatusBadge({ status }) {
  const s = String(status || '').toUpperCase();
  const styles = {
    SUCCESS: { bg: '#dcfce7', fg: '#166534' },
    OK: { bg: '#dcfce7', fg: '#166534' },
    FAILED: { bg: '#fee2e2', fg: '#991b1b' },
    ERROR: { bg: '#fee2e2', fg: '#991b1b' },
    PARTIAL: { bg: '#fef3c7', fg: '#92400e' },
    RUNNING: { bg: '#dbeafe', fg: '#1e40af' }
  };
  const cfg = styles[s] || { bg: '#e5e7eb', fg: '#374151' };
  return (
    <span style={{ background: cfg.bg, color: cfg.fg, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
      {status || '-'}
    </span>
  );
}

function toCsv(rows) {
  const headers = ['id','startedAt','finishedAt','durationMs','status','pickupsFound','newlyInserted','updated','errors','notes'];
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      escape(r.id),
      escape(r.startedAt || r.createdAt),
      escape(r.finishedAt || r.endedAt),
      escape(durationMs(r.startedAt || r.createdAt, r.finishedAt || r.endedAt)),
      escape(r.status),
      escape(r.pickupsFound),
      escape(r.newlyInserted ?? r.inserted),
      escape(r.updated),
      escape(r.errors ?? r.errorCount),
      escape(r.notes || r.message || '')
    ].join(','));
  }
  return lines.join('\n');
}

function downloadCsv(filename, csv) {
  if (typeof window === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function TLRunsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';

  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [tenants, setTenants] = useState([]);
  const [expandedId, setExpandedId] = useState(null);

  const scoped = (path) => {
    if (!isSuper || !tenantId) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
  };

  useEffect(() => {
    if (!isSuper) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api('/api/admin/tenants', {}, token).catch(() => ({ rows: [] }));
        if (cancelled) return;
        const list = Array.isArray(res) ? res : (res?.rows || res?.tenants || []);
        setTenants(list);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [token, isSuper]);

  const load = async () => {
    if (!isSuper) return;
    setLoading(true);
    setError('');
    try {
      const res = await api(scoped('/api/admin/integrations/tl-international/runs?limit=200'), { bypassCache: true }, token);
      setRuns(Array.isArray(res?.runs) ? res.runs : []);
    } catch (e) {
      setError(e?.message || 'No se pudo cargar el historial / Could not load history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, tenantId, isSuper]);

  const filtered = useMemo(() => {
    let out = runs;
    if (statusFilter !== 'all') {
      out = out.filter((r) => String(r.status || '').toUpperCase() === statusFilter.toUpperCase());
    }
    if (dateFrom) {
      const fromMs = new Date(dateFrom).getTime();
      out = out.filter((r) => new Date(r.startedAt || r.createdAt).getTime() >= fromMs);
    }
    if (dateTo) {
      const toMs = new Date(dateTo).getTime() + 24 * 60 * 60 * 1000;
      out = out.filter((r) => new Date(r.startedAt || r.createdAt).getTime() <= toMs);
    }
    return out;
  }, [runs, statusFilter, dateFrom, dateTo]);

  const stats = useMemo(() => {
    const total = filtered.length;
    const successCount = filtered.filter((r) => String(r.status).toUpperCase() === 'SUCCESS').length;
    const successRate = total ? Math.round((successCount / total) * 100) : 0;
    const sumPickups = filtered.reduce((s, r) => s + (Number(r.pickupsFound) || 0), 0);
    const sumNew = filtered.reduce((s, r) => s + (Number(r.newlyInserted ?? r.inserted) || 0), 0);
    return {
      total,
      successRate,
      avgPickups: total ? Math.round(sumPickups / total) : 0,
      avgNew: total ? Math.round(sumNew / total) : 0
    };
  }, [filtered]);

  if (!isSuper) {
    return (
      <AuthGate>{() => (
        <AppShell me={me} logout={logout}>
          <div style={{ padding: 20 }}>
            <strong>Solo SUPER_ADMIN.</strong> / SUPER_ADMIN only.
          </div>
        </AppShell>
      )}</AuthGate>
    );
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="ui-muted" style={{ fontSize: 13, marginBottom: 4 }}>
          <Link href="/settings" style={{ color: '#2563eb' }}>Settings</Link>
          {' > '}
          Integrations
          {' > '}
          TL International
          {' > '}
          Run history
        </div>
        <h2 className="page-title" style={{ marginTop: 0 }}>Historial de sincronizaciones / Run history</h2>
        <p className="ui-muted">Auditoria completa de las corridas del sync TL International. / Full audit log of TL International sync runs.</p>

        <div className="app-card-grid compact" style={{ marginTop: 12 }}>
          <div className="info-tile">
            <span className="label">Total corridas / Total runs</span>
            <strong>{stats.total}</strong>
          </div>
          <div className="info-tile">
            <span className="label">Tasa de exito / Success rate</span>
            <strong>{stats.successRate}%</strong>
          </div>
          <div className="info-tile">
            <span className="label">Pickups promedio / Avg pickups</span>
            <strong>{stats.avgPickups}</strong>
          </div>
          <div className="info-tile">
            <span className="label">Nuevas promedio / Avg new</span>
            <strong>{stats.avgNew}</strong>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', marginTop: 16 }}>
          <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            Desde / From
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            Hasta / To
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            Estado / Status
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">Todos / All</option>
              <option value="SUCCESS">Success</option>
              <option value="PARTIAL">Partial</option>
              <option value="FAILED">Failed</option>
              <option value="RUNNING">Running</option>
            </select>
          </label>
          {isSuper && tenants.length ? (
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
              Tenant
              <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                <option value="">(actual / current)</option>
                {tenants.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
              </select>
            </label>
          ) : null}
          <button type="button" onClick={() => downloadCsv(`tl-runs-${Date.now()}.csv`, toCsv(filtered))}>
            Exportar CSV / Export CSV
          </button>
          <button type="button" onClick={load}>Refrescar / Refresh</button>
        </div>
      </section>

      <section className="glass card section-card" style={{ marginBottom: 16 }}>
        {error ? (
          <div style={{ padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 4, marginBottom: 8 }}>{error}</div>
        ) : null}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left', background: '#f9fafb' }}>
                <th style={{ padding: '6px 8px' }}>Inicio / Started</th>
                <th style={{ padding: '6px 8px' }}>Fin / Finished</th>
                <th style={{ padding: '6px 8px' }}>Duracion / Duration</th>
                <th style={{ padding: '6px 8px' }}>Estado / Status</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Pickups</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Nuevas / New</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Actualizadas / Updated</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Errores / Errors</th>
                <th style={{ padding: '6px 8px' }}>Notas / Notes</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} style={{ padding: 12, color: '#6b7280' }}>Cargando... / Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: 12, color: '#6b7280' }}>Sin resultados / No results</td></tr>
              ) : filtered.map((r) => {
                const d = durationMs(r.startedAt || r.createdAt, r.finishedAt || r.endedAt);
                const notes = r.notes || r.message || '';
                const truncated = notes.length > 80 ? `${notes.slice(0, 80)}...` : notes;
                const open = expandedId === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => setExpandedId(open ? null : r.id)}
                      style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer', background: open ? '#f0f9ff' : 'transparent' }}
                    >
                      <td style={{ padding: '6px 8px' }}>{fmtTimestamp(r.startedAt || r.createdAt)}</td>
                      <td style={{ padding: '6px 8px' }}>{fmtTimestamp(r.finishedAt || r.endedAt)}</td>
                      <td style={{ padding: '6px 8px' }}>{fmtDuration(d)}</td>
                      <td style={{ padding: '6px 8px' }}><StatusBadge status={r.status} /></td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.pickupsFound ?? '-'}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.newlyInserted ?? r.inserted ?? '-'}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.updated ?? '-'}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.errors ?? r.errorCount ?? 0}</td>
                      <td style={{ padding: '6px 8px', color: '#6b7280' }}>{truncated || '-'}</td>
                    </tr>
                    {open ? (
                      <tr key={`${r.id}-detail`} style={{ background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                        <td colSpan={9} style={{ padding: 12 }}>
                          <div style={{ fontSize: 12, color: '#374151' }}>
                            <div><strong>Run ID:</strong> <code>{r.id}</code></div>
                            <div><strong>Job ID:</strong> <code>{r.jobId || '-'}</code></div>
                            {notes ? (
                              <div style={{ marginTop: 6 }}>
                                <strong>Notes / Notas:</strong>
                                <pre style={{ whiteSpace: 'pre-wrap', background: 'white', padding: 8, borderRadius: 4, marginTop: 4 }}>{notes}</pre>
                              </div>
                            ) : null}
                            {r.errorDetails ? (
                              <div style={{ marginTop: 6 }}>
                                <strong>Errors / Errores:</strong>
                                <pre style={{ whiteSpace: 'pre-wrap', background: '#fef2f2', color: '#991b1b', padding: 8, borderRadius: 4, marginTop: 4 }}>
                                  {typeof r.errorDetails === 'string' ? r.errorDetails : JSON.stringify(r.errorDetails, null, 2)}
                                </pre>
                              </div>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
