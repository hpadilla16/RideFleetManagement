import { prisma } from '../../lib/prisma.js';

export const DEFAULT_PLANNER_RULES = {
  minTurnaroundMinutes: 60,
  washBufferMinutes: 30,
  prepBufferMinutes: 15,
  maintenanceBufferMinutes: 120,
  lockWindowMinutesBeforePickup: 180,
  sameDayReservationBufferMinutes: 45,
  allowCrossLocationReassignment: false,
  strictVehicleTypeMatch: true,
  allowUpgrade: true,
  allowDowngrade: false,
  defaultWashRequired: true,
  assignmentMode: 'STRICT',
  maintenanceMode: 'FLEXIBLE',
  vehicleTypeOverrides: {},
  locationOverrides: {},
  scoringWeights: {}
};

const RULE_MODE_VALUES = new Set(['STRICT', 'FLEXIBLE']);

function parseJsonObject(value, fallback = {}) {
  if (!value) return { ...fallback };
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function toInteger(value, fallback) {
  if (value === '' || value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWeights(raw = {}) {
  const out = {};
  for (const [key, value] of Object.entries(parseJsonObject(raw))) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) out[key] = parsed;
  }
  return out;
}

function normalizeOverrideMap(raw = {}) {
  const parsed = parseJsonObject(raw);
  const out = {};
  for (const [outerKey, outerValue] of Object.entries(parsed)) {
    if (!outerKey || !outerValue || typeof outerValue !== 'object' || Array.isArray(outerValue)) continue;
    const next = {};
    for (const [key, value] of Object.entries(outerValue)) {
      if (typeof value === 'boolean') next[key] = value;
      else if (value === '' || value == null) next[key] = value;
      else if (typeof value === 'number') next[key] = value;
      else if (typeof value === 'string') {
        const maybeNumber = Number(value);
        next[key] = Number.isFinite(maybeNumber) && value.trim() !== '' ? maybeNumber : value;
      } else if (Array.isArray(value) || typeof value === 'object') {
        next[key] = value;
      }
    }
    out[outerKey] = next;
  }
  return out;
}

function normalizeMode(value, fallback) {
  const normalized = String(value || fallback || '').trim().toUpperCase();
  return RULE_MODE_VALUES.has(normalized) ? normalized : fallback;
}

function requireTenantScope(scope = {}) {
  if (!scope?.tenantId) throw new Error('tenantId is required for planner rules');
  return String(scope.tenantId);
}

function mergeRules(base = {}, extra = {}) {
  return {
    ...base,
    ...(extra || {})
  };
}

function mapRuleRow(row = null, scope = {}) {
  if (!row) {
    return {
      id: null,
      tenantId: scope?.tenantId || null,
      ...DEFAULT_PLANNER_RULES
    };
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    minTurnaroundMinutes: row.minTurnaroundMinutes,
    washBufferMinutes: row.washBufferMinutes,
    prepBufferMinutes: row.prepBufferMinutes,
    maintenanceBufferMinutes: row.maintenanceBufferMinutes,
    lockWindowMinutesBeforePickup: row.lockWindowMinutesBeforePickup,
    sameDayReservationBufferMinutes: row.sameDayReservationBufferMinutes,
    allowCrossLocationReassignment: !!row.allowCrossLocationReassignment,
    strictVehicleTypeMatch: !!row.strictVehicleTypeMatch,
    allowUpgrade: !!row.allowUpgrade,
    allowDowngrade: !!row.allowDowngrade,
    defaultWashRequired: !!row.defaultWashRequired,
    assignmentMode: normalizeMode(row.assignmentMode, DEFAULT_PLANNER_RULES.assignmentMode),
    maintenanceMode: normalizeMode(row.maintenanceMode, DEFAULT_PLANNER_RULES.maintenanceMode),
    vehicleTypeOverrides: normalizeOverrideMap(row.vehicleTypeOverridesJson),
    locationOverrides: normalizeOverrideMap(row.locationOverridesJson),
    scoringWeights: normalizeWeights(row.scoringWeightsJson)
  };
}

function toStoredRuleData(payload = {}) {
  return {
    minTurnaroundMinutes: payload.minTurnaroundMinutes,
    washBufferMinutes: payload.washBufferMinutes,
    prepBufferMinutes: payload.prepBufferMinutes,
    maintenanceBufferMinutes: payload.maintenanceBufferMinutes,
    lockWindowMinutesBeforePickup: payload.lockWindowMinutesBeforePickup,
    sameDayReservationBufferMinutes: payload.sameDayReservationBufferMinutes,
    allowCrossLocationReassignment: payload.allowCrossLocationReassignment,
    strictVehicleTypeMatch: payload.strictVehicleTypeMatch,
    allowUpgrade: payload.allowUpgrade,
    allowDowngrade: payload.allowDowngrade,
    defaultWashRequired: payload.defaultWashRequired,
    assignmentMode: payload.assignmentMode,
    maintenanceMode: payload.maintenanceMode,
    vehicleTypeOverridesJson: JSON.stringify(payload.vehicleTypeOverrides || {}),
    locationOverridesJson: JSON.stringify(payload.locationOverrides || {}),
    scoringWeightsJson: JSON.stringify(payload.scoringWeights || {})
  };
}

export const plannerRulesService = {
  validateRulePayload(payload = {}) {
    const errors = [];
    const integerKeys = [
      'minTurnaroundMinutes',
      'washBufferMinutes',
      'prepBufferMinutes',
      'maintenanceBufferMinutes',
      'lockWindowMinutesBeforePickup',
      'sameDayReservationBufferMinutes'
    ];
    integerKeys.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return;
      const parsed = Number.parseInt(String(payload[key]), 10);
      if (!Number.isFinite(parsed) || parsed < 0) errors.push(`${key} must be a non-negative integer`);
    });
    ['assignmentMode', 'maintenanceMode'].forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return;
      const normalized = String(payload[key] || '').trim().toUpperCase();
      if (!RULE_MODE_VALUES.has(normalized)) errors.push(`${key} must be STRICT or FLEXIBLE`);
    });
    ['vehicleTypeOverrides', 'locationOverrides', 'scoringWeights'].forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return;
      if (!payload[key] || typeof payload[key] !== 'object' || Array.isArray(payload[key])) {
        errors.push(`${key} must be an object`);
      }
    });
    return errors;
  },

  normalizeRulePayload(payload = {}, base = {}) {
    const defaults = {
      ...DEFAULT_PLANNER_RULES,
      ...(base || {})
    };
    return {
      minTurnaroundMinutes: toInteger(payload.minTurnaroundMinutes, defaults.minTurnaroundMinutes),
      washBufferMinutes: toInteger(payload.washBufferMinutes, defaults.washBufferMinutes),
      prepBufferMinutes: toInteger(payload.prepBufferMinutes, defaults.prepBufferMinutes),
      maintenanceBufferMinutes: toInteger(payload.maintenanceBufferMinutes, defaults.maintenanceBufferMinutes),
      lockWindowMinutesBeforePickup: toInteger(payload.lockWindowMinutesBeforePickup, defaults.lockWindowMinutesBeforePickup),
      sameDayReservationBufferMinutes: toInteger(payload.sameDayReservationBufferMinutes, defaults.sameDayReservationBufferMinutes),
      allowCrossLocationReassignment: Object.prototype.hasOwnProperty.call(payload, 'allowCrossLocationReassignment') ? !!payload.allowCrossLocationReassignment : defaults.allowCrossLocationReassignment,
      strictVehicleTypeMatch: Object.prototype.hasOwnProperty.call(payload, 'strictVehicleTypeMatch') ? !!payload.strictVehicleTypeMatch : defaults.strictVehicleTypeMatch,
      allowUpgrade: Object.prototype.hasOwnProperty.call(payload, 'allowUpgrade') ? !!payload.allowUpgrade : defaults.allowUpgrade,
      allowDowngrade: Object.prototype.hasOwnProperty.call(payload, 'allowDowngrade') ? !!payload.allowDowngrade : defaults.allowDowngrade,
      defaultWashRequired: Object.prototype.hasOwnProperty.call(payload, 'defaultWashRequired') ? !!payload.defaultWashRequired : defaults.defaultWashRequired,
      assignmentMode: normalizeMode(payload.assignmentMode, defaults.assignmentMode),
      maintenanceMode: normalizeMode(payload.maintenanceMode, defaults.maintenanceMode),
      vehicleTypeOverrides: normalizeOverrideMap(Object.prototype.hasOwnProperty.call(payload, 'vehicleTypeOverrides') ? payload.vehicleTypeOverrides : defaults.vehicleTypeOverrides),
      locationOverrides: normalizeOverrideMap(Object.prototype.hasOwnProperty.call(payload, 'locationOverrides') ? payload.locationOverrides : defaults.locationOverrides),
      scoringWeights: normalizeWeights(Object.prototype.hasOwnProperty.call(payload, 'scoringWeights') ? payload.scoringWeights : defaults.scoringWeights)
    };
  },

  async getRuleSet(scope = {}) {
    const tenantId = requireTenantScope(scope);
    const row = await prisma.plannerRuleSet.findUnique({
      where: { tenantId }
    });
    return mapRuleRow(row, { tenantId });
  },

  async upsertRuleSet(payload = {}, scope = {}) {
    const tenantId = requireTenantScope(scope);
    const current = await this.getRuleSet({ tenantId });
    const errors = this.validateRulePayload(payload);
    if (errors.length) {
      const error = new Error('Validation failed');
      error.details = errors;
      throw error;
    }
    const normalized = this.normalizeRulePayload(payload, current);
    const row = await prisma.plannerRuleSet.upsert({
      where: { tenantId },
      create: {
        tenantId,
        ...toStoredRuleData(normalized)
      },
      update: toStoredRuleData(normalized)
    });
    return mapRuleRow(row, { tenantId });
  },

  async resolveEffectiveRules({ scope = {}, locationId = null, vehicleTypeId = null } = {}) {
    const rules = await this.getRuleSet(scope);
    const locationOverrides = locationId ? (rules.locationOverrides?.[locationId] || {}) : {};
    const vehicleTypeOverrides = vehicleTypeId ? (rules.vehicleTypeOverrides?.[vehicleTypeId] || {}) : {};
    return mergeRules(rules, mergeRules(locationOverrides, vehicleTypeOverrides));
  }
};
