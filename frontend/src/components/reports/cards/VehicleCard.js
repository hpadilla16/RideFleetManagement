'use client';

/**
 * VehicleCard — one vehicle row in a drill-down list. Used by the Availability
 * report drawer (and any future report that surfaces individual vehicles).
 *
 * Expected `item` shape:
 *   { id, internalNumber, plate, label, color, mileage, status, homeLocation,
 *     currentReservation: { reservationNumber, customerName, customerPhone,
 *                           returnLabel, status } | null }
 */

import Link from 'next/link';

const STATUS_STYLE = {
  AVAILABLE:      { bg: '#EAF3DE', fg: '#173404', label: 'Available' },
  RESERVED:       { bg: '#EEEDFE', fg: '#26215C', label: 'Reserved' },
  ON_RENT:        { bg: '#FAEEDA', fg: '#412402', label: 'On rent' },
  IN_MAINTENANCE: { bg: '#F1EFE8', fg: '#444441', label: 'Maintenance' },
  OUT_OF_SERVICE: { bg: '#FCEBEB', fg: '#501313', label: 'Out of service' },
};

export function VehicleCard({ item: v }) {
  const s = STATUS_STYLE[v.status] || { bg: '#f1efe8', fg: '#5F5E5A', label: v.status };
  const r = v.currentReservation || null;
  return (
    <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, padding: '10px 12px', background: 'white' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13, color: '#211a38' }}>
            {v.plate ? `[${v.plate}] ` : ''}{v.label || '(unspecified)'}
          </div>
          <div style={{ fontSize: 11, color: '#6f668f', marginTop: 1 }}>
            #{v.internalNumber}
            {v.color ? ` · ${v.color}` : ''}
            {Number.isFinite(v.mileage) && v.mileage > 0 ? ` · ${v.mileage.toLocaleString()} mi` : ''}
          </div>
        </div>
        <span style={{
          background: s.bg, color: s.fg, fontSize: 10,
          padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
        }}>{s.label}</span>
      </div>
      {v.homeLocation ? (
        <div style={{ fontSize: 11, color: '#6f668f', marginTop: 6 }}>
          <span style={{ color: '#6f668f' }}>Home location</span> {v.homeLocation}
        </div>
      ) : null}
      {r ? (
        <div style={{ marginTop: 8, padding: '8px 10px', background: '#FAEEDA', color: '#412402', borderRadius: 6, fontSize: 12 }}>
          <div style={{ fontWeight: 500 }}>
            {r.customerName || '(no customer)'}
            {r.customerPhone ? <span style={{ fontWeight: 400, opacity: 0.85 }}> · {r.customerPhone}</span> : null}
          </div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
            <Link href={`/reservations/${r.id}`} style={{ color: '#412402', textDecoration: 'underline' }}>
              #{r.reservationNumber || r.id}
            </Link>
            {' · returns '}
            {r.returnLabel || 'unknown'}
          </div>
        </div>
      ) : null}
    </div>
  );
}
