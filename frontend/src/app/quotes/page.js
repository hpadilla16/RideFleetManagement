'use client';

/**
 * Quotes module page (2026-07-17) — Hector-approved mockup v2
 * (doc/quotes-module-mockups-2026-07-17.html). Saved, speakable price estimates
 * (Q-1042) from the live pricing engine; convert honors the quoted price.
 * NON-MONEY surface: no balances, no payments, quotes never feed money reports.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

export default function QuotesPage() {
  return <AuthGate>{({ token, me, logout }) => <QuotesInner token={token} me={me} logout={logout} />}</AuthGate>;
}

const money = (v) => `$${Number(Number(v || 0)).toFixed(2)}`;
const dt = (v) => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const dateShort = (v) => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const daysLeft = (v) => { if (!v) return null; const ms = new Date(v).getTime() - Date.now(); return ms > 0 ? Math.ceil(ms / 86400000) : 0; };

const STATUS_TONE = { ACTIVE: 'good', EXPIRED: 'neutral', CONVERTED: '', CANCELLED: 'warn' };
const TABS = [
  { key: 'ACTIVE', labelKey: 'quotes.tabActive' },
  { key: 'CONVERTED', labelKey: 'quotes.tabConverted' },
  { key: 'EXPIRED', labelKey: 'quotes.tabExpired' },
  { key: '', labelKey: 'quotes.tabAll' },
];

function QuotesInner({ token, me, logout }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState(null); // null = loading
  const [tab, setTab] = useState('ACTIVE');
  const [q, setQ] = useState('');
  const [locations, setLocations] = useState([]);
  const [selected, setSelected] = useState(null); // detail
  const [creating, setCreating] = useState(false);
  const [converting, setConverting] = useState(null); // quote being converted
  const [editingAddOns, setEditingAddOns] = useState(null); // quote whose add-ons are being edited
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const locById = useMemo(() => Object.fromEntries(locations.map((l) => [l.id, l])), [locations]);

  const reload = useCallback(async () => {
    try {
      const data = await api(`/api/quotes?_=1${tab ? `&status=${tab}` : ''}`, { bypassCache: true }, token);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) { setRows([]); setMsg(String(e?.message || e)); }
  }, [tab, token]);

  useEffect(() => { setRows(null); reload(); }, [reload]);
  useEffect(() => {
    // /selectable, not the ADMIN-only configuration endpoint: an AGENT gets
    // 403 from the latter and the catch below turned that into an empty
    // dropdown (Hector, 2026-08-10). Only id/code/name are used here anyway.
    api('/api/locations/selectable', {}, token).then((d) => {
      const list = Array.isArray(d) ? d : (d?.locations || []);
      setLocations(list.map((l) => ({ id: l.id, code: l.code, name: l.name })));
    }).catch(() => {});
  }, [token]);

  const filtered = useMemo(() => {
    if (!Array.isArray(rows)) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    const digits = needle.replace(/\D/g, '');
    return rows.filter((r) =>
      String(r.quoteNumber || '').toLowerCase().includes(needle) ||
      String(r.contactName || '').toLowerCase().includes(needle) ||
      (digits && String(r.contactPhone || '').replace(/\D/g, '').includes(digits)) ||
      String(r.contactEmail || '').toLowerCase().includes(needle)
    );
  }, [rows, q]);

  async function cancelQuote(quote) {
    // GD: destructive — the locked price is unrecoverable (re-quote = fresh prices).
    if (!window.confirm(t('quotes.confirmCancel', { number: quote.quoteNumber }))) return;
    setBusy(true);
    try {
      await api(`/api/quotes/${quote.id}/cancel`, { method: 'POST', body: '{}' }, token);
      setMsg(t('quotes.cancelled')); setSelected(null); await reload();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  async function requote(quote) {
    setBusy(true);
    try {
      const fresh = await api(`/api/quotes/${quote.id}/requote`, { method: 'POST', body: '{}' }, token);
      setMsg(t('quotes.requoted', { number: fresh.quoteNumber })); setSelected(fresh); setTab('ACTIVE'); await reload();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  return (
    <AppShell me={me} logout={logout}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0 }}>{t('quotes.title')}</h1>
          <div style={{ opacity: 0.7, fontSize: 13 }}>{t('quotes.subtitle', { hours: 72 })}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('quotes.search')} style={{ minWidth: 230 }} />
          <button onClick={() => setCreating(true)}>{t('quotes.newQuote')}</button>
        </div>
      </div>

      {msg ? <div className="surface-note" style={{ margin: '10px 0' }}>{msg}</div> : null}

      <div style={{ display: 'flex', gap: 8, margin: '14px 0 10px' }}>
        {TABS.map(({ key, labelKey }) => (
          <button key={key || 'all'} className={tab === key ? '' : 'button-subtle'} onClick={() => setTab(key)}>
            {t(labelKey)}
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="surface-note">{t('quotes.loading')}</div>
      ) : filtered.length === 0 ? (
        <div style={{ border: '1.5px dashed rgba(135,82,254,.35)', borderRadius: 14, padding: 26, textAlign: 'center', opacity: 0.85 }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{t('quotes.emptyTitle')}</div>
          <div style={{ fontSize: 12.5, maxWidth: 360, margin: '0 auto 12px' }}>{t('quotes.emptyBody')}</div>
          <button onClick={() => setCreating(true)}>{t('quotes.newQuote')}</button>
        </div>
      ) : (
        <div className="table-shell">
          <table>
            <thead><tr>
              <th>{t('quotes.colQuote')}</th><th>{t('quotes.colContact')}</th><th>{t('quotes.colClass')}</th>
              <th>{t('quotes.colLoc')}</th><th>{t('quotes.colDates')}</th><th>{t('quotes.colTotal')}</th>
              <th>{t('quotes.colValid')}</th><th>{t('quotes.colSource')}</th><th>{t('quotes.colStatus')}</th>
            </tr></thead>
            <tbody>
              {filtered.map((r) => {
                const left = r.status === 'ACTIVE' ? daysLeft(r.expiresAt) : null;
                return (
                  <tr key={r.id} onClick={() => setSelected(r)} style={{ cursor: 'pointer', opacity: r.status === 'EXPIRED' ? 0.6 : 1 }}>
                    <td style={{ fontWeight: 700 }}>{r.quoteNumber}</td>
                    <td>{r.contactName || '—'}{r.contactPhone ? <div style={{ fontSize: 11.5, opacity: 0.65 }}>{r.contactPhone}</div> : null}</td>
                    <td>{r.vehicleTypeName || r.vehicleTypeCode || '—'}</td>
                    <td>{locById[r.pickupLocationId]?.code || '—'}</td>
                    <td>{dateShort(r.pickupAt)} → {dateShort(r.returnAt)}</td>
                    <td style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(r.total)}</td>
                    <td>{r.status === 'ACTIVE' ? <>{dt(r.expiresAt)}{left !== null && left <= 3 ? <span style={{ color: '#b45309', fontWeight: 700 }}> · {t('quotes.daysLeft', { n: left })}</span> : null}</> : '—'}</td>
                    <td><span className="status-chip">{r.source === 'VOZIA' ? 'VozIA' : 'Staff'}</span></td>
                    <td>
                      <span className={`status-chip ${STATUS_TONE[r.status] || ''}`}>{r.status}</span>
                      {r.status === 'CONVERTED' && r.convertedReservationId ? (
                        <div><Link href={`/reservations/${r.convertedReservationId}`} style={{ fontSize: 11 }} onClick={(e) => e.stopPropagation()}>{t('quotes.viewReservation')} →</Link></div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <QuoteDetail quote={selected} locById={locById} busy={busy} t={t}
          onClose={() => setSelected(null)} onConvert={() => setConverting(selected)}
          onCancel={() => cancelQuote(selected)} onRequote={() => requote(selected)}
          onEditAddOns={() => setEditingAddOns(selected)} />
      ) : null}
      {editingAddOns ? (
        <AddOnsEditor token={token} quote={editingAddOns} t={t}
          onClose={() => setEditingAddOns(null)}
          onSaved={async (updated) => {
            setEditingAddOns(null);
            setSelected(updated);
            setMsg(t('quotes.addOnsSaved', { defaultValue: 'Add-ons updated — new total {{total}}', total: money(updated.total) }));
            await reload();
          }} />
      ) : null}
      {creating ? (
        <NewQuotePanel token={token} locations={locations} t={t}
          onClose={() => setCreating(false)}
          onSaved={async (quote) => {
            setCreating(false);
            setMsg(t('quotes.quoteSaved', { number: quote.quoteNumber, until: dt(quote.expiresAt) }));
            setTab('ACTIVE'); await reload();
          }} />
      ) : null}
      {converting ? (
        <ConvertModal token={token} quote={converting} t={t}
          onClose={() => setConverting(null)}
          onDone={async (out) => {
            setConverting(null); setSelected(null);
            setMsg(t('quotes.converted', { number: out?.reservation?.reservationNumber || out?.reservationId || '' }));
            await reload();
          }} />
      ) : null}
    </AppShell>
  );
}

function Overlay({ children, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,12,40,.42)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} className="glass" style={{ width: 'min(480px, 96vw)', height: '100%', overflowY: 'auto', borderRadius: 0, padding: 20 }}>
        {children}
      </div>
    </div>
  );
}

function Row({ k, v, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px dashed rgba(135,82,254,.18)', fontSize: 13 }}>
      <span style={{ opacity: 0.65 }}>{k}</span>
      <span style={{ fontWeight: strong ? 800 : 600, fontSize: strong ? 16 : 13, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  );
}

function parseQuoteAddOns(quote) {
  try {
    const parsed = JSON.parse(quote?.addOnsJson || 'null');
    return parsed && Array.isArray(parsed.items) && parsed.items.length ? parsed.items : null;
  } catch { return null; }
}

function QuoteDetail({ quote, locById, busy, t, onClose, onConvert, onCancel, onRequote, onEditAddOns }) {
  const addOns = parseQuoteAddOns(quote);
  const loc = locById[quote.pickupLocationId];
  const left = quote.status === 'ACTIVE' ? daysLeft(quote.expiresAt) : null;
  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 21, fontWeight: 800, color: '#8752FE' }}>{quote.quoteNumber}</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <span className="status-chip">{quote.source === 'VOZIA' ? 'VozIA' : 'Staff'}</span>
          <span className={`status-chip ${STATUS_TONE[quote.status] || ''}`}>{quote.status}</span>
        </span>
      </div>
      <div style={{ fontSize: 11.5, opacity: 0.65, margin: '2px 0 12px' }}>
        {t('quotes.detailCreatedBy', { when: dt(quote.createdAt), author: quote.author || (quote.source === 'VOZIA' ? 'Chloe (AI)' : 'Staff') })}
        {quote.ticketId ? ` · ${quote.ticketId}` : ''}
      </div>
      <Row k={t('quotes.colClass')} v={`${quote.vehicleTypeName || quote.vehicleTypeCode || '—'} · ${loc ? (loc.code || loc.name) : '—'}`} />
      <Row k={t('quotes.colDates')} v={`${dt(quote.pickupAt)} → ${dt(quote.returnAt)} (${quote.days} ${t('quotes.days')})`} />
      <Row k={t('quotes.dailyRate')} v={<>{money(quote.dailyRate)}{quote.revenuePricingApplied ? <span style={{ color: '#6d3df2', fontSize: 10.5 }}> · {t('quotes.revenuePricing')}</span> : null}</>} />
      <Row k={t('quotes.subtotal')} v={money(quote.subtotal)} />
      <Row k={t('quotes.fees')} v={money(quote.fees)} />
      {addOns ? addOns.map((a) => (
        <Row key={`${a.kind}:${a.code}`}
          k={`+ ${a.kind === 'INSURANCE' ? t('quotes.addOnInsurance', { defaultValue: 'Insurance' }) + ': ' : ''}${a.name}${Number(a.quantity) > 1 ? ` (${a.quantity} × ${money(a.rate)})` : ''}`}
          v={money(a.total)} />
      )) : null}
      <Row k={t('quotes.taxes')} v={money(quote.taxes)} />
      <Row k={t('quotes.totalQuoted')} v={money(quote.total)} strong />
      {quote.status === 'ACTIVE' ? (
        <div className="surface-note" style={{ margin: '12px 0 4px' }}>
          {t('quotes.validUntil', { until: dt(quote.expiresAt) })}{left !== null && left <= 3 ? ` · ${t('quotes.daysLeft', { n: left })}` : ''}
        </div>
      ) : null}
      <div style={{ fontSize: 11.5, opacity: 0.65, margin: '6px 0 14px' }}>{t('quotes.priceLocked')}</div>
      {quote.status === 'CONVERTED' && quote.convertedReservationId ? (
        <Link href={`/reservations/${quote.convertedReservationId}`}><button>{t('quotes.viewReservation')} →</button></Link>
      ) : (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {quote.status === 'ACTIVE' ? <button className="button-subtle" disabled={busy} onClick={onEditAddOns}>{t('quotes.editAddOns', { defaultValue: 'Add-ons' })}</button> : null}
          {quote.status === 'ACTIVE' ? <button className="button-subtle" disabled={busy} onClick={onCancel}>{t('quotes.cancelQuote')}</button> : null}
          {quote.status === 'EXPIRED' || quote.status === 'CANCELLED' ? <button className="button-subtle" disabled={busy} onClick={onRequote}>{t('quotes.requote')}</button> : null}
          {quote.status === 'ACTIVE' ? <button disabled={busy} onClick={onConvert}>{t('quotes.convert')} →</button> : null}
        </div>
      )}
    </Overlay>
  );
}

/**
 * Add-ons editor (2026-08-06): services + insurance for an ACTIVE quote.
 * Codes only go to the server — prices always resolve there, against the same
 * catalog the booking engine sells from. Clearing every box restores the
 * original spoken price.
 */
