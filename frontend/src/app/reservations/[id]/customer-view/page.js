'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, readStoredToken } from '../../../../lib/client';

const POLL_INTERVAL = 8000;

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function fmtDate(v) {
  if (!v) return '—';
  try { return new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
}

function StatusBadge({ status }) {
  const map = {
    NEW: { bg: 'rgba(59,130,246,.1)', color: '#2563eb', border: 'rgba(59,130,246,.25)' },
    CONFIRMED: { bg: 'rgba(22,163,74,.08)', color: '#166534', border: 'rgba(22,163,74,.2)' },
    CHECKED_OUT: { bg: 'rgba(245,158,11,.1)', color: '#92400e', border: 'rgba(245,158,11,.25)' },
    CHECKED_IN: { bg: 'rgba(22,163,74,.1)', color: '#166534', border: 'rgba(22,163,74,.25)' },
    CANCELLED: { bg: 'rgba(220,38,38,.08)', color: '#991b1b', border: 'rgba(220,38,38,.2)' },
    NO_SHOW: { bg: 'rgba(107,114,128,.1)', color: '#4b5563', border: 'rgba(107,114,128,.2)' },
  };
  const s = String(status || 'NEW').toUpperCase();
  const m = map[s] || map.NEW;
  return (
    <span style={{ display: 'inline-block', padding: '6px 14px', borderRadius: 999, background: m.bg, border: `1px solid ${m.border}`, color: m.color, fontWeight: 800, fontSize: '0.84rem', letterSpacing: '.03em' }}>
      {s.replace(/_/g, ' ')}
    </span>
  );
}

function ProgressStep({ label, done, active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: done ? '#16a34a' : active ? '#7c3aed' : 'rgba(110,73,255,.1)',
        color: done || active ? '#fff' : '#a090c8',
        fontWeight: 800, fontSize: done ? 13 : 12,
        border: active ? '2px solid #7c3aed' : 'none',
        boxShadow: active ? '0 2px 8px rgba(110,73,255,.25)' : 'none',
      }}>
        {done ? '✓' : ''}
      </div>
      <span style={{ fontWeight: 700, fontSize: '0.9rem', color: done ? '#166534' : active ? '#4c1d95' : '#94a3b8' }}>{label}</span>
    </div>
  );
}

