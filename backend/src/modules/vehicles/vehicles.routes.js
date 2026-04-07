import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { vehiclesService } from './vehicles.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';
import { crossTenantScopeFor as scopeFor } from '../../lib/tenant-scope.js';
import { settingsService } from '../settings/settings.service.js';
import { requireString, assertPlainObject } from '../../lib/request-validation.js';
import { attachPublicRequestMeta, createOptionalIdempotencyGuard, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';

export const vehiclesRouter = Router();
export const publicVehicleTelematicsRouter = Router();

const publicTelematicsWebhookGuard = [
  attachPublicRequestMeta('public-telematics-zubie-webhook'),
  createPublicRateLimitGuard({ name: 'public-telematics-zubie-webhook', maxRequests: 120, windowMs: 60 * 1000 }),
  createOptionalIdempotencyGuard({ name: 'public-telematics-zubie-webhook', windowMs: 30 * 60 * 1000 })
];

function vehicleDuplicateMessage(error) {
  const target = Array.isArray(error?.meta?.target) ? error.meta.target.map((item) => String(item)) : [];
  if (target.includes('plate')) return 'A vehicle with that plate already exists in this tenant';
  if (target.includes('vin')) return 'A vehicle with that VIN already exists';
  return 'A vehicle with that internal number already exists in this tenant';
}

function isTenantLimitError(error) {
  return /allows up to .*vehicles|adding more cars/i.test(String(error?.message || ''));
}

function scopeForTenantId(tenantId) {
  return { tenantId: String(tenantId || '').trim() || null, allowCrossTenant: false };
}

function secretMatches(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || !b.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function enforceTelematicsFeature(req, res, next) {
  try {
    const cfg = await settingsService.getTelematicsConfig(scopeFor(req));
    if (!cfg?.planDefaults?.telematicsIncluded) {
      return res.status(403).json({ error: 'Telematics is not included for this tenant plan' });
    }
    if (!cfg?.enabled) {
      return res.status(403).json({ error: 'Telematics is disabled for this tenant' });
    }
    req.telematicsConfig = cfg;
    next();
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for telematics routes' });
    }
    next(e);
  }
}

async function enforcePublicZubieWebhook(req, res, next) {
  const tenantId = String(req.params?.tenantId || req.query?.tenantId || '').trim();
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required for the Zubie webhook' });
  try {
    const scopedTenantId = requireString(tenantId, 'tenantId');
    const cfg = await settingsService.getTelematicsConfig(scopeForTenantId(scopedTenantId), { includeSecret: true });
    if (!cfg?.planDefaults?.telematicsIncluded) {
      return res.status(403).json({ error: 'Telematics is not included for this tenant plan' });
    }
    if (!cfg?.enabled) {
      return res.status(403).json({ error: 'Telematics is disabled for this tenant' });
    }
    if (String(cfg?.provider || '').toUpperCase() !== 'ZUBIE' || !cfg?.allowZubieConnector) {
      return res.status(403).json({ error: 'Zubie connector is not enabled for this tenant' });
    }
    if (String(cfg?.webhookAuthMode || 'HEADER_SECRET').toUpperCase() === 'HEADER_SECRET') {
      if (!cfg?.hasZubieWebhookSecret) {
        return res.status(412).json({ error: 'Zubie webhook secret is not configured for this tenant' });
      }
      const presentedSecret = String(
        req.get('x-zubie-webhook-secret')
        || req.get('x-ridefleet-webhook-secret')
        || req.get('x-webhook-secret')
        || ''
      ).trim();
      if (!secretMatches(presentedSecret, cfg.zubieWebhookSecret)) {
        return res.status(401).json({ error: 'Invalid Zubie webhook secret' });
      }
    }
    req.telematicsConfig = cfg;
    req.telematicsScope = scopeForTenantId(scopedTenantId);
    next();
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for the Zubie webhook' });
    }
    next(e);
  }
}

function zubieRequestMetadata(req, options = {}) {
  return {
    requestPath: req.originalUrl || req.url || '',
    deliveryId: req.get('x-zubie-delivery-id') || req.get('x-request-id') || null,
    userAgent: req.get('user-agent') || null,
    contentType: req.get('content-type') || null,
    secretVerified: !!options.secretVerified
  };
}

publicVehicleTelematicsRouter.post('/zubie/:tenantId/webhook', publicTelematicsWebhookGuard, enforcePublicZubieWebhook, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'Zubie webhook payload');
    const out = await vehiclesService.ingestZubieWebhook(req.body || {}, req.telematicsScope || scopeForTenantId(req.params?.tenantId), {
      ingestSource: 'PUBLIC_WEBHOOK',
      requestMetadata: zubieRequestMetadata(req, {
        secretVerified: String(req.telematicsConfig?.webhookAuthMode || '').toUpperCase() === 'HEADER_SECRET'
      })
    });
    res.status(202).json(out);
  } catch (e) {
    if (/Telematics device not found|Vehicle not found/i.test(String(e?.message || ''))) {
      return res.status(404).json({ error: String(e.message) });
    }
    if (/externalDeviceId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: String(e.message) });
    }
    next(e);
  }
});

vehiclesRouter.get('/', async (_req, res) => {
  res.json(await vehiclesService.list(scopeFor(_req)));
});