function AddOnsEditor({ token, quote, t, onClose, onSaved }) {
  const [options, setOptions] = useState(null); // null = loading
  const [chosen, setChosen] = useState({});     // "KIND:CODE" -> true
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');

  useEffect(() => {
    api(`/api/quotes/${quote.id}/add-on-options`, { bypassCache: true }, token)
      .then((d) => {
        setOptions(d);
        const pre = {};
        for (const it of (d?.addOns?.items || [])) pre[`${it.kind}:${String(it.code).toUpperCase()}`] = true;
        setChosen(pre);
      })
      .catch((e) => { setOptions({ services: [], insurancePlans: [] }); setErrMsg(String(e?.message || e)); });
  }, [quote.id, token]);

  const toggle = (kind, code) => setChosen((c) => {
    const k = `${kind}:${String(code).toUpperCase()}`;
    return { ...c, [k]: !c[k] };
  });

  const lines = [];
  for (const svc of options?.services || []) {
    if (chosen[`SERVICE:${String(svc.code || svc.id || '').toUpperCase()}`]) lines.push(svc);
  }
  for (const plan of options?.insurancePlans || []) {
    if (chosen[`INSURANCE:${String(plan.code || '').toUpperCase()}`]) lines.push(plan);
  }
  const addOnsSubtotal = lines.reduce((sum, l) => sum + Number(l.total || 0), 0);

  const save = async () => {
    setBusy(true); setErrMsg('');
    try {
      const addOns = [];
      for (const svc of options?.services || []) {
        if (chosen[`SERVICE:${String(svc.code || svc.id || '').toUpperCase()}`]) addOns.push({ kind: 'SERVICE', code: svc.code || svc.id });
      }
      for (const plan of options?.insurancePlans || []) {
        if (chosen[`INSURANCE:${String(plan.code || '').toUpperCase()}`]) addOns.push({ kind: 'INSURANCE', code: plan.code });
      }
      const updated = await api(`/api/quotes/${quote.id}/add-ons`, { method: 'PUT', body: { addOns } }, token);
      onSaved(updated);
    } catch (e) { setErrMsg(String(e?.message || e)); } finally { setBusy(false); }
  };

  const optionRow = (kind, key, label, detail, total) => (
    <label key={`${kind}:${key}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px dashed rgba(135,82,254,.14)', cursor: 'pointer', fontSize: 13 }}>
      <input type="checkbox" checked={!!chosen[`${kind}:${String(key).toUpperCase()}`]} onChange={() => toggle(kind, key)} disabled={busy} />
      <span style={{ flex: 1 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {detail ? <span style={{ opacity: 0.6, marginLeft: 6, fontSize: 12 }}>{detail}</span> : null}
      </span>
      <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</span>
    </label>
  );

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 19, fontWeight: 800, color: '#8752FE' }}>{quote.quoteNumber} · {t('quotes.editAddOns', { defaultValue: 'Add-ons' })}</span>
        <button className="button-subtle" onClick={onClose}>✕</button>
      </div>
      {options === null ? <div style={{ padding: 16, opacity: 0.6 }}>{t('quotes.loading', { defaultValue: 'Loading…' })}</div> : (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', opacity: 0.6, margin: '14px 0 2px' }}>
            {t('quotes.addOnServices', { defaultValue: 'Additional services' })}
          </div>
          {(options.services || []).length === 0 ? <div style={{ fontSize: 12.5, opacity: 0.55, padding: '6px 4px' }}>{t('quotes.noneAvailable', { defaultValue: 'None available for this class/location' })}</div>
            : options.services.map((svc) => optionRow('SERVICE', svc.code || svc.id, svc.name,
                Number(svc.quantity) > 1 ? `${svc.quantity} × ${money(svc.rate)}` : null, svc.total))}
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', opacity: 0.6, margin: '14px 0 2px' }}>
            {t('quotes.addOnInsurancePlans', { defaultValue: 'Insurance / protection' })}
          </div>
          {(options.insurancePlans || []).length === 0 ? <div style={{ fontSize: 12.5, opacity: 0.55, padding: '6px 4px' }}>{t('quotes.noneAvailable', { defaultValue: 'None available for this class/location' })}</div>
            : options.insurancePlans.map((plan) => optionRow('INSURANCE', plan.code, plan.label || plan.name || plan.code,
                Number(plan.quantity) > 1 ? `${plan.quantity} × ${money(plan.rate || plan.amount)}` : null, plan.total))}
          <div style={{ marginTop: 14 }}>
            <Row k={t('quotes.totalQuoted')} v={money(quote.total)} />
            <Row k={t('quotes.addOnsSubtotal', { defaultValue: 'Add-ons selected' })} v={money(addOnsSubtotal)} />
            <div style={{ fontSize: 11.5, opacity: 0.6, margin: '6px 0 12px' }}>
              {t('quotes.addOnsTaxNote', { defaultValue: 'Taxes on taxable add-ons are applied on save; the final total comes from the server.' })}
            </div>
          </div>
          {errMsg ? <div className="surface-note warn" style={{ marginBottom: 10 }}>{errMsg}</div> : null}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="button-subtle" disabled={busy} onClick={onClose}>{t('common.cancel', { defaultValue: 'Cancel' })}</button>
            <button disabled={busy} onClick={save}>{t('quotes.saveAddOns', { defaultValue: 'Save add-ons' })}</button>
          </div>
        </>
      )}
    </Overlay>
  );
}

function NewQuotePanel({ token, locations, t, onClose, onSaved }) {
  const [form, setForm] = useState({ pickupLocationId: '', pickupAt: '', returnAt: '', contactName: '', contactPhone: '', contactEmail: '' });
  const [preview, setPreview] = useState({ state: 'idle', results: [], ttlHours: 72 }); // idle|loading|ready|error
  const [vehicleTypeId, setVehicleTypeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const debounceRef = useRef(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const loadPreview = useCallback(() => {
    const { pickupLocationId, pickupAt, returnAt } = form;
    if (!pickupLocationId || !pickupAt || !returnAt) return;
    setPreview((p) => ({ ...p, state: 'loading' }));
    api(`/api/quotes/preview?pickupLocationId=${encodeURIComponent(pickupLocationId)}&pickupAt=${encodeURIComponent(pickupAt)}&returnAt=${encodeURIComponent(returnAt)}`, { bypassCache: true }, token)
      .then((d) => setPreview({ state: 'ready', results: d?.results || [], ttlHours: d?.ttlHours || 72 }))
      .catch(() => setPreview((p) => ({ ...p, state: 'error' })));
  }, [form, token]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadPreview, 400);
    return () => clearTimeout(debounceRef.current);
  }, [form.pickupLocationId, form.pickupAt, form.returnAt, loadPreview]);

  const chosen = preview.results.find((r) => r.vehicleTypeId === vehicleTypeId);
  const canSave = !!(chosen && chosen.available && !busy);

  async function save() {
    setBusy(true); setErrMsg('');
    try {
      const quote = await api('/api/quotes', { method: 'POST', body: JSON.stringify({ ...form, vehicleTypeId }) }, token);
      onSaved(quote);
    } catch (e) { setErrMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <h2 style={{ margin: '0 0 12px' }}>{t('quotes.newQuoteTitle')}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label className="label" style={{ display: 'block' }}>{t('quotes.pickupLocation')}
          <select value={form.pickupLocationId} onChange={set('pickupLocationId')} style={{ width: '100%', marginTop: 4 }}>
            <option value="">—</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code || l.name}</option>)}
          </select>
        </label>
        <span />
        <label className="label" style={{ display: 'block' }}>{t('quotes.pickup')}
          <input type="datetime-local" value={form.pickupAt} onChange={set('pickupAt')} style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label className="label" style={{ display: 'block' }}>{t('quotes.return')}
          <input type="datetime-local" value={form.returnAt} onChange={set('returnAt')} style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label className="label" style={{ display: 'block' }}>{t('quotes.contactName')}
          <input value={form.contactName} onChange={set('contactName')} style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label className="label" style={{ display: 'block' }}>{t('quotes.phone')}
          <input value={form.contactPhone} onChange={set('contactPhone')} style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label className="label" style={{ display: 'block', gridColumn: '1 / -1' }}>{t('quotes.email')}
          <input value={form.contactEmail} onChange={set('contactEmail')} style={{ width: '100%', marginTop: 4 }} />
        </label>
      </div>

      <div style={{ margin: '14px 0 8px', fontWeight: 800 }}>{t('quotes.livePrices')}</div>
      {preview.state === 'loading' ? (
        <div className="surface-note" style={{ opacity: 0.7 }}>{t('quotes.loading')}</div>
      ) : preview.state === 'error' ? (
        <div className="surface-note" style={{ borderColor: 'rgba(245,158,11,.4)' }}>
          {t('quotes.pricesFailed')} <button className="button-subtle" onClick={loadPreview}>{t('quotes.retry')}</button>
        </div>
      ) : preview.state === 'ready' ? (
        preview.results.map((r) => (
          <button type="button" key={r.vehicleTypeId} disabled={!r.available}
            onClick={() => setVehicleTypeId(r.vehicleTypeId)}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', marginBottom: 8,
              width: '100%', textAlign: 'left', background: 'transparent', boxSizing: 'border-box',
              // Real <button> (GD a11y fix) — the app's global button style paints
              // white text + gradient; inherit the panel's text color instead.
              color: 'inherit', font: 'inherit', textShadow: 'none',
              border: `1.5px solid ${vehicleTypeId === r.vehicleTypeId ? '#8752FE' : 'rgba(135,82,254,.18)'}`,
              boxShadow: vehicleTypeId === r.vehicleTypeId ? '0 0 0 3px rgba(135,82,254,.13)' : 'none',
              borderRadius: 14, cursor: r.available ? 'pointer' : 'not-allowed', opacity: r.available ? 1 : 0.55,
            }}>
            <div>
              <div style={{ fontWeight: 700 }}>{r.vehicleTypeName || r.vehicleTypeCode}</div>
              <div style={{ fontSize: 11.5, opacity: 0.65 }}>
                {r.available ? `${r.availableUnits} ${t('quotes.available')} · ${money(r.dailyRate)}${t('quotes.perDay')}` : t('quotes.soldOut')}
              </div>
            </div>
            <div style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{r.available ? money(r.total) : '—'}</div>
          </button>
        ))
      ) : null}

      <div className="surface-note" style={{ margin: '10px 0' }}>{t('quotes.priceNote', { hours: preview.ttlHours })}</div>
      {errMsg ? <div className="surface-note" style={{ borderColor: 'rgba(229,72,77,.4)', margin: '0 0 10px' }}>{errMsg}</div> : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="button-subtle" onClick={onClose}>{t('quotes.back')}</button>
        <button disabled={!canSave} onClick={save}>{t('quotes.saveQuote')}</button>
      </div>
    </Overlay>
  );
}

function ConvertModal({ token, quote, t, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const needsContact = !quote.customerId && !(quote.contactName && quote.contactPhone);
  const [contact, setContact] = useState({ contactName: quote.contactName || '', contactPhone: quote.contactPhone || '' });

  async function run() {
    setBusy(true); setErrMsg('');
    try {
      const body = needsContact ? contact : {};
      const out = await api(`/api/quotes/${quote.id}/convert`, { method: 'POST', body: JSON.stringify(body) }, token);
      onDone(out);
    } catch (e) {
      const m = String(e?.message || e);
      setErrMsg(/no longer available|QUOTE_UNAVAILABLE/i.test(m) ? t('quotes.noLongerAvailable') : m);
    } finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,12,40,.42)', zIndex: 70, display: 'grid', placeItems: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} className="glass card" style={{ width: 'min(500px, 94vw)' }}>
        <h3 style={{ margin: '0 0 10px' }}>{t('quotes.convertTitle', { number: quote.quoteNumber })}</h3>
        <Row k={t('quotes.convertCustomer')} v={quote.contactName || quote.customerId || '—'} />
        <Row k={t('quotes.colTotal')} v={t('quotes.convertPrice', { total: money(quote.total) })} strong />
        <div style={{ fontSize: 12.5, margin: '10px 0' }}>{t('quotes.convertCreates')}</div>
        <div className="surface-note" style={{ marginBottom: 12 }}>{t('quotes.convertNote')}</div>
        {needsContact ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <label className="label" style={{ display: 'block' }}>{t('quotes.contactName')}
              <input value={contact.contactName} onChange={(e) => setContact((c) => ({ ...c, contactName: e.target.value }))} style={{ width: '100%', marginTop: 4 }} />
            </label>
            <label className="label" style={{ display: 'block' }}>{t('quotes.phone')}
              <input value={contact.contactPhone} onChange={(e) => setContact((c) => ({ ...c, contactPhone: e.target.value }))} style={{ width: '100%', marginTop: 4 }} />
            </label>
          </div>
        ) : null}
        {errMsg ? <div className="surface-note" style={{ borderColor: 'rgba(229,72,77,.4)', marginBottom: 10 }}>{errMsg}</div> : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="button-subtle" onClick={onClose}>{t('quotes.back')}</button>
          <button disabled={busy || (needsContact && !(contact.contactName && contact.contactPhone))} onClick={run}>
            {t('quotes.createReservation')}
          </button>
        </div>
      </div>
    </div>
  );
}
