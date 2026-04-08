'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api, readStoredToken } from '../../lib/client';

const POLL_INTERVAL = 6000;
const CHANNEL_NAME = 'customer-display';
const FONT = "Aptos, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";

function money(n) { return `$${Number(n || 0).toFixed(2)}`; }
function fmtDate(v) {
  if (!v) return '\u2014';
  try { return new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return '\u2014'; }
}
function fmtDateShort(v) {
  if (!v) return '\u2014';
  try { return new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return '\u2014'; }
}

/* ─── Status Badge ──────────────────────────────────────────────── */
function StatusBadge({ status }) {
  const map = {
    NEW: { bg: 'linear-gradient(135deg, rgba(59,130,246,.12), rgba(59,130,246,.06))', color: '#2563eb' },
    CONFIRMED: { bg: 'linear-gradient(135deg, rgba(22,163,74,.12), rgba(22,163,74,.06))', color: '#166534' },
    CHECKED_OUT: { bg: 'linear-gradient(135deg, rgba(245,158,11,.14), rgba(245,158,11,.06))', color: '#92400e' },
    CHECKED_IN: { bg: 'linear-gradient(135deg, rgba(22,163,74,.14), rgba(22,163,74,.06))', color: '#166534' },
    CANCELLED: { bg: 'linear-gradient(135deg, rgba(220,38,38,.1), rgba(220,38,38,.05))', color: '#991b1b' },
    NO_SHOW: { bg: 'linear-gradient(135deg, rgba(107,114,128,.1), rgba(107,114,128,.05))', color: '#4b5563' },
  };
  const s = String(status || 'NEW').toUpperCase();
  const m = map[s] || map.NEW;
  return (
    <span style={{ display: 'inline-block', padding: '5px 14px', borderRadius: 999, background: m.bg, color: m.color, fontWeight: 800, fontSize: '0.78rem', letterSpacing: '.04em', textTransform: 'uppercase' }}>
      {s.replace(/_/g, ' ')}
    </span>
  );
}

