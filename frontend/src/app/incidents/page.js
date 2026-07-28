'use client';

/**
 * Incidents HUB (2026-07-28): every incident report for the tenant in one
 * place — joined with its reservation, customer, vehicle and sede — with
 * print (same HTML the per-reservation panel uses) and email-to-anyone.
 * Location-scoped users only see their sedes' incidents (backend enforced).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api, API_BASE } from '../../lib/client';

const STATUS_TONE = {
  DRAFT: 'neutral',
  ISSUED: 'brand',
  DISPUTED: 'danger',
  RESOLVED: 'ok',
  CLOSED: 'neutral',
  VOID: 'neutral',
};
const SEVERITY_TONE = { MINOR: 'neutral', MODERATE: 'warn', SEVERE: 'danger' };
const TYPES = ['DAMAGE', 'SMOKING', 'CLEANING', 'POLICY_VIOLATION', 'TOLL', 'LATE_RETURN', 'OTHER'];
const STATUSES = ['DRAFT', 'ISSUED', 'DISPUTED', 'RESOLVED', 'CLOSED', 'VOID'];
const PAGE_SIZE = 50;

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

export default function IncidentsPage() {
  return <AuthGate>{({ token, me, logout }) => <IncidentsInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function IncidentsInner({ token, me, logout }) {
  const { t } = useTranslation();
  const [data, setData] = useState({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [emailFor, setEmailFor] = useState(null); // report row for the email dialog
  const [emailTo, setEmailTo] = useState('');
  const [emailNote, setEmailNote] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) params.set('status', status);
      if (type) params.set('type', type);
      if (q.trim()) params.set('q', q.trim());
      const res = await api(`/api/incident-reports?${params.toString()}`, {}, token);
      setData(res);
    } catch (e) {
      setError(e?.message || 'Failed to load incident reports');
    } finally {
      setLoading(false);
    }
  }, [token, page, status, type, q]);

  useEffect(() => { load(); }, [load]);

  async function printReport(row) {
    try {
      const res = await fetch(`${API_BASE}/api/incident-reports/${row.id}/print`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const html = await res.text();
      const w = window.open('', '_blank');
      if (!w) return;
      w.document.write(html);
      w.document.close();
      // Give the new document a beat to lay out before invoking print.
      setTimeout(() => { try { w.print(); } catch {} }, 350);
    } catch (e) {
      setNotice(e?.message || 'Print failed');
    }
  }

  async function sendEmail() {
    if (!emailFor) return;
    setEmailBusy(true);
    setNotice('');
    try {
      await api(`/api/incident-reports/${emailFor.id}/email`, {
        method: 'POST',
        body: JSON.stringify({ to: emailTo, note: emailNote }),
      }, token);
      setNotice(t('incidents.emailSent', { defaultValue: 'Report emailed to' }) + ` ${emailTo}`);
      setEmailFor(null); setEmailTo(''); setEmailNote('');
    } catch (e) {
      setNotice(e?.message || 'Email failed');
    } finally {
      setEmailBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil((data.total || 0) / PAGE_SIZE));

  return (
    <AppShell me={me} onLogout={logout}>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h1 style={{ margin: 0, fontSize: '1.15rem' }}>{t('incidents.title', { defaultValue: 'Incident Reports' })}</h1>
          <span className="chip chip--neutral">{data.total} {t('incidents.total', { defaultValue: 'total' })}</span>
          <div style={{ flex: 1 }} />
          <input
            className="input" style={{ maxWidth: 240 }}
            placeholder={t('incidents.searchPlaceholder', { defaultValue: 'Report #, customer, plate…' })}
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
          />
          <select className="input" style={{ maxWidth: 150 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">{t('incidents.allStatuses', { defaultValue: 'All statuses' })}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input" style={{ maxWidth: 170 }} value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
            <option value="">{t('incidents.allTypes', { defaultValue: 'All types' })}</option>
            {TYPES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>

        {notice ? <div className="chip chip--brand" style={{ marginBottom: 10 }}>{notice}</div> : null}
        {error ? <div className="chip chip--danger" style={{ marginBottom: 10 }}>{error}</div> : null}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: '0.86rem', minWidth: 1080, width: '100%' }}>
            <thead>
              <tr>
                <th>{t('incidents.report', { defaultValue: 'Report' })}</th>
                <th>{t('incidents.date', { defaultValue: 'Date' })}</th>
                <th>{t('incidents.type', { defaultValue: 'Type' })}</th>
                <th>{t('incidents.status', { defaultValue: 'Status' })}</th>
                <th>{t('incidents.reservation', { defaultValue: 'Reservation' })}</th>
                <th>{t('incidents.customer', { defaultValue: 'Customer' })}</th>
                <th>{t('incidents.vehicle', { defaultValue: 'Vehicle' })}</th>
                <th>{t('incidents.location', { defaultValue: 'Location' })}</th>
                <th style={{ textAlign: 'right' }}>{t('incidents.actions', { defaultValue: 'Actions' })}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} style={{ padding: 18, textAlign: 'center', color: 'var(--text-2)' }}>…</td></tr>
              ) : data.items.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: 18, textAlign: 'center', color: 'var(--text-2)' }}>
                  {t('incidents.empty', { defaultValue: 'No incident reports found.' })}
                </td></tr>
              ) : data.items.map((row) => {
                const c = row.reservation?.customer;
                const v = row.reservation?.vehicle;
                return (
                  <tr key={row.id}>
                    <td>
                      <div style={{ fontWeight: 640 }}>{row.reportNumber}</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-2)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.title}>{row.title}</div>
                    </td>
                    <td>{fmtDate(row.discoveryAt)}</td>
                    <td>
                      <span className={`chip chip--${SEVERITY_TONE[row.severity] || 'neutral'}`}>
                        {row.type.replace(/_/g, ' ')}{row.severity ? ` · ${row.severity}` : ''}
                      </span>
                    </td>
                    <td><span className={`chip chip--${STATUS_TONE[row.status] || 'neutral'}`}><span className="led" />{row.status}</span></td>
                    <td>
                      {row.reservation ? (
                        <Link href={`/reservations/${row.reservation.id}`} style={{ fontWeight: 600 }}>
                          {row.reservation.reservationNumber}
                        </Link>
                      ) : '—'}
                    </td>
                    <td>
                      {c ? (
                        <div>
                          <div>{c.firstName} {c.lastName}</div>
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-2)' }}>{c.email || c.phone || ''}</div>
                        </div>
                      ) : '—'}
                    </td>
                    <td>{v ? `${v.plate || v.internalNumber || ''}` : '—'}</td>
                    <td>{row.reservation?.location?.code || row.reservation?.location?.name || '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn ghost" type="button" style={{ fontSize: 12.5 }} onClick={() => printReport(row)}>
                        {t('incidents.print', { defaultValue: 'Print' })}
                      </button>{' '}
                      <button
                        className="btn ghost" type="button" style={{ fontSize: 12.5 }}
                        disabled={row.status === 'DRAFT'}
                        title={row.status === 'DRAFT' ? t('incidents.draftNoEmail', { defaultValue: 'Draft reports cannot be emailed' }) : ''}
                        onClick={() => { setEmailFor(row); setEmailTo(row.reservation?.customer?.email || ''); }}
                      >
                        {t('incidents.email', { defaultValue: 'Email' })}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>←</button>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-2)' }}>{page} / {totalPages}</span>
          <button className="btn ghost" type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>→</button>
        </div>
      </div>

      {emailFor ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 90 }}>
          <div className="card" style={{ padding: 18, width: 'min(440px, 92vw)' }}>
            <h3 style={{ marginTop: 0 }}>{t('incidents.emailTitle', { defaultValue: 'Email report' })} {emailFor.reportNumber}</h3>
            <label style={{ display: 'block', fontSize: '0.82rem', marginBottom: 4 }}>{t('incidents.emailTo', { defaultValue: 'Recipient' })}</label>
            <input className="input" style={{ width: '100%', marginBottom: 10 }} type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="someone@example.com" />
            <label style={{ display: 'block', fontSize: '0.82rem', marginBottom: 4 }}>{t('incidents.emailNote', { defaultValue: 'Note (optional)' })}</label>
            <textarea className="input" style={{ width: '100%', minHeight: 70, marginBottom: 12 }} value={emailNote} onChange={(e) => setEmailNote(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" type="button" disabled={emailBusy} onClick={() => setEmailFor(null)}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button className="btn" type="button" disabled={emailBusy || !emailTo.trim()} onClick={sendEmail}>
                {emailBusy ? '…' : t('incidents.send', { defaultValue: 'Send' })}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
