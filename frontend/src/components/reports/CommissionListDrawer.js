'use client';

/**
 * CommissionListDrawer — drill-down drawer specialized for AgreementCommission
 * rows. Thin wrapper around ListDrawer + CommissionCard.
 *
 * Expected endpoint payload: { commissions: [...], totalAmount?, commissionCount? }.
 */

import { ListDrawer } from './ListDrawer';
import { CommissionCard } from './cards/CommissionCard';

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CommissionListDrawer(props) {
  return (
    <ListDrawer
      {...props}
      dataKey="commissions"
      renderItem={(item) => <CommissionCard item={item} />}
      emptyMessage="No commissions for this employee in the selected window."
      countLabel={(n) => `${n} commission${n === 1 ? '' : 's'}`}
      renderHeaderExtras={(data) =>
        typeof data?.totalAmount === 'number' ? (
          <div style={{ fontSize: 13, fontWeight: 500, color: '#211a38', marginTop: 6 }}>
            {fmtMoney(data.totalAmount)} total
          </div>
        ) : null
      }
    />
  );
}
