'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api, readStoredToken } from '../../lib/client';

const POLL_INTERVAL = 6000;
const CHANNEL_NAME = 'customer-display';

function money(n) { return `$${Number(n || 0).toFixed(2)}`; }
function fmtDate(v) {
  if (!v) return '\u2014';
  try { return new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return '\u2014'; }
}

/* ─── Status Badge ──────────────────────────────────────────────── */
function StatusBadge({ status }) {
  const map = {
    NEW: { bg: 'rgba(59,130,246,.12)', color: '#2563eb', border: 'rgba(59,130,246,.25)' },
    CONFIRMED: { bg: 'rgba(22,163,74,.1)', color: '#166534', border: 'rgba(22,163,74,.22)' },
    CHECKED_OUT: { bg: 'rgba(245,158,11,.12)', color: '#92400e', border: 'rgba(245,158,11,.25)' },
    CHECKED_IN: { bg: 'rgba(22,163,74,.12)', color: '#166534', border: 'rgba(22,163,74,.25)' },
    CANCELLED: { bg: 'rgba(220,38,38,.1)', color: '#991b1b', border: 'rgba(220,38,38,.2)' },
    NO_SHOW: { bg: 'rgba(107,114,128,.1)', color: '#4b5563', border: 'rgba(107,114,128,.2)' },
  };
  const s = String(status || 'NEW').toUpperCase();
  const m = map[s] || map.NEW;
  return (
    <span style={{ display: 'inline-block', padding: '6px 16px', borderRadius: 999, background: m.bg, border: `1px solid ${m.border}`, color: m.color, fontWeight: 800, fontSize: '0.88rem', letterSpacing: '.03em' }}>
      {s.replace(/_/g, ' ')}
    </span>
  );
}

