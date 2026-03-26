import { prisma } from '../../lib/prisma.js';

const DEFAULT_PRE_PICKUP_GRACE_MINUTES = 120;
const DEFAULT_POST_RETURN_GRACE_MINUTES = 180;

function tenantWhereForScope(scope = {}) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : {};
}

function toMoney(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : fallback;
}

function normalizeToken(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

function normalizeNullableToken(value) {
  const normalized = normalizeToken(value);
  return normalized || null;
}

function normalizeDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('transactionAt is invalid');
  return date;
}

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function startOfDay(date) {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

function mergeChargeNotes(existing, nextNote) {
  const base = String(existing || '').trim();
  const incoming = String(nextNote || '').trim();
  if (!incoming) return base || null;
  if (!base) return incoming;
  if (base.includes(incoming)) return base;
  return `${base}\n${incoming}`;
}

function transactionStatusLabel(status) {
  return String(status || '').replaceAll('_', ' ').toLowerCase();
}

function serializeTransaction(row) {
  const latestAssignment = Array.isArray(row.assignments) && row.assignments.length ? row.assignments[0] : null;
  return {
    id: row.id,
    externalId: row.externalId || '',
    transactionAt: row.transactionAt,
    transactionDate: row.transactionDate,
    transactionTimeRaw: row.transactionTimeRaw || '',
    amount: toMoney(row.amount),
    location: row.location || '',
    lane: row.lane || '',
    direction: row.direction || '',
    plateRaw: row.plateRaw || '',
    plateNormalized: row.plateNormalized || '',
    tagRaw: row.tagRaw || '',
    tagNormalized: row.tagNormalized || '',
    selloRaw: row.selloRaw || '',
    selloNormalized: row.selloNormalized || '',
    status: row.status,
    statusLabel: transactionStatusLabel(row.status),
    billingStatus: row.billingStatus,
    needsReview: !!row.needsReview,
    matchConfidence: row.matchConfidence == null ? null : Number(row.matchConfidence),
    reviewNotes: row.reviewNotes || '',
    vehicle: row.vehicle ? {
      id: row.vehicle.id,
      internalNumber: row.vehicle.internalNumber,
      plate: row.vehicle.plate || '',
      tollTagNumber: row.vehicle.tollTagNumber || '',
      tollStickerNumber: row.vehicle.tollStickerNumber || '',
      make: row.vehicle.make || '',
      model: row.vehicle.model || '',
      year: row.vehicle.year || null
    } : null,
    reservation: row.reservation ? {
      id: row.reservation.id,
      reservationNumber: row.reservation.reservationNumber,
      status: row.reservation.status,
      pickupAt: row.reservation.pickupAt,
      returnAt: row.reservation.returnAt,
      workflowMode: row.reservation.workflowMode,
      customer: row.reservation.customer ? {
        id: row.reservation.customer.id,
        firstName: row.reservation.customer.firstName,
        lastName: row.reservation.customer.lastName
      } : null
    } : null,
    latestAssignment: latestAssignment ? {
      id: latestAssignment.id,
      status: latestAssignment.status,
      confidence: latestAssignment.confidence == null ? null : Number(latestAssignment.confidence),
      matchReason: latestAssignment.matchReason || '',
      reservation: latestAssignment.reservation ? {
        id: latestAssignment.reservation.id,
        reservationNumber: latestAssignment.reservation.reservationNumber,
        pickupAt: latestAssignment.reservation.pickupAt,
        returnAt: latestAssignment.reservation.returnAt
      } : null
    } : null
  };
}

async function ensureTenantAllowsTolls(scope = {}) {
  if (!scope?.tenantId) return;
  const tenant = await prisma.tenant.findUnique({
    where: { id: scope.tenantId },
    select: { tollsEnabled: true }
  });
  if (!tenant?.tollsEnabled) throw new Error('Tolls is not enabled for this tenant');
}

async function listTenantVehiclesForMatch(scope = {}, transaction = null) {
  const where = tenantWhereForScope(scope);
  if (transaction) {
    const matches = [];
    const plate = normalizeNullableToken(transaction.plateRaw || transaction.plateNormalized);
    const tag = normalizeNullableToken(transaction.tagRaw || transaction.tagNormalized);
    const sello = normalizeNullableToken(transaction.selloRaw || transaction.selloNormalized);
    if (plate) matches.push({ plate });
    if (tag) matches.push({ tollTagNumber: tag });
    if (sello) matches.push({ tollStickerNumber: sello });
    if (matches.length) where.OR = matches;
  }

  const rows = await prisma.vehicle.findMany({
    where,
    select: {
      id: true,
      tenantId: true,
      internalNumber: true,
      plate: true,
      tollTagNumber: true,
      tollStickerNumber: true,
      make: true,
      model: true,
      year: true
    }
  });

  return rows.map((row) => ({
    ...row,
    plateNormalized: normalizeNullableToken(row.plate),
    tollTagNumberNormalized: normalizeNullableToken(row.tollTagNumber),
    tollStickerNumberNormalized: normalizeNullableToken(row.tollStickerNumber)
  }));
}

async function listReservationCandidates(scope = {}, vehicleIds = [], transactionAt = null) {
  if (!vehicleIds.length || !transactionAt) return [];
  const transactionDate = normalizeDateTime(transactionAt);
  const dayWindowStart = new Date(transactionDate.getTime() - 1000 * 60 * 60 * 24 * 3);
  const dayWindowEnd = new Date(transactionDate.getTime() + 1000 * 60 * 60 * 24 * 3);

  return prisma.reservation.findMany({
    where: {
      ...tenantWhereForScope(scope),
      vehicleId: { in: vehicleIds },
      pickupAt: { lte: dayWindowEnd },
      returnAt: { gte: dayWindowStart },
      status: { not: 'CANCELLED' }
    },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true } },
      vehicle: {
        select: {
          id: true,
          internalNumber: true,
          plate: true,
          tollTagNumber: true,
          tollStickerNumber: true
        }
      }
    },
    orderBy: [{ pickupAt: 'asc' }]
  });
}

