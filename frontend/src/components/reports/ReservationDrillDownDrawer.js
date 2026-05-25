'use client';

/**
 * Deprecated — superseded by ReservationListDrawer (Round 27).
 *
 * Kept as a thin re-export for backward compatibility. New code should import
 * `ReservationListDrawer` directly and pass a constructed `endpoint` URL
 * instead of the old `cell` prop shape.
 */

export { ReservationListDrawer as ReservationDrillDownDrawer } from './ReservationListDrawer';
