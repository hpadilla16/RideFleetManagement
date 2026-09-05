'use client';

/**
 * Partnerships — shared bits for the list and the editor (2026-09-05).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';

export const STATUS_TONE = { ACTIVE: 'good', PAUSED: 'warn', DRAFT: 'neutral', EXPIRED: 'neutral', NOT_STARTED: 'warn' };

/**
 * The app's modal pattern: `.modal-backdrop` (z-index above the sticky topbar,
 * scroll-safe) + `.tq-dialog` for confirms or `.rent-modal glass` for forms.
 * Backdrop click and Escape close it unless `busy`.
 */
export function Dialog({ titleId, onClose, busy = false, wide = false, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}>
      <div className={wide ? 'rent-modal glass' : 'tq-dialog'} role="dialog" aria-modal="true" aria-labelledby={titleId} style={wide ? { display: 'grid', gap: 12 } : undefined}>
        {children}
      </div>
    </div>
  );
}

export function StatusChip({ status }) {
  const { t } = useTranslation();
  const key = String(status || 'DRAFT').toUpperCase();
  return <span className={`status-chip ${STATUS_TONE[key] || 'neutral'}`}>{t(`partnerships.status.${key}`, { defaultValue: key })}</span>;
}

/**
 * Both logos, tenant first, partner on a white plate. The partner logo is an
 * uncontrolled image (any colours) — it is NEVER used to colour chrome; without
 * a logo the partner name renders as text on the same plate (GD must-change #1).
 */
export function PartnerLogo({ tenantLogoUrl, partner, size = 22 }) {
  const { t } = useTranslation();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: size + 12 }}>
      {tenantLogoUrl ? <img src={tenantLogoUrl} alt="" style={{ height: size, width: 'auto', maxWidth: 120, objectFit: 'contain' }} /> : null}
      {tenantLogoUrl ? <span style={{ opacity: 0.35 }}>×</span> : null}
      {/* White plate on purpose (GD-approved): the partner logo is an uncontrolled image and must sit on white in both themes. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 8px', minHeight: size + 10, maxWidth: 160 }}>
        {partner?.logoUrl
          ? <img src={partner.logoUrl} alt={partner?.name || ''} style={{ height: size, width: 'auto', maxWidth: 140, objectFit: 'contain' }} />
          : <span style={{ fontWeight: 800, fontSize: 12.5, color: '#211a38', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={t('partnerships.noLogo')}>{partner?.name || t('partnerships.noLogo')}</span>}
      </span>
    </span>
  );
}

export function tenantQuerySuffix(activeTenantId, isSuperAdmin) {
  return isSuperAdmin && activeTenantId ? `?tenantId=${encodeURIComponent(activeTenantId)}` : '';
}

/** SUPER_ADMIN picks a tenant (the API refuses to operate in the void); everyone else is pinned by the JWT. */
export function useTenantContext(me, token) {
  const isSuperAdmin = String(me?.role || '').toUpperCase() === 'SUPER_ADMIN';
  const [tenants, setTenants] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState(() => {
    if (!isSuperAdmin) return me?.tenantId || '';
    if (typeof window === 'undefined') return '';
    try { return new URLSearchParams(window.location.search).get('tenantId') || ''; } catch { return ''; }
  });
  useEffect(() => {
    if (!isSuperAdmin) return;
    api('/api/tenants', {}, token).then((rows) => setTenants(Array.isArray(rows) ? rows : (rows?.items || []))).catch(() => {});
  }, [isSuperAdmin, token]);
  const tenantLogoUrl = useMemo(() => {
    if (isSuperAdmin) return tenants.find((tn) => tn.id === activeTenantId)?.companyLogoUrl || null;
    return me?.tenant?.companyLogoUrl || me?.companyLogoUrl || null;
  }, [isSuperAdmin, tenants, activeTenantId, me]);
  return { isSuperAdmin, tenants, activeTenantId, setActiveTenantId, tenantLogoUrl };
}
