/**
 * vehicle-status-sweep.poll — periodic drift repair for Vehicle.status.
 *
 * beta.116 (KII873 incident, 2026-06-05): UNIT-112/KII873 sat ON_RENT for two
 * days after its reservation checked in, because a pre-fix vehicle swap left
 * RentalAgreement.vehicleId stale and the check-in sync freed the wrong car.
 * The sync itself is hardened now (vehicle-status-sync.js), but this sweep is
 * the belt-and-suspenders: every SWEEP_INTERVAL_MS it repairs any vehicle
 * whose status drifted from the reservation truth, in both directions, and
 * logs a WARN (so the droplet log monitor surfaces it) whenever it had to
 * fix something — a fix means some code path forgot to sync and should be
 * hunted down.
 *
 * Same pattern as autocharge.poll.js: plain setInterval in the worker
 * process, no queue dependency, safe to run concurrently with the API.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { sweepVehicleStatusDrift } from './vehicle-status-sync.js';

const SWEEP_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.VEHICLE_DRIFT_SWEEP_MS || String(60 * 60 * 1000), 10) || 60 * 60 * 1000
);

let timerHandle = null;
let running = false;

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const { freed, rented } = await sweepVehicleStatusDrift(prisma);
    if (freed.length || rented.length) {
      // WARN on purpose: drift should be rare; each occurrence points at a
      // code path that failed to call syncVehicleStatusForReservation.
      logger.warn('[vehicle-drift-sweep] repaired vehicle status drift', {
        freedCount: freed.length,
        rentedCount: rented.length,
        freed: freed.map((v) => v.plate || v.internalNumber || v.vehicleId),
        rented: rented.map((v) => v.plate || v.internalNumber || v.vehicleId),
      });
    } else {
      logger.debug?.('[vehicle-drift-sweep] clean — no drift');
    }
  } catch (err) {
    logger.warn('[vehicle-drift-sweep] sweep failed', { message: err.message });
  } finally {
    running = false;
  }
}

export function startVehicleDriftSweep() {
  if (timerHandle) return;
  // First pass shortly after boot (give the DB pool a moment), then steady.
  setTimeout(() => { runOnce().catch(() => {}); }, 30 * 1000);
  timerHandle = setInterval(() => { runOnce().catch(() => {}); }, SWEEP_INTERVAL_MS);
  logger.info('[vehicle-drift-sweep] started', { intervalMs: SWEEP_INTERVAL_MS });
}

export function stopVehicleDriftSweep() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}
