'use client';

import { activeAvailabilityBlock, blockColor, blockTypeLabel, hasInspectionAttention, hasTelematicsAttention, hasTurnReadyAttention, statusColor, turnReadyScore, turnReadyStatus, turnReadyTone } from './planner-utils.mjs';

export function PlannerTrackRow({
  vehicle,
  trackLayout,
  dayCount,
  dayWidth,
  plannerOverbookedCount,
  lockedReservationIds,
  overbookedReservationIds,
  draggingId,
  onDropReservation,
  onDragReservationStart,
  onDragReservationEnd,
  onTouchReservationStart,
  onTouchDrop,
  onSelectReservation,
  onSelectBlock,
  onOpenBlockVehicle,
  onReleaseVehicleBlock
}) {
  const rows = trackLayout?.items || [];
  const laneCount = Math.max(1, trackLayout?.lanes || 1);
  const maxRowHeight = 170;
  const lanePitch = laneCount <= 2 ? 30 : Math.max(14, Math.floor((maxRowHeight - 12) / laneCount));
  const blockHeight = Math.max(10, lanePitch - 6);
  const rowHeight = Math.max(64, Math.min(maxRowHeight, laneCount * lanePitch + 12));
  const activeBlock = activeAvailabilityBlock(vehicle);

  return (
    <div className="planner-row" style={{ gridTemplateColumns: `260px repeat(${dayCount}, ${dayWidth}px)` }}>
      <div className="planner-cell planner-sticky planner-track-meta" style={{ minHeight: rowHeight }}>
        {activeBlock ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span className="status-chip warning">Blocked</span>
            <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
              Free {new Date(activeBlock.availableFrom).toLocaleString()}
            </span>
          </div>
        ) : null}
        <div style={{ fontWeight: 700 }}>{vehicle.make} {vehicle.model} {vehicle.year || ''}</div>
        <div className="label">#{vehicle.internalNumber} | {vehicle.vehicleType?.code || '-'}</div>
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
          Plate {vehicle.plate || 'Pending'}
        </div>
        {vehicle.id !== '__unassigned__' ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <span className={`status-chip ${turnReadyTone(turnReadyStatus(vehicle))}`}>
              Turn-Ready {turnReadyScore(vehicle) ?? '-'}
            </span>
            {['MEDIUM', 'HIGH'].includes(String(vehicle?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase()) ? (
              <span className={`status-chip ${String(vehicle?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase() === 'HIGH' ? 'warn' : 'neutral'}`}>
                Damage {vehicle.operationalSignals?.inspection?.damageTriage?.severity || 'Review'}
              </span>
            ) : null}
            {['LOW', 'CRITICAL'].includes(String(vehicle?.operationalSignals?.telematics?.fuelStatus || '').toUpperCase()) ? (
              <span className={`status-chip ${String(vehicle?.operationalSignals?.telematics?.fuelStatus || '').toUpperCase() === 'CRITICAL' ? 'warn' : 'neutral'}`}>
                Fuel {vehicle.operationalSignals?.telematics?.fuelStatus}
              </span>
            ) : null}
            {String(vehicle?.operationalSignals?.telematics?.gpsStatus || '').toUpperCase() === 'MISSING' ? (
              <span className="status-chip neutral">GPS Missing</span>
            ) : null}
            {hasInspectionAttention(vehicle) ? <span className="status-chip warn">Inspection Attention</span> : null}
            {hasTelematicsAttention(vehicle) ? <span className="status-chip neutral">Telematics {vehicle.operationalSignals?.telematics?.status || 'Attention'}</span> : null}
          </div>
        ) : null}
        {vehicle.id === '__unassigned__' && plannerOverbookedCount ? (
          <div className="surface-note" style={{ marginTop: 6, background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>
            {plannerOverbookedCount} booking(s) still flagged as overbooking in this visible range.
          </div>
        ) : null}
        {vehicle.id !== '__unassigned__' ? (
          <>
            {activeBlock ? (
              <div className="surface-note" style={{ marginTop: 6 }}>
                {blockTypeLabel(activeBlock.blockType)} | {activeBlock.reason || 'Legacy contract migration hold'}
              </div>
            ) : null}
            {hasInspectionAttention(vehicle) ? (
              <div className="surface-note" style={{ marginTop: 6, background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>
                {vehicle.operationalSignals?.inspection?.summary || 'Latest inspection needs review before the next assignment.'}
              </div>
            ) : null}
            {['MEDIUM', 'HIGH'].includes(String(vehicle?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase()) ? (
              <div
                className="surface-note"
                style={{
                  marginTop: 6,
                  background: String(vehicle?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase() === 'HIGH' ? '#fef2f2' : '#fff7ed',
                  borderColor: String(vehicle?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase() === 'HIGH' ? '#fecaca' : '#fed7aa',
                  color: String(vehicle?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase() === 'HIGH' ? '#991b1b' : '#9a3412'
                }}
              >
                {vehicle.operationalSignals?.inspection?.damageTriage?.recommendedAction || 'Latest inspection suggests damage review before dispatch.'}
              </div>
            ) : null}
            {hasTurnReadyAttention(vehicle) ? (
              <div
                className="surface-note"
                style={{
                  marginTop: 6,
                  background: turnReadyStatus(vehicle) === 'BLOCKED' ? '#fef2f2' : '#eff6ff',
                  borderColor: turnReadyStatus(vehicle) === 'BLOCKED' ? '#fecaca' : '#bfdbfe',
                  color: turnReadyStatus(vehicle) === 'BLOCKED' ? '#991b1b' : '#1d4ed8'
                }}
              >
                {vehicle.operationalSignals?.turnReady?.summary || 'Vehicle should be reviewed before the next turn.'}
              </div>
            ) : null}
            {['LOW', 'CRITICAL'].includes(String(vehicle?.operationalSignals?.telematics?.fuelStatus || '').toUpperCase()) ? (
              <div
                className="surface-note"
                style={{
                  marginTop: 6,
                  background: String(vehicle?.operationalSignals?.telematics?.fuelStatus || '').toUpperCase() === 'CRITICAL' ? '#fef2f2' : '#fff7ed',
                  borderColor: String(vehicle?.operationalSignals?.telematics?.fuelStatus || '').toUpperCase() === 'CRITICAL' ? '#fecaca' : '#fed7aa',
                  color: String(vehicle?.operationalSignals?.telematics?.fuelStatus || '').toUpperCase() === 'CRITICAL' ? '#991b1b' : '#9a3412'
                }}
              >
                {vehicle.operationalSignals?.telematics?.recommendedAction || 'Fuel level should be reviewed before dispatch.'}
              </div>
            ) : null}
            {String(vehicle?.operationalSignals?.telematics?.gpsStatus || '').toUpperCase() === 'MISSING' ? (
              <div className="surface-note" style={{ marginTop: 6 }}>
                {vehicle.operationalSignals?.telematics?.recommendedAction || 'Latest telematics update is missing GPS coordinates.'}
              </div>
            ) : null}
            {hasTelematicsAttention(vehicle) ? (
              <div className="surface-note" style={{ marginTop: 6 }}>
                {vehicle.operationalSignals?.telematics?.summary || 'Telematics feed needs review.'}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <button type="button" className="button-subtle" onClick={() => onOpenBlockVehicle(vehicle)}>
                {activeBlock ? 'Adjust Hold' : 'Add Hold'}
              </button>
              {activeBlock ? (
                <button type="button" className="button-subtle" onClick={() => onReleaseVehicleBlock(activeBlock.id)}>
                  Release
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {Array.from({ length: dayCount }).map((_, i) => (
        <div
          key={i}
          className="planner-cell planner-drop"
          style={{ minHeight: rowHeight }}
          data-drop-cell="1"
          data-track-id={vehicle.id}
          data-day-index={i}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onDropReservation(vehicle.id, i, {
              pointerOffsetWithinCellPx: e.clientX - rect.left
            });
          }}
        />
      ))}

      <div className="planner-overlay" style={{ left: 260, width: dayCount * dayWidth, height: rowHeight }}>
        {rows.map((rowItem) => {
          if (rowItem.kind === 'block') {
            const block = rowItem.block;
            return (
              <div
                key={`block-${block.id}`}
                className="planner-block"
                onClick={() => onSelectBlock({ block, vehicle: rowItem.vehicle })}
                style={{
                  left: rowItem.start * dayWidth + 2,
                  top: rowItem.lane * lanePitch + 4,
                  height: blockHeight,
                  width: Math.max(12, rowItem.span * dayWidth - 4),
                  background: blockColor(block),
                  opacity: 0.92,
                  cursor: 'pointer'
                }}
                title={`Blocked until ${new Date(block.availableFrom).toLocaleString()}`}
              >
                <span className="planner-block-text">{blockTypeLabel(block.blockType)} | {block.reason || 'Legacy contract'} | Free {new Date(block.availableFrom).toLocaleDateString()}</span>
              </div>
            );
          }

          const reservation = rowItem.reservation;
          const locked = lockedReservationIds.has(reservation.id);
          const overbooked = overbookedReservationIds.includes(reservation.id);
          return (
            <div
              key={reservation.id}
              className="planner-block"
              draggable={!locked}
              onDragStart={(e) => onDragReservationStart(reservation, e)}
              onDragEnd={onDragReservationEnd}
              onTouchStart={(e) => onTouchReservationStart(reservation, e)}
              onTouchEnd={onTouchDrop}
              onClick={() => onSelectReservation({ reservation, locked, overbooked })}
              style={{
                left: rowItem.start * dayWidth + 2,
                top: rowItem.lane * lanePitch + 4,
                height: blockHeight,
                width: Math.max(12, rowItem.span * dayWidth - 4),
                background: statusColor(reservation, locked, overbooked),
                opacity: locked ? 0.7 : (draggingId === reservation.id ? 0.85 : 1)
              }}
              title={`${reservation.reservationNumber} ${locked ? '(locked by agreement)' : ''}`}
            >
              <span className="planner-block-text">{overbooked ? 'Overbooked | ' : ''}{locked ? 'Locked | ' : ''}{reservation.reservationNumber} | {reservation.customer?.firstName || ''} {reservation.customer?.lastName || ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