/* ─── Horizontal Progress Bar ───────────────────────────────────── */
function ProgressBar({ steps }) {
  const doneCount = steps.filter(s => s.done).length;
  const activeIdx = steps.findIndex(s => s.active);
  const pct = Math.round((doneCount / steps.length) * 100);
  return (
    <div>
      {/* Bar */}
      <div style={{ position: 'relative', height: 6, borderRadius: 6, background: 'rgba(110,73,255,.08)', overflow: 'hidden', marginBottom: 12 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, borderRadius: 6, background: 'linear-gradient(90deg, #6e49ff, #1fc7aa)', transition: 'width .6s ease' }} />
      </div>
      {/* Step labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
        {steps.map((step, i) => (
          <div key={step.label} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%', margin: '0 auto 4px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 800,
              background: step.done ? 'linear-gradient(135deg, #16a34a, #15803d)' : step.active ? 'linear-gradient(135deg, #7c3aed, #6e49ff)' : 'rgba(110,73,255,.06)',
              color: step.done || step.active ? '#fff' : '#c4b5e0',
              boxShadow: step.active ? '0 2px 8px rgba(110,73,255,.35)' : 'none',
              transition: 'all .4s ease',
            }}>
              {step.done ? '\u2713' : ''}
            </div>
            <div style={{ fontSize: '0.62rem', fontWeight: 700, color: step.done ? '#166534' : step.active ? '#4c1d95' : '#b0a8c8', lineHeight: 1.2, letterSpacing: '.01em' }}>
              {step.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Recommendation Card ───────────────────────────────────────── */
function RecommendationCard({ rec }) {
  const isInsurance = rec.type === 'insurance';
  const accent = isInsurance ? '#6e49ff' : '#0d9488';
  const bgGrad = isInsurance
    ? 'linear-gradient(135deg, rgba(110,73,255,.06), rgba(110,73,255,.02))'
    : 'linear-gradient(135deg, rgba(13,148,136,.06), rgba(13,148,136,.02))';
  return (
    <div style={{ padding: '12px 14px', borderRadius: 14, background: bgGrad, border: `1px solid ${isInsurance ? 'rgba(110,73,255,.12)' : 'rgba(13,148,136,.12)'}`, transition: 'all .2s' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, color: '#1a1230', fontSize: '0.9rem' }}>{rec.headline}</div>
          <div style={{ fontSize: '0.8rem', color: '#55456f', lineHeight: 1.5, marginTop: 3 }}>{rec.reason}</div>
          {rec.cta && rec.cta !== rec.reason && <div style={{ fontSize: '0.74rem', color: '#8090a8', marginTop: 3 }}>{rec.cta}</div>}
          {rec.altNote && <div style={{ fontSize: '0.72rem', color: accent, fontWeight: 700, marginTop: 4 }}>{rec.altNote}</div>}
        </div>
        <div style={{ flexShrink: 0, textAlign: 'right', padding: '4px 0' }}>
          <div style={{ fontWeight: 900, color: accent, fontSize: '1rem', whiteSpace: 'nowrap' }}>
            {money(rec.price)}<span style={{ fontSize: '0.7rem', fontWeight: 600, opacity: 0.7 }}>{rec.priceLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   IDLE SCREEN
   ═══════════════════════════════════════════════════════════════════ */
function IdleScreen({ branding }) {
  const [time, setTime] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setTime(new Date()), 30000); return () => clearInterval(t); }, []);
  const logo = branding?.companyLogoUrl;
  const name = branding?.companyName || 'Ride Fleet';
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(145deg, #0f0a2e 0%, #1a1145 30%, #2d1b69 55%, #1a1145 80%, #0f0a2e 100%)',
      fontFamily: FONT, position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: '15%', left: '20%', width: 300, height: 300, borderRadius: '50%', background: 'radial-gradient(circle, rgba(110,73,255,.15) 0%, transparent 70%)', filter: 'blur(60px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '20%', right: '15%', width: 250, height: 250, borderRadius: '50%', background: 'radial-gradient(circle, rgba(31,199,170,.1) 0%, transparent 70%)', filter: 'blur(50px)', pointerEvents: 'none' }} />
      <div style={{ textAlign: 'center', zIndex: 1, padding: 40 }}>
        {logo ? (
          <img src={logo} alt={name} style={{ maxHeight: 80, maxWidth: 280, objectFit: 'contain', marginBottom: 24, filter: 'drop-shadow(0 4px 20px rgba(110,73,255,.3))' }} />
        ) : (
          <div style={{ fontWeight: 900, fontSize: '2.8rem', color: '#fff', letterSpacing: '-.03em', marginBottom: 8, textShadow: '0 4px 30px rgba(110,73,255,.4)' }}>{name}</div>
        )}
        <div style={{ fontSize: '1.1rem', color: 'rgba(255,255,255,.4)', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase' }}>Customer Display</div>
        <div style={{ marginTop: 48, padding: '20px 36px', borderRadius: 20, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', backdropFilter: 'blur(12px)' }}>
          <div style={{ fontSize: '2rem', fontWeight: 900, color: 'rgba(255,255,255,.85)' }}>{time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
          <div style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,.35)', marginTop: 4, fontWeight: 600 }}>{time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
        </div>
        <div style={{ marginTop: 48, fontSize: '0.88rem', color: 'rgba(255,255,255,.2)', fontWeight: 500 }}>Waiting for an agent to load a reservation...</div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SMART RECOMMENDATION ENGINE
   ═══════════════════════════════════════════════════════════════════ */
function buildRecommendations({ row, charges, insurancePlans, additionalServices }) {
  const recs = [];
  const serviceSources = ['ADDITIONAL_SERVICE', 'ADDITIONAL_SERVICE_PRECHECKIN', 'SERVICE'];
  const serviceCharges = charges.filter(c => serviceSources.includes(c.source));
  const selectedServiceIds = new Set(serviceCharges.map(c => c.sourceRefId).filter(Boolean));
  const selectedServiceNames = new Set(serviceCharges.map(c => String(c.name || '').replace(/^(Service:\s*|Fee:\s*)/i, '').trim().toLowerCase()).filter(Boolean));
  const isServiceSelected = (svc) => selectedServiceIds.has(svc.id) || selectedServiceNames.has(String(svc.name || '').trim().toLowerCase());
  const hasInsurance = charges.some(c => c.source === 'INSURANCE');
  const hasTolls = charges.some(c => c.coversTolls) || additionalServices.some(s => s.coversTolls && isServiceSelected(s));

  const pickup = row?.pickupAt ? new Date(row.pickupAt) : null;
  const ret = row?.returnAt ? new Date(row.returnAt) : null;
  const tripDays = pickup && ret ? Math.max(1, Math.ceil((ret - pickup) / 86400000)) : 1;
  const locationName = String(row?.pickupLocation?.name || '').toLowerCase();
  const isAirport = /airport|aeropuerto|terminal|sju|mia|jfk|lax|ord|atl|dfw/i.test(locationName);

  const svcMatches = (svc, ...keywords) => {
    const hay = `${svc.name} ${svc.code || ''} ${svc.description || ''}`.toLowerCase();
    return keywords.some(k => hay.includes(k));
  };

  // Insurance
  if (insurancePlans.length > 0) {
    const currentCharge = charges.find(c => c.source === 'INSURANCE');
    const currentCode = String(currentCharge?.sourceRefId || '').toUpperCase();
    const currentAmount = Number(currentCharge?.total || currentCharge?.rate || 0);
    const available = insurancePlans.filter(p => String(p.code || '').toUpperCase() !== currentCode);
    const candidates = hasInsurance ? available.filter(p => Number(p.amount || p.rate || 0) > currentAmount) : available;
    if (candidates.length > 0) {
      const sorted = [...candidates].sort((a, b) => Number(b.displayPriority || 0) - Number(a.displayPriority || 0));
      const pick = Number(sorted[0]?.displayPriority || 0) > 0 ? sorted[0] : [...candidates].sort((a, b) => Number(a.amount || a.rate || 0) - Number(b.amount || b.rate || 0))[0];
      const price = Number(pick.total || pick.amount || pick.rate || 0);
      const perDay = pick.chargeBy === 'PER_DAY';
      const custDesc = pick.displayDescription || pick.description || null;
      const isUpgrade = hasInsurance;
      recs.push({
        type: 'insurance', priority: Math.max(Number(pick.displayPriority || 0), isUpgrade ? 7 : 10), item: pick,
        headline: pick.name || 'Trip Protection',
        reason: custDesc || (isUpgrade ? `Upgrade your coverage for more protection` : `Drive worry-free with full coverage`),
        price, priceLabel: perDay ? '/day' : '',
        cta: isUpgrade ? 'Ask about upgrading' : null,
        altNote: candidates.length > 1 ? `${candidates.length} ${isUpgrade ? 'upgrade options' : 'plans'} available` : null,
      });
    }
  }

  // Services
  const availableServices = additionalServices.filter(s => !isServiceSelected(s) && !s.mandatory)
    .sort((a, b) => (Number(b.displayPriority || 0)) - (Number(a.displayPriority || 0)) || (Number(a.sortOrder || 0)) - (Number(b.sortOrder || 0)));

  for (const svc of availableServices) {
    if (recs.length >= 4) break;
    const flatRate = Number(svc.rate || 0);
    const dailyRate = Number(svc.dailyRate || 0);
    let rate = flatRate;
    let unitLabel = svc.chargeType === 'UNIT' ? `/${svc.unitLabel || 'unit'}` : '/day';
    if (dailyRate > 0) { rate = dailyRate; unitLabel = '/day'; }
    else if (flatRate <= 0 && Number(svc.weeklyRate || 0) > 0) { rate = Number(svc.weeklyRate); unitLabel = '/week'; }
    const customerDesc = svc.displayDescription || svc.description || null;
    const linkedFee = svc.linkedFee;
    const feeAmount = Number(linkedFee?.amount || 0);
    const feeNote = linkedFee && feeAmount > 0 ? `+ ${linkedFee.name} ${money(feeAmount)} one-time` : null;
    const tenantPriority = Number(svc.displayPriority || 0);

    let reason = customerDesc;
    let contextBoost = tenantPriority || 2;

    if (!reason) {
      if (svcMatches(svc, 'toll', 'sunpass', 'e-pass', 'peaje') && !hasTolls) { reason = isAirport ? 'Airport travelers use toll roads \u2014 avoid surprise charges' : 'Electronic toll coverage'; contextBoost = Math.max(contextBoost, isAirport ? 8 : 6); }
      else if (svcMatches(svc, 'gps', 'navigation')) { reason = 'Navigate with confidence'; contextBoost = Math.max(contextBoost, isAirport ? 7 : 4); }
      else if (svcMatches(svc, 'roadside', 'assistance', 'breakdown')) { reason = tripDays >= 5 ? `Peace of mind for your ${tripDays}-day trip` : '24/7 roadside help'; contextBoost = Math.max(contextBoost, tripDays >= 5 ? 7 : 5); }
      else if (svcMatches(svc, 'child', 'baby', 'booster', 'car seat')) { reason = 'Ready-to-install seats for little ones'; contextBoost = Math.max(contextBoost, 3); }
      else if (svcMatches(svc, 'wifi', 'hotspot')) { reason = 'Stay connected on the go'; contextBoost = Math.max(contextBoost, tripDays >= 3 ? 5 : 3); }
      else if (svcMatches(svc, 'fuel', 'gas', 'prepaid fuel')) { reason = isAirport ? 'Skip the gas station before your flight' : 'Return without refueling'; contextBoost = Math.max(contextBoost, isAirport ? 6 : 4); }
      else if (svcMatches(svc, 'clean', 'wash', 'detail')) { reason = 'Skip the cleaning fee \u2014 return worry-free'; contextBoost = Math.max(contextBoost, 3); }
      else { reason = svc.name; }
    }

    recs.push({ type: 'service', priority: contextBoost, item: svc, headline: svc.name, reason, price: rate, priceLabel: unitLabel, cta: feeNote, altNote: null });
  }

  recs.sort((a, b) => b.priority - a.priority);
  return recs.slice(0, 3);
}

/* ═══════════════════════════════════════════════════════════════════
   ACTIVE VIEW — Premium 4-panel layout
   ═══════════════════════════════════════════════════════════════════ */
function ActiveView({ data, branding }) {
  const row = data?.reservation;
  const insurancePlans = data?.insurancePlans || [];
  const additionalServices = data?.additionalServices || [];
  if (!row) return null;

  const customer = row?.customer || {};
  const vehicle = row?.vehicle;
  const vehicleType = row?.vehicleType || vehicle?.vehicleType;
  const vehicleTypeImage = vehicleType?.imageUrl || null;
  const charges = Array.isArray(row?.charges) ? row.charges.filter((c) => c.selected) : [];
  const vehicleLabel = vehicle ? `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim() : null;
  const pickupLocation = row?.pickupLocation;
  const returnLocation = row?.returnLocation;
  const status = String(row?.status || 'NEW').toUpperCase();
  const agreementTotal = Number(row?.rentalAgreement?.total || row?.estimatedTotal || 0);
  const paidTotal = (row?.payments || []).concat(row?.rentalAgreement?.payments || []).reduce((sum, p) => sum + Number(p?.amount || 0), 0);
  const balance = Number((agreementTotal - paidTotal).toFixed(2));

  const precheckinDone = !!row?.customerInfoCompletedAt;
  const signatureDone = !!row?.signatureCompletedAt || !!row?.rentalAgreement?.signedAt;
  const paymentDone = balance <= 0 && paidTotal > 0;
  const isCheckedOut = status === 'CHECKED_OUT';
  const isCheckedIn = status === 'CHECKED_IN';
  const isComplete = isCheckedIn;
  const isOtaPrepaid = charges.some((c) => c.source === 'OTA_PREPAID_VOUCHER');

  const recommendations = buildRecommendations({ row, charges, insurancePlans, additionalServices });

  // Charge calculations
  const hideSources = ['OTA_PREPAID_VOUCHER', 'SECURITY_DEPOSIT'];
  const visibleCharges = charges.filter(c => !hideSources.includes(c.source) && Number(c.total || 0) > 0 && String(c.chargeType || '').toUpperCase() !== 'TAX');
  const taxTotal = charges.filter(c => String(c.chargeType || '').toUpperCase() === 'TAX' && Number(c.total || 0) > 0).reduce((s, c) => s + Number(c.total || 0), 0);
  const depositCharge = charges.find(c => c.source === 'SECURITY_DEPOSIT' && Number(c.total || 0) > 0);
  const chargesTotal = visibleCharges.reduce((s, c) => s + Number(c.total || 0), 0) + taxTotal;

  const companyName = branding?.companyName || 'Ride Fleet';

  const progressSteps = [
    { label: 'Created', done: true, active: false },
    { label: 'Pre-Check-in', done: precheckinDone, active: !precheckinDone && !isCheckedOut },
    { label: 'Signed', done: signatureDone, active: precheckinDone && !signatureDone && !isCheckedOut },
    { label: 'Payment', done: paymentDone, active: signatureDone && !paymentDone && !isCheckedOut },
    { label: 'Checked Out', done: isCheckedOut || isCheckedIn, active: false },
    { label: 'Returned', done: isCheckedIn, active: isCheckedOut },
  ];

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '12px 20px 16px', minHeight: '100vh', fontFamily: FONT }}>

      {/* ── TOP BAR ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {branding?.companyLogoUrl ? (
            <img src={branding.companyLogoUrl} alt={companyName} style={{ height: 30, maxWidth: 140, objectFit: 'contain' }} />
          ) : (
            <div style={{ fontWeight: 900, fontSize: '1.15rem', color: '#1a1230' }}>{companyName}</div>
          )}
          <div style={{ width: 1, height: 24, background: 'rgba(110,73,255,.15)' }} />
          <StatusBadge status={status} />
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: '#1a1230' }}>
            {customer.firstName ? `Welcome, ${customer.firstName}` : 'Your Reservation'}
          </div>
          <div style={{ fontSize: '0.75rem', color: '#8090a8', fontWeight: 600 }}>#{row?.reservationNumber}</div>
        </div>
      </div>

      {/* ── PROGRESS BAR (full width) ────────────────────────── */}
      <div style={{ ...P, marginBottom: 12, padding: '14px 18px' }}>
        <ProgressBar steps={progressSteps} />
      </div>

      {/* ── 2x2 PANEL GRID ───────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

        {/* PANEL 1: Trip + Vehicle */}
        <div style={P}>
          <div style={PT}>Your Trip</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: vehicleLabel ? 10 : 0 }}>
            <div style={TL}>
              <div style={TLB}>Pickup</div>
              <div style={TV}>{fmtDateShort(row?.pickupAt)}</div>
              {pickupLocation && <div style={TS}>{pickupLocation.name}</div>}
            </div>
            <div style={TL}>
              <div style={TLB}>Return</div>
              <div style={TV}>{fmtDateShort(row?.returnAt)}</div>
              {returnLocation && <div style={TS}>{returnLocation.name}</div>}
            </div>
          </div>
          {vehicleLabel && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 12, background: 'linear-gradient(135deg, rgba(110,73,255,.04), rgba(31,199,170,.03))', border: '1px solid rgba(110,73,255,.06)' }}>
              <div style={{
                width: 56, height: 42, borderRadius: 10, flexShrink: 0, overflow: 'hidden',
                background: vehicleTypeImage ? '#f8f7fc' : 'linear-gradient(135deg, rgba(110,73,255,.1), rgba(31,199,170,.08))',
                display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(110,73,255,.06)',
              }}>
                {vehicleTypeImage ? (
                  <img src={vehicleTypeImage} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontSize: '1.2rem' }}>{'\uD83D\uDE97'}</span>
                )}
              </div>
              <div>
                <div style={{ fontWeight: 800, color: '#1a1230', fontSize: '0.88rem' }}>{vehicleLabel}</div>
                {vehicleType?.name && <div style={{ fontSize: '0.72rem', color: '#8090a8', marginTop: 1 }}>{vehicleType.name}</div>}
                <div style={{ display: 'flex', gap: 5, marginTop: 3 }}>
                  {vehicle?.color && <span style={CH}>{vehicle.color}</span>}
                  {vehicle?.plate && <span style={CH}>{vehicle.plate}</span>}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* PANEL 2: Trip Summary / Charges */}
        <div style={P}>
          <div style={PT}>{isOtaPrepaid ? 'Your Add-ons' : 'Trip Summary'}</div>
          {isOtaPrepaid && (
            <div style={{ fontSize: '0.72rem', color: '#92400e', background: 'rgba(245,158,11,.06)', padding: '5px 10px', borderRadius: 8, marginBottom: 8, fontWeight: 700 }}>
              Base rental prepaid {'\u2713'}
            </div>
          )}
          {visibleCharges.length > 0 ? (
            <div style={{ display: 'grid', gap: 2 }}>
              {visibleCharges.map((c, i) => {
                const isProt = c.source === 'INSURANCE';
                const isSvc = ['ADDITIONAL_SERVICE', 'ADDITIONAL_SERVICE_PRECHECKIN', 'SERVICE'].includes(c.source);
                return (
                  <div key={c.id || i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', padding: '3px 0', color: isProt ? '#166534' : isSvc ? '#0d9488' : '#53607b' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>{c.name}</span>
                    <strong style={{ color: '#1a1230', flexShrink: 0 }}>{money(c.total)}</strong>
                  </div>
                );
              })}
              {taxTotal > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: '#94a3b8', padding: '1px 0' }}>
                  <span>Tax</span><span>{money(taxTotal)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, marginTop: 4, borderTop: '2px solid rgba(110,73,255,.1)' }}>
                <span style={{ fontWeight: 800, color: '#1a1230', fontSize: '0.88rem' }}>Total</span>
                <span style={{ fontWeight: 900, fontSize: '1.05rem', color: '#1a1230' }}>{money(chargesTotal)}</span>
              </div>
              {depositCharge && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#94a3b8' }}>
                  <span>Deposit (hold)</span><span>{money(depositCharge.total)}</span>
                </div>
              )}
              {balance > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#b45309', marginTop: 2 }}>
                  <span>Balance Due</span><strong>{money(balance)}</strong>
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: '0.82rem', color: '#b0a8c8', fontStyle: 'italic', padding: '10px 0' }}>No charges yet</div>
          )}
        </div>

        {/* PANEL 3: Recommendations */}
        <div style={{
          ...P, gridColumn: recommendations.length > 0 && !isComplete ? '1 / -1' : undefined,
          background: recommendations.length > 0 ? 'linear-gradient(145deg, rgba(255,255,255,.96), rgba(110,73,255,.03))' : P.background,
          position: 'relative', overflow: 'hidden',
        }}>
          {recommendations.length > 0 && !isComplete ? (
            <>
              <div style={{ position: 'absolute', top: -30, right: -30, width: 100, height: 100, borderRadius: '50%', background: 'radial-gradient(circle, rgba(110,73,255,.05) 0%, transparent 70%)', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', bottom: -20, left: '40%', width: 80, height: 80, borderRadius: '50%', background: 'radial-gradient(circle, rgba(31,199,170,.04) 0%, transparent 70%)', pointerEvents: 'none' }} />
              <div style={{ ...PT, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>{'\u2728'}</span> Recommended for You
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: recommendations.length > 1 ? 'repeat(auto-fit, minmax(250px, 1fr))' : '1fr', gap: 10 }}>
                {recommendations.map((rec, i) => (
                  <RecommendationCard key={rec.item?.code || rec.item?.id || i} rec={rec} />
                ))}
              </div>
              <div style={{ marginTop: 10, textAlign: 'center', fontSize: '0.76rem', color: '#8090a8', fontWeight: 600 }}>
                Interested? Just let your agent know
              </div>
            </>
          ) : isComplete ? (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <div style={{ fontSize: '2rem', marginBottom: 6 }}>{'\u2705'}</div>
              <div style={{ fontWeight: 900, color: '#166534', fontSize: '0.95rem' }}>Trip Complete</div>
              <div style={{ fontSize: '0.82rem', color: '#6b7a9a', marginTop: 3 }}>Thank you for renting with us!</div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <div style={{ fontSize: '1.6rem', marginBottom: 6 }}>{'\uD83C\uDF1F'}</div>
              <div style={{ fontWeight: 800, color: '#166534', fontSize: '0.9rem' }}>You&apos;re All Set</div>
              <div style={{ fontSize: '0.78rem', color: '#8090a8', marginTop: 3 }}>Let your agent know if you need anything</div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{ textAlign: 'center', padding: '10px 0 8px', fontSize: '0.72rem', color: '#b0a8c8' }}>
        {companyName} {'\u00B7'} Updates automatically
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════════════ */
export default function CustomerDisplayPage() {
  const [reservationId, setReservationId] = useState(null);
  const [data, setData] = useState(null);
  const [branding, setBranding] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef(null);
  const channelRef = useRef(null);

  const loadReservation = useCallback(async (id) => {
    try {
      const token = readStoredToken();
      if (!token) { setError('Session expired'); setLoading(false); return; }
      let result;
      try {
        result = await api(`/api/reservations/${id}/display-data`, { bypassCache: true }, token);
      } catch {
        const reservation = await api(`/api/reservations/${id}`, { bypassCache: true }, token);
        result = { reservation, insurancePlans: [], additionalServices: [] };
      }
      setData(result);
      setError('');
      if (result?.branding) setBranding(result.branding);
    } catch (e) {
      console.error('Customer display fetch error:', e);
      setError(e?.message || 'Unable to load reservation');
    } finally {
      setLoading(false);
    }
  }, []);

  const activateReservation = useCallback((id) => {
    setReservationId(id);
    setLoading(true);
    setData(null);
    loadReservation(id);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => loadReservation(id), POLL_INTERVAL);
  }, [loadReservation]);

  const deactivate = useCallback(() => {
    setReservationId(null);
    setData(null);
    setLoading(false);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const token = readStoredToken();
        if (!token) return;
        const settings = await api('/api/settings/rental-agreement', {}, token);
        setBranding({ companyName: settings?.companyName || 'Ride Fleet', companyLogoUrl: settings?.companyLogoUrl || '', companyPhone: settings?.companyPhone || '' });
      } catch { /* defaults */ }
    })();
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'load-reservation' && msg.id) activateReservation(msg.id);
      else if (msg?.type === 'exit') deactivate();
    };
    ch.postMessage({ type: 'display-ready' });
    return () => { ch.close(); channelRef.current = null; };
  }, [activateReservation, deactivate]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (id) activateReservation(id);
  }, [activateReservation]);

  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  if (!reservationId) return <IdleScreen branding={branding} />;

  if ((loading && !data) || (!data && reservationId && !error)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: BG, fontFamily: FONT }}>
        <div style={{ ...P, textAlign: 'center', padding: 48, maxWidth: 400 }}>
          <p style={{ color: '#6b7a9a', fontWeight: 600 }}>Loading reservation...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: BG, fontFamily: FONT }}>
        <div style={{ ...P, textAlign: 'center', padding: 48, maxWidth: 400 }}>
          <p style={{ color: '#991b1b', fontWeight: 600 }}>{error}</p>
          <p style={{ color: '#6b7a9a', fontSize: '0.85rem', marginTop: 8 }}>Retrying automatically...</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: FONT }}>
      <ActiveView data={data} branding={branding} />
    </div>
  );
}

/* ─── Design Tokens ─────────────────────────────────────────────── */
const BG = 'linear-gradient(145deg, #f0eef8, #e8e4f4, #f5f3fa)';

const P = {
  padding: '16px 18px',
  borderRadius: 16,
  background: 'rgba(255,255,255,.88)',
  border: '1px solid rgba(110,73,255,.08)',
  boxShadow: '0 4px 16px rgba(47,58,114,.04), 0 1px 3px rgba(47,58,114,.06)',
  backdropFilter: 'blur(8px)',
};

const PT = {
  fontWeight: 800, fontSize: '0.78rem', color: '#7c7a9a',
  textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 10,
};

const TL = {
  padding: '8px 10px', borderRadius: 10,
  background: 'rgba(110,73,255,.03)', border: '1px solid rgba(110,73,255,.05)',
};

const TLB = { fontSize: '0.64rem', fontWeight: 700, color: '#8090a8', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 };
const TV = { fontWeight: 800, color: '#1a1230', fontSize: '0.82rem' };
const TS = { fontSize: '0.7rem', color: '#8090a8', marginTop: 1 };

const CH = {
  display: 'inline-block', padding: '1px 7px', borderRadius: 999,
  background: 'rgba(110,73,255,.05)', color: '#5c4d8a', fontSize: '0.68rem', fontWeight: 700,
};
