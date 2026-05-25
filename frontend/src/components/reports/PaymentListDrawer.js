'use client';

/**
 * PaymentListDrawer — drill-down drawer specialized for lists of payments.
 * Thin wrapper around the generic ListDrawer + PaymentCard.
 *
 * The endpoint is expected to return `{ payments: [...], totalAmount?, paymentCount? }`.
 * If `totalAmount` is present, it's surfaced in the header as a chip so the
 * user sees the day-total at a glance.
 */

import { ListDrawer } from './ListDrawer';
import { PaymentCard } from './cards/PaymentCard';

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PaymentListDrawer(props) {
  return (
    <ListDrawer
      {...props}
      dataKey="payments"
      renderItem={(item) => <PaymentCard item={item} />}
      emptyMessage="No payments to show here."
      countLabel={(n) => `${n} payment${n === 1 ? '' : 's'}`}
      renderHeaderExtras={(data) =>
        typeof data?.totalAmount === 'number' ? (
          <div style={{ fontSize: 13, fontWeight: 500, color: '#211a38', marginTop: 6 }}>
            {fmtMoney(data.totalAmount)} collected
          </div>
        ) : null
      }
    />
  );
}
