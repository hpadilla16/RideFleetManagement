'use client';

/**
 * ChargeListDrawer — drill-down drawer specialized for lists of charges.
 * Thin wrapper around the generic ListDrawer + ChargeCard.
 *
 * The endpoint is expected to return `{ charges: [...], totalAmount?, chargeCount? }`.
 */

import { ListDrawer } from './ListDrawer';
import { ChargeCard } from './cards/ChargeCard';

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ChargeListDrawer(props) {
  return (
    <ListDrawer
      {...props}
      dataKey="charges"
      renderItem={(item) => <ChargeCard item={item} />}
      emptyMessage="No charges in this category for the selected window."
      countLabel={(n) => `${n} charge${n === 1 ? '' : 's'}`}
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
