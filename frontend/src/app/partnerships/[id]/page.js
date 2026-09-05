'use client';

/**
 * Partnerships — partner editor (2026-09-05, Hector-approved mockup v2.1
 * doc/partnerships-module-mockups-2026-09-05.html §B).
 *
 * Six tabs (Profile · Terms · Pricing · Vehicles · Services · Hosted page); the
 * program STATUS lives in the header only (chip + one Publish/Pause action with a
 * confirm). Readiness pills link to the tab that still needs work. Theme-aware:
 * globals.css classes only; the QR canvas is the one deliberately white surface
 * (scanners need dark modules on light).
 *
 * Vehicles tab = Hector's "show inventory" switch: ON → classes with photo and
 * program price; OFF + insurer → the customer picks a preferred TYPE and accepts
 * the coverage disclosure (no number, no online payment by default); OFF + other
 * kinds → assign at pickup with a default class.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { Dialog, PartnerLogo, StatusChip, tenantQuerySuffix, useTenantContext } from '../_shared';

export default function PartnerEditorPage() {
  return <AuthGate>{({ token, me, logout }) => <Editor token={token} me={me} logout={logout} />}</AuthGate>;
}

const TABS = ['profile', 'terms', 'pricing', 'vehicles', 'services', 'hosted'];
const KINDS = ['INSURANCE', 'CORPORATE', 'COOPERATIVE', 'HOTEL', 'OTHER'];
const money = (v) => (v === null || v === undefined ? '—' : `$${Number(v).toFixed(2)}`);
const toDateInput = (v) => (v ? String(v).slice(0, 10) : '');
const dt = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
// Reservation status enum → the app's global `status.*` i18n keys (checkedOut, noShow…).
const statusKey = (s) => String(s || '').toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function Editor({ token, me, logout }) {
  const { t } = useTranslation();
  const params = useParams();
  const id = String(params?.id || '');
  const tenantCtx = useTenantContext(me, token);
  const qs = tenantQuerySuffix(tenantCtx.activeTenantId, tenantCtx.isSuperAdmin);
  // Memoized: PricingTab/HostedTab effects depend on it — a fresh function per render
  // would refire /pricing-grid, /hosted and /reservations on every setBusy/setMsg.
  const url = useCallback((path, extra = '') => `/api/partnerships/${id}${path}${qs}${extra ? (qs ? '&' : '?') + extra : ''}`, [id, qs]);

  const [partner, setPartner] = useState(null);
  const [tab, setTab] = useState('profile');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'PAUSE' | 'PUBLISH'
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [catalog, setCatalog] = useState([]);

  const reload = useCallback(async () => {
    try {
      const row = await api(url(''), { bypassCache: true }, token);
      setPartner(row);
    } catch (e) { setMsg(String(e?.message || e)); }
  }, [url, token]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    api(`/api/vehicle-types${qs}`, {}, token).then((d) => setVehicleTypes(Array.isArray(d) ? d : (d?.items || []))).catch(() => {});
    // ?tenantId= matters for SUPER_ADMIN — without it the selectable list spans every tenant.
    api(`/api/locations/selectable${qs}`, {}, token).then((d) => setLocations(Array.isArray(d) ? d : (d?.locations || []))).catch(() => {});
    api(`/api/additional-services${qs}${qs ? '&' : '?'}activeOnly=1`, {}, token).then((d) => setCatalog(Array.isArray(d) ? d : [])).catch(() => {});
  }, [qs, token]);

  const run = async (fn, okMsg) => {
    setBusy(true); setMsg('');
    try { const out = await fn(); if (out && out.id) setPartner(out); else await reload(); if (okMsg) setMsg(okMsg); return out; }
    catch (e) { setMsg(String(e?.message || e)); return null; }
    finally { setBusy(false); }
  };
  const patch = (body, okMsg = t('partnerships.saved')) => run(() => api(url(''), { method: 'PATCH', body: JSON.stringify(body) }, token), okMsg);

  if (!partner) {
    return <AppShell me={me} logout={logout}><div className="surface-note">{msg || t('partnerships.loading')}</div></AppShell>;
  }

  const readiness = partner.readiness || { missing: [], steps: {} };
  const missingLabels = (readiness.missing || []).map((k) => t(`partnerships.missing.${k}`, { defaultValue: k })).join(', ');
  const stepToTab = { profile: 'profile', terms: 'terms', pricing: 'pricing', vehicles: 'vehicles', services: 'services', hosted: 'hosted' };

  return (
    <AppShell me={me} logout={logout}>
      <div className="page-hero">
        <div style={{ fontSize: 12.5, opacity: 0.75 }}><Link href={`/partnerships${qs}`}>{t('partnerships.title')}</Link> · {partner.name}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0 }}>{partner.name}</h1>
              <StatusChip status={partner.effectiveStatus || partner.status} />
              <span className="status-chip neutral">{t(`partnerships.kind.${partner.kind}`)}</span>
            </div>
            <div style={{ fontSize: 12.5, opacity: 0.75 }}>{partner.status === 'DRAFT' ? t('partnerships.urlOnPublish') : <code>{partner.hostedUrl}</code>}{partner.updatedAt ? <span> · {t('partnerships.lastEdited', { when: dt(partner.updatedAt) })}</span> : null}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* The hosted page itself is served by the storefront (F2) / RFM (F3); until then the link is only offered for a live program. */}
            {partner.status === 'ACTIVE' ? <button type="button" className="button-subtle" onClick={() => window.open(partner.hostedUrl, '_blank', 'noopener')}>{t('partnerships.hosted.open')}</button> : null}
            {partner.status === 'ACTIVE'
              ? <button className="button-subtle" onClick={() => setConfirm('PAUSE')} disabled={busy}>{t('partnerships.pause')}</button>
              : <button onClick={() => setConfirm('PUBLISH')} disabled={busy || !readiness.ready} title={readiness.ready ? '' : t('partnerships.readiness.missing', { items: missingLabels })}>{partner.status === 'PAUSED' ? t('partnerships.resume') : t('partnerships.publish')}</button>}
          </div>
        </div>
        <div className="hero-meta">
          {Object.entries(readiness.steps || {}).map(([step, done]) => (
            <button key={step} type="button" className={`hero-pill ${done ? '' : 'hero-pill-warn'}`} onClick={() => setTab(stepToTab[step] || 'profile')}>
              {done ? '✓' : '•'} {t(`partnerships.readiness.${step}`)}{pillDetail(step, partner, t)}
            </button>
          ))}
        </div>
        {!readiness.ready ? <div className="surface-note" style={{ fontSize: 12.5 }}>{t('partnerships.readiness.missing', { items: missingLabels })}</div> : null}
      </div>

      {msg ? <div className="surface-note" style={{ margin: '10px 0' }}>{msg}</div> : null}

      <div role="tablist" style={{ display: 'flex', gap: 8, margin: '4px 0 14px', flexWrap: 'wrap' }}>
        {TABS.map((key) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? '' : 'button-subtle'} onClick={() => setTab(key)}>{t(`partnerships.tabs.${key}`)}</button>
        ))}
      </div>

      {tab === 'profile' ? <ProfileTab partner={partner} locations={locations} tenantLogoUrl={tenantCtx.tenantLogoUrl} busy={busy} onSave={patch} onLogo={(dataUrl) => run(() => api(url('/logo'), { method: 'POST', body: JSON.stringify({ dataUrl }) }, token).then(() => null), t('partnerships.saved'))} /> : null}
      {tab === 'terms' ? <TermsTab partner={partner} busy={busy} onSave={patch} /> : null}
      {tab === 'pricing' ? <PricingTab partner={partner} locations={locations} busy={busy} token={token} url={url} run={run} onSave={patch} /> : null}
      {tab === 'vehicles' ? <VehiclesTab partner={partner} vehicleTypes={vehicleTypes} busy={busy} onSave={patch} goPricing={() => setTab('pricing')} /> : null}
      {tab === 'services' ? <ServicesTab partner={partner} catalog={catalog} busy={busy} token={token} url={url} run={run} /> : null}
      {tab === 'hosted' ? <HostedTab partner={partner} token={token} url={url} /> : null}

      {confirm ? (
        <Dialog titleId="partner-status-title" onClose={() => setConfirm(null)} busy={busy}>
          <h3 id="partner-status-title">{confirm === 'PAUSE' ? t('partnerships.confirmPauseTitle', { name: partner.name }) : t('partnerships.publish')}</h3>
          <p>{confirm === 'PAUSE' ? t('partnerships.confirmPauseBody') : t('partnerships.confirmPublishBody', { name: partner.name })}</p>
          <div className="row">
            <button type="button" className="button-subtle" onClick={() => setConfirm(null)} disabled={busy}>{t('partnerships.cancel')}</button>
            <button type="button" disabled={busy} onClick={async () => {
              const status = confirm === 'PAUSE' ? 'PAUSED' : 'ACTIVE';
              setConfirm(null);
              await run(() => api(url('/status'), { method: 'POST', body: JSON.stringify({ status }) }, token), t('partnerships.saved'));
            }}>{confirm === 'PAUSE' ? t('partnerships.pause') : t('partnerships.publish')}</button>
          </div>
        </Dialog>
      ) : null}
    </AppShell>
  );
}

