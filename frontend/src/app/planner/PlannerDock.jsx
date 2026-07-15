'use client';

import { useTranslation } from 'react-i18next';
import { fmtDay } from './planner-utils.mjs';
import { reservationMatchesSearch } from './planner-board-helpers.mjs';

const COLLAPSED_LIMIT = 6;

// PL-1 unassigned dock: horizontally scrollable cards, always visible.
// Cards are drag sources; the dock itself is a drop target to UNASSIGN.
export function PlannerDock({
  unassignedReservations,
  search,
  expanded,
  setExpanded,
  highlightOverbooked,
  overbookedReservationIds,
  dragItem,
  onDragCardStart,
  onDragCardEnd,
  onTouchCardStart,
  onTouchDrop,
  onSelectReservation,
  onDropToUnassign
}) {
  const { t } = useTranslation();
  const cards = (unassignedReservations || []).filter((reservation) => reservationMatchesSearch(reservation, search));
  const visibleCards = expanded ? cards : cards.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = cards.length - visibleCards.length;
  const droppable = !!dragItem?.vehicleId;

  return (
    <div
      className={`pl-dock ${expanded ? 'pl-dock-expanded' : ''} ${droppable ? 'pl-dock-droppable' : ''}`}
      data-dock-drop="1"
      onDragOver={(e) => { if (droppable) e.preventDefault(); }}
      onDrop={(e) => {
        if (!droppable) return;
        e.preventDefault();
        onDropToUnassign();
      }}
    >
      <span className="pl-dock-label">⚠ {t('planner.dockLabel', { count: cards.length })}</span>
      {cards.length === 0 ? (
        <span className="pl-dock-empty">{t('planner.dockEmpty')}</span>
      ) : null}
      {visibleCards.map((reservation) => {
        const overbooked = reservation.overbooked || (overbookedReservationIds || []).includes(reservation.id);
        return (
          <button
            key={reservation.id}
            type="button"
            className={[
              'pl-dcard',
              dragItem?.id === reservation.id ? 'pl-dragging' : '',
              overbooked && highlightOverbooked ? 'pl-dcard-overbooked' : ''
            ].filter(Boolean).join(' ')}
            draggable
            onDragStart={(e) => onDragCardStart(reservation, e)}
            onDragEnd={onDragCardEnd}
            onTouchStart={(e) => onTouchCardStart(reservation, e)}
            onTouchEnd={onTouchDrop}
            onClick={() => onSelectReservation({ reservation, locked: false, overbooked })}
          >
            <span className="pl-dcard-cls">{reservation.vehicleType?.code || reservation.vehicleType?.name || '—'}</span>
            {reservation.reservationNumber} · {reservation.customer?.lastName || reservation.customer?.firstName || ''} · {fmtDay(reservation.pickupAt)}→{fmtDay(reservation.returnAt)}
          </button>
        );
      })}
      {hiddenCount > 0 ? (
        <button type="button" className="pl-dcard pl-dcard-more" onClick={() => setExpanded(true)}>
          {t('planner.dockMore', { count: hiddenCount })}
        </button>
      ) : null}
      {expanded && cards.length > COLLAPSED_LIMIT ? (
        <button type="button" className="pl-dcard pl-dcard-more" onClick={() => setExpanded(false)}>
          {t('planner.dockCollapse')}
        </button>
      ) : null}
    </div>
  );
}
