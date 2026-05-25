'use client';

/**
 * CommissionCard — one AgreementCommission row in a drill-down list.
 *
 * Expected `item` shape:
 *   { id, status, commissionAmount, grossRevenue, serviceRevenue, eligibleRevenue,
 *     calculatedAt, calculatedLabel, paidAt, approvedAt, monthKey,
 *     agreementId, agreementNumber, customerName, pickupAt, pickupLocation }
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

const STATUS_STYLE = {
  PAID:     { bg: '#EAF3DE', fg: '#173404', label: 'Paid' },
  APPROVED: { bg: '#EEEDFE', fg: '#26215C', label: 'Approved' },
  PENDING:  { bg: '#FAEEDA', fg: '#412402', label: 'Pending' },
  VOID:     { bg: '#F1EFE8', fg: '#444441', label: 'Void' },
};

export function CommissionCard({ item: c }) {
  const s = STATUS_STYLE[c.status] || { bg: '#f1efe8', fg: '#5F5E5A', label: c.status };
  return (
    <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, padding: '10px 12px', background: 'white' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13, color: '#211a38' }}>
            {c.customerName || '(no customer)'}
          </div>
          {c.agreementNumber ? (
            <div style={{ fontSize: 11, color: '#6f668f', marginTop: 1 }}>Agreement #{c.agreementNumber}</div>
          ) : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span style={{ background: s.bg, color: s.fg, fontSize: 10, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>
            {s.label}
          </span>
          <span style={{ fontSize: 15, fontWeight: 500, color: '#211a38' }}>{fmtMoney(c.commissionAmount)}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#211a38', marginTop: 8, lineHeight: 1.5 }}>
        <div><span style={{ color: '#6f668f' }}>Calculated</span> {c.calculatedLabel || fmtDate(c.calculatedAt)}</div>
        {c.paidAt ? <div><span style={{ color: '#6f668f' }}>Paid</span> {fmtDate(c.paidAt)}</div> : null}
        {c.approvedAt && !c.paidAt ? <div><span style={{ color: '#6f668f' }}>Approved</span> {fmtDate(c.approvedAt)}</div> : null}
        {c.pickupLocation ? <div><span style={{ color: '#6f668f' }}>Location</span> {c.pickupLocation}</div> : null}
        {c.monthKey ? <div><span style={{ color: '#6f668f' }}>Month</span> {c.monthKey}</div> : null}
      </div>
      {(c.grossRevenue > 0 || c.serviceRevenue > 0 || c.eligibleRevenue > 0) ? (
        <div style={{ fontSize: 11, color: '#6f668f', marginTop: 8, padding: 8, background: '#f1efe8', borderRadius: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span><span style={{ color: '#6f668f' }}>Gross</span> {fmtMoney(c.grossRevenue)}</span>
          <span><span style={{ color: '#6f668f' }}>Service</span> {fmtMoney(c.serviceRevenue)}</span>
          <span><span style={{ color: '#6f668f' }}>Eligible</span> {fmtMoney(c.eligibleRevenue)}</span>
        </div>
      ) : null}
    </div>
  );
}
