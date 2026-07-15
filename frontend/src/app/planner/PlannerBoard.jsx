'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addDays, isPlannerAssignableReservation } from './planner-utils.mjs';
import {
  LANE_PITCH,
  boardRowHeight,
  computeVirtualWindow
} from './planner-board-helpers.mjs';

const RAIL_WIDTH = 240;
const BAR_HEIGHT = 26;

function vehicleDotClass(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'AVAILABLE') return 'pl-dot-ok';
  if (['ON_RENT', 'RESERVED'].includes(value)) return 'pl-dot-rent';
  return 'pl-dot-hold';
}

function mileageLabel(vehicle) {
  const mileage = Number(vehicle?.mileage);
  if (!Number.isFinite(mileage) || mileage <= 0) return '';
  return mileage >= 1000 ? ` · ${Math.round(mileage / 1000)}k mi` : ` · ${mileage} mi`;
}

function blockBarClass(blockType) {
  const value = String(blockType || '').toUpperCase();
  if (value === 'WASH_HOLD') return 'pl-bar pl-bar-wash';
  if (['MAINTENANCE_HOLD', 'OUT_OF_SERVICE_HOLD'].includes(value)) return 'pl-bar pl-bar-hold';
  return 'pl-bar pl-bar-mig';
}

function reservationTag(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'CONFIRMED') return 'CONF';
  if (value === 'CHECKED_OUT') return 'ON RENT';
  return value.slice(0, 8);
}