function scoreCandidate({ transaction, vehicle, reservation, siblingCandidates = 1 }) {
  const plate = normalizeNullableToken(transaction.plateRaw || transaction.plateNormalized);
  const tag = normalizeNullableToken(transaction.tagRaw || transaction.tagNormalized);
  const sello = normalizeNullableToken(transaction.selloRaw || transaction.selloNormalized);
  const vehiclePlate = normalizeNullableToken(vehicle?.plate);
  const vehicleTag = normalizeNullableToken(vehicle?.tollTagNumber);
  const vehicleSello = normalizeNullableToken(vehicle?.tollStickerNumber);
  const when = normalizeDateTime(transaction.transactionAt);

  let score = 0;
  const reasons = [];

  if (vehicle?.id && reservation?.vehicleId && vehicle.id === reservation.vehicleId) {
    score += 60;
    reasons.push('vehicleId');
  }
  if (plate && vehiclePlate && plate === vehiclePlate) {
    score += 25;
    reasons.push('plate');
  }
  if (tag && vehicleTag && tag === vehicleTag) {
    score += 20;
    reasons.push('tag');
  }
  if (sello && vehicleSello && sello === vehicleSello) {
    score += 20;
    reasons.push('sello');
  }

  const prePickupAt = new Date(reservation.pickupAt.getTime() - DEFAULT_PRE_PICKUP_GRACE_MINUTES * 60 * 1000);
  const postReturnAt = new Date(reservation.returnAt.getTime() + DEFAULT_POST_RETURN_GRACE_MINUTES * 60 * 1000);
  if (when >= reservation.pickupAt && when <= reservation.returnAt) {
    score += 25;
    reasons.push('withinTripWindow');
  } else if (when >= prePickupAt && when <= postReturnAt) {
    score += 10;
    reasons.push('withinGraceWindow');
  }

  if (siblingCandidates > 1) {
    score -= 30;
    reasons.push('multipleCandidates');
  }

  return {
    score,
    matchReason: reasons.join(',') || 'manual-review'
  };
}

