'use client';

/**
 * PaymentCard — one payment in a drill-down list, used by the Payments by Day
 * drawer (and any future report that surfaces individual payments).
 *
 * Expected `item` shape:
 *   { id, method, bucket, amount, reference, status, paidAt, notes,
 *     agreementNumber, customerName, pickupLocation }
 */

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// One pill per method enum value. Keep the labels short so the chip stays narrow.
const METHOD_STYLE = {
  CASH:          { bg: '#E1F5EE', fg: '#04342C', label: 'Cash' },
  CARD:          { bg: '#EEEDFE', fg: '#26215C', label: 'Card' },
  ZELLE:         { bg: '#EEEDFE', fg: '#26215C', label: 'Zelle' },
  ATH_MOVIL:     { bg: '#EEEDFE', fg: '#26215C', label: 'ATH Móvil' },
  CHECK:         { bg: '#FEF9C3', fg: '#713F12', label: 'Check' },
  BANK_TRANSFER: { bg: '#EEEDFE', fg: '#26215C', label: 'Bank xfer' },
  OTHER:         { bg: '#F1EFE8', fg: '#444441', label: 'Other' },
  AUTH_HOLD:     { bg: '#FAEEDA', fg: '#412402', label: 'Auth hold' },
};

export function PaymentCard({ item: p }) {
  const m = METHOD_STYLE[p.method] || { bg: '#f1efe8', fg: '#5F5E5A', label: p.method };
  return (
    <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, padding: '10px 12px', background: 'white' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13, color: '#211a38' }}>
            {p.customerName || '(no customer)'}
          </div>
          {p.agreementNumber ? (
            <div style={{ fontSize: 11, color: '#6f668f', marginTop: 1 }}>Agreement #{p.agreementNumber}</div>
          ) : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span style={{
            background: m.bg, color: m.fg, fontSize: 10,
            padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{m.label}</span>
          <span style={{ fontSize: 15, fontWeight: 500, color: '#211a38' }}>{fmtMoney(p.amount)}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#211a38', marginTop: 8, lineHeight: 1.5 }}>
        <div><span style={{ color: '#6f668f' }}>Paid at</span> {fmtDateTime(p.paidAt)}</div>
        {p.reference ? (
          <div><span style={{ color: '#6f668f' }}>Reference</span> {p.reference}</div>
        ) : null}
        {p.pickupLocation ? (
          <div><span style={{ color: '#6f668f' }}>Location</span> {p.pickupLocation}</div>
        ) : null}
        {p.notes ? (
          <div style={{ marginTop: 4, color: '#6f668f', fontSize: 11, fontStyle: 'italic' }}>{p.notes}</div>
        ) : null}
      </div>
    </div>
  );
}
