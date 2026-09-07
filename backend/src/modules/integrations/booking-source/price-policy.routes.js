/**
 * Which price each writeback publishes, per sede (2026-09-07).
 *
 * ONE screen for every integration instead of the same control cloned into
 * each provider's settings page. Mounted at /api/admin/integrations/price-policy.
 *
 *   GET  /            → every sede that has a writeback configured, with its
 *                       rate-push switch, the source it publishes from, and
 *                       whether MI even has anything to contribute there.
 *   PUT  /            → { locationId, provider, priceSource?, ratePushEnabled? }
 *
 * Authorization matches every other integration router: SUPER_ADMIN + ADMIN,
 * ADMIN hard-scoped to their own tenant, and further scoped to their own sedes
 * so a location-restricted ADMIN cannot reprice a branch they cannot see.
 *
 * MONEY-ADJACENT: this decides whose numbers land in a partner's live pricing
 * system, so every change is audited with both the old and the new value.
 */
import { Router } from 'express';
import { requireAuth, requireRole, isSuperAdmin } from '../../../middleware/auth.js';
import { prisma } from '../../../lib/prisma.js';
import { userAllowedLocationIds } from '../../../lib/tenant-scope.js';
import { auditFromReq } from '../../audit/audit.service.js';
import { PRICE_SOURCES, normalizePriceSource, MARKET_AUTHOR } from './price-source.js';

export const pricePolicyRouter = Router();

