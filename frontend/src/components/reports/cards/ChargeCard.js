'use client';

/**
 * ChargeCard — one RentalAgreementCharge line in a sales-by-category
 * drill-down list.
 *
 * Expected `item` shape:
 *   { id, name, code, chargeType, quantity, rate, amount,
 *     agreementNumber, customerName, pickupAt, pickupLocation }
 */

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

const TYPE_STYLE = {
  UNIT:    { bg: '#EEEDFE', fg: '#26215C' },
  DAILY:   { bg: '#E1F5EE', fg: '#04342C' },
  TAX:     { bg: '#FAEEDA', fg: '#412402' },
  PERCENT: { bg: '#FAEEDA', fg: '#412402' },
  DEPOSIT: { bg: '#F1EFE8', fg: '#444441' },
};

export function ChargeCard({ item: c }) {
  const t = TYPE_STYLE[c.chargeType] || { bg: '#f1efe8', fg: '#5F5E5A' };
  const qtyRate = (c.quantity && c.rate)
    ? `${Number(c.quantity).toLocaleString()} × ${fmtMoney(c.rate)}`
    : null;
  return (
    <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, padding: '10px 12px', background: 'white' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13, color: '#211a38' }}>{c.name || '(uncategorized)'}</div>
          {c.code ? <div style={{ fontSize: 11, color: '#6f668f', marginTop: 1 }}>{c.code}</div> : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          {c.chargeType ? (
            <span style={{ background: t.bg, color: t.fg, fontSize: 10, padding: '2px 8px', borderRadius: 999 }}>
              {c.chargeType}
            </span>
          ) : null}
          <span style={{ fontSize: 15, fontWeight: 500, color: '#211a38' }}>{fmtMoney(c.amount)}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#211a38', marginTop: 8, lineHeight: 1.5 }}>
        {c.customerName ? (
          <div><span style={{ color: '#6f668f' }}>Customer</span> {c.customerName}</div>
        ) : null}
        {c.agreementNumber ? (
          <div><span style={{ color: '#6f668f' }}>Agreement</span> #{c.agreementNumber}</div>
        ) : null}
        {c.pickupAt ? (
          <div><span style={{ color: '#6f668f' }}>Pickup</span> {fmtDate(c.pickupAt)}</div>
        ) : null}
        {c.pickupLocation ? (
          <div><span style={{ color: '#6f668f' }}>Location</span> {c.pickupLocation}</div>
        ) : null}
        {qtyRate ? (
          <div style={{ marginTop: 4, color: '#6f668f', fontSize: 11 }}>{qtyRate}</div>
        ) : null}
      </div>
    </div>
  );
}
