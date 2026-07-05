/**
 * Ride Kiosk — device auth middleware (Fase B1, 2026-07-05).
 *
 * X-Kiosk-Token header → SHA-256 → unique-index lookup → constant-time
 * digest re-compare → ACTIVE check. Attaches req.kioskDevice
 * {id, tenantId, locationId, name, walkupEnabled} and bumps lastSeenAt as a
 * heartbeat (throttled, fire-and-forget). 401 on anything else — a revoked
 * or rotated-away token dies on its next request.
 */

import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { sha256Hex } from './kiosk-device.service.js';

// Don't write lastSeenAt on every poll — only when the stamp is stale.
export const LAST_SEEN_THROTTLE_MS = 30 * 1000;

export async function requireKioskDevice(req, res, next) {
  try {
    const token = String(req.get('x-kiosk-token') || '').trim();
    if (!token) return res.status(401).json({ error: 'Kiosk device token required' });

    const digest = sha256Hex(token);
    const device = await prisma.kioskDevice.findUnique({ where: { tokenHash: digest } });

    // Constant-time re-compare of the hex digests — defense-in-depth on top
    // of the unique-index lookup (equal length by construction when found).
    const stored = Buffer.from(String(device?.tokenHash || ''), 'utf8');
    const given = Buffer.from(digest, 'utf8');
    const match = !!device && stored.length === given.length && crypto.timingSafeEqual(stored, given);

    if (!match || device.status !== 'ACTIVE') {
      return res.status(401).json({ error: 'Invalid kiosk device token' });
    }

    req.kioskDevice = {
      id: device.id,
      tenantId: device.tenantId,
      locationId: device.locationId,
      name: device.name,
      walkupEnabled: device.walkupEnabled,
    };

    const lastSeenMs = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    if (Date.now() - lastSeenMs > LAST_SEEN_THROTTLE_MS) {
      const appVersion = String(req.get('x-kiosk-app-version') || '').trim().slice(0, 64);
      prisma.kioskDevice.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date(), ...(appVersion ? { appVersion } : {}) },
      }).catch(() => {});
    }

    return next();
  } catch (err) {
    logger.error('[kiosk-auth] middleware failure', { message: err?.message });
    return res.status(500).json({ error: 'Internal error' });
  }
}
