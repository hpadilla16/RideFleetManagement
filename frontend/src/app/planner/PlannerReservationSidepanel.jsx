'use client';

import Link from 'next/link';
import { reservationVehicleTypeLabel, turnReadyScore, turnReadyStatus } from './planner-utils.mjs';

export function PlannerReservationSidepanel({
  selectedReservation,
  vehicles,
  onClose
}) {
  if (!selectedReservation) return null;

  const assignedVehicle = selectedReservation.reservation.vehicleId
    ? (vehicles || []).find((vehicle) => vehicle.id === selectedReservation.reservation.vehicleId)
    : null;
  const turnReadySummary = assignedVehicle?.operationalSignals?.turnReady?.summary || '';
  const assignedStatus = turnReadyStatus(assignedVehicle);
  const assignedScore = turnReadyScore(assignedVehicle);

  return (
    <aside className="planner-sidepanel glass card">
      <div className="row-between" style={{ marginBottom: 6 }}>
        <h3>Reservation</h3>
        <button onClick={onClose}>Close</button>
      </div>
      <div style={{ fontWeight: 700 }}>{selectedReservation.reservation.reservationNumber}</div>
      <div className="label">{selectedReservation.reservation.customer?.firstName || ''} {selectedReservation.reservation.customer?.lastName || ''}</div>
      <div className="label">Vehicle type: {reservationVehicleTypeLabel(selectedReservation.reservation)}</div>
      <div className="label">
        Vehicle: {selectedReservation.reservation.vehicle?.internalNumber || 'Unassigned'}
      </div>
      {selectedReservation.reservation.vehicleId ? (
        <div className="label">
          Turn-Ready: {assignedStatus ? `${assignedStatus}${assignedScore != null ? ` (${assignedScore})` : ''}` : 'Unknown'}
        </div>
      ) : null}
      <div className="label">From: {new Date(selectedReservation.reservation.pickupAt).toLocaleString()}</div>
      <div className="label">To: {new Date(selectedReservation.reservation.returnAt).toLocaleString()}</div>
      <div className="label" style={{ marginBottom: 8 }}>{selectedReservation.locked ? 'Locked by agreement' : 'Movable reservation'}</div>
      {selectedReservation.overbooked ? (
        <div className="surface-note" style={{ marginBottom: 8, background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>
          This reservation could not be auto-accommodated and is currently counted as overbooking in this planner range.
        </div>
      ) : null}
      {selectedReservation.reservation.vehicleId && turnReadySummary ? (
        <div
          className="surface-note"
          style={{
            marginBottom: 8,
            background: assignedStatus === 'BLOCKED' ? '#fef2f2' : '#eff6ff',
            borderColor: assignedStatus === 'BLOCKED' ? '#fecaca' : '#bfdbfe',
            color: assignedStatus === 'BLOCKED' ? '#991b1b' : '#1d4ed8'
          }}
        >
          {turnReadySummary}
        </div>
      ) : null}
      <div style={{ display: 'grid', gap: 8 }}>
        <Link href={`/reservations/${selectedReservation.reservation.id}`}><button>Open Reservation</button></Link>
      </div>
    </aside>
  );
}