async function buildMatchSuggestion(transaction, scope = {}) {
  const vehicles = await listTenantVehiclesForMatch(scope, transaction);
  if (!vehicles.length) {
    return {
      vehicle: null,
      reservation: null,
      score: 0,
      matchStatus: null,
      needsReview: true,
      matchReason: 'vehicle-not-found'
    };
  }

  const vehicleIds = vehicles.map((vehicle) => vehicle.id);
  const reservations = await listReservationCandidates(scope, vehicleIds, transaction.transactionAt);
  if (!reservations.length) {
    return {
      vehicle: vehicles.length === 1 ? vehicles[0] : null,
      reservation: null,
      score: vehicles.length === 1 ? 45 : 0,
      matchStatus: null,
      needsReview: true,
      matchReason: vehicles.length === 1 ? 'vehicle-found-no-reservation-window' : 'multiple-vehicles-no-reservation'
    };
  }

  const candidates = reservations.map((reservation) => {
    const vehicle = vehicles.find((item) => item.id === reservation.vehicleId) || reservation.vehicle;
    const siblingCandidates = reservations.filter((item) => item.vehicleId === reservation.vehicleId).length;
    const scored = scoreCandidate({ transaction, vehicle, reservation, siblingCandidates });
    return {
      vehicle,
      reservation,
      score: scored.score,
      matchReason: scored.matchReason
    };
  }).sort((a, b) => b.score - a.score || new Date(a.reservation.pickupAt).getTime() - new Date(b.reservation.pickupAt).getTime());

  const top = candidates[0];
  const matchStatus = top.score >= 85 ? 'AUTO_CONFIRMED' : top.score >= 60 ? 'SUGGESTED' : null;
  return {
    vehicle: top.vehicle || null,
    reservation: top.reservation || null,
    score: top.score,
    matchStatus,
    needsReview: matchStatus !== 'AUTO_CONFIRMED',
    matchReason: top.matchReason || 'manual-review',
    candidates: candidates.slice(0, 5).map((candidate) => ({
      reservationId: candidate.reservation.id,
      reservationNumber: candidate.reservation.reservationNumber,
      vehicleId: candidate.vehicle?.id || candidate.reservation.vehicleId || null,
      vehicleInternalNumber: candidate.vehicle?.internalNumber || candidate.reservation.vehicle?.internalNumber || '',
      score: candidate.score,
      matchReason: candidate.matchReason
    }))
  };
}

async function createAssignmentRecord(tx, transaction, suggestion, matchedByUserId = null) {
  if (!suggestion?.reservation?.id) return null;
  return tx.tollAssignment.create({
    data: {
      tenantId: transaction.tenantId,
      tollTransactionId: transaction.id,
      reservationId: suggestion.reservation.id,
      vehicleId: suggestion.vehicle?.id || suggestion.reservation.vehicleId || null,
      status: suggestion.matchStatus || 'SUGGESTED',
      confidence: suggestion.score,
      matchedByUserId: matchedByUserId || null,
      matchReason: suggestion.matchReason || null
    }
  });
}

async function getTransactionOrThrow(id, scope = {}) {
  const row = await prisma.tollTransaction.findFirst({
    where: {
      id,
      ...tenantWhereForScope(scope)
    },
    include: {
      vehicle: true,
      reservation: {
        include: {
          customer: { select: { id: true, firstName: true, lastName: true } }
        }
      },
      assignments: {
        include: {
          reservation: { select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true } }
        },
        orderBy: [{ createdAt: 'desc' }]
      }
    }
  });
  if (!row) throw new Error('Toll transaction not found');
  return row;
}

async function refreshReservationEstimatedTotal(reservationId) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      charges: { where: { selected: true } }
    }
  });
  if (!reservation) return null;
  const estimatedTotal = Number((reservation.charges || []).reduce((sum, row) => sum + toMoney(row.total), 0).toFixed(2));
  await prisma.reservation.update({
    where: { id: reservationId },
    data: { estimatedTotal }
  });
  return estimatedTotal;
}

function reviewActionLabel(action) {
  switch (String(action || '').toUpperCase()) {
    case 'RESET_MATCH':
      return 'match reset';
    case 'MARK_DISPUTED':
      return 'marked disputed';
    case 'MARK_NOT_BILLABLE':
      return 'marked not billable';
    default:
      return 'review updated';
  }
}