/* ─── Progress Step ─────────────────────────────────────────────── */
function ProgressStep({ label, done, active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: done ? '#16a34a' : active ? '#7c3aed' : 'rgba(110,73,255,.08)',
        color: done || active ? '#fff' : '#b0a0d0',
        fontWeight: 800, fontSize: done ? 14 : 13,
        border: active ? '2.5px solid #7c3aed' : 'none',
        boxShadow: active ? '0 3px 12px rgba(110,73,255,.3)' : 'none',
        transition: 'all .3s ease',
      }}>
        {done ? '\u2713' : ''}
      </div>
      <span style={{ fontWeight: 700, fontSize: '0.95rem', color: done ? '#166534' : active ? '#4c1d95' : '#94a3b8', transition: 'color .3s' }}>{label}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   IDLE SCREEN — Branded waiting state
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
      fontFamily: "Aptos, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Ambient glow orbs */}
      <div style={{ position: 'absolute', top: '15%', left: '20%', width: 300, height: 300, borderRadius: '50%', background: 'radial-gradient(circle, rgba(110,73,255,.15) 0%, transparent 70%)', filter: 'blur(60px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '20%', right: '15%', width: 250, height: 250, borderRadius: '50%', background: 'radial-gradient(circle, rgba(31,199,170,.1) 0%, transparent 70%)', filter: 'blur(50px)', pointerEvents: 'none' }} />

      <div style={{ textAlign: 'center', zIndex: 1, padding: 40 }}>
        {logo ? (
          <img src={logo} alt={name} style={{ maxHeight: 80, maxWidth: 280, objectFit: 'contain', marginBottom: 24, filter: 'drop-shadow(0 4px 20px rgba(110,73,255,.3))' }} />
        ) : (
          <div style={{ fontWeight: 900, fontSize: '2.8rem', color: '#fff', letterSpacing: '-.03em', marginBottom: 8, textShadow: '0 4px 30px rgba(110,73,255,.4)' }}>
            {name}
          </div>
        )}
        <div style={{ fontSize: '1.1rem', color: 'rgba(255,255,255,.45)', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', marginTop: logo ? 0 : 4 }}>
          Customer Display
        </div>

        <div style={{ marginTop: 48, padding: '20px 36px', borderRadius: 20, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', backdropFilter: 'blur(12px)' }}>
          <div style={{ fontSize: '2rem', fontWeight: 900, color: 'rgba(255,255,255,.85)', letterSpacing: '-.01em' }}>
            {time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
          </div>
          <div style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,.35)', marginTop: 4, fontWeight: 600 }}>
            {time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </div>
        </div>

        <div style={{ marginTop: 48, fontSize: '0.88rem', color: 'rgba(255,255,255,.25)', fontWeight: 500 }}>
          Waiting for an agent to load a reservation...
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SMART RECOMMENDATION ENGINE
   Analyzes trip context and produces max 3 contextual suggestions.
   ═══════════════════════════════════════════════════════════════════ */
function buildRecommendations({ row, charges, insurancePlans, additionalServices }) {
  const recs = [];
  const selectedServiceIds = new Set(
    charges.filter(c => c.source === 'ADDITIONAL_SERVICE' || c.source === 'ADDITIONAL_SERVICE_PRECHECKIN').map(c => c.sourceRefId)
  );
  const hasInsurance = charges.some(c => c.source === 'INSURANCE');
  const hasTolls = charges.some(c => c.coversTolls) || additionalServices.some(s => s.coversTolls && selectedServiceIds.has(s.id));

  // Trip context
  const pickup = row?.pickupAt ? new Date(row.pickupAt) : null;
  const ret = row?.returnAt ? new Date(row.returnAt) : null;
  const tripDays = pickup && ret ? Math.max(1, Math.ceil((ret - pickup) / 86400000)) : 1;
  const locationName = String(row?.pickupLocation?.name || '').toLowerCase();
  const locationCity = String(row?.pickupLocation?.city || '').toLowerCase();
  const isAirport = /airport|aeropuerto|terminal|sju|mia|jfk|lax|ord|atl|dfw/i.test(locationName);
  const vehicleTypeName = String(row?.vehicleType?.name || row?.vehicle?.vehicleType?.name || '').toLowerCase();
  const isLargeVehicle = /suv|truck|van|minivan|premium|luxury|full.?size/i.test(vehicleTypeName);

  // Helper: keyword match against service name/code/description
  const svcMatches = (svc, ...keywords) => {
    const hay = `${svc.name} ${svc.code || ''} ${svc.description || ''}`.toLowerCase();
    return keywords.some(k => hay.includes(k));
  };

  // 1. Insurance — highest priority if missing
  if (!hasInsurance && insurancePlans.length > 0) {
    // Pick the mid-tier plan (best value), or the first if only one
    const sorted = [...insurancePlans].sort((a, b) => Number(a.amount || a.rate || 0) - Number(b.amount || b.rate || 0));
    const pick = sorted.length >= 3 ? sorted[1] : sorted[0];
    const price = Number(pick.total || pick.amount || pick.rate || 0);
    const perDay = pick.chargeBy === 'PER_DAY';
    const dailyCost = perDay ? price : (tripDays > 0 ? Number((price / tripDays).toFixed(2)) : price);
    recs.push({
      type: 'insurance', priority: 10, item: pick,
      headline: pick.name || 'Trip Protection',
      reason: dailyCost <= 25
        ? `For just ${money(dailyCost)}/day, drive worry-free with full coverage`
        : (pick.description || 'Protect yourself from unexpected costs during your rental'),
      price, priceLabel: perDay ? '/day' : '',
      cta: pick.description && dailyCost <= 25 ? pick.description : 'Your agent can add this in seconds',
    });
    // If multiple plans, note alternatives
    if (insurancePlans.length > 1) {
      recs[recs.length - 1].altNote = `${insurancePlans.length} plans available \u2014 ask about the best fit for your trip`;
    }
  }

  // 2. Smart service recommendations based on context
  // Sort by tenant-defined displayPriority (higher = more important), then sortOrder
  const availableServices = additionalServices
    .filter(s => !selectedServiceIds.has(s.id) && !s.mandatory)
    .sort((a, b) => (Number(b.displayPriority || 0)) - (Number(a.displayPriority || 0)) || (Number(a.sortOrder || 0)) - (Number(b.sortOrder || 0)));

  for (const svc of availableServices) {
    if (recs.length >= 4) break; // We'll cap at 3 later, but gather 4 candidates
    const rate = Number(svc.rate || 0);
    const unitLabel = svc.chargeType === 'UNIT' ? `/${svc.unitLabel || 'unit'}` : '/day';
    const customerDesc = svc.displayDescription || svc.description || null;
    const linkedFee = svc.linkedFee;
    const totalWithFee = linkedFee ? rate + Number(linkedFee.amount || 0) : rate;
    const feeNote = linkedFee ? `Includes ${linkedFee.name}${linkedFee.description ? ` \u2014 ${linkedFee.description}` : ''} (${money(linkedFee.amount)})` : null;

    // If tenant set a displayPriority > 0, honor that as the base priority
    const tenantPriority = Number(svc.displayPriority || 0);

    // Toll pass — recommend if location suggests highways/bridges
    if (svcMatches(svc, 'toll', 'sunpass', 'e-pass', 'peaje') && !hasTolls) {
      const contextBoost = isAirport ? 8 : 6;
      recs.push({
        type: 'service', priority: Math.max(tenantPriority, contextBoost), item: svc,
        headline: svc.name,
        reason: customerDesc || (isAirport
          ? 'Most travelers from the airport use toll roads \u2014 avoid surprise charges'
          : 'Covers electronic toll charges so you don\u2019t have to worry about cash or fines'),
        price: totalWithFee, priceLabel: unitLabel,
        cta: feeNote,
      });
      continue;
    }

    // GPS / Navigation
    if (svcMatches(svc, 'gps', 'navigation', 'nav ')) {
      const contextBoost = isAirport ? 7 : 4;
      recs.push({
        type: 'service', priority: Math.max(tenantPriority, contextBoost), item: svc,
        headline: svc.name,
        reason: customerDesc || (isAirport
          ? 'Navigate unfamiliar roads with confidence from day one'
          : 'Never miss a turn \u2014 built-in navigation for your trip'),
        price: totalWithFee, priceLabel: unitLabel,
        cta: feeNote,
      });
      continue;
    }

    // Roadside assistance — higher priority for longer trips
    if (svcMatches(svc, 'roadside', 'assistance', 'breakdown', 'tow')) {
      const contextBoost = tripDays >= 5 ? 7 : 5;
      recs.push({
        type: 'service', priority: Math.max(tenantPriority, contextBoost), item: svc,
        headline: svc.name,
        reason: customerDesc || (tripDays >= 5
          ? `${tripDays}-day trip \u2014 peace of mind for longer adventures`
          : '24/7 help if you ever need it on the road'),
        price: totalWithFee, priceLabel: unitLabel,
        cta: feeNote,
      });
      continue;
    }

    // Child/baby seat
    if (svcMatches(svc, 'child', 'baby', 'booster', 'infant', 'car seat', 'carseat')) {
      recs.push({
        type: 'service', priority: Math.max(tenantPriority, 3), item: svc,
        headline: svc.name,
        reason: customerDesc || 'Traveling with little ones? We have seats ready to install',
        price: totalWithFee, priceLabel: unitLabel,
        cta: feeNote,
      });
      continue;
    }

    // WiFi / hotspot
    if (svcMatches(svc, 'wifi', 'hotspot', 'internet', 'connectivity')) {
      const contextBoost = tripDays >= 3 ? 5 : 3;
      recs.push({
        type: 'service', priority: Math.max(tenantPriority, contextBoost), item: svc,
        headline: svc.name,
        reason: customerDesc || 'Stay connected on the go \u2014 great for navigation and streaming',
        price: totalWithFee, priceLabel: unitLabel,
        cta: feeNote,
      });
      continue;
    }

    // Prepaid fuel
    if (svcMatches(svc, 'fuel', 'gas', 'prepaid fuel', 'refuel')) {
      const contextBoost = isAirport ? 6 : 4;
      recs.push({
        type: 'service', priority: Math.max(tenantPriority, contextBoost), item: svc,
        headline: svc.name,
        reason: customerDesc || (isAirport
          ? 'Skip the gas station rush before your flight \u2014 return with any fuel level'
          : 'No need to refuel before returning \u2014 we handle it'),
        price: totalWithFee, priceLabel: unitLabel,
        cta: feeNote,
      });
      continue;
    }

    // Any service with tenant priority or description
    if (tenantPriority > 0 || customerDesc) {
      recs.push({
        type: 'service', priority: Math.max(tenantPriority, 2), item: svc,
        headline: svc.name,
        reason: customerDesc || svc.name,
        price: totalWithFee, priceLabel: unitLabel,
        cta: feeNote,
      });
    }
  }

  // Sort by priority descending, then cap at 3
  recs.sort((a, b) => b.priority - a.priority);
  return recs.slice(0, 3);
}

/* ═══════════════════════════════════════════════════════════════════
   RECOMMENDATION CARD — A single subtle upsell item
   ═══════════════════════════════════════════════════════════════════ */
function RecommendationCard({ rec, index }) {
  const isInsurance = rec.type === 'insurance';
  const accentColor = isInsurance ? '#6e49ff' : '#0d9488';
  const accentBg = isInsurance ? 'rgba(110,73,255,.04)' : 'rgba(13,148,136,.04)';
  const accentBorder = isInsurance ? 'rgba(110,73,255,.15)' : 'rgba(13,148,136,.15)';

  return (
    <div style={{
      padding: '16px 18px', borderRadius: 16,
      background: accentBg, border: `1.5px solid ${accentBorder}`,
      transition: 'all .2s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, color: '#1a1230', fontSize: '0.98rem' }}>{rec.headline}</div>
          <div style={{ fontSize: '0.86rem', color: '#55456f', lineHeight: 1.55, marginTop: 5 }}>{rec.reason}</div>
          {rec.cta && rec.cta !== rec.reason && (
            <div style={{ fontSize: '0.82rem', color: '#6b7a9a', marginTop: 4, lineHeight: 1.5 }}>{rec.cta}</div>
          )}
          {rec.altNote && (
            <div style={{ fontSize: '0.8rem', color: accentColor, fontWeight: 600, marginTop: 6 }}>{rec.altNote}</div>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontWeight: 900, color: accentColor, fontSize: '1.05rem', whiteSpace: 'nowrap' }}>
            {money(rec.price)}<span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{rec.priceLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ACTIVE VIEW — Reservation loaded (smart sales version)
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
  const vehicleColor = vehicle?.color || null;
  const vehiclePlate = vehicle?.plate || null;
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

  const selectedInsurance = charges.find((c) => c.source === 'INSURANCE');
  const selectedServices = charges.filter((c) => c.source === 'ADDITIONAL_SERVICE' || c.source === 'ADDITIONAL_SERVICE_PRECHECKIN');
  const isOtaPrepaid = charges.some((c) => c.source === 'OTA_PREPAID_VOUCHER');
  const includedItems = [...(selectedInsurance ? [selectedInsurance] : []), ...selectedServices];

  // Smart recommendations
  const recommendations = buildRecommendations({ row, charges, insurancePlans, additionalServices });

  const companyName = branding?.companyName || 'Ride Fleet';

  return (
    <div style={shell}>
      {/* Brand header */}
      <div style={{ textAlign: 'center', padding: '16px 0 6px' }}>
        {branding?.companyLogoUrl ? (
          <img src={branding.companyLogoUrl} alt={companyName} style={{ maxHeight: 36, maxWidth: 180, objectFit: 'contain' }} />
        ) : (
          <div style={{ fontWeight: 900, fontSize: '1.3rem', color: '#1a1230', letterSpacing: '-.02em' }}>{companyName}</div>
        )}
      </div>

      {/* Welcome + Status */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: '1.2rem', color: '#1a1230' }}>
              {customer.firstName ? `Welcome, ${customer.firstName}` : 'Your Reservation'}
            </div>
            <div style={{ fontSize: '0.88rem', color: '#6b7a9a', marginTop: 3 }}>
              Reservation #{row?.reservationNumber}
            </div>
          </div>
          <StatusBadge status={status} />
        </div>
      </div>

      {/* Trip Details */}
      <div style={card}>
        <div style={sectionTitle}>Trip Details</div>
        <div style={grid2}>
          <div style={tile}>
            <div style={tileLabel}>Pickup</div>
            <div style={tileValue}>{fmtDate(row?.pickupAt)}</div>
            {pickupLocation && <div style={tileSub}>{[pickupLocation.name, pickupLocation.city].filter(Boolean).join(', ')}</div>}
          </div>
          <div style={tile}>
            <div style={tileLabel}>Return</div>
            <div style={tileValue}>{fmtDate(row?.returnAt)}</div>
            {returnLocation && <div style={tileSub}>{[returnLocation.name, returnLocation.city].filter(Boolean).join(', ')}</div>}
          </div>
        </div>
      </div>

      {/* Vehicle — with actual photo */}
      {vehicleLabel && (
        <div style={card}>
          <div style={sectionTitle}>Your Vehicle</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{
              width: 90, height: 68, borderRadius: 14, flexShrink: 0, overflow: 'hidden',
              background: vehicleTypeImage ? '#f8f7fc' : 'linear-gradient(135deg, rgba(110,73,255,.1), rgba(31,199,170,.08))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '1px solid rgba(110,73,255,.1)',
            }}>
              {vehicleTypeImage ? (
                <img src={vehicleTypeImage} alt={vehicleType?.name || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span style={{ fontSize: '2rem' }}>{'\uD83D\uDE97'}</span>
              )}
            </div>
            <div>
              <div style={{ fontWeight: 800, color: '#1a1230', fontSize: '1.08rem' }}>{vehicleLabel}</div>
              {vehicleType?.name && <div style={{ fontSize: '0.82rem', color: '#6b7a9a', marginTop: 2 }}>{vehicleType.name}</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                {vehicleColor && <span style={chip}>{vehicleColor}</span>}
                {vehiclePlate && <span style={chip}>Plate: {vehiclePlate}</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Progress */}
      <div style={card}>
        <div style={sectionTitle}>Reservation Progress</div>
        <div style={{ display: 'grid', gap: 10, padding: '4px 0' }}>
          <ProgressStep label="Reservation Created" done />
          <ProgressStep label="Pre-Check-in" done={precheckinDone} active={!precheckinDone && !isCheckedOut} />
          <ProgressStep label="Agreement Signed" done={signatureDone} active={precheckinDone && !signatureDone && !isCheckedOut} />
          <ProgressStep label="Payment" done={paymentDone} active={signatureDone && !paymentDone && !isCheckedOut} />
          <ProgressStep label="Checked Out" done={isCheckedOut || isCheckedIn} active={false} />
          <ProgressStep label="Returned" done={isCheckedIn} active={isCheckedOut} />
        </div>
      </div>

      {/* ── INCLUDED WITH YOUR TRIP ─────────────────────────────── */}
      {/* Shows what the customer already has — reinforces good choices */}
      {charges.filter(c => c.source !== 'OTA_PREPAID_VOUCHER').length > 0 && (
        <div style={card}>
          <div style={sectionTitle}>Included with Your Trip</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {charges.filter(c => c.source !== 'OTA_PREPAID_VOUCHER').map((c, i) => {
              const isProtection = c.source === 'INSURANCE';
              const isAddon = c.source === 'ADDITIONAL_SERVICE' || c.source === 'ADDITIONAL_SERVICE_PRECHECKIN';
              return (
                <div key={c.id || i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: '0.9rem', padding: '6px 0',
                  borderBottom: '1px solid rgba(110,73,255,.06)',
                  color: isProtection ? '#166534' : isAddon ? '#0d9488' : '#53607b',
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isProtection && <span style={{ fontSize: '0.85rem' }}>{'\uD83D\uDEE1\uFE0F'}</span>}
                    {isAddon && <span style={{ fontSize: '0.85rem' }}>{'\u2713'}</span>}
                    {c.name || 'Charge'}
                  </span>
                  <strong style={{ color: '#1a1230' }}>{money(c.total)}</strong>
                </div>
              );
            })}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTop: '2px solid rgba(110,73,255,.12)' }}>
              <span style={{ fontWeight: 800, color: '#1a1230' }}>Total</span>
              <span style={{ fontWeight: 900, fontSize: '1.2rem', color: '#1a1230' }}>{money(agreementTotal)}</span>
            </div>
            {paidTotal > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', color: '#166534' }}>
                <span>Paid</span><strong>{money(paidTotal)}</strong>
              </div>
            )}
            {balance > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', color: '#b45309' }}>
                <span>Remaining Balance</span><strong>{money(balance)}</strong>
              </div>
            )}
          </div>
        </div>
      )}

      {isOtaPrepaid && (
        <div style={{ ...card, background: 'rgba(245,158,11,.06)', borderColor: 'rgba(245,158,11,.2)' }}>
          <div style={{ fontWeight: 800, color: '#92400e', marginBottom: 6 }}>Prepaid Booking</div>
          <div style={{ fontSize: '0.88rem', color: '#78716c', lineHeight: 1.6 }}>
            Your base rental is covered. Any add-on services selected below apply separately.
          </div>
        </div>
      )}

      {/* ── RECOMMENDED FOR YOU ─────────────────────────────────── */}
      {/* Smart, contextual suggestions — max 3, never pushy */}
      {recommendations.length > 0 && !isComplete && (
        <div style={{
          ...card,
          background: 'linear-gradient(145deg, rgba(255,255,255,.95), rgba(110,73,255,.03))',
          borderColor: 'rgba(110,73,255,.12)',
          position: 'relative', overflow: 'hidden',
        }}>
          {/* Subtle ambient dot */}
          <div style={{ position: 'absolute', top: -20, right: -20, width: 80, height: 80, borderRadius: '50%', background: 'radial-gradient(circle, rgba(110,73,255,.06) 0%, transparent 70%)', pointerEvents: 'none' }} />

          <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '1rem' }}>{'\u2728'}</span>
            Recommended for You
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {recommendations.map((rec, i) => (
              <RecommendationCard key={rec.item?.code || rec.item?.id || i} rec={rec} index={i} />
            ))}
          </div>
          <div style={{
            marginTop: 14, textAlign: 'center', padding: '10px 16px',
            borderRadius: 12, background: 'rgba(110,73,255,.04)',
            fontSize: '0.86rem', color: '#6b7a9a', fontWeight: 600, lineHeight: 1.5,
          }}>
            Interested in any of these? Just let your agent know
          </div>
        </div>
      )}

      {/* Completion */}
      {isComplete && (
        <div style={{ ...card, background: 'linear-gradient(135deg, rgba(22,163,74,.06), rgba(110,73,255,.04))', borderColor: 'rgba(22,163,74,.18)', textAlign: 'center' }}>
          <div style={{ fontSize: '2.2rem', marginBottom: 8 }}>{'\u2705'}</div>
          <div style={{ fontWeight: 900, color: '#166534', fontSize: '1.15rem' }}>Trip Complete</div>
          <div style={{ fontSize: '0.9rem', color: '#55456f', marginTop: 4 }}>
            Thank you for renting with us! We hope you had a great experience.
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ textAlign: 'center', padding: '12px 0 20px', fontSize: '0.78rem', color: '#94a3b8' }}>
        {companyName} {'\u00B7'} This view updates automatically
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN PAGE — Orchestrates idle/active via BroadcastChannel
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
      if (!token) { setError('Session expired — please log in and reopen the display'); setLoading(false); return; }
      let result;
      try {
        result = await api(`/api/reservations/${id}/display-data`, { bypassCache: true }, token);
      } catch {
        // Fallback: if display-data endpoint not available, use regular reservation endpoint
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

  // Load branding on mount
  useEffect(() => {
    (async () => {
      try {
        const token = readStoredToken();
        if (!token) return;
        const settings = await api('/api/settings/rental-agreement', {}, token);
        setBranding({
          companyName: settings?.companyName || 'Ride Fleet',
          companyLogoUrl: settings?.companyLogoUrl || '',
          companyPhone: settings?.companyPhone || ''
        });
      } catch { /* use defaults */ }
    })();
  }, []);

  // BroadcastChannel listener
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'load-reservation' && msg.id) {
        activateReservation(msg.id);
      } else if (msg?.type === 'exit') {
        deactivate();
      }
    };
    // Announce we're ready
    ch.postMessage({ type: 'display-ready' });
    return () => { ch.close(); channelRef.current = null; };
  }, [activateReservation, deactivate]);

  // Check URL params on mount (fallback: ?id=xxx)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (id) activateReservation(id);
  }, [activateReservation]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  if (!reservationId) {
    return <IdleScreen branding={branding} />;
  }

  if ((loading && !data) || (!data && reservationId && !error)) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(145deg, #f0eef8, #e8e4f4, #f5f3fa)',
        fontFamily: "Aptos, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
      }}>
        <div style={{ ...card, textAlign: 'center', padding: 48, maxWidth: 400 }}>
          <p style={{ color: '#6b7a9a', fontWeight: 600 }}>Loading reservation...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(145deg, #f0eef8, #e8e4f4, #f5f3fa)',
        fontFamily: "Aptos, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
      }}>
        <div style={{ ...card, textAlign: 'center', padding: 48, maxWidth: 400 }}>
          <p style={{ color: '#991b1b', fontWeight: 600 }}>{error}</p>
          <p style={{ color: '#6b7a9a', fontSize: '0.85rem', marginTop: 8 }}>The display will retry automatically, or click Customer View again.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(145deg, #f0eef8, #e8e4f4, #f5f3fa)',
      fontFamily: "Aptos, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
    }}>
      <ActiveView data={data} branding={branding} />
    </div>
  );
}

