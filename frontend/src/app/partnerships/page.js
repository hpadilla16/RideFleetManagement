'use client';

/**
 * Partnerships — list (2026-09-05, Hector-approved mockup v2.1
 * doc/partnerships-module-mockups-2026-09-05.html §A / §G).
 * Alliance programs with their own price book, terms, services and hosted page + QR.
 * Tenant opt-in module (Tenant.partnershipsEnabled); ADMIN/OPS. Theme-aware: only
 * globals.css classes, no inline hex.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import { Dialog, PartnerLogo, StatusChip, tenantQuerySuffix, useTenantContext } from './_shared';

export default function PartnershipsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

const money = (v) => `$${Number(Number(v || 0)).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const dateShort = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); };

function Inner({ token, me, logout }) {
  const { t } = useTranslation();
  const router = useRouter();
  const tenantCtx = useTenantContext(me, token);
  const qs = tenantQuerySuffix(tenantCtx.activeTenantId, tenantCtx.isSuperAdmin);

  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [settings, setSettings] = useState(null);
  const [msg, setMsg] = useState('');
  const [creating, setCreating] = useState(false);
  const [domainOpen, setDomainOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (tenantCtx.isSuperAdmin && !tenantCtx.activeTenantId) { setRows([]); return; }
    try {
      const [list, sum, cfg] = await Promise.all([
        api(`/api/partnerships${qs}`, { bypassCache: true }, token),
        api(`/api/partnerships/summary${qs}`, { bypassCache: true }, token),
        api(`/api/partnerships/settings${qs}`, { bypassCache: true }, token)
      ]);
      setRows(Array.isArray(list) ? list : []);
      setSummary(sum || null);
      setSettings(cfg || null);
    } catch (e) { setRows([]); setMsg(String(e?.message || e)); }
  }, [qs, token, tenantCtx.isSuperAdmin, tenantCtx.activeTenantId]);

  useEffect(() => { setRows(null); reload(); }, [reload]);

  const stats = useMemo(() => summary || { activePrograms: 0, bookings30d: 0, bookedEstimate30d: 0, visitsTotal: 0 }, [summary]);

  return (
    <AppShell me={me} logout={logout}>
      <div className="page-hero">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0 }}>{t('partnerships.title')}</h1>
            <div style={{ opacity: 0.7, fontSize: 13 }}>{t('partnerships.subtitle')}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {tenantCtx.isSuperAdmin ? (
              <select value={tenantCtx.activeTenantId} onChange={(e) => tenantCtx.setActiveTenantId(e.target.value)} aria-label={t('partnerships.tenantPicker')}>
                <option value="">{t('partnerships.tenantPickerEmpty')}</option>
                {tenantCtx.tenants.map((tn) => <option key={tn.id} value={tn.id}>{tn.name}</option>)}
              </select>
            ) : null}
            <button className="button-subtle" onClick={() => setDomainOpen(true)} disabled={!settings}>{t('partnerships.domainSettings')}</button>
            <button onClick={() => setCreating(true)} disabled={tenantCtx.isSuperAdmin && !tenantCtx.activeTenantId}>{t('partnerships.newPartner')}</button>
          </div>
        </div>
      </div>

      {msg ? <div className="surface-note" style={{ margin: '10px 0' }}>{msg}</div> : null}

      <div className="metric-grid" style={{ marginBottom: 16 }}>
        <div className="metric-card"><span className="label">{t('partnerships.kpiActive')}</span><strong>{stats.activePrograms}</strong></div>
        <div className="metric-card"><span className="label">{t('partnerships.kpiBookings')}</span><strong>{stats.bookings30d}</strong></div>
        <div className="metric-card"><span className="label">{t('partnerships.kpiBooked')}</span><strong>{money(stats.bookedEstimate30d)}</strong></div>
        <div className="metric-card"><span className="label">{t('partnerships.kpiVisitsTotal')}</span><strong>{stats.visitsTotal}</strong></div>
      </div>

      {rows === null ? (
        <div className="surface-note">{t('partnerships.loading')}</div>
      ) : rows.length === 0 ? (
        <div className="glass card" style={{ textAlign: 'center', padding: 28 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('partnerships.emptyTitle')}</div>
          <div style={{ fontSize: 12.5, maxWidth: 420, margin: '0 auto 12px', opacity: 0.85 }}>{t('partnerships.emptyBody')}</div>
          <button onClick={() => setCreating(true)} disabled={tenantCtx.isSuperAdmin && !tenantCtx.activeTenantId}>{t('partnerships.newPartner')}</button>
          {settings ? (
            <div className="surface-note" style={{ marginTop: 16, textAlign: 'left' }}>
              {t('partnerships.domainHelp')} {settings.partnerHostedBaseUrl ? <code>{settings.partnerHostedBaseUrl}</code> : <code>{settings.fallbackBaseUrl}/&lt;slug&gt;</code>}
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {rows.map((p) => {
            const done = Object.values(p.readiness?.steps || {}).filter(Boolean).length;
            const total = Object.keys(p.readiness?.steps || {}).length || 6;
            const pricing = p.rateId ? t('partnerships.pricingRate') : (p.discountPct ? t('partnerships.pricingDiscount', { pct: p.discountPct }) : t('partnerships.pricingNone'));
            return (
              <Link key={p.id} href={`/partnerships/${p.id}${qs}`} className="glass card" style={{ display: 'grid', gap: 10, textDecoration: 'none', color: 'inherit' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 34 }}>
                  <PartnerLogo tenantLogoUrl={tenantCtx.tenantLogoUrl} partner={p} size={22} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 14 }}>{p.name}</strong>
                  <StatusChip status={p.effectiveStatus || p.status} />
                  <span className="status-chip neutral">{t(`partnerships.kind.${p.kind}`)}</span>
                </div>
                <div style={{ fontSize: 12, opacity: 0.75, display: 'grid', gap: 2 }}>
                  <span>{pricing} · {p.code}</span>
                  <span>{t(`partnerships.mode.${p.vehicleMode}`)}{p.validTo ? ` · ${dateShort(p.validTo)}` : ''}</span>
                </div>
                <code style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: p.status === 'DRAFT' ? 0.6 : 1 }}>
                  {p.status === 'DRAFT' ? t('partnerships.urlOnPublish') : p.hostedUrl.replace(/^https?:\/\//, '')}
                </code>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
                  <span>{p.status === 'DRAFT'
                    ? (p.readiness?.missing?.length ? t('partnerships.missingShort', { items: p.readiness.missing.map((k) => t(`partnerships.missing.${k}`, { defaultValue: k })).join(', ') }) : t('partnerships.stepsOf', { done, total }))
                    : <><strong>{p.bookings30d}</strong> {t('partnerships.bookings30d')}</>}</span>
                  <span className="button-subtle" style={{ padding: '4px 10px', fontSize: 12 }}>{p.status === 'DRAFT' ? t('partnerships.continue') : t('partnerships.open')}</span>
                </div>
              </Link>
            );
          })}
          {/* button-subtle supplies the text colour + a sane hover; .glass/.card alone inherit the global button rule (white text, purple hover). */}
          <button className="glass card button-subtle" onClick={() => setCreating(true)} style={{ minHeight: 150, border: '1.5px dashed var(--border-brand)', background: 'transparent', fontWeight: 700 }}>
            {t('partnerships.newPartner')}
          </button>
        </div>
      )}

      {creating ? (
        <CreateDialog
          onClose={() => setCreating(false)}
          busy={busy}
          onCreate={async (payload) => {
            setBusy(true);
            try {
              const created = await api(`/api/partnerships${qs}`, { method: 'POST', body: JSON.stringify(payload) }, token);
              setCreating(false);
              router.push(`/partnerships/${created.id}${qs}`);
            } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
          }}
        />
      ) : null}

      {domainOpen && settings ? (
        <DomainDialog
          settings={settings}
          busy={busy}
          onClose={() => setDomainOpen(false)}
          onSave={async (partnerHostedBaseUrl) => {
            setBusy(true);
            try {
              const out = await api(`/api/partnerships/settings${qs}`, { method: 'PUT', body: JSON.stringify({ partnerHostedBaseUrl }) }, token);
              setSettings(out); setDomainOpen(false); setMsg(t('partnerships.saved')); await reload();
            } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
          }}
        />
      ) : null}
    </AppShell>
  );
}