pricePolicyRouter.use(requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'));

/** Providers that actually write prices somewhere. Grows with each writeback. */
export const WRITEBACK_PROVIDERS = Object.freeze(['ECONOMY', 'MEX']);

function resolveTenantId(req) {
  if (isSuperAdmin(req.user)) {
    const t = req.query?.tenantId || req.body?.tenantId || req.user?.tenantId;
    if (!t) throw new Error('tenantId is required (SUPER_ADMIN must pick one)');
    return String(t);
  }
  return req.user?.tenantId;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * The sedes that have a writeback configured, per provider. Reading the
 * providers' own config tables (rather than a list of locations) means the
 * screen only ever offers a choice that can actually take effect.
 */
async function configuredSedes(tenantId) {
  const [economy, mex] = await Promise.all([
    prisma.economyLocationConfig.findMany({
      where: { tenantId },
      select: { locationId: true, externalArea: true, enabled: true, externalLocationCode: true },
    }).catch(() => []),
    prisma.mexLocationConfig.findMany({
      where: { tenantId },
      select: { locationId: true, tsdNumber: true, branch: true, enabled: true },
    }).catch(() => []),
  ]);

  const out = [];
  for (const c of economy) {
    out.push({
      provider: 'ECONOMY',
      locationId: c.locationId,
      externalCode: c.externalLocationCode || c.externalArea || null,
      integrationEnabled: Boolean(c.enabled),
    });
  }
  for (const c of mex) {
    out.push({
      provider: 'MEX',
      locationId: c.locationId,
      externalCode: `${c.tsdNumber}/${c.branch}`,
      integrationEnabled: Boolean(c.enabled),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET / — the whole picture for one tenant.
// ---------------------------------------------------------------------------
pricePolicyRouter.get('/', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const allowed = userAllowedLocationIds(req.user);

  const sedes = await configuredSedes(tenantId);
  const scoped = allowed ? sedes.filter((s) => allowed.includes(s.locationId)) : sedes;
  if (!scoped.length) return res.json({ providers: WRITEBACK_PROVIDERS, rows: [] });

  const locationIds = [...new Set(scoped.map((s) => s.locationId))];
  const [locations, policies, marketProfiles] = await Promise.all([
    prisma.location.findMany({
      where: { id: { in: locationIds } },
      select: { id: true, name: true, code: true },
    }),
    prisma.integrationPricePolicy.findMany({
      where: { tenantId, locationId: { in: locationIds } },
      select: {
        locationId: true, provider: true, priceSource: true,
        ratePushEnabled: true, updatedAt: true, updatedByUserId: true,
      },
    }),
    // Does Market Intelligence actually have anything to say about this sede?
    // Offering MARKET where no profile auto-applies would promise a source
    // that resolves to the base rate anyway.
    prisma.marketScrapeProfile.findMany({
      where: { tenantId, active: true },
      select: { locationCode: true, autoApply: true, name: true },
    }).catch(() => []),
  ]);

  const locById = new Map(locations.map((l) => [l.id, l]));
  const policyBy = new Map(policies.map((p) => [`${p.locationId}:${p.provider}`, p]));
  const autoApplyByCode = new Map();
  for (const p of marketProfiles) {
    const code = String(p.locationCode || '').toUpperCase();
    if (!code) continue;
    autoApplyByCode.set(code, (autoApplyByCode.get(code) || false) || Boolean(p.autoApply));
  }

  const rows = scoped.map((s) => {
    const loc = locById.get(s.locationId);
    const policy = policyBy.get(`${s.locationId}:${s.provider}`);
    const code = String(loc?.code || '').toUpperCase();
    return {
      locationId: s.locationId,
      locationName: loc?.name || null,
      locationCode: loc?.code || null,
      provider: s.provider,
      externalCode: s.externalCode,
      // Whether the sede is MAPPED for this provider at all (its config row is
      // active). Distinct from ratePushEnabled: a sede can import reservations
      // all day with its rate push switched off — which is the whole point.
      integrationEnabled: s.integrationEnabled,
      ratePushEnabled: policy?.ratePushEnabled === true,
      // Absent row is not an error — it is the closed default (no push, MANUAL
      // source), and saying so keeps the screen from looking unconfigured.
      priceSource: normalizePriceSource(policy?.priceSource),
      explicit: Boolean(policy),
      updatedAt: policy?.updatedAt || null,
      marketIntelligenceAutoApplies: autoApplyByCode.get(code) || false,
    };
  });

  res.json({ providers: WRITEBACK_PROVIDERS, sources: Object.values(PRICE_SOURCES), marketAuthor: MARKET_AUTHOR, rows });
}));

// ---------------------------------------------------------------------------
// PUT / — set one sede's source for one integration.
// ---------------------------------------------------------------------------
pricePolicyRouter.put('/', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const {
    locationId, provider: rawProvider,
    priceSource: rawSource, ratePushEnabled: rawEnabled,
  } = req.body || {};
  if (!locationId) return res.status(400).json({ error: 'locationId is required' });

  const provider = String(rawProvider || '').toUpperCase();
  if (!WRITEBACK_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of ${WRITEBACK_PROVIDERS.join(', ')}` });
  }

  // Both fields are optional so the screen can toggle one without restating the
  // other, but a request that changes NOTHING is a caller bug, not a no-op to
  // swallow — it usually means a field name drifted.
  const wantsSource = rawSource !== undefined;
  const wantsSwitch = rawEnabled !== undefined;
  if (!wantsSource && !wantsSwitch) {
    return res.status(400).json({ error: 'Nothing to change: send priceSource, ratePushEnabled, or both' });
  }

  // Reject an unknown source rather than normalizing it to MANUAL: a typo that
  // silently lands on a valid-looking posture is how someone thinks they
  // enabled MI and never did.
  const wanted = wantsSource ? String(rawSource).trim().toUpperCase() : null;
  if (wantsSource && !Object.keys(PRICE_SOURCES).includes(wanted)) {
    return res.status(400).json({ error: `priceSource must be one of ${Object.values(PRICE_SOURCES).join(', ')}` });
  }

  // A money switch takes a real boolean. 'false' the STRING is truthy, and this
  // one decides whether we write into somebody else's pricing system.
  if (wantsSwitch && typeof rawEnabled !== 'boolean') {
    return res.status(400).json({ error: 'ratePushEnabled must be true or false' });
  }

  const location = await prisma.location.findFirst({
    where: { id: String(locationId), tenantId },
    select: { id: true, name: true, code: true },
  });
  if (!location) return res.status(404).json({ error: 'Location not found for this tenant' });

  const allowed = userAllowedLocationIds(req.user);
  if (allowed && !allowed.includes(location.id)) {
    return res.status(403).json({ error: 'This location is outside your scope' });
  }

  const key = { tenantId_locationId_provider: { tenantId, locationId: location.id, provider } };
  const before = await prisma.integrationPricePolicy.findUnique({
    where: key,
    select: { priceSource: true, ratePushEnabled: true },
  });
  const previous = {
    priceSource: normalizePriceSource(before?.priceSource),
    ratePushEnabled: before?.ratePushEnabled === true,
  };

  const patch = {
    ...(wantsSource ? { priceSource: wanted } : {}),
    ...(wantsSwitch ? { ratePushEnabled: rawEnabled } : {}),
  };

  const saved = await prisma.integrationPricePolicy.upsert({
    where: key,
    // A row created by toggling only ONE field must not silently invent the
    // other: the create defaults match the closed posture the resolver assumes
    // when no row exists, so creating a row never changes unstated behaviour.
    create: {
      tenantId, locationId: location.id, provider,
      priceSource: PRICE_SOURCES.MANUAL,
      ratePushEnabled: false,
      ...patch,
      updatedByUserId: req.user?.id || null,
    },
    update: { ...patch, updatedByUserId: req.user?.id || null },
    select: { locationId: true, provider: true, priceSource: true, ratePushEnabled: true, updatedAt: true },
  });

  await auditFromReq(req, {
    action: 'INTEGRATION_PRICE_POLICY_CHANGED',
    targetType: 'IntegrationPricePolicy',
    targetId: `${location.id}:${provider}`,
    metadata: {
      provider,
      locationCode: location.code,
      locationName: location.name,
      from: previous,
      to: { priceSource: saved.priceSource, ratePushEnabled: saved.ratePushEnabled },
      wasExplicit: Boolean(before),
    },
  });

  res.json({ ok: true, ...saved, previous });
}));

export default pricePolicyRouter;
