import { prisma } from '../../lib/prisma.js';

const DEFAULT_PRE_PICKUP_GRACE_MINUTES = 120;
const DEFAULT_POST_RETURN_GRACE_MINUTES = 180;
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 15;
const AUTOEXPRESO_LOGIN_URL = 'https://www.autoexpreso.com/login?v=0.0.1';
const AUTOEXPRESO_BALANCE_URL = 'https://www.autoexpreso.com/dashboard/balance';
const AUTOEXPRESO_USERNAME_SELECTOR = "input[placeholder='Usuario o Correo Electronico'], input[placeholder='Usuario o Correo Electrónico'], input[placeholder*='Usuario'], input[placeholder*='Correo'], input[type='email'], input[type='text']";
const AUTOEXPRESO_PASSWORD_SELECTOR = "input[formcontrolname='password'], input[type='password']";
const AUTOEXPRESO_ACTIVITY_SELECTOR = 'div.az-media-list-activity';
const tollSyncLocks = new Set();

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

function normalizeComparableText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function clickAutoExpresoLoginButton(page) {
  const clicked = await page.evaluate(() => {
    const normalize = (value = '') => String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const candidates = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button']"));
    const target = candidates.find((element) => {
      const text = normalize(element.textContent || element.value || '');
      return text.includes('iniciar sesion') || text.includes('login') || text.includes('entrar');
    });
    if (!target) return false;
    target.click();
    return true;
  });

  if (!clicked) {
    await page.click("button[type='submit'], input[type='submit'], button");
  }
}

async function captureAutoExpresoPageState(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const hint = await page.evaluate(() => {
    const text = String(document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280);
    return text;
  }).catch(() => '');

  return {
    url,
    title: String(title || '').trim(),
    hint: String(hint || '').trim()
  };
}

async function waitForAutoExpresoTransactionState(page, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await page.$(AUTOEXPRESO_ACTIVITY_SELECTOR)) return 'transactions';

    const state = await page.evaluate(({ usernameSelector, passwordSelector }) => {
      const normalize = (value = '') => String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const bodyText = normalize(document.body?.innerText || '');
      const hasUsername = !!document.querySelector(usernameSelector);
      const hasPassword = !!document.querySelector(passwordSelector);
      const pathname = window.location.pathname || '';

      if ((hasUsername && hasPassword) || pathname.includes('/login')) {
        return 'login';
      }
      if (pathname.includes('/dashboard/balance') || bodyText.includes('ultimas transacciones') || bodyText.includes('últimas transacciones') || bodyText.includes('transacciones pendientes')) {
        return 'transactions';
      }
      if (bodyText.includes('estado de cuenta') || bodyText.includes('seleccione el mes y ano deseado') || bodyText.includes('seleccione el mes y año deseado')) {
        return 'account-statements';
      }
      if (bodyText.includes('captcha') || bodyText.includes('robot')) {
        return 'captcha';
      }
      if (bodyText.includes('credenciales') || bodyText.includes('incorrect') || bodyText.includes('intente nuevamente')) {
        return 'auth-error';
      }
      if (bodyText.includes('dashboard') || bodyText.includes('transacciones')) {
        return 'dashboard-loading';
      }
      return '';
    }, {
      usernameSelector: AUTOEXPRESO_USERNAME_SELECTOR,
      passwordSelector: AUTOEXPRESO_PASSWORD_SELECTOR
    }).catch(() => '');

    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return 'timeout';
}

