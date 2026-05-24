'use client';

/**
 * ReservationCard — one reservation in a drill-down list. Used by every
 * report drawer that surfaces underlying reservations.
 *
 * Expected `item` shape:
 *   { id, reservationNumber, status, pickupAt, returnAt, customerName,
 *     vehicle: { plate?, label? }?, vehicleType?, pickupLocation? }
 */

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

const STATUS_STYLE = {
  NEW:                       { bg: '#EEEDFE', fg: '#26215C', label: 'New' },
  CONFIRMED:                 { bg: '#EAF3DE', fg: '#173404', label: 'Confirmed' },
  CHECKED_OUT:               { bg: '#FAEEDA', fg: '#412402', label: 'Checked out' },
  CHECKED_IN:                { bg: '#E1F5EE', fg: '#04342C', label: 'Checked in' },
  CHECKED_IN_UNPAID:         { bg: '#FCEBEB', fg: '#501313', label: 'Checked in · unpaid' },
  CANCELLED:                 { bg: '#F1EFE8', fg: '#444441', label: 'Cancelled' },
  NO_SHOW:                   { bg: '#FCEBEB', fg: '#501313', label: 'No show' },
  PENDING_FRANCHISE_IMPORT:  { bg: '#EEEDFE', fg: '#26215C', label: 'Pending import' },
};

export function ReservationCard({ item: r }) {
  const s = STATUS_STYLE[r.status] || { bg: '#f1efe8', fg: '#5F5E5A', label: r.status };
  return (
    <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, padding: '10px 12px', background: 'white' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13, color: '#211a38' }}>
            {r.customerName || '(no customer)'}
          </div>
          <div style={{ fontSize: 11, color: '#6f668f', marginTop: 1 }}>#{r.reservationNumber || r.id}</div>
        </div>
        <span style={{
          background: s.bg, color: s.fg, fontSize: 10,
          padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
        }}>{s.label}</span>
      </div>
      <div style={{ fontSize: 12, color: '#211a38', marginTop: 8, lineHeight: 1.5 }}>
        <div><span style={{ color: '#6f668f' }}>Pickup</span> {fmtDateTime(r.pickupAt)}</div>
        <div><span style={{ color: '#6f668f' }}>Return</span> {fmtDateTime(r.returnAt)}</div>
        {r.vehicleType ? (
          <div><span style={{ color: '#6f668f' }}>Type</span> {r.vehicleType}</div>
        ) : null}
        {r.vehicle?.plate || r.vehicle?.label ? (
          <div>
            <span style={{ color: '#6f668f' }}>Vehicle</span> {r.vehicle?.plate ? `[${r.vehicle.plate}] ` : ''}{r.vehicle?.label || ''}
          </div>
        ) : null}
        {r.pickupLocation ? (
          <div><span style={{ color: '#6f668f' }}>Location</span> {r.pickupLocation}</div>
        ) : null}
      </div>
    </div>
  );
}
