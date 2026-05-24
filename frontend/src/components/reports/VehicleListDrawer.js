'use client';

/**
 * VehicleListDrawer — drill-down drawer specialized for lists of vehicles.
 * Thin wrapper around the generic ListDrawer + VehicleCard.
 *
 * The endpoint is expected to return `{ vehicles: [...], type? }`.
 */

import { ListDrawer } from './ListDrawer';
import { VehicleCard } from './cards/VehicleCard';

export function VehicleListDrawer(props) {
  return (
    <ListDrawer
      {...props}
      dataKey="vehicles"
      renderItem={(item) => <VehicleCard item={item} />}
      emptyMessage="No vehicles in this class for the selected location."
      countLabel={(n) => `${n} vehicle${n === 1 ? '' : 's'}`}
    />
  );
}
