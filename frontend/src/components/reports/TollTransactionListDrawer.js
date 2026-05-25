'use client';

/**
 * TollTransactionListDrawer — drill-down drawer specialized for lists of
 * toll transactions. Thin wrapper around ListDrawer + TollTransactionCard.
 *
 * The endpoint is expected to return `{ transactions: [...], totalAmount?, transactionCount? }`.
 */

import { ListDrawer } from './ListDrawer';
import { TollTransactionCard } from './cards/TollTransactionCard';

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function TollTransactionListDrawer(props) {
  return (
    <ListDrawer
      {...props}
      dataKey="transactions"
      renderItem={(item) => <TollTransactionCard item={item} />}
      emptyMessage="No toll transactions for this selection."
      countLabel={(n) => `${n} transaction${n === 1 ? '' : 's'}`}
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
