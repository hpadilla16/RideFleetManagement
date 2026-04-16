const allowedTransitions = {
  NEW: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'],
  CHECKED_OUT: ['CHECKED_IN'],
  CHECKED_IN: [],
  CANCELLED: [],
  NO_SHOW: []
};

// Admin/Super Admin can force-cancel from these additional states
const adminOnlyTransitions = {
  CHECKED_OUT: ['CANCELLED'],
  CHECKED_IN: ['CANCELLED']
};

export function validateReservationCreate(input) {
  const errors = [];

  if (!input.reservationNumber) errors.push('reservationNumber is required');
  if (!input.customerId) errors.push('customerId is required');
  if (!input.pickupLocationId) errors.push('pickupLocationId is required');
  if (!input.returnLocationId) errors.push('returnLocationId is required');
  if (!input.pickupAt) errors.push('pickupAt is required');
  if (!input.returnAt) errors.push('returnAt is required');

  if (input.pickupAt && input.returnAt) {
    const pickup = new Date(input.pickupAt);
    const ret = new Date(input.returnAt);
    if (Number.isNaN(pickup.getTime()) || Number.isNaN(ret.getTime())) {
      errors.push('pickupAt and returnAt must be valid dates');
    } else if (ret <= pickup) {
      errors.push('returnAt must be later than pickupAt');
    }
  }

  if (input.status === 'CHECKED_OUT') {
    if (!input.vehicleId) errors.push('vehicleId is required when status is CHECKED_OUT');
  }

  return errors;
}

export function validateReservationPatch(current, patch, { role } = {}) {
  const errors = [];

  if (patch.pickupAt || patch.returnAt) {
    const pickup = new Date(patch.pickupAt || current.pickupAt);
    const ret = new Date(patch.returnAt || current.returnAt);
    if (Number.isNaN(pickup.getTime()) || Number.isNaN(ret.getTime())) {
      errors.push('pickupAt and returnAt must be valid dates');
    } else if (ret <= pickup) {
      errors.push('returnAt must be later than pickupAt');
    }
  }

  if (patch.status && patch.status !== current.status) {
    const allowed = allowedTransitions[current.status] || [];
    const isAdmin = role === 'SUPER_ADMIN' || role === 'ADMIN';
    const adminAllowed = isAdmin ? (adminOnlyTransitions[current.status] || []) : [];
    if (!allowed.includes(patch.status) && !adminAllowed.includes(patch.status)) {
      if (adminOnlyTransitions[current.status]?.includes(patch.status)) {
        errors.push(`Only an Admin can cancel a reservation that is already ${current.status.replace('_', ' ').toLowerCase()}. Please contact your administrator.`);
      } else {
        errors.push(`invalid status transition: ${current.status} -> ${patch.status}`);
      }
    }

    if (patch.status === 'CHECKED_OUT' && !(patch.vehicleId || current.vehicleId)) {
      errors.push('vehicleId is required before CHECKED_OUT');
    }

    if (patch.status === 'CANCELLED' && !String(patch.cancellationReason || '').trim()) {
      errors.push('cancellationReason is required when cancelling a reservation');
    }
  }

  return errors;
}