/* ─── Shared Styles ─────────────────────────────────────────────── */
const shell = {
  maxWidth: 520,
  margin: '0 auto',
  padding: '8px 18px 24px',
  minHeight: '100vh',
};

const card = {
  padding: '18px 22px',
  borderRadius: 20,
  background: 'rgba(255,255,255,.92)',
  border: '1px solid rgba(110,73,255,.1)',
  boxShadow: '0 8px 28px rgba(47,58,114,.06)',
  marginBottom: 14,
};

const sectionTitle = {
  fontWeight: 800,
  fontSize: '0.86rem',
  color: '#6b7a9a',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  marginBottom: 12,
};

const grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };

const tile = {
  padding: '12px 14px',
  borderRadius: 14,
  background: 'rgba(110,73,255,.04)',
  border: '1px solid rgba(110,73,255,.08)',
};

const tileLabel = {
  fontSize: '0.72rem', fontWeight: 700, color: '#6b7a9a',
  textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4,
};

const tileValue = { fontWeight: 800, color: '#1a1230', fontSize: '0.92rem' };
const tileSub = { fontSize: '0.8rem', color: '#6b7a9a', marginTop: 3 };

const chip = {
  display: 'inline-block', padding: '3px 10px', borderRadius: 999,
  background: 'rgba(110,73,255,.06)', border: '1px solid rgba(110,73,255,.12)',
  color: '#4c1d95', fontSize: '0.78rem', fontWeight: 700,
};