export default function CustomerViewPage() {
  const { id } = useParams();
  const [row, setRow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = async () => {
    try {
      const token = readStoredToken();
      if (!token) { setError('Session expired'); setLoading(false); return; }
      const data = await api(`/api/reservations/${id}`, { bypassCache: true }, token);
      setRow(data);
      setError('');
    } catch (e) {
      setError(e?.message || 'Unable to load reservation');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [id]);

  useEffect(() => {
    const interval = setInterval(loadData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [id]);

  if (loading && !row) {
    return (
      <div style={shell}>
        <div style={{ ...card, textAlign: 'center', padding: 48 }}>
          <p style={{ color: '#6b7a9a', fontWeight: 600 }}>Loading your reservation...</p>
        </div>
      </div>
    );
  }

  if (error && !row) {
    return (
      <div style={shell}>
        <div style={{ ...card, textAlign: 'center', padding: 48 }}>
          <p style={{ color: '#991b1b', fontWeight: 600 }}>{error}</p>
        </div>
      </div>
    );
  }

  const customer = row?.customer || {};
  const vehicle = row?.vehicle;
  const charges = Array.isArray(row?.charges) ? row.charges.filter((c) => c.selected) : [];
  const vehicleLabel = vehicle ? `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim() : null;
  const vehicleColor = vehicle?.color || null;
  const vehiclePlate = vehicle?.plate || null;
  const pickupLocation = row?.pickupLocation;
  const returnLocation = row?.returnLocation;
  const status = String(row?.status || 'NEW').toUpperCase();
  const hasAgreement = !!row?.rentalAgreement?.id;
  const agreementTotal = Number(row?.rentalAgreement?.total || row?.estimatedTotal || 0);
  const paidTotal = (row?.payments || []).reduce((sum, p) => sum + Number(p?.amount || 0), 0);
  const balance = Number((agreementTotal - paidTotal).toFixed(2));

  const precheckinDone = !!row?.customerInfoCompletedAt;
  const signatureDone = !!row?.signatureCompletedAt || !!row?.rentalAgreement?.signedAt;
  const paymentDone = balance <= 0 && paidTotal > 0;

  const isCheckedOut = status === 'CHECKED_OUT';
  const isCheckedIn = status === 'CHECKED_IN';
  const isComplete = isCheckedIn;

  const insuranceCharge = charges.find((c) => c.source === 'INSURANCE');
  const serviceCharges = charges.filter((c) => c.source === 'ADDITIONAL_SERVICE' || c.source === 'ADDITIONAL_SERVICE_PRECHECKIN');
  const isOtaPrepaid = charges.some((c) => c.source === 'OTA_PREPAID_VOUCHER');

  return (
    <div style={shell}>
      {/* Brand header */}
      <div style={{ textAlign: 'center', padding: '20px 0 8px' }}>
        <div style={{ fontWeight: 900, fontSize: '1.3rem', color: '#1a1230', letterSpacing: '-.02em' }}>Ride Fleet</div>
        <div style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600, marginTop: 2 }}>Customer View</div>
      </div>

      {/* Welcome + Status */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: '1.15rem', color: '#1a1230' }}>
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

      {/* Vehicle */}
      {vehicleLabel && (
        <div style={card}>
          <div style={sectionTitle}>Your Vehicle</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(135deg, rgba(110,73,255,.1), rgba(31,199,170,.08))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.6rem', flexShrink: 0 }}>
              🚗
            </div>
            <div>
              <div style={{ fontWeight: 800, color: '#1a1230', fontSize: '1.05rem' }}>{vehicleLabel}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                {vehicleColor && <span style={chip}>{vehicleColor}</span>}
                {vehiclePlate && <span style={chip}>Plate: {vehiclePlate}</span>}
                {vehicle?.internalNumber && <span style={chip}>#{vehicle.internalNumber}</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Progress */}
      <div style={card}>
        <div style={sectionTitle}>Reservation Progress</div>
        <div style={{ display: 'grid', gap: 12, padding: '4px 0' }}>
          <ProgressStep label="Reservation Created" done />
          <ProgressStep label="Pre-Check-in" done={precheckinDone} active={!precheckinDone && !isCheckedOut} />
          <ProgressStep label="Agreement Signed" done={signatureDone} active={precheckinDone && !signatureDone && !isCheckedOut} />
          <ProgressStep label="Payment" done={paymentDone} active={signatureDone && !paymentDone && !isCheckedOut} />
          <ProgressStep label="Checked Out" done={isCheckedOut || isCheckedIn} active={false} />
          <ProgressStep label="Returned" done={isCheckedIn} active={isCheckedOut} />
        </div>
      </div>

      {/* Charges / Pricing */}
      {charges.length > 0 && !isOtaPrepaid && (
        <div style={card}>
          <div style={sectionTitle}>Trip Summary</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {charges.filter((c) => c.source !== 'OTA_PREPAID_VOUCHER').map((c, i) => (
              <div key={c.id || i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.9rem', color: '#53607b', padding: '4px 0', borderBottom: '1px solid rgba(110,73,255,.06)' }}>
                <span>{c.name || 'Charge'}</span>
                <strong style={{ color: '#1a1230' }}>{money(c.total)}</strong>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTop: '2px solid rgba(110,73,255,.12)' }}>
              <span style={{ fontWeight: 800, color: '#1a1230' }}>Total</span>
              <span style={{ fontWeight: 900, fontSize: '1.15rem', color: '#1a1230' }}>{money(agreementTotal)}</span>
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
            This reservation was prepaid through a third-party provider. Your daily rate, taxes, and standard fees are covered by your voucher.
          </div>
        </div>
      )}

      {/* Protection & Services */}
      {(insuranceCharge || serviceCharges.length > 0) && (
        <div style={card}>
          <div style={sectionTitle}>Your Selections</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {insuranceCharge && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderRadius: 12, background: 'rgba(22,163,74,.05)', border: '1px solid rgba(22,163,74,.15)' }}>
                <div>
                  <div style={{ fontWeight: 700, color: '#166534', fontSize: '0.9rem' }}>🛡 {insuranceCharge.name}</div>
                </div>
                <strong style={{ color: '#166534' }}>{money(insuranceCharge.total)}</strong>
              </div>
            )}
            {serviceCharges.map((svc, i) => (
              <div key={svc.id || i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderRadius: 12, background: 'rgba(110,73,255,.04)', border: '1px solid rgba(110,73,255,.1)' }}>
                <span style={{ fontWeight: 600, color: '#32405d', fontSize: '0.88rem' }}>{svc.name}</span>
                <strong style={{ color: '#1a1230', fontSize: '0.88rem' }}>{money(svc.total)}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Completion */}
      {isComplete && (
        <div style={{ ...card, background: 'linear-gradient(135deg, rgba(22,163,74,.06), rgba(110,73,255,.04))', borderColor: 'rgba(22,163,74,.18)', textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>✅</div>
          <div style={{ fontWeight: 900, color: '#166534', fontSize: '1.1rem' }}>Trip Complete</div>
          <div style={{ fontSize: '0.88rem', color: '#55456f', marginTop: 4 }}>
            Thank you for renting with us! We hope you had a great experience.
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ textAlign: 'center', padding: '16px 0 24px', fontSize: '0.78rem', color: '#94a3b8' }}>
        Ride Fleet · This view updates automatically
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const shell = {
  maxWidth: 480,
  margin: '0 auto',
  padding: '8px 16px 24px',
  minHeight: '100vh',
  fontFamily: "Aptos, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
};

const card = {
  padding: '18px 20px',
  borderRadius: 20,
  background: 'rgba(255,255,255,.92)',
  border: '1px solid rgba(110,73,255,.1)',
  boxShadow: '0 8px 24px rgba(47,58,114,.06)',
  marginBottom: 14,
};

const sectionTitle = {
  fontWeight: 800,
  fontSize: '0.88rem',
  color: '#6b7a9a',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  marginBottom: 12,
};

const grid2 = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
};

const tile = {
  padding: '12px 14px',
  borderRadius: 14,
  background: 'rgba(110,73,255,.04)',
  border: '1px solid rgba(110,73,255,.08)',
};

const tileLabel = {
  fontSize: '0.72rem',
  fontWeight: 700,
  color: '#6b7a9a',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  marginBottom: 4,
};

const tileValue = {
  fontWeight: 800,
  color: '#1a1230',
  fontSize: '0.92rem',
};

const tileSub = {
  fontSize: '0.8rem',
  color: '#6b7a9a',
  marginTop: 3,
};

const chip = {
  display: 'inline-block',
  padding: '3px 10px',
  borderRadius: 999,
  background: 'rgba(110,73,255,.06)',
  border: '1px solid rgba(110,73,255,.12)',
  color: '#4c1d95',
  fontSize: '0.78rem',
  fontWeight: 700,
};
