'use client';

/**
 * TollTransactionCard — one TollTransaction in a drill-down list. Used by
 * the toll-per-vehicle and toll-per-location report drawers.
 *
 * Expected `item` shape:
 *   { id, transactionAt, transactionLabel, amount, location, lane, direction,
 *     plateRaw, tagRaw, status, needsReview }
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

const STATUS_STYLE = {
  IMPORTED:  { bg: '#EEEDFE', fg: '#26215C', label: 'Imported' },
  MATCHED:   { bg: '#EAF3DE', fg: '#173404', label: 'Matched' },
  ASSIGNED:  { bg: '#EAF3DE', fg: '#173404', label: 'Assigned' },
  CHARGED:   { bg: '#E1F5EE', fg: '#04342C', label: 'Charged' },
  DISPUTED:  { bg: '#FAEEDA', fg: '#412402', label: 'Disputed' },
  CANCELLED: { bg: '#F1EFE8', fg: '#444441', label: 'Cancelled' },
};

export function TollTransactionCard({ item: t }) {
  const s = STATUS_STYLE[t.status] || { bg: '#f1efe8', fg: '#5F5E5A', label: t.status };
  return (
    <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, padding: '10px 12px', background: 'white' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13, color: '#211a38' }}>
            {t.location || '(unknown plaza)'}
          </div>
          <div style={{ fontSize: 11, color: '#6f668f', marginTop: 1 }}>
            {fmtDateTime(t.transactionAt)}
            {t.lane ? ` · lane ${t.lane}` : ''}
            {t.direction ? ` · ${t.direction}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          {t.needsReview ? (
            <span style={{ background: '#FAEEDA', color: '#412402', fontSize: 10, padding: '2px 8px', borderRadius: 999 }}>
              Needs review
            </span>
          ) : (
            <span style={{ background: s.bg, color: s.fg, fontSize: 10, padding: '2px 8px', borderRadius: 999 }}>
              {s.label}
            </span>
          )}
          <span style={{ fontSize: 15, fontWeight: 500, color: '#211a38' }}>{fmtMoney(t.amount)}</span>
        </div>
      </div>
      {(t.plateRaw || t.tagRaw) ? (
        <div style={{ fontSize: 11, color: '#6f668f', marginTop: 6 }}>
          {t.plateRaw ? `Plate: ${t.plateRaw}` : ''}
          {t.plateRaw && t.tagRaw ? ' · ' : ''}
          {t.tagRaw ? `Tag: ${t.tagRaw}` : ''}
        </div>
      ) : null}
    </div>
  );
}
