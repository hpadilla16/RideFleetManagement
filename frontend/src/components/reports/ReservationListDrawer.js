'use client';

/**
 * ReservationListDrawer — drill-down drawer specialized for lists of
 * reservations. Thin wrapper around the generic ListDrawer + ReservationCard.
 *
 * Props match ListDrawer's: { open, endpoint, title, subtitle, token, onClose }.
 * The endpoint is expected to return `{ reservations: [...] }`.
 */

import { ListDrawer } from './ListDrawer';
import { ReservationCard } from './cards/ReservationCard';

export function ReservationListDrawer(props) {
  return (
    <ListDrawer
      {...props}
      dataKey="reservations"
      renderItem={(item) => <ReservationCard item={item} />}
      emptyMessage="No reservations to show here."
      countLabel={(n) => `${n} reservation${n === 1 ? '' : 's'}`}
    />
  );
}