// ------------------------------------------------------------------ Profile
function ProfileTab({ partner, locations, tenantLogoUrl, busy, onSave, onLogo }) {
  const { t } = useTranslation();
  const locked = partner.status !== 'DRAFT';
  const [f, setF] = useState(() => ({
    name: partner.name || '', kind: partner.kind || 'OTHER', code: partner.code || '', slug: partner.slug || '',
    validFrom: toDateInput(partner.validFrom), validTo: toDateInput(partner.validTo),
    contactName: partner.contactName || '', contactEmail: partner.contactEmail || '', contactPhone: partner.contactPhone || '',
    locationIds: Array.isArray(partner.locationIds) ? partner.locationIds : [],
    showTenantContact: partner.showTenantContact !== false, showTenantTerms: partner.showTenantTerms !== false
  }));
  const fileRef = useRef(null);
  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));

  const save = () => onSave({
    name: f.name, kind: f.kind, ...(locked ? {} : { code: f.code, slug: f.slug }),
    validFrom: f.validFrom || null, validTo: f.validTo || null,
    contactName: f.contactName, contactEmail: f.contactEmail, contactPhone: f.contactPhone,
    locationIds: f.locationIds.length ? f.locationIds : null,
    showTenantContact: f.showTenantContact, showTenantTerms: f.showTenantTerms
  });

  const onFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onLogo(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  return (
    <div className="section-card">
      <div className="glass card" style={{ display: 'grid', gap: 14 }}>
        <div className="form-grid-2">
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.profile.name')}<input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.profile.kind')}
            <select value={f.kind} onChange={(e) => set('kind', e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{t(`partnerships.kind.${k}`)}</option>)}</select>
          </label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.profile.code')}<input value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} disabled={locked} maxLength={16} /><Help>{t('partnerships.profile.codeHelp')}</Help></label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.profile.slug')}<input value={f.slug} onChange={(e) => set('slug', e.target.value)} disabled={locked} /><Help>{t('partnerships.profile.slugHelp')}</Help></label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.profile.validFrom')}<input type="date" value={f.validFrom} onChange={(e) => set('validFrom', e.target.value)} /></label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.profile.validTo')}<input type="date" value={f.validTo} onChange={(e) => set('validTo', e.target.value)} /><Help>{t('partnerships.profile.validHelp')}</Help></label>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>{t('partnerships.profile.locations')}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}><input type="checkbox" checked={f.locationIds.length === 0} onChange={() => set('locationIds', [])} /> {t('partnerships.profile.allLocations')}</label>
            {locations.map((l) => (
              <label key={l.id} className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <input type="checkbox" checked={f.locationIds.includes(l.id)} onChange={(e) => set('locationIds', e.target.checked ? [...f.locationIds, l.id] : f.locationIds.filter((x) => x !== l.id))} /> {l.name}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="glass card" style={{ display: 'grid', gap: 10 }}>
        <h3>{t('partnerships.profile.logo')}</h3>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <PartnerLogo tenantLogoUrl={tenantLogoUrl} partner={partner} size={30} />
          <div style={{ fontSize: 12.5, opacity: 0.85, maxWidth: 520 }}>{t('partnerships.profile.logoHelp')}</div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          <button className="button-subtle" onClick={() => fileRef.current?.click()} disabled={busy}>{partner.logoUrl ? t('partnerships.profile.replace') : t('partnerships.profile.upload')}</button>
        </div>
      </div>

      <div className="form-grid-2">
        <div className="glass card" style={{ display: 'grid', gap: 10 }}>
          <h3>{t('partnerships.profile.contact')}</h3>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.profile.contactName')}<input value={f.contactName} onChange={(e) => set('contactName', e.target.value)} /></label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.profile.contactEmail')}<input type="email" value={f.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} /></label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.profile.contactPhone')}<input value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} /></label>
        </div>
        <div className="glass card" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <h3>{t('partnerships.profile.customerSees')}</h3>
          <Switch checked={f.showTenantContact} onChange={(v) => set('showTenantContact', v)} label={t('partnerships.profile.showContact')} />
          <Switch checked={f.showTenantTerms} onChange={(v) => set('showTenantTerms', v)} label={t('partnerships.profile.showTerms')} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={save} disabled={busy}>{t('partnerships.save')}</button></div>
    </div>
  );
}