// PL-1/PL-2 board: sticky vehicle rail + timeline grid with windowed rows.
export function PlannerBoard({
  rows,
  dayCount,
  colWidth,
  rangeStart,
  todayIndex,
  dragItem,
  legalityMap,
  ghost,
  turnaroundMinutes,
  overbookedReservationIds,
  highlightOverbooked,
  onDropVehicle,
  onBarDragStart,
  onBarDragEnd,
  onBarTouchStart,
  onTouchDrop,
  onSelectReservation,
  onSelectBlock,
  onAddHold
}) {
  const { t } = useTranslation();
  const scrollRef = useRef(null);
  const rafRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [dragOverVehicleId, setDragOverVehicleId] = useState('');

  useEffect(() => {
    const measure = () => {
      if (scrollRef.current) setViewportHeight(scrollRef.current.clientHeight || 720);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    if (!dragItem) setDragOverVehicleId('');
  }, [dragItem]);

  const heights = useMemo(() => rows.map((row) => boardRowHeight(row)), [rows]);
  const windowInfo = useMemo(
    () => computeVirtualWindow({ heights, scrollTop, viewportHeight }),
    [heights, scrollTop, viewportHeight]
  );

  const handleScroll = (event) => {
    const nextTop = event.currentTarget.scrollTop;
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      setScrollTop(nextTop);
    });
  };

  const gridTemplateColumns = `${RAIL_WIDTH}px repeat(${dayCount}, ${colWidth}px)`;
  const turnaroundHours = Math.round(((turnaroundMinutes || 0) / 60) * 10) / 10;

  const illegalTip = (legality) => {
    const reason = legality?.reason;
    if (reason === 'OCCUPIED' || reason === 'TURNAROUND') {
      const conflict = legality.conflict;
      const until = conflict
        ? new Date(conflict.kind === 'block' ? conflict.availableFrom : conflict.returnAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '';
      return reason === 'TURNAROUND'
        ? t('planner.tipTurnaround', { until, hours: turnaroundHours })
        : t('planner.tipOccupied', { until });
    }
    if (reason === 'TYPE_MISMATCH') return t('planner.tipTypeMismatch');
    if (reason === 'CROSS_LOCATION') return t('planner.tipCrossLocation');
    if (reason === 'LOCKED_STATUS') return t('planner.tipLockedStatus');
    return t('planner.tipIllegal');
  };

  const renderDayHeaders = () => (
    Array.from({ length: dayCount }).map((_, index) => {
      const day = addDays(rangeStart, index);
      return (
        <div key={index} className={`pl-day ${index === todayIndex ? 'pl-day-today' : ''}`}>
          {new Date(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
        </div>
      );
    })
  );

  const renderBar = (item, vehicle) => {
    const top = 6 + (item.lane || 0) * LANE_PITCH;
    const left = item.start * colWidth + 2;
    const width = Math.max(14, item.span * colWidth - 4);

    if (item.kind === 'block') {
      const isWash = String(item.blockType || '').toUpperCase() === 'WASH_HOLD';
      return (
        <button
          key={`block-${item.id}`}
          type="button"
          className={blockBarClass(item.blockType)}
          style={{ left, top, width, height: BAR_HEIGHT }}
          onClick={() => onSelectBlock({ block: item, vehicle })}
          title={`${item.reason || ''}`.trim() || undefined}
        >
          <span className="pl-bar-text">{isWash ? '🧽' : '🔧'} {item.reason || item.blockType}</span>
        </button>
      );
    }

    // Draggability mirrors the backend's ASSIGNABLE_STATUSES — CHECKED_IN /
    // PENDING_FRANCHISE_IMPORT bars would only 409 on drop (QA 2026-07-14).
    const locked = !isPlannerAssignableReservation(item);
    const overbooked = (overbookedReservationIds || []).includes(item.id);
    const classes = [
      'pl-bar',
      locked ? 'pl-bar-locked' : 'pl-bar-res',
      overbooked ? 'pl-bar-overbooked' : '',
      overbooked && highlightOverbooked ? 'pl-bar-pulse' : '',
      dragItem?.id === item.id ? 'pl-dragging' : ''
    ].filter(Boolean).join(' ');

    return (
      <div
        key={item.id}
        role="button"
        tabIndex={0}
        className={classes}
        draggable={!locked}
        onDragStart={(e) => { if (!locked) onBarDragStart(item, e); }}
        onDragEnd={onBarDragEnd}
        onTouchStart={(e) => { if (!locked) onBarTouchStart(item, e); }}
        onTouchEnd={locked ? undefined : onTouchDrop}
        onClick={() => onSelectReservation({ reservation: item, locked, overbooked })}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectReservation({ reservation: item, locked, overbooked }); } }}
        style={{ left, top, width, height: BAR_HEIGHT }}
        title={`${item.reservationNumber || ''}${locked ? ` (${t('planner.lockedTag')})` : ''}`}
      >
        <span className="pl-bar-text">
          {item.reservationNumber} · {item.customer?.lastName || item.customer?.firstName || ''}
          <span className="pl-bar-tag">{reservationTag(item.status)}</span>
        </span>
      </div>
    );
  };

  const renderRow = (row) => {
    if (row.kind === 'group') {
      return (
        <div key={row.id} className="pl-row pl-row-group" style={{ gridTemplateColumns, height: boardRowHeight(row) }}>
          <div className="pl-rail pl-rail-group pl-sticky-left">
            {row.label}{row.code ? ` · ${row.code}` : ''} · {t('planner.groupUnits', { count: row.count })}
          </div>
          <div className="pl-lane pl-lane-group" style={{ gridColumn: `2 / span ${dayCount}` }} />
        </div>
      );
    }

    const track = row.track;
    const vehicle = track.vehicle;
    const legality = dragItem ? legalityMap?.[vehicle.id] : null;
    const showLegality = !!dragItem && !!legality;
    const laneClasses = [
      'pl-lane',
      showLegality && legality.legal ? 'pl-lane-legal' : '',
      showLegality && !legality.legal ? 'pl-lane-illegal' : ''
    ].filter(Boolean).join(' ');

    return (
      <div key={row.id} className="pl-row" style={{ gridTemplateColumns, height: boardRowHeight(row) }}>
        <div className="pl-rail pl-sticky-left">
          <div className="pl-veh-line">
            <span className="pl-plate">{vehicle.plate || `#${vehicle.internalNumber || '—'}`}</span>
            <span className={`pl-dot ${vehicleDotClass(vehicle.status)}`} />
          </div>
          <div className="pl-veh-meta">
            {[vehicle.make, vehicle.model].filter(Boolean).join(' ') || `#${vehicle.internalNumber || ''}`}{mileageLabel(vehicle)}
          </div>
          <button
            type="button"
            className="pl-hold-btn"
            onClick={() => onAddHold(vehicle)}
            title={t('planner.addHold')}
            aria-label={t('planner.addHold')}
          >
            ＋
          </button>
        </div>
        <div
          className={laneClasses}
          style={{ gridColumn: `2 / span ${dayCount}`, backgroundSize: `${colWidth}px 100%` }}
          data-drop-cell="1"
          data-vehicle-id={vehicle.id}
          onDragOver={(e) => {
            if (!dragItem) return;
            e.preventDefault();
            if (dragOverVehicleId !== vehicle.id) setDragOverVehicleId(vehicle.id);
          }}
          onDrop={(e) => {
            if (!dragItem) return;
            e.preventDefault();
            onDropVehicle(vehicle.id);
          }}
        >
          {todayIndex >= 0 && todayIndex < dayCount ? (
            <span className="pl-today-col" style={{ left: todayIndex * colWidth, width: colWidth }} />
          ) : null}
          {track.items.map((item) => renderBar(item, vehicle))}
          {showLegality && legality.legal && ghost ? (
            <span
              className="pl-ghostbar"
              style={{ left: ghost.start * colWidth + 2, top: 6, width: Math.max(14, ghost.span * colWidth - 4), height: BAR_HEIGHT }}
            >
              {t('planner.dropHere', { plate: vehicle.plate || `#${vehicle.internalNumber || ''}` })} ✓
            </span>
          ) : null}
          {showLegality && !legality.legal && dragOverVehicleId === vehicle.id ? (
            <span className="pl-tip">{illegalTip(legality)}</span>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="pl-board-scroll" ref={scrollRef} onScroll={handleScroll}>
      <div className="pl-grid-head" style={{ gridTemplateColumns }}>
        <div className="pl-corner pl-sticky-left">{t('planner.railHeader')}</div>
        {renderDayHeaders()}
      </div>
      {windowInfo.topPad > 0 ? <div style={{ height: windowInfo.topPad }} /> : null}
      {rows.slice(windowInfo.start, windowInfo.end).map((row) => renderRow(row))}
      {windowInfo.bottomPad > 0 ? <div style={{ height: windowInfo.bottomPad }} /> : null}
    </div>
  );
}
