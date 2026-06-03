/**
 * Mid-wizard vehicle swap.
 *
 * The change-vehicle button is available from steps 1-4 of
 * checkout-wizard-v2. It atomically updates BOTH:
 *   • Reservation.vehicleId
 *   • RentalAgreement.vehicleId (this is the field that drifted before
 *     today's fix — keep them in sync)
 *
 * Refuses when:
 *   • The new vehicle has an overlapping CHECKED_OUT reservation
 *   • The new vehicle is SOLD or OUT_OF_SERVICE
 *   • The session is past INSPECTION_IN_PROGRESS (photos already taken
 *     on the previous car — can't swap retroactively)
 *
 * Appends a VEHICLE_SWAP event to the session log and creates an
 * RentalAgreementVehicleSwap row for the audit trail.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { appendEvent } from './state-machine.js';
import { CheckoutSessionError } from './checkout-session.service.js';

const STEPS_BLOCKING_SWAP = new Set([
  'INSPECTION_IN_PROGRESS',
  'CUSTOMER_SIGN_PENDING',
  'FINALIZING',
  'CLOSED',
  'CANCELLED',
]);

async function swapVehicle({ sessionId, newVehicleId, actorUserId }) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);
  if (!newVehicleId) throw new CheckoutSessionError('newVehicleId required', 400);

  const session = await prisma.checkoutSession.findUnique({
    where: { id: sessionId },
    include: {
      reservation: { select: { id: true, vehicleId: true, pickupAt: true, returnAt: true, tenantId: true } },
      agreement: { select: { id: true } },
    },
  });
  if (!session) throw new CheckoutSessionError('Session not found', 404);

  if (STEPS_BLOCKING_SWAP.has(session.currentStep)) {
    throw new CheckoutSessionError(
      `Cannot swap vehicle once inspection has started (currentStep=${session.currentStep})`,
      409, 'SWAP_LOCKED',
    );
  }

  const oldVehicleId = session.reservation.vehicleId;
  if (oldVehicleId === newVehicleId) {
    throw new CheckoutSessionError('New vehicle is the same as current', 400);
  }

  // Eligibility checks on the new vehicle.
  const newVehicle = await prisma.vehicle.findUnique({
    where: { id: newVehicleId },
    select: { id: true, status: true, tenantId: true },
  });
  if (!newVehicle) throw new CheckoutSessionError('New vehicle not found', 404);
  if (session.reservation.tenantId && newVehicle.tenantId !== session.reservation.tenantId) {
    throw new CheckoutSessionError('Vehicle belongs to another tenant', 403);
  }
  if (['SOLD', 'OUT_OF_SERVICE'].includes(newVehicle.status)) {
    throw new CheckoutSessionError(
      `Vehicle is ${newVehicle.status.toLowerCase()} — cannot rent`,
      409, 'VEHICLE_TERMINAL',
    );
  }

  // Overlap check: does the new vehicle have any active reservation
  // whose window overlaps this one's? Same logic the planner uses.
  const overlap = await prisma.reservation.findFirst({
    where: {
      vehicleId: newVehicleId,
      status: { in: ['CHECKED_OUT', 'CONFIRMED', 'NEW'] },
      pickupAt: { lt: session.reservation.returnAt },
      returnAt: { gt: session.reservation.pickupAt },
      id: { not: session.reservation.id },
    },
    select: { id: true, reservationNumber: true },
  });
  if (overlap) {
    throw new CheckoutSessionError(
      `Vehicle already reserved on this window (${overlap.reservationNumber})`,
      409, 'VEHICLE_DOUBLE_BOOKED',
    );
  }

  // Atomic swap — both rows must move together. If only Reservation
  // moves and Agreement stays, we get the late-fee drift bug from
  // earlier today's commits.
  const txnResults = await prisma.$transaction([
    prisma.reservation.update({
      where: { id: session.reservation.id },
      data: { vehicleId: newVehicleId },
    }),
    ...(session.agreement?.id
      ? [prisma.rentalAgreement.update({
          where: { id: session.agreement.id },
          data: { vehicleId: newVehicleId },
        })]
      : []),
    // Audit row in the existing vehicle-swap table. rentalAgreementId
    // is required by schema, so we skip the swap-log entry when there's
    // no agreement yet (very rare — pre-DRAFT). The event in the
    // CheckoutSession log below captures it either way.
    ...(session.agreement?.id
      ? [prisma.rentalAgreementVehicleSwap.create({
          data: {
            rentalAgreementId: session.agreement.id,
            actorUserId: actorUserId || null,
            previousVehicleId: oldVehicleId || null,
            nextVehicleId: newVehicleId,
            note: 'Swapped via checkout-wizard-v2 change-vehicle helper',
          },
        })]
      : []),
    prisma.checkoutSession.update({
      where: { id: sessionId },
      data: {
        events: appendEvent(session.events, {
          kind: 'VEHICLE_SWAP',
          fromVehicleId: oldVehicleId,
          toVehicleId: newVehicleId,
          actorUserId: actorUserId || null,
        }),
      },
    }),
  ]);

  logger.info('[checkout-session] vehicle swapped', {
    sessionId, fromVehicleId: oldVehicleId, toVehicleId: newVehicleId, actorUserId,
  });

  return {
    sessionId,
    fromVehicleId: oldVehicleId,
    toVehicleId: newVehicleId,
    session: txnResults[txnResults.length - 1],
  };
}

export const vehicleSwapService = { swapVehicle };