export const tollsService = {
  async getDashboard(scope = {}, filters = {}) {
    await ensureTenantAllowsTolls(scope);
    const search = String(filters.q || '').trim();
    const searchFilter = search ? {
      OR: [
        { location: { contains: search, mode: 'insensitive' } },
        { plateRaw: { contains: search, mode: 'insensitive' } },
        { tagRaw: { contains: search, mode: 'insensitive' } },
        { selloRaw: { contains: search, mode: 'insensitive' } },
        { reservation: { reservationNumber: { contains: search, mode: 'insensitive' } } },
        { vehicle: { internalNumber: { contains: search, mode: 'insensitive' } } }
      ]
    } : {};

    const where = {
      ...tenantWhereForScope(scope),
      ...(filters.status ? { status: String(filters.status).toUpperCase() } : {}),
      ...(filters.needsReview === true ? { needsReview: true } : {}),
      ...(filters.reservationId ? { reservationId: String(filters.reservationId) } : {}),
      ...searchFilter
    };

    const [transactions, importedToday, matchedCount, reviewCount, billedCount, disputedCount] = await Promise.all([
      prisma.tollTransaction.findMany({
        where,
        include: {
          vehicle: true,
          reservation: {
            include: {
              customer: { select: { id: true, firstName: true, lastName: true } }
            }
          },
          assignments: {
            include: {
              reservation: { select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true } }
            },
            orderBy: [{ createdAt: 'desc' }]
          }
        },
        orderBy: [{ needsReview: 'desc' }, { transactionAt: 'desc' }],
        take: 200
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          createdAt: { gte: startOfDay(new Date()) }
        }
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          status: 'MATCHED'
        }
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          needsReview: true
        }
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          billingStatus: { in: ['POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT'] }
        }
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          billingStatus: 'DISPUTED'
        }
      })
    ]);

    return {
      metrics: {
        importedToday,
        matched: matchedCount,
        needsReview: reviewCount,
        postedToBilling: billedCount,
        disputed: disputedCount
      },
      transactions: transactions.map(serializeTransaction)
    };
  },

  async createManualTransactions(rows = [], scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for manual toll imports');
    const inputRows = (Array.isArray(rows) ? rows : []).filter(Boolean);
    if (!inputRows.length) throw new Error('rows are required');

    const created = [];
    for (const raw of inputRows) {
      const transactionAt = normalizeDateTime(raw.transactionAt);
      const plateRaw = String(raw.plate || raw.plateRaw || '').trim();
      const tagRaw = String(raw.tag || raw.tagRaw || raw.tollTagNumber || '').trim();
      const selloRaw = String(raw.sello || raw.selloRaw || raw.tollStickerNumber || '').trim();
      const amount = toMoney(raw.amount);
      if (!(amount > 0)) throw new Error('amount must be > 0');

      const draft = {
        transactionAt,
        transactionDate: startOfDay(transactionAt),
        transactionTimeRaw: String(raw.transactionTimeRaw || '').trim() || transactionAt.toISOString().slice(11, 16),
        amount,
        location: String(raw.location || '').trim() || null,
        lane: String(raw.lane || '').trim() || null,
        direction: String(raw.direction || '').trim() || null,
        plateRaw: plateRaw || null,
        plateNormalized: normalizeNullableToken(plateRaw),
        tagRaw: tagRaw || null,
        tagNormalized: normalizeNullableToken(tagRaw),
        selloRaw: selloRaw || null,
        selloNormalized: normalizeNullableToken(selloRaw),
        externalId: String(raw.externalId || '').trim() || null,
        sourcePayloadJson: JSON.stringify(raw || {})
      };

      const suggestion = await buildMatchSuggestion(draft, scope);
      const row = await prisma.$transaction(async (tx) => {
        const createdTransaction = await tx.tollTransaction.create({
          data: {
            tenantId: scope.tenantId,
            providerAccountId: null,
            importRunId: null,
            externalId: draft.externalId,
            transactionAt: draft.transactionAt,
            transactionDate: draft.transactionDate,
            transactionTimeRaw: draft.transactionTimeRaw,
            amount: draft.amount,
            location: draft.location,
            lane: draft.lane,
            direction: draft.direction,
            plateRaw: draft.plateRaw,
            plateNormalized: draft.plateNormalized,
            tagRaw: draft.tagRaw,
            tagNormalized: draft.tagNormalized,
            selloRaw: draft.selloRaw,
            selloNormalized: draft.selloNormalized,
            vehicleId: suggestion.vehicle?.id || null,
            reservationId: suggestion.reservation?.id || null,
            status: suggestion.matchStatus === 'AUTO_CONFIRMED' ? 'MATCHED' : 'NEEDS_REVIEW',
            matchConfidence: suggestion.score || null,
            needsReview: suggestion.needsReview !== false,
            billingStatus: 'PENDING',
            sourcePayloadJson: draft.sourcePayloadJson,
            reviewNotes: suggestion.matchReason || null
          }
        });

        if (suggestion.reservation?.id) {
          await createAssignmentRecord(tx, createdTransaction, suggestion, actorUserId);
        }

        return createdTransaction;
      });

      created.push(await getTransactionOrThrow(row.id, scope));
    }

    return {
      created: created.map(serializeTransaction)
    };
  },

  async confirmMatch(id, payload = {}, scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    const transaction = await getTransactionOrThrow(id, scope);
    const reservationId = payload.reservationId ? String(payload.reservationId) : null;
    const reservationNumber = payload.reservationNumber ? String(payload.reservationNumber).trim() : '';

    let reservation = null;
    if (reservationId) {
      reservation = await prisma.reservation.findFirst({
        where: { id: reservationId, ...tenantWhereForScope(scope) },
        include: { vehicle: true, customer: { select: { id: true, firstName: true, lastName: true } } }
      });
    } else if (reservationNumber) {
      reservation = await prisma.reservation.findFirst({
        where: { reservationNumber, ...tenantWhereForScope(scope) },
        include: { vehicle: true, customer: { select: { id: true, firstName: true, lastName: true } } }
      });
    }
    if (!reservation) throw new Error('Reservation not found for toll match');

    const vehicle = reservation.vehicle || (reservation.vehicleId
      ? await prisma.vehicle.findUnique({ where: { id: reservation.vehicleId } })
      : null);

    const suggestion = {
      vehicle,
      reservation,
      score: payload.confidence != null ? Number(payload.confidence) : 100,
      matchStatus: 'CONFIRMED',
      matchReason: String(payload.matchReason || 'manual-confirmed').trim() || 'manual-confirmed'
    };

    await prisma.$transaction(async (tx) => {
      if (transaction.assignments?.length) {
        await tx.tollAssignment.updateMany({
          where: { tollTransactionId: transaction.id, status: { in: ['SUGGESTED', 'AUTO_CONFIRMED'] } },
          data: { status: 'REJECTED' }
        });
      }

      await tx.tollTransaction.update({
        where: { id: transaction.id },
        data: {
          vehicleId: reservation.vehicleId || vehicle?.id || null,
          reservationId: reservation.id,
          status: 'MATCHED',
          needsReview: false,
          matchConfidence: suggestion.score,
          reviewNotes: suggestion.matchReason
        }
      });

      await createAssignmentRecord(tx, transaction, suggestion, actorUserId);
    });

    return serializeTransaction(await getTransactionOrThrow(transaction.id, scope));
  },

  async postToReservation(id, payload = {}, scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    const transaction = await getTransactionOrThrow(id, scope);
    if (!transaction.reservationId) throw new Error('Reservation match is required before posting a toll');
    if (['POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT'].includes(String(transaction.billingStatus || '').toUpperCase())) {
      return serializeTransaction(transaction);
    }

    const note = String(payload.note || '').trim();
    const chargeName = `Toll Charge${transaction.location ? ` - ${transaction.location}` : ''}`;
    const sourceRefId = transaction.id;

    await prisma.$transaction(async (tx) => {
      const existing = await tx.reservationCharge.findFirst({
        where: {
          reservationId: transaction.reservationId,
          source: 'TOLL_MODULE',
          sourceRefId
        }
      });

      if (existing) {
        await tx.reservationCharge.update({
          where: { id: existing.id },
          data: {
            name: chargeName,
            quantity: 1,
            rate: transaction.amount,
            total: transaction.amount,
            chargeType: 'UNIT',
            taxable: false,
            selected: true,
            notes: mergeChargeNotes(existing.notes, note)
          }
        });
      } else {
        const currentMaxSort = await tx.reservationCharge.aggregate({
          where: { reservationId: transaction.reservationId },
          _max: { sortOrder: true }
        });

        await tx.reservationCharge.create({
          data: {
            reservationId: transaction.reservationId,
            code: 'TOLL',
            name: chargeName,
            chargeType: 'UNIT',
            quantity: 1,
            rate: transaction.amount,
            total: transaction.amount,
            taxable: false,
            selected: true,
            sortOrder: Number(currentMaxSort._max.sortOrder || 0) + 1,
            source: 'TOLL_MODULE',
            sourceRefId,
            notes: note || null
          }
        });
      }

      await tx.tollTransaction.update({
        where: { id: transaction.id },
        data: {
          billingStatus: 'POSTED_TO_RESERVATION',
          status: 'BILLED',
          reviewNotes: mergeChargeNotes(transaction.reviewNotes, note ? `Posted to reservation: ${note}` : 'Posted to reservation')
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: transaction.tenantId,
          reservationId: transaction.reservationId,
          actorUserId: actorUserId || null,
          action: 'UPDATE',
          metadata: JSON.stringify({
            tollPostedToReservation: true,
            tollTransactionId: transaction.id,
            amount: toMoney(transaction.amount)
          })
        }
      });
    });

    await refreshReservationEstimatedTotal(transaction.reservationId);
    return serializeTransaction(await getTransactionOrThrow(transaction.id, scope));
  },

  async applyReviewAction(id, payload = {}, scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    const transaction = await getTransactionOrThrow(id, scope);
    const action = String(payload.action || '').toUpperCase();
    const note = String(payload.note || '').trim();
    if (!['RESET_MATCH', 'MARK_DISPUTED', 'MARK_NOT_BILLABLE'].includes(action)) {
      throw new Error('Unsupported toll review action');
    }

    await prisma.$transaction(async (tx) => {
      if (action === 'RESET_MATCH') {
        await tx.tollAssignment.updateMany({
          where: {
            tollTransactionId: transaction.id,
            status: { in: ['SUGGESTED', 'AUTO_CONFIRMED', 'CONFIRMED'] }
          },
          data: { status: 'REJECTED' }
        });

        await tx.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            reservationId: null,
            status: 'NEEDS_REVIEW',
            needsReview: true,
            matchConfidence: null,
            billingStatus: transaction.billingStatus === 'DISPUTED' ? 'DISPUTED' : 'PENDING',
            reviewNotes: mergeChargeNotes(transaction.reviewNotes, note || 'Match reset for manual review')
          }
        });
      }

      if (action === 'MARK_DISPUTED') {
        await tx.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            status: 'DISPUTED',
            billingStatus: 'DISPUTED',
            needsReview: true,
            reviewNotes: mergeChargeNotes(transaction.reviewNotes, note || 'Marked disputed')
          }
        });
      }

      if (action === 'MARK_NOT_BILLABLE') {
        await tx.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            status: 'VOID',
            billingStatus: 'WAIVED',
            needsReview: false,
            reviewNotes: mergeChargeNotes(transaction.reviewNotes, note || 'Marked not billable')
          }
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: transaction.tenantId,
          reservationId: transaction.reservationId || null,
          actorUserId: actorUserId || null,
          action: 'UPDATE',
          metadata: JSON.stringify({
            tollReviewAction: action,
            tollTransactionId: transaction.id,
            note: note || null
          })
        }
      });
    });

    return {
      action,
      actionLabel: reviewActionLabel(action),
      transaction: serializeTransaction(await getTransactionOrThrow(transaction.id, scope))
    };
  },

  async listReservationTolls(reservationId, scope = {}) {
    const reservation = await prisma.reservation.findFirst({
      where: {
        id: reservationId,
        ...tenantWhereForScope(scope)
      },
      select: {
        id: true,
        reservationNumber: true
      }
    });
    if (!reservation) throw new Error('Reservation not found');

    const rows = await prisma.tollTransaction.findMany({
      where: {
        reservationId,
        ...tenantWhereForScope(scope)
      },
      include: {
        vehicle: true,
        reservation: {
          include: {
            customer: { select: { id: true, firstName: true, lastName: true } }
          }
        },
        assignments: {
          include: {
            reservation: { select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true } }
          },
          orderBy: [{ createdAt: 'desc' }]
        }
      },
      orderBy: [{ transactionAt: 'desc' }]
    });

    const totalAmount = Number(rows.reduce((sum, row) => sum + toMoney(row.amount), 0).toFixed(2));
    const postedAmount = Number(rows
      .filter((row) => ['POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT'].includes(String(row.billingStatus || '').toUpperCase()))
      .reduce((sum, row) => sum + toMoney(row.amount), 0)
      .toFixed(2));

    return {
      reservationId,
      reservationNumber: reservation.reservationNumber,
      totals: {
        totalAmount,
        postedAmount,
        reviewCount: rows.filter((row) => row.needsReview).length
      },
      transactions: rows.map(serializeTransaction)
    };
  }
};