function CreateDialog({ onClose, onCreate, busy }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('INSURANCE');
  const [code, setCode] = useState('');
  return (
    <Dialog titleId="partner-create-title" onClose={onClose} busy={busy} wide>
        <h3 id="partner-create-title">{t('partnerships.createTitle')}</h3>
        <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.createName')} *
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required aria-required="true" />
        </label>
        <div className="form-grid-2">
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.createKind')}
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {['INSURANCE', 'CORPORATE', 'COOPERATIVE', 'HOTEL', 'OTHER'].map((k) => <option key={k} value={k}>{t(`partnerships.kind.${k}`)}</option>)}
            </select>
          </label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.createCode')}
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ISLA26" maxLength={16} />
            <span style={{ fontSize: 11, textTransform: 'none', letterSpacing: 0 }}>{t('partnerships.createCodeHelp')}</span>
          </label>
        </div>
        <div className="row">
          <button className="button-subtle" onClick={onClose} disabled={busy}>{t('partnerships.cancel')}</button>
          <button onClick={() => onCreate({ name, kind, code: code || undefined })} disabled={busy || !name.trim()}>{t('partnerships.create')}</button>
        </div>
    </Dialog>
  );
}

function DomainDialog({ settings, onClose, onSave, busy }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(settings.partnerHostedBaseUrl || '');
  return (
    <Dialog titleId="partner-domain-title" onClose={onClose} busy={busy} wide>
        <h3 id="partner-domain-title">{t('partnerships.domainTitle')}</h3>
        <p style={{ fontSize: 13, opacity: 0.85 }}>{t('partnerships.domainHelp')}</p>
        <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.domainField')}
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://partners.rentandgopr.com" />
        </label>
        <div className="surface-note" style={{ fontSize: 12.5 }}>{t('partnerships.domainFallback', { url: settings.fallbackBaseUrl })}</div>
        <div className="row">
          <button className="button-subtle" onClick={onClose} disabled={busy}>{t('partnerships.cancel')}</button>
          <button onClick={() => onSave(value.trim() || null)} disabled={busy}>{t('partnerships.save')}</button>
        </div>
    </Dialog>
  );
}