// -------------------------------------------------------------------- Terms
function TermsTab({ partner, busy, onSave }) {
  const { t } = useTranslation();
  const [terms, setTerms] = useState(() => ({ es: partner.termsJson?.es || '', en: partner.termsJson?.en || '' }));
  const [landing, setLanding] = useState(() => {
    const base = { eyebrow: '', heroTitle: '', heroSubtitle: '', partnerNote: '', ctaLabel: '', benefits: [] };
    return { es: { ...base, ...(partner.landingJson?.es || {}) }, en: { ...base, ...(partner.landingJson?.en || {}) } };
  });
  const [lang, setLang] = useState('es');
  const L = landing[lang];
  const setL = (k, v) => setLanding((prev) => ({ ...prev, [lang]: { ...prev[lang], [k]: v } }));
  const setBenefit = (i, k, v) => setL('benefits', L.benefits.map((b, idx) => (idx === i ? { ...b, [k]: v } : b)));

  return (
    <div className="section-card">
      <div className="glass card" style={{ display: 'grid', gap: 10 }}>
        <h3>{t('partnerships.terms.title')}</h3>
        <div style={{ fontSize: 12.5, opacity: 0.85 }}>{t('partnerships.terms.help')}</div>
        <div className="form-grid-2">
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.terms.es')}<textarea rows={12} value={terms.es} onChange={(e) => setTerms({ ...terms, es: e.target.value })} /></label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.terms.en')}<textarea rows={12} value={terms.en} onChange={(e) => setTerms({ ...terms, en: e.target.value })} />
            {!terms.en.trim() ? <Help warn>{t('partnerships.terms.enEmpty')}</Help> : null}</label>
        </div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>{t('partnerships.terms.version', { n: partner.termsVersion })}</div>
      </div>

      <div className="glass card" style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h3>{t('partnerships.terms.landing')}</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            {['es', 'en'].map((l) => <button key={l} className={lang === l ? '' : 'button-subtle'} onClick={() => setLang(l)}>{l.toUpperCase()}</button>)}
          </div>
        </div>
        <div className="form-grid-2">
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.terms.eyebrow')}<input value={L.eyebrow} onChange={(e) => setL('eyebrow', e.target.value)} /></label>
          <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.terms.ctaLabel')}<input value={L.ctaLabel} onChange={(e) => setL('ctaLabel', e.target.value)} /></label>
        </div>
        <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.terms.heroTitle')}<input value={L.heroTitle} onChange={(e) => setL('heroTitle', e.target.value)} /></label>
        <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.terms.heroSubtitle')}<textarea rows={2} value={L.heroSubtitle} onChange={(e) => setL('heroSubtitle', e.target.value)} /></label>
        <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.terms.partnerNote')}<input value={L.partnerNote} onChange={(e) => setL('partnerNote', e.target.value)} /></label>
        <div className="label">{t('partnerships.terms.benefits')}</div>
        {L.benefits.map((b, i) => (
          <div key={i} className="form-grid-2" style={{ alignItems: 'end' }}>
            <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.terms.benefitTitle')}<input value={b.title || ''} onChange={(e) => setBenefit(i, 'title', e.target.value)} /></label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
              <label className="label" style={{ display: 'grid', gap: 4, flex: 1 }}>{t('partnerships.terms.benefitBody')}<input value={b.body || ''} onChange={(e) => setBenefit(i, 'body', e.target.value)} /></label>
              <button className="button-subtle" onClick={() => setL('benefits', L.benefits.filter((_, idx) => idx !== i))}>{t('partnerships.terms.remove')}</button>
            </div>
          </div>
        ))}
        {L.benefits.length < 6 ? <div><button className="button-subtle" onClick={() => setL('benefits', [...L.benefits, { icon: 'check', title: '', body: '' }])}>{t('partnerships.terms.addBenefit')}</button></div> : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button disabled={busy} onClick={() => onSave({ termsJson: terms, landingJson: landing })}>{t('partnerships.save')}</button></div>
    </div>
  );
}