vehiclesRouter.get('/telematics/providers', async (_req, res) => {
  res.json(vehiclesService.listTelematicsProviders());
});

vehiclesRouter.post('/telematics/zubie/webhook', enforceTelematicsFeature, async (req, res, next) => {
  try {
    if (String(req.telematicsConfig?.provider || '').toUpperCase() !== 'ZUBIE' || !req.telematicsConfig?.allowZubieConnector) {
      return res.status(403).json({ error: 'Zubie connector is not enabled for this tenant' });
    }
    const out = await vehiclesService.ingestZubieWebhook(req.body || {}, scopeFor(req), {
      ingestSource: 'AUTH_STUB',
      requestMetadata: zubieRequestMetadata(req, { secretVerified: false })
    });
    res.status(202).json(out);
  } catch (e) {
    if (/Telematics device not found|Vehicle not found/i.test(String(e?.message || ''))) {
      return res.status(404).json({ error: String(e.message) });
    }
    if (/externalDeviceId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: String(e.message) });
    }
    next(e);
  }
});

vehiclesRouter.get('/:id', async (req, res) => {
  const row = await vehiclesService.getById(req.params.id, scopeFor(req));
  if (!row) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(row);
});

vehiclesRouter.post('/', async (req, res, next) => {
  const required = ['internalNumber', 'vehicleTypeId'];
  const missing = required.filter((k) => !req.body?.[k]);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  try {
    const row = await vehiclesService.create(req.body, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (isTenantLimitError(e)) {
      return res.status(400).json({ error: e.message });
    }
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: vehicleDuplicateMessage(e) });
    }
    next(e);
  }
});

vehiclesRouter.post('/bulk/validate', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const report = await vehiclesService.validateBulk(rows, scopeFor(req));
  res.json(report);
});

vehiclesRouter.post('/bulk/import', async (req, res, next) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  try {
    const out = await vehiclesService.importBulk(rows, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (isTenantLimitError(e)) {
      return res.status(400).json({ error: e.message });
    }
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: 'One or more vehicles already exist in this tenant by unit ID, plate, or VIN. Re-run validation and refresh the inventory list.' });
    }
    next(e);
  }
});

vehiclesRouter.post('/availability-blocks/validate', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const report = await vehiclesService.validateBulkAvailabilityBlocks(rows, scopeFor(req));
  res.json(report);
});

vehiclesRouter.post('/availability-blocks/import', async (req, res, next) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  try {
    const out = await vehiclesService.importBulkAvailabilityBlocks(rows, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

vehiclesRouter.post('/:id/availability-blocks', async (req, res, next) => {
  try {
    const row = await vehiclesService.createAvailabilityBlock(req.params.id, req.body || {}, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (/Vehicle not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Vehicle not found' });
    if (/availableFrom is required|availableFrom must be after blockedFrom|blockType is invalid/i.test(String(e?.message || ''))) return res.status(400).json({ error: String(e.message) });
    next(e);
  }
});

vehiclesRouter.get('/:id/telematics', enforceTelematicsFeature, async (req, res, next) => {
  try {
    const out = await vehiclesService.listTelematics(req.params.id, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (/Vehicle not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Vehicle not found' });
    next(e);
  }
});

vehiclesRouter.post('/:id/telematics/devices', enforceTelematicsFeature, async (req, res, next) => {
  try {
    const out = await vehiclesService.registerTelematicsDevice(req.params.id, req.body || {}, scopeFor(req));
    res.status(201).json(out);
  } catch (e) {
    if (/Vehicle not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Vehicle not found' });
    if (/provider is required|externalDeviceId is required/i.test(String(e?.message || ''))) return res.status(400).json({ error: String(e.message) });
    if (e?.code === 'P2002') return res.status(409).json({ error: 'A telematics device with that provider and external device id already exists' });
    next(e);
  }
});

vehiclesRouter.post('/:id/telematics/events', enforceTelematicsFeature, async (req, res, next) => {
  try {
    if (req.telematicsConfig && !req.telematicsConfig.allowManualEventIngest) {
      return res.status(403).json({ error: 'Manual telematics event ingest is disabled for this tenant' });
    }
    const out = await vehiclesService.ingestTelematicsEvent(req.params.id, req.body || {}, scopeFor(req));
    res.status(201).json(out);
  } catch (e) {
    if (/Vehicle not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Vehicle not found' });
    if (/Telematics device not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Telematics device not found for this vehicle' });
    next(e);
  }
});

vehiclesRouter.post('/availability-blocks/:id/release', async (req, res, next) => {
  try {
    const row = await vehiclesService.releaseAvailabilityBlock(req.params.id, scopeFor(req));
    res.json(row);
  } catch (e) {
    if (/Availability block not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Availability block not found' });
    next(e);
  }
});

vehiclesRouter.patch('/:id', async (req, res, next) => {
  try {
    const row = await vehiclesService.update(req.params.id, req.body || {}, scopeFor(req));
    res.json(row);
  } catch (e) {
    if (e?.code === 'P2002') return res.status(409).json({ error: vehicleDuplicateMessage(e) });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Vehicle not found' });
    next(e);
  }
});

vehiclesRouter.delete('/:id', async (req, res) => {
  try {
    await vehiclesService.remove(req.params.id, scopeFor(req));
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Vehicle not found' });
  }
});