async function scrapeAutoExpresoBalanceRows(page) {
  return page.evaluate(() => {
    const normalize = (value = '') => String(value).replace(/\s+/g, ' ').trim();
    const amountFromText = (value = '') => {
      const match = String(value).match(/\$\s*-?\d[\d,]*\.?\d*/);
      if (!match) return null;
      const parsed = Number(match[0].replace(/[^0-9.-]/g, ''));
      return Number.isFinite(parsed) ? Math.abs(parsed) : null;
    };

    const seen = new Set();
    const blocks = Array.from(document.querySelectorAll('div, li, article, section'));
    const candidates = [];

    for (const node of blocks) {
      const text = normalize(node.innerText || '');
      if (!text) continue;
      if (!/tablilla:/i.test(text)) continue;
      if (!/peaje:/i.test(text)) continue;
      if (!/\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s*[AP]M/i.test(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);

      const lines = text.split('\n').map((line) => normalize(line)).filter(Boolean);
      const plateMatch = text.match(/Tablilla:\s*([A-Z0-9-]+)/i);
      const selloMatch = text.match(/Sello:\s*([A-Z0-9-]+)/i);
      const peajeLine = lines.find((line) => /^Peaje:/i.test(line)) || '';
      const dateLine = lines.find((line) => /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s*[AP]M/i.test(line)) || '';
      const amountLine = lines.find((line) => /\$\s*-?\d[\d,]*\.?\d*/.test(line)) || text;

      candidates.push({
        plateRaw: plateMatch ? normalize(plateMatch[1]) : '',
        selloRaw: selloMatch ? normalize(selloMatch[1]) : '',
        amountRaw: amountLine,
        location: peajeLine.replace(/^Peaje:\s*/i, '').trim(),
        datetimeFull: dateLine,
        rawText: text
      });
    }

    return candidates
      .map((row) => ({
        ...row,
        amount: amountFromText(row.amountRaw)
      }))
      .filter((row) => row.plateRaw && row.datetimeFull && row.amount !== null);
  });
}

async function clickAutoExpresoNextPage(page) {
  return page.evaluate(() => {
    const normalize = (value = '') => String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const candidates = Array.from(document.querySelectorAll('a, button'));
    const next = candidates.find((element) => {
      const text = normalize(element.textContent || element.value || '');
      const aria = normalize(element.getAttribute('aria-label') || '');
      const parentClass = normalize(element.parentElement?.className || '');
      const disabled = element.hasAttribute('disabled') || parentClass.includes('disabled');
      if (disabled) return false;
      return aria.includes('next') || text === '»' || text === '›' || text === 'siguiente';
    });

    if (!next) return false;
    next.click();
    return true;
  });
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

function encodeSecret(value) {
  return value ? Buffer.from(String(value), 'utf8').toString('base64') : null;
}

function decodeSecret(value) {
  if (!value) return '';
  try {
    return Buffer.from(String(value), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function serializeProviderAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    isActive: !!row.isActive,
    username: row.username || '',
    settings: safeJsonParse(row.settingsJson, {}),
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus || '',
    lastSyncMessage: row.lastSyncMessage || '',
    hasPassword: !!row.passwordEncrypted
  };
}

function serializeImportRun(row) {
  return {
    id: row.id,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    sourceType: row.sourceType || '',
    status: row.status || '',
    importedCount: Number(row.importedCount || 0),
    matchedCount: Number(row.matchedCount || 0),
    reviewCount: Number(row.reviewCount || 0),
    errorMessage: row.errorMessage || '',
    metadata: safeJsonParse(row.metadataJson, {})
  };
}

function parseAutoExpresoDateTime(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('AutoExpreso transaction date/time missing');
  const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(.+)/);
  if (!match) throw new Error(`Unsupported AutoExpreso date/time: ${text}`);
  const [, day, month, year, timePart] = match;
  const parsed = new Date(`${month}/${day}/${year} ${timePart}`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Unsupported AutoExpreso date/time: ${text}`);
  return parsed;
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

async function getTenantTollsState(scope = {}) {
  if (!scope?.tenantId) {
    return { tenantId: null, tollsEnabled: false };
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: scope.tenantId },
    select: { id: true, tollsEnabled: true }
  });

  return {
    tenantId: tenant?.id || scope.tenantId,
    tollsEnabled: !!tenant?.tollsEnabled
  };
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
  let withinTripWindow = false;

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
    withinTripWindow = true;
    score += 25;
    reasons.push('withinTripWindow');
  } else if (when >= prePickupAt && when <= postReturnAt) {
    score += 10;
    reasons.push('withinGraceWindow');
  }

  if (withinTripWindow && vehicle?.id && reservation?.vehicleId && vehicle.id === reservation.vehicleId) {
    score += 20;
    reasons.push('assignedVehicleTripWindow');
  }

  if (siblingCandidates > 1) {
    score -= withinTripWindow ? 10 : 30;
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

async function replaceSuggestedAssignments(tx, transaction, suggestion, matchedByUserId = null) {
  await tx.tollAssignment.updateMany({
    where: {
      tollTransactionId: transaction.id,
      status: { in: ['SUGGESTED', 'AUTO_CONFIRMED', 'CONFIRMED'] }
    },
    data: { status: 'REJECTED' }
  });

  if (suggestion?.reservation?.id) {
    await createAssignmentRecord(tx, transaction, suggestion, matchedByUserId);
  }
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

function getAutoSyncIntervalMinutes() {
  const raw = Number(process.env.TOLLS_AUTO_SYNC_INTERVAL_MINUTES || DEFAULT_AUTO_SYNC_INTERVAL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
}

function getAutoSyncStatus(providerAccount, latestAutoSyncRun = null, pendingReviewCount = 0) {
  const enabled = String(process.env.TOLLS_AUTO_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
  const intervalMinutes = getAutoSyncIntervalMinutes();
  const startupDelaySeconds = Number(process.env.TOLLS_AUTO_SYNC_STARTUP_DELAY_SECONDS || 45);
  const lastAutomaticRunAt = providerAccount?.lastSyncAt || null;
  const lastSweepMeta = safeJsonParse(latestAutoSyncRun?.metadataJson, {});
  const nextRunAt = enabled
    ? new Date((lastAutomaticRunAt ? new Date(lastAutomaticRunAt).getTime() : Date.now() + (Number.isFinite(startupDelaySeconds) ? startupDelaySeconds : 45) * 1000) + intervalMinutes * 60 * 1000)
    : null;

  return {
    enabled,
    intervalMinutes,
    startupDelaySeconds: Number.isFinite(startupDelaySeconds) ? startupDelaySeconds : 45,
    lastAutomaticRunAt,
    nextRunAt,
    lastSweep: latestAutoSyncRun ? {
      importRunId: latestAutoSyncRun.id,
      startedAt: latestAutoSyncRun.startedAt,
      completedAt: latestAutoSyncRun.completedAt,
      importedCount: Number(lastSweepMeta?.autoSync?.importedCount ?? latestAutoSyncRun.importedCount ?? 0),
      autoMatchedCount: Number(lastSweepMeta?.autoSync?.autoMatchedCount ?? 0),
      suggestedCount: Number(lastSweepMeta?.autoSync?.suggestedCount ?? 0),
      pendingReviewCount: Number(lastSweepMeta?.autoSync?.pendingReviewCount ?? pendingReviewCount ?? 0)
    } : null
  };
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
    const tollState = await getTenantTollsState(scope);
    if (scope?.tenantId && !tollState.tollsEnabled) {
      return {
        tollsEnabled: false,
        metrics: {
          importedToday: 0,
          matched: 0,
          needsReview: 0,
          postedToBilling: 0,
          disputed: 0
        },
        providerAccount: null,
        autoSync: {
          enabled: false,
          intervalMinutes: 0,
          startupDelaySeconds: 0,
          lastAutomaticRunAt: null,
          nextRunAt: null,
          lastSweep: null
        },
        importRuns: [],
        transactions: []
      };
    }

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

    const [transactions, importedToday, matchedCount, reviewCount, billedCount, disputedCount, providerAccount, importRuns] = await Promise.all([
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
      }),
      scope?.tenantId ? prisma.tollProviderAccount.findFirst({
        where: {
          tenantId: scope.tenantId,
          provider: 'AUTOEXPRESO'
        },
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
      }) : null,
      scope?.tenantId ? prisma.tollImportRun.findMany({
        where: {
          tenantId: scope.tenantId
        },
        orderBy: [{ startedAt: 'desc' }],
        take: 10
      }) : []
    ]);

    const latestAutoSyncRun = (importRuns || []).find((run) => String(run.sourceType || '').toUpperCase() === 'AUTOEXPRESO_SYNC') || null;

    return {
      tollsEnabled: true,
      metrics: {
        importedToday,
        matched: matchedCount,
        needsReview: reviewCount,
        postedToBilling: billedCount,
        disputed: disputedCount
      },
      providerAccount: serializeProviderAccount(providerAccount),
      autoSync: getAutoSyncStatus(providerAccount, latestAutoSyncRun, reviewCount),
      importRuns: (importRuns || []).map(serializeImportRun),
      transactions: transactions.map(serializeTransaction)
    };
  },

  async getProviderAccount(scope = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');
    const row = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider: 'AUTOEXPRESO'
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });
    return serializeProviderAccount(row);
  },

  async saveProviderAccount(payload = {}, scope = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');

    const username = String(payload.username || '').trim();
    const password = String(payload.password || '').trim();
    const isActive = payload.isActive !== false;
    const settings = {
      loginUrl: String(payload.loginUrl || '').trim(),
      notes: String(payload.notes || '').trim()
    };

    const existing = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider: 'AUTOEXPRESO'
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });

    const row = existing
      ? await prisma.tollProviderAccount.update({
          where: { id: existing.id },
          data: {
            username: username || null,
            passwordEncrypted: password ? encodeSecret(password) : existing.passwordEncrypted,
            isActive,
            settingsJson: JSON.stringify(settings),
            lastSyncStatus: existing.lastSyncStatus || 'READY'
          }
        })
      : await prisma.tollProviderAccount.create({
          data: {
            tenantId: scope.tenantId,
            provider: 'AUTOEXPRESO',
            username: username || null,
            passwordEncrypted: password ? encodeSecret(password) : null,
            isActive,
            settingsJson: JSON.stringify(settings),
            lastSyncStatus: 'READY'
          }
        });

    return serializeProviderAccount(row);
  },

  async runProviderHealthCheck(scope = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');
    const row = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider: 'AUTOEXPRESO'
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });
    if (!row) throw new Error('AutoExpreso provider account is not configured');

    const missing = [];
    if (!String(row.username || '').trim()) missing.push('username');
    if (!decodeSecret(row.passwordEncrypted)) missing.push('password');
    const ready = missing.length === 0 && !!row.isActive;

    const updated = await prisma.tollProviderAccount.update({
      where: { id: row.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: ready ? 'READY' : 'MISSING_CONFIG',
        lastSyncMessage: ready ? 'Provider account looks ready for AutoExpreso sync' : `Missing: ${missing.join(', ')}${row.isActive ? '' : ' | account inactive'}`
      }
    });

    return {
      ready,
      missing,
      providerAccount: serializeProviderAccount(updated)
    };
  },

  async runMockSync(scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');
    const row = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider: 'AUTOEXPRESO'
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });
    if (!row) throw new Error('AutoExpreso provider account is not configured');

    const health = await this.runProviderHealthCheck(scope);
    if (!health.ready) throw new Error(`Provider not ready: ${(health.missing || []).join(', ')}`);

    const startedAt = new Date();
    const run = await prisma.tollImportRun.create({
      data: {
        tenantId: scope.tenantId,
        providerAccountId: row.id,
        sourceType: 'AUTOEXPRESO_MOCK_SYNC',
        status: 'COMPLETED',
        importedCount: 0,
        matchedCount: 0,
        reviewCount: 0,
        startedAt,
        completedAt: startedAt,
        metadataJson: JSON.stringify({
          mock: true,
          actorUserId: actorUserId || null,
          note: 'Mock sync completed without scraping'
        })
      }
    });

    await prisma.tollProviderAccount.update({
      where: { id: row.id },
      data: {
        lastSyncAt: startedAt,
        lastSyncStatus: 'MOCK_SYNC_OK',
        lastSyncMessage: 'Mock sync completed. Ready for real scraper integration.'
      }
    });

    return {
      ok: true,
      importRun: serializeImportRun(run)
    };
  },

  async runLiveSync(scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');
    const syncLockKey = String(scope.tenantId);
    if (tollSyncLocks.has(syncLockKey)) {
      throw new Error('AutoExpreso sync already running for this tenant');
    }

    tollSyncLocks.add(syncLockKey);
    const row = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider: 'AUTOEXPRESO'
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });
    if (!row) throw new Error('AutoExpreso provider account is not configured');

    const health = await this.runProviderHealthCheck(scope);
    if (!health.ready) throw new Error(`Provider not ready: ${(health.missing || []).join(', ')}`);

    let puppeteer;
    try {
      puppeteer = await import('puppeteer');
    } catch {
      throw new Error('Puppeteer is not installed on backend for live AutoExpreso sync');
    }

    const settings = safeJsonParse(row.settingsJson, {});
    const loginUrl = String(settings.loginUrl || AUTOEXPRESO_LOGIN_URL).trim() || AUTOEXPRESO_LOGIN_URL;
    const transactionUrl = String(settings.transactionUrl || AUTOEXPRESO_BALANCE_URL).trim() || AUTOEXPRESO_BALANCE_URL;
    const maxPages = Number(settings.maxPages || 25) > 0 ? Number(settings.maxPages || 25) : 25;
    const username = String(row.username || '').trim();
    const password = decodeSecret(row.passwordEncrypted);

    const browser = await puppeteer.default.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    try {
      await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector(AUTOEXPRESO_USERNAME_SELECTOR, { timeout: 30000 });
      await page.waitForSelector(AUTOEXPRESO_PASSWORD_SELECTOR, { timeout: 30000 });
      await page.click(AUTOEXPRESO_USERNAME_SELECTOR, { clickCount: 3 }).catch(() => null);
      await page.type(AUTOEXPRESO_USERNAME_SELECTOR, username);
      await page.click(AUTOEXPRESO_PASSWORD_SELECTOR, { clickCount: 3 }).catch(() => null);
      await page.type(AUTOEXPRESO_PASSWORD_SELECTOR, password);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
        clickAutoExpresoLoginButton(page)
      ]);

      await page.goto(transactionUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      const transactionState = await waitForAutoExpresoTransactionState(page, 30000);
      if (transactionState !== 'transactions') {
        const pageState = await captureAutoExpresoPageState(page);
        const accountStatementHint = transactionState === 'account-statements'
          ? ' | This AutoExpreso account is landing on monthly account statements instead of the legacy live transaction feed. Use manual/CSV import for now or add monthly statement ingestion for this tenant.'
          : '';
        throw new Error(`AutoExpreso sync could not open transactions (${transactionState}). URL: ${pageState.url || 'unknown'} | Title: ${pageState.title || 'unknown'}${pageState.hint ? ` | Hint: ${pageState.hint}` : ''}${accountStatementHint}`);
      }

      const rows = [];
      const seenExternalIds = new Set();
      let pageNumber = 0;
      while (pageNumber < maxPages) {
        const pageRows = await scrapeAutoExpresoBalanceRows(page);
        for (const raw of pageRows) {
          try {
            const transactionAt = parseAutoExpresoDateTime(raw.datetimeFull);
            const amount = Number(raw.amount);
            const externalId = normalizeToken(`${raw.plateRaw}|${raw.selloRaw}|${transactionAt.toISOString()}|${amount}|${raw.location}`);
            if (!externalId || seenExternalIds.has(externalId)) continue;
            seenExternalIds.add(externalId);
            rows.push({
              transactionAt: transactionAt.toISOString(),
              amount,
              location: String(raw.location || '').trim(),
              lane: '',
              direction: '',
              plate: String(raw.plateRaw || '').trim(),
              tag: '',
              sello: String(raw.selloRaw || '').trim(),
              transactionTimeRaw: String(raw.datetimeFull || '').split(/\s+/).slice(1).join(' '),
              externalId
            });
          } catch {
            // Skip malformed rows but continue sync.
          }
        }

        const beforeSnapshot = await page.evaluate(() => String(document.body?.innerText || '').slice(0, 2000)).catch(() => '');
        const moved = await clickAutoExpresoNextPage(page);
        if (!moved) break;
        await page.waitForFunction((previous) => String(document.body?.innerText || '').slice(0, 2000) !== previous, { timeout: 15000 }, beforeSnapshot).catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        pageNumber += 1;
      }

      await browser.close();

      if (!rows.length) {
        const startedAt = new Date();
        const run = await prisma.tollImportRun.create({
          data: {
            tenantId: scope.tenantId,
            providerAccountId: row.id,
            sourceType: 'AUTOEXPRESO_SYNC',
            status: 'COMPLETED',
            importedCount: 0,
            matchedCount: 0,
            reviewCount: 0,
            startedAt,
            completedAt: startedAt,
            metadataJson: JSON.stringify({
              liveSync: true,
              actorUserId: actorUserId || null,
              note: 'AutoExpreso sync completed with no new rows'
            })
          }
        });

        await prisma.tollProviderAccount.update({
          where: { id: row.id },
          data: {
            lastSyncAt: startedAt,
            lastSyncStatus: 'SYNC_OK',
            lastSyncMessage: 'AutoExpreso sync completed with no new rows'
          }
        });

        return {
          ok: true,
          createdCount: 0,
          importRun: serializeImportRun(run)
        };
      }

      const created = await this.createManualTransactions(rows, scope, actorUserId, {
        sourceType: 'AUTOEXPRESO_SYNC',
        providerAccountId: row.id
      });

      await prisma.tollProviderAccount.update({
        where: { id: row.id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'SYNC_OK',
          lastSyncMessage: `Imported ${Array.isArray(created?.created) ? created.created.length : 0} toll rows from AutoExpreso`
        }
      });

      return {
        ok: true,
        createdCount: Array.isArray(created?.created) ? created.created.length : 0,
        importRun: created?.importRun || null
      };
    } catch (error) {
      await browser.close().catch(() => null);
      await prisma.tollProviderAccount.update({
        where: { id: row.id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'SYNC_FAILED',
          lastSyncMessage: String(error?.message || 'AutoExpreso sync failed')
        }
      });
      throw error;
    } finally {
      tollSyncLocks.delete(syncLockKey);
    }
  },

  async autoMatchPendingTransactions(scope = {}, actorUserId = null, options = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll auto-match');

    const limit = Number(options.limit || 200) > 0 ? Number(options.limit || 200) : 200;
    const rows = await prisma.tollTransaction.findMany({
      where: {
        ...tenantWhereForScope(scope),
        needsReview: true,
        billingStatus: 'PENDING'
      },
      include: {
        assignments: true
      },
      orderBy: [{ transactionAt: 'desc' }],
      take: limit
    });

    let autoConfirmed = 0;
    let suggested = 0;
    let reviewed = 0;

    for (const transaction of rows) {
      const suggestion = await buildMatchSuggestion(transaction, scope);
      await prisma.$transaction(async (tx) => {
        await replaceSuggestedAssignments(tx, transaction, suggestion, actorUserId);

        await tx.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            vehicleId: suggestion.vehicle?.id || null,
            reservationId: suggestion.reservation?.id || null,
            status: suggestion.matchStatus === 'AUTO_CONFIRMED' ? 'MATCHED' : 'NEEDS_REVIEW',
            needsReview: suggestion.needsReview !== false,
            matchConfidence: suggestion.score || null,
            reviewNotes: suggestion.matchReason || null
          }
        });
      });

      reviewed += 1;
      if (suggestion.matchStatus === 'AUTO_CONFIRMED') {
        autoConfirmed += 1;
      } else if (suggestion.reservation?.id) {
        suggested += 1;
      }
    }

    const pendingReviewCount = await prisma.tollTransaction.count({
      where: {
        ...tenantWhereForScope(scope),
        needsReview: true,
        billingStatus: 'PENDING'
      }
    });

    return {
      reviewed,
      autoConfirmed,
      suggested,
      pendingReviewCount
    };
  },

  async runAutomaticSyncSweep() {
    const providerAccounts = await prisma.tollProviderAccount.findMany({
      where: {
        provider: 'AUTOEXPRESO',
        isActive: true,
        tenant: {
          tollsEnabled: true
        }
      },
      select: {
        id: true,
        tenantId: true,
        username: true,
        passwordEncrypted: true,
        settingsJson: true,
        lastSyncAt: true
      },
      orderBy: [{ updatedAt: 'asc' }]
    });

    const intervalMinutes = getAutoSyncIntervalMinutes();
    const now = Date.now();
    const results = [];

    for (const providerAccount of providerAccounts) {
      const tenantId = providerAccount.tenantId;
      const password = decodeSecret(providerAccount.passwordEncrypted);
      if (!tenantId || !String(providerAccount.username || '').trim() || !password) {
        results.push({ tenantId, ok: false, skipped: true, reason: 'provider-not-ready' });
        continue;
      }

      const lastSyncAt = providerAccount.lastSyncAt ? new Date(providerAccount.lastSyncAt).getTime() : 0;
      if (lastSyncAt && now - lastSyncAt < intervalMinutes * 60 * 1000) {
        results.push({ tenantId, ok: true, skipped: true, reason: 'within-sync-interval' });
        continue;
      }

      try {
        const liveSync = await this.runLiveSync({ tenantId }, null);
        const autoMatch = await this.autoMatchPendingTransactions({ tenantId }, null);
        const importedCount = Number(liveSync?.createdCount || 0);
        const autoMatchedCount = Number(autoMatch?.autoConfirmed || 0);
        const suggestedCount = Number(autoMatch?.suggested || 0);
        const pendingReviewCount = Number(autoMatch?.pendingReviewCount || 0);

        if (liveSync?.importRun?.id) {
          const currentRun = await prisma.tollImportRun.findUnique({
            where: { id: liveSync.importRun.id },
            select: { id: true, metadataJson: true }
          });
          if (currentRun) {
            const existingMeta = safeJsonParse(currentRun.metadataJson, {});
            await prisma.tollImportRun.update({
              where: { id: currentRun.id },
              data: {
                metadataJson: JSON.stringify({
                  ...existingMeta,
                  autoSync: {
                    importedCount,
                    autoMatchedCount,
                    suggestedCount,
                    pendingReviewCount
                  }
                })
              }
            });
          }
        }

        const providerAccount = await prisma.tollProviderAccount.findFirst({
          where: { tenantId, provider: 'AUTOEXPRESO' },
          orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
        });
        if (providerAccount) {
          await prisma.tollProviderAccount.update({
            where: { id: providerAccount.id },
            data: {
              lastSyncAt: new Date(),
              lastSyncStatus: 'SYNC_OK',
              lastSyncMessage: `Imported ${importedCount} | Auto-matched ${autoMatchedCount} | Suggested ${suggestedCount} | Pending review ${pendingReviewCount}`
            }
          });
        }

        results.push({
          tenantId,
          ok: true,
          createdCount: importedCount,
          autoMatched: autoMatchedCount,
          suggested: suggestedCount,
          pendingReviewCount
        });
      } catch (error) {
        results.push({
          tenantId,
          ok: false,
          error: String(error?.message || 'Auto toll sync failed')
        });
      }
    }

    return {
      processedTenants: results.length,
      results
    };
  },

  async createManualTransactions(rows = [], scope = {}, actorUserId = null, options = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for manual toll imports');
    const inputRows = (Array.isArray(rows) ? rows : []).filter(Boolean);
    if (!inputRows.length) throw new Error('rows are required');

    const providerAccount = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider: 'AUTOEXPRESO'
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });

    const effectiveProviderAccount = providerAccount || await prisma.tollProviderAccount.create({
      data: {
        tenantId: scope.tenantId,
        provider: 'AUTOEXPRESO',
        isActive: false,
        lastSyncStatus: 'PENDING_SETUP',
        lastSyncMessage: 'Created automatically from manual toll import'
      }
    });

    const importRun = await prisma.tollImportRun.create({
      data: {
        tenantId: scope.tenantId,
        providerAccountId: options.providerAccountId || effectiveProviderAccount.id,
        sourceType: options.sourceType || (inputRows.length > 1 ? 'CSV_PASTE' : 'MANUAL_ENTRY'),
        status: 'RUNNING'
      }
    });

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

      if (draft.externalId) {
        const existing = await prisma.tollTransaction.findFirst({
          where: {
            tenantId: scope.tenantId,
            externalId: draft.externalId
          },
          select: { id: true }
        });
        if (existing) {
          continue;
        }
      }

      const suggestion = await buildMatchSuggestion(draft, scope);
      const row = await prisma.$transaction(async (tx) => {
        const createdTransaction = await tx.tollTransaction.create({
          data: {
            tenantId: scope.tenantId,
            providerAccountId: options.providerAccountId || effectiveProviderAccount.id,
            importRunId: importRun.id,
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

    await prisma.tollImportRun.update({
      where: { id: importRun.id },
      data: {
        completedAt: new Date(),
        status: 'COMPLETED',
        importedCount: created.length,
        matchedCount: created.filter((row) => String(row.status || '').toUpperCase() === 'MATCHED').length,
        reviewCount: created.filter((row) => !!row.needsReview).length
      }
    });

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