// ------------------------------------------------------------------ Pricing
function PricingTab({ partner, locations, busy, token, url, run, onSave }) {
  const { t } = useTranslation();
  const [locationId, setLocationId] = useState(() => (Array.isArray(partner.locationIds) && partner.locationIds[0]) || locations[0]?.id || '');
  const [grid, setGrid] = useState(null);
  const [rows, setRows] = useState([]);
  const [discount, setDiscount] = useState(partner.discountPct ?? '');
  const mode = partner.rateId ? 'RATE' : 'DISCOUNT';

  const loadGrid = useCallback(async () => {
    try {
      const g = await api(url('/pricing-grid', locationId ? `locationId=${encodeURIComponent(locationId)}` : ''), { bypassCache: true }, token);
      setGrid(g); setRows((g?.rows || []).map((r) => ({ ...r, daily: r.daily ?? '', weekly: r.weekly ?? '', monthly: r.monthly ?? '' })));
    } catch (e) { setGrid({ rows: [] }); }
  }, [locationId, token, url]);
  useEffect(() => { loadGrid(); }, [loadGrid, partner.rateId]);

  const setCell = (vehicleTypeId, k, v) => setRows((prev) => prev.map((r) => (r.vehicleTypeId === vehicleTypeId ? { ...r, [k]: v } : r)));
  const delta = (r) => {
    const on = Number(r.onlineDaily), pt = Number(r.daily);
    if (!on || !pt) return null;
    return Math.round(((pt - on) / on) * 100);
  };

  return (
    <div className="section-card">
      <div className="form-grid-2">
        <button type="button" className="glass card button-subtle" style={{ textAlign: 'left', border: mode === 'RATE' ? '1.5px solid var(--border-brand)' : undefined }} aria-pressed={mode === 'RATE'} onClick={() => { if (mode !== 'RATE') run(() => api(url('/rate'), { method: 'POST', body: JSON.stringify({ copyFromLocationId: locationId || null }) }, token), t('partnerships.saved')); }} disabled={busy}>
          <strong>{t('partnerships.pricing.modeRate')}</strong>
          <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 4 }}>{t('partnerships.pricing.modeRateHelp')}</div>
        </button>
        <div className="glass card" style={{ border: mode === 'DISCOUNT' ? '1.5px solid var(--border-brand)' : undefined, display: 'grid', gap: 8 }}>
          <strong>{t('partnerships.pricing.modeDiscount')}</strong>
          <div style={{ fontSize: 12.5, opacity: 0.8 }}>{t('partnerships.pricing.modeDiscountHelp')}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
            <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.pricing.discountPct')}<input type="number" min={1} max={99} step={0.5} value={discount} onChange={(e) => setDiscount(e.target.value)} style={{ width: 110 }} /></label>
            {mode === 'RATE'
              ? <button className="button-subtle" disabled={busy} onClick={async () => { const out = await run(() => api(url('/rate'), { method: 'DELETE' }, token)); if (out && discount) onSave({ discountPct: Number(discount) }); }}>{t('partnerships.pricing.detach')}</button>
              : <button disabled={busy || !discount} onClick={() => onSave({ discountPct: Number(discount) })}>{t('partnerships.save')}</button>}
          </div>
        </div>
      </div>

      {mode === 'RATE' ? (
        <div className="glass card" style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3>{t('partnerships.pricing.gridTitle')}</h3>
            <label className="label" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{t('partnerships.pricing.location')}
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
            </label>
          </div>
          {grid === null ? <div className="surface-note" style={{ fontSize: 12.5 }}>{t('partnerships.pricing.loadingGrid')}</div> : null}
          {grid && !grid.onlineRate ? <div className="surface-note" style={{ fontSize: 12.5 }}>{t('partnerships.pricing.noOnline')}</div> : null}
          <div className="table-shell">
            <table>
              <thead><tr><th>{t('partnerships.pricing.colClass')}</th><th style={{ textAlign: 'right' }}>{t('partnerships.pricing.colOnline')}</th><th style={{ textAlign: 'right' }}>{t('partnerships.pricing.colDaily')}</th><th style={{ textAlign: 'right' }}>{t('partnerships.pricing.colWeekly')}</th><th style={{ textAlign: 'right' }}>{t('partnerships.pricing.colMonthly')}</th><th>{t('partnerships.pricing.colDelta')}</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const d = delta(r);
                  const off = !Number(r.daily);
                  return (
                    <tr key={r.vehicleTypeId} style={{ opacity: off ? 0.6 : 1 }}>
                      <td><strong>{r.code}</strong> · {r.name}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(r.onlineDaily)}</td>
                      {['daily', 'weekly', 'monthly'].map((k) => (
                        <td key={k} style={{ textAlign: 'right' }}><input type="number" min={0} step={0.01} value={r[k]} placeholder={k === 'daily' ? t('partnerships.pricing.noPrice') : ''} onChange={(e) => setCell(r.vehicleTypeId, k, e.target.value)} style={{ width: 96, textAlign: 'right' }} aria-label={`${r.code} · ${t(`partnerships.pricing.col${k[0].toUpperCase()}${k.slice(1)}`)}`} /></td>
                      ))}
                      <td style={{ fontSize: 12 }}>{off ? <span style={{ opacity: 0.7 }}>{t('partnerships.pricing.hidden')}</span> : d === null ? '—' : <span className={d <= 0 ? 'status-chip good' : 'status-chip warn'}>{d > 0 ? '+' : ''}{d}%</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="surface-note" style={{ fontSize: 12.5 }}>{t('partnerships.pricing.failClosed')}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="button-subtle" onClick={() => window.open('/rates', '_blank', 'noopener')}>{t('partnerships.pricing.openInRates')}</button>
            <button disabled={busy} onClick={() => run(() => api(url('/rate/items'), { method: 'PUT', body: JSON.stringify({ items: rows.map((r) => ({ vehicleTypeId: r.vehicleTypeId, daily: Number(r.daily || 0), weekly: Number(r.weekly || 0), monthly: Number(r.monthly || 0) })) }) }, token), t('partnerships.saved')).then(loadGrid)}>{t('partnerships.pricing.saveGrid')}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------- Vehicles
function VehiclesTab({ partner, vehicleTypes, busy, onSave, goPricing }) {
  const { t } = useTranslation();
  const isInsurer = partner.kind === 'INSURANCE';
  const [showInventory, setShowInventory] = useState(partner.vehicleMode === 'SHOW_INVENTORY');
  const [allowed, setAllowed] = useState(Array.isArray(partner.allowedVehicleTypeIds) ? partner.allowedVehicleTypeIds : []);
  const [defaultType, setDefaultType] = useState(partner.defaultVehicleTypeId || '');
  const [disclosure, setDisclosure] = useState(() => ({ es: partner.coverageDisclosureJson?.es || '', en: partner.coverageDisclosureJson?.en || '' }));
  const [pricingShown, setPricingShown] = useState(partner.preferredTypePricing || 'CONFIRM_AT_PICKUP');
  const [askPolicy, setAskPolicy] = useState(!!partner.askPolicyNumber);
  const pricedIds = useMemo(() => new Set((partner.rate?.items || []).filter((it) => Number(it.daily) > 0).map((it) => it.vehicleTypeId)), [partner.rate]);
  const mode = showInventory ? 'SHOW_INVENTORY' : (isInsurer ? 'PREFERRED_TYPE' : 'ASSIGN_AT_PICKUP');
  const toggle = (id) => setAllowed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = () => onSave({
    vehicleMode: mode,
    allowedVehicleTypeIds: allowed.length ? allowed : null,
    defaultVehicleTypeId: mode === 'ASSIGN_AT_PICKUP' ? (defaultType || null) : partner.defaultVehicleTypeId || null,
    ...(mode === 'PREFERRED_TYPE' ? { coverageDisclosureJson: disclosure, preferredTypePricing: pricingShown, askPolicyNumber: askPolicy } : {})
  });

  return (
    <div className="section-card">
      <div className="glass card" style={{ display: 'grid', gap: 8 }}>
        <Switch checked={showInventory} onChange={setShowInventory} label={t('partnerships.vehicles.switch')} big />
        <div style={{ fontSize: 12.5, opacity: 0.8, paddingLeft: 46 }}>{showInventory ? t('partnerships.vehicles.switchOn') : t('partnerships.vehicles.switchOff')}</div>
        {showInventory ? (
          <div style={{ paddingLeft: 46, display: 'grid', gap: 6 }}>
            <div className="label">{t('partnerships.vehicles.allowedTypesShow')}</div>
            <TypeChecklist vehicleTypes={vehicleTypes} selected={allowed} onToggle={toggle} pricedIds={pricedIds} showPriced />
            {partner.rateId && pricedIds.size === 0 ? <div className="surface-note" style={{ fontSize: 12.5 }}>{t('partnerships.vehicles.noPriced')} <button className="button-subtle" onClick={goPricing}>{t('partnerships.tabs.pricing')}</button></div> : <Help>{t('partnerships.vehicles.typesFailClosed')}</Help>}
          </div>
        ) : null}
      </div>

      {!showInventory ? (
        <div className="glass card" style={{ display: 'grid', gap: 12 }}>
          <h3>{isInsurer ? t('partnerships.vehicles.offInsurer') : t('partnerships.vehicles.offOther')}</h3>
          {isInsurer ? (
            <>
              <div className="form-grid-2">
                <div className="surface-note" style={{ borderColor: 'var(--border-brand)' }}><strong>{t('partnerships.vehicles.preferredTitle')}</strong><div style={{ fontSize: 12.5, opacity: 0.85 }}>{t('partnerships.vehicles.preferredHelp')}</div></div>
                <div className="surface-note" style={{ opacity: 0.55 }} aria-disabled="true"><strong>{t('partnerships.vehicles.assignTitle')}</strong><div style={{ fontSize: 12.5 }}>{t('partnerships.vehicles.assignInsurerHelp')}</div></div>
              </div>
              <div className="label">{t('partnerships.vehicles.allowedTypes')}</div>
              <TypeChecklist vehicleTypes={vehicleTypes} selected={allowed} onToggle={toggle} pricedIds={pricedIds} />
              <div className="form-grid-2">
                <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.vehicles.disclosure')}<textarea rows={5} value={disclosure.es} onChange={(e) => setDisclosure({ ...disclosure, es: e.target.value })} /></label>
                <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.vehicles.disclosureEn')}<textarea rows={5} value={disclosure.en} onChange={(e) => setDisclosure({ ...disclosure, en: e.target.value })} /></label>
              </div>
              <Help>{t('partnerships.vehicles.disclosureHelp')}</Help>
              <div className="form-grid-2">
                <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.vehicles.pricingShown')}
                  <select value={pricingShown} onChange={(e) => setPricingShown(e.target.value)}>
                    <option value="CONFIRM_AT_PICKUP">{t('partnerships.vehicles.pricingConfirm')}</option>
                    <option value="TYPE_PRICE">{t('partnerships.vehicles.pricingType')}</option>
                  </select>
                </label>
                <div style={{ alignSelf: 'end' }}><Switch checked={askPolicy} onChange={setAskPolicy} label={t('partnerships.vehicles.askPolicy')} /></div>
              </div>
            </>
          ) : (
            <>
              <div><strong>{t('partnerships.vehicles.assignTitle')}</strong><div style={{ fontSize: 12.5, opacity: 0.8 }}>{t('partnerships.vehicles.assignHelp')}</div></div>
              <label className="label" style={{ display: 'grid', gap: 4, maxWidth: 360 }}>{t('partnerships.vehicles.defaultType')} *
                <select value={defaultType} onChange={(e) => setDefaultType(e.target.value)} className={!defaultType ? 'error' : ''} aria-invalid={!defaultType} aria-required="true">
                  <option value="">—</option>
                  {vehicleTypes.map((vt) => <option key={vt.id} value={vt.id}>{vt.code} · {vt.name}</option>)}
                </select>
                <Help warn={!defaultType}>{t('partnerships.vehicles.defaultTypeHelp')}</Help>
              </label>
            </>
          )}
        </div>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={save} disabled={busy}>{t('partnerships.save')}</button></div>
    </div>
  );
}

function TypeChecklist({ vehicleTypes, selected, onToggle, pricedIds, showPriced = false }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {vehicleTypes.map((vt) => {
        const priced = pricedIds.has(vt.id);
        return (
          <label key={vt.id} className="label" style={{ textTransform: 'none', letterSpacing: 0, display: 'inline-flex', gap: 6, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 10, padding: '6px 10px', opacity: showPriced && !priced ? 0.55 : 1 }}>
            <input type="checkbox" checked={selected.includes(vt.id)} onChange={() => onToggle(vt.id)} /> {vt.code} · {vt.name}{showPriced && !priced ? ' ·' : ''}{showPriced && !priced ? <span style={{ fontSize: 11 }}>$—</span> : null}
          </label>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- Services
function ServicesTab({ partner, catalog, busy, token, url, run }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState(() => {
    const byId = new Map((partner.services || []).map((s) => [s.additionalServiceId, s]));
    const company = catalog.map((svc) => {
      const row = byId.get(svc.id);
      return { additionalServiceId: svc.id, name: svc.name, listRate: svc.rate, chargeType: svc.chargeType, partnerOnly: false, on: !!row, rateOverride: row?.rateOverride ?? '', mandatory: !!row?.mandatory };
    });
    const custom = (partner.services || []).filter((s) => s.service?.partnerOnly).map((s) => ({ additionalServiceId: s.additionalServiceId, name: s.service.name, listRate: s.service.rate, chargeType: s.service.chargeType, partnerOnly: true, on: true, rateOverride: s.rateOverride ?? '', mandatory: !!s.mandatory }));
    return [...company, ...custom];
  });
  const [custom, setCustom] = useState({ name: '', rate: '', chargeType: 'UNIT', taxable: false, mandatory: false, open: false });
  const set = (id, k, v) => setRows((prev) => prev.map((r) => (r.additionalServiceId === id ? { ...r, [k]: v } : r)));

  useEffect(() => {
    // Catalog arrives after the partner: merge company rows in without losing edits.
    setRows((prev) => {
      const known = new Set(prev.map((r) => r.additionalServiceId));
      const byId = new Map((partner.services || []).map((s) => [s.additionalServiceId, s]));
      const add = catalog.filter((svc) => !known.has(svc.id)).map((svc) => { const row = byId.get(svc.id); return { additionalServiceId: svc.id, name: svc.name, listRate: svc.rate, chargeType: svc.chargeType, partnerOnly: false, on: !!row, rateOverride: row?.rateOverride ?? '', mandatory: !!row?.mandatory }; });
      return add.length ? [...prev, ...add] : prev;
    });
  }, [catalog, partner.services]);

  const save = () => run(() => api(url('/services'), { method: 'PUT', body: JSON.stringify({ services: rows.filter((r) => r.on).map((r, idx) => ({ additionalServiceId: r.additionalServiceId, rateOverride: r.rateOverride === '' ? null : Number(r.rateOverride), mandatory: !!r.mandatory, sortOrder: idx })) }) }, token), t('partnerships.saved'));

  return (
    <div className="section-card">
      <div className="glass card" style={{ display: 'grid', gap: 10 }}>
        <h3>{t('partnerships.services.title')}</h3>
        <div style={{ fontSize: 12.5, opacity: 0.85 }}>{t('partnerships.services.help')}</div>
        <div className="table-shell">
          <table>
            <thead><tr><th></th><th>{t('partnerships.services.colService')}</th><th style={{ textAlign: 'right' }}>{t('partnerships.services.colList')}</th><th style={{ textAlign: 'right' }}>{t('partnerships.services.colProgram')}</th><th>{t('partnerships.services.colMandatory')}</th><th>{t('partnerships.services.colOrigin')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.additionalServiceId} style={{ opacity: r.on ? 1 : 0.55 }}>
                  <td><input type="checkbox" checked={r.on} onChange={(e) => set(r.additionalServiceId, 'on', e.target.checked)} aria-label={r.name} /></td>
                  <td>{r.name}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(r.listRate)}{r.chargeType === 'PER_DAY' ? ` ${t('partnerships.services.perDayShort')}` : ''}</td>
                  <td style={{ textAlign: 'right' }}><input type="number" min={0} step={0.01} value={r.rateOverride} placeholder={t('partnerships.services.normal')} disabled={!r.on} onChange={(e) => set(r.additionalServiceId, 'rateOverride', e.target.value)} style={{ width: 96, textAlign: 'right' }} aria-label={`${r.name} · ${t('partnerships.services.colProgram')}`} /></td>
                  <td><label style={{ display: 'inline-flex', padding: 8, cursor: 'pointer' }}><input type="checkbox" checked={r.mandatory} disabled={!r.on} onChange={(e) => set(r.additionalServiceId, 'mandatory', e.target.checked)} aria-label={`${r.name} · ${t('partnerships.services.colMandatory')}`} /></label></td>
                  <td style={{ fontSize: 12 }}>{r.partnerOnly ? <span className="status-chip">{t('partnerships.services.partnerOnly')}</span> : <span style={{ opacity: 0.7 }}>{t('partnerships.services.company')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <button className="button-subtle" onClick={() => setCustom({ ...custom, open: !custom.open })}>{t('partnerships.services.addCustom')}</button>
          <button onClick={save} disabled={busy}>{t('partnerships.services.saveServices')}</button>
        </div>
        {custom.open ? (
          <div className="form-grid-2" style={{ alignItems: 'end', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.services.customName')}<input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
              <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.services.customRate')}<input type="number" min={0} step={0.01} value={custom.rate} onChange={(e) => setCustom({ ...custom, rate: e.target.value })} style={{ width: 100 }} /></label>
              <label className="label" style={{ display: 'grid', gap: 4 }}>{t('partnerships.services.customType')}
                <select value={custom.chargeType} onChange={(e) => setCustom({ ...custom, chargeType: e.target.value })}><option value="UNIT">{t('partnerships.services.unit')}</option><option value="PER_DAY">{t('partnerships.services.perDay')}</option></select>
              </label>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}><input type="checkbox" checked={custom.taxable} onChange={(e) => setCustom({ ...custom, taxable: e.target.checked })} /> {t('partnerships.services.customTaxable')}</label>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}><input type="checkbox" checked={custom.mandatory} onChange={(e) => setCustom({ ...custom, mandatory: e.target.checked })} /> {t('partnerships.services.customMandatory')}</label>
              <button disabled={busy || !custom.name.trim()} onClick={async () => {
                const out = await run(() => api(url('/services/custom'), { method: 'POST', body: JSON.stringify({ name: custom.name, rate: Number(custom.rate || 0), chargeType: custom.chargeType, taxable: custom.taxable, mandatory: custom.mandatory }) }, token), t('partnerships.saved'));
                if (out) {
                  setCustom({ name: '', rate: '', chargeType: 'UNIT', taxable: false, mandatory: false, open: false });
                  setRows((prev) => {
                    const fresh = (out.services || []).filter((s) => s.service?.partnerOnly && !prev.some((r) => r.additionalServiceId === s.additionalServiceId));
                    return [...prev, ...fresh.map((s) => ({ additionalServiceId: s.additionalServiceId, name: s.service.name, listRate: s.service.rate, chargeType: s.service.chargeType, partnerOnly: true, on: true, rateOverride: s.rateOverride ?? '', mandatory: !!s.mandatory }))];
                  });
                }
              }}>{t('partnerships.create')}</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Hosted
function HostedTab({ partner, token, url }) {
  const { t } = useTranslation();
  const [hosted, setHosted] = useState(null);
  const [reservations, setReservations] = useState(null);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    api(url('/hosted'), { bypassCache: true }, token).then(setHosted).catch(() => setHosted(null));
    api(url('/reservations'), { bypassCache: true }, token).then((d) => setReservations(Array.isArray(d) ? d : [])).catch(() => setReservations([]));
  }, [token, url, partner.status]);

  useEffect(() => {
    if (!hosted?.published || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, hosted.qrUrl, { width: 220, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#211a38', light: '#ffffff' } }).catch(() => {});
  }, [hosted]);

  const download = async (format) => {
    if (!hosted?.published) return;
    const name = `qr-${partner.slug}`;
    if (format === 'svg') {
      const svg = await QRCode.toString(hosted.qrUrl, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}.svg`; a.click(); URL.revokeObjectURL(a.href);
      return;
    }
    const dataUrl = await QRCode.toDataURL(hosted.qrUrl, { width: 1024, margin: 4, errorCorrectionLevel: 'M' });
    const a = document.createElement('a'); a.href = dataUrl; a.download = `${name}.png`; a.click();
  };

  return (
    <div className="section-card">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="glass card" style={{ display: 'grid', gap: 8 }}>
            <div className="label">{t('partnerships.hosted.url')}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{hosted?.url || partner.hostedUrl}</code>
              <button className="button-subtle" onClick={() => { navigator.clipboard?.writeText(hosted?.url || partner.hostedUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? t('partnerships.hosted.copied') : t('partnerships.hosted.copy')}</button>
            </div>
            <Help>{t('partnerships.hosted.urlHelp')}</Help>
          </div>
          <div className="glass card" style={{ display: 'grid', gap: 8 }}>
            <h3>{t('partnerships.hosted.statusTitle')}</h3>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
              <StatusChip status={hosted?.effectiveStatus || partner.effectiveStatus || partner.status} />
              <span style={{ opacity: 0.8 }}>{t('partnerships.hosted.languages')}</span>
              <span style={{ opacity: 0.8 }}>{t('partnerships.hosted.lastVisit')}: {dt(hosted?.lastVisitAt) || t('partnerships.hosted.never')} · {hosted?.visitCount ?? partner.visitCount ?? 0} {t('partnerships.hosted.visits')}</span>
              <span style={{ opacity: 0.7 }}>{t('partnerships.hosted.changeStatus')}</span>
            </div>
          </div>
          <div className="glass card" style={{ display: 'grid', gap: 8 }}>
            <h3>{t('partnerships.hosted.reservations')}</h3>
            {reservations === null ? <div style={{ fontSize: 12.5 }}>{t('partnerships.loading')}</div> : reservations.length === 0 ? <div style={{ fontSize: 12.5, opacity: 0.8 }}>{t('partnerships.hosted.noReservations')}</div> : (
              <div className="table-shell"><table><tbody>
                {reservations.map((r) => (
                  <tr key={r.id}><td><Link href={`/reservations/${r.id}`}>{r.reservationNumber}</Link></td><td>{r.customer ? `${r.customer.firstName} ${r.customer.lastName}` : '—'}</td><td>{r.vehicleType?.code || '—'}{r.partnerPreferredVehicleTypeId ? ` · ${t('partnerships.hosted.prefers')}` : ''}</td><td>{dt(r.pickupAt)}</td><td><span className="status-chip neutral">{t(`status.${statusKey(r.status)}`, { defaultValue: r.status })}</span></td><td style={{ textAlign: 'right' }}>{money(r.estimatedTotal)}</td></tr>
                ))}
              </tbody></table></div>
            )}
          </div>
        </div>
        <div className="glass card" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <h3>{t('partnerships.hosted.qrTitle')}</h3>
          {/* White box on purpose: scanners need dark modules on light. Locked state dims the CANVAS only; the instruction stays readable below. */}
          <div style={{ width: 220, height: 220, background: '#ffffff', border: '1px solid var(--border)', borderRadius: 12, display: 'grid', placeItems: 'center', alignSelf: 'center', justifySelf: 'center' }}>
            {hosted?.published ? <canvas ref={canvasRef} width={220} height={220} aria-label={t('partnerships.hosted.qrTitle')} /> : <canvas width={196} height={196} aria-hidden="true" style={{ opacity: 0.15, background: 'repeating-linear-gradient(45deg,#211a38 0 6px,#fff 6px 12px)' }} />}
          </div>
          {!hosted?.published ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-2)' }}><span aria-hidden="true">🔒</span>{t('partnerships.hosted.qrLocked')}</div> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => download('png')} disabled={!hosted?.published}>{t('partnerships.hosted.downloadPng')}</button>
            <button className="button-subtle" onClick={() => download('svg')} disabled={!hosted?.published}>{t('partnerships.hosted.downloadSvg')}</button>
          </div>
          <Help>{t('partnerships.hosted.qrHelp')}</Help>
        </div>
      </div>
      <div className="glass card" style={{ display: 'grid', gap: 6 }}>
        <h3>{t('partnerships.audit.title')}</h3>
        {(partner.auditLogs || []).length === 0 ? <div style={{ fontSize: 12.5, opacity: 0.8 }}>{t('partnerships.audit.empty')}</div> : (partner.auditLogs || []).map((a) => (
          <div key={a.id} style={{ fontSize: 12.5, display: 'flex', gap: 10 }}><span style={{ opacity: 0.7, minWidth: 130 }}>{dt(a.createdAt)}</span><span className="status-chip neutral">{t(`partnerships.audit.actions.${a.action}`, { defaultValue: a.action })}</span><span style={{ opacity: 0.8 }}>{a.actorRole ? t(`partnerships.audit.roles.${a.actorRole}`, { defaultValue: a.actorRole }) : ''}</span></div>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- helpers
/** Readiness pill suffix (mockup: "Terms · ES + EN", "Pricing · own price book"…). */
function pillDetail(step, partner, t) {
  const sep = ' · ';
  if (step === 'terms') { const es = !!partner.termsJson?.es, en = !!partner.termsJson?.en; return es ? sep + (en ? 'ES + EN' : 'ES') : ''; }
  if (step === 'pricing') { if (partner.rateId) return sep + t('partnerships.pricingRate') + (partner.pricedClassCount ? ` (${partner.pricedClassCount})` : ''); if (partner.discountPct) return sep + t('partnerships.pricingDiscount', { pct: partner.discountPct }); return ''; }
  if (step === 'vehicles') return sep + t(`partnerships.mode.${partner.vehicleMode}`);
  if (step === 'services') return partner.serviceCount ? sep + String(partner.serviceCount) : '';
  if (step === 'hosted') return sep + (partner.status === 'ACTIVE' ? t('partnerships.hosted.published') : t('partnerships.hosted.notPublished'));
  return '';
}
function Help({ children, warn = false }) {
  return <span style={{ fontSize: 11.5, textTransform: 'none', letterSpacing: 0, opacity: warn ? 1 : 0.75 }} className={warn ? 'error' : ''}>{children}</span>;
}

function Switch({ checked, onChange, label, big = false }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: big ? 14 : 13, fontWeight: big ? 700 : 500, cursor: 'pointer' }}>
      <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)} />
      <span>{label}</span>
    </label>
  );
}
