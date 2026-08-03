/**
 * Turn-Ready rule set — per-tenant read/write.
 *
 * Mirrors planner.rules.service.js: an absent row is not an error, it is the
 * default configuration. That matters here more than usual — the planner scores
 * every vehicle through this, so a tenant that has never opened the settings
 * screen must still get a working score.
 */

import { prisma } from '../../lib/prisma.js';
import {
  DEFAULT_TURN_READY_RULES,
  normalizeTurnReadyRules,
  validateTurnReadyRules,
  parseStoredTurnReadyRules,
} from '../../lib/turn-ready-rules.js';

function requireTenantScope(scope = {}) {
  const tenantId = scope?.tenantId || null;
  if (!tenantId) {
    const error = new Error('Tenant scope is required for turn-ready rules.');
    error.status = 400;
    throw error;
  }
  return tenantId;
}

export const turnReadyRulesService = {
  defaults() {
    return { ...DEFAULT_TURN_READY_RULES };
  },

  /** Effective rules for a tenant. Never throws on a missing or corrupt row. */
  async getRules(scope = {}) {
    const tenantId = requireTenantScope(scope);
    const row = await prisma.turnReadyRuleSet.findUnique({ where: { tenantId } });
    return {
      tenantId,
      isCustomized: !!row?.rulesJson,
      updatedAt: row?.updatedAt || null,
      rules: parseStoredTurnReadyRules(row?.rulesJson),
    };
  },

  async upsertRules(payload = {}, scope = {}) {
    const tenantId = requireTenantScope(scope);
    const errors = validateTurnReadyRules(payload);
    if (errors.length) {
      const error = new Error('Validation failed');
      error.status = 400;
      error.details = errors;
      throw error;
    }
    // Merge onto what the tenant already has, so a partial PATCH from the
    // settings screen does not silently reset every untouched weight.
    const current = await this.getRules({ tenantId });
    const normalized = normalizeTurnReadyRules(payload, current.rules);
    const rulesJson = JSON.stringify(normalized);
    const row = await prisma.turnReadyRuleSet.upsert({
      where: { tenantId },
      create: { tenantId, rulesJson },
      update: { rulesJson },
    });
    return { tenantId, isCustomized: true, updatedAt: row.updatedAt, rules: normalized };
  },

  /** Drop customization and fall back to the defaults. */
  async resetRules(scope = {}) {
    const tenantId = requireTenantScope(scope);
    await prisma.turnReadyRuleSet.deleteMany({ where: { tenantId } });
    return { tenantId, isCustomized: false, updatedAt: null, rules: { ...DEFAULT_TURN_READY_RULES } };
  },
};
