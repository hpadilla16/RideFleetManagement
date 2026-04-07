export const VEHICLE_BLOCK_TYPES = ['MIGRATION_HOLD', 'MAINTENANCE_HOLD', 'WASH_HOLD', 'OUT_OF_SERVICE_HOLD'];

export function normalizeVehicleBlockType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return 'MIGRATION_HOLD';
  return VEHICLE_BLOCK_TYPES.includes(normalized) ? normalized : null;
}

export function isMigrationHoldType(value) {
  return normalizeVehicleBlockType(value) === 'MIGRATION_HOLD';
}

export function isServiceHoldType(value) {
  const normalized = normalizeVehicleBlockType(value);
  return normalized === 'MAINTENANCE_HOLD' || normalized === 'OUT_OF_SERVICE_HOLD';
}

export function isVehicleBlockActive(block, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const releasedAt = block?.releasedAt ? new Date(block.releasedAt) : null;
  const blockedFrom = block?.blockedFrom ? new Date(block.blockedFrom) : current;
  const availableFrom = block?.availableFrom ? new Date(block.availableFrom) : null;
  if (releasedAt || !availableFrom) return false;
  if (Number.isNaN(blockedFrom.getTime()) || Number.isNaN(availableFrom.getTime())) return false;
  return blockedFrom <= current && availableFrom > current;
}

export function activeVehicleBlockOverlapWhere({ start, end, types } = {}) {
  const where = {
    releasedAt: null,
    blockedFrom: { lt: end },
    availableFrom: { gt: start }
  };
  if (Array.isArray(types) && types.length) {
    where.blockType = { in: types };
  }
  return where;
}
