/**
 * Counter routes for Interactive T&C + Dejavoo P1 unified flow (2026-05-21).
 *
 * Mounted in main.js as:
 *   app.use('/api/payment-gateway/counter',
 *           requireAuth, tenantRateLimit,
 *           requireRole('ADMIN','OPS','AGENT'),
 *           counterRouter);
 *   app.use('/api/reservations', requireAuth, tenantRateLimit, signingStatusRouter);
 *
 * Endpoints:
 *   POST  /api/payment-gateway/counter/start-checkin
 *       Body: { reservationId, terminalId? }
 *       Returns { surface, jobId?, signingId? }
 *           surface = 'DEJAVOO_TERMINAL' | 'TABLET' | 'LEGACY'
 *           Frontend wizard reads `surface` and picks the UX.
 *
 *   POST  /api/payment-gateway/counter/abort
 *       Body: { terminalId }
 *       Aborts whatever transaction is currently active on the terminal.
 *
 *   GET   /api/reservations/:id/signing
 *       Returns current signing state + per-field progress.
 *
 *   POST  /api/reservations/:id/signing/refuse
 *       Body: { reason }
 *       Agent records customer refusal. Reservation stays unsigned.
 *
 * Spec: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §8
 */

import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { getTenantFlag, resolveFlag } from '../../lib/feature-flags.js';
import { getActiveTemplateForTenant } from '../terms/terms-templates.service.js';
import { enqueueCounterCheckin } from './counter-checkin.worker.js';
import { enqueueCounterReturn } from './counter-return.worker.js';
import { spinClient } from './spin-client.js';
import { CounterOrchestratorError } from './counter-orchestrator.service.js';

// Lazy prisma
let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

export const counterRouter = Router();
export const signingStatusRouter = Router();

function sendError(res, err) {
  if (err instanceof CounterOrchestratorError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  if (err && typeof err.status === 'number') {
    return res.status(err.status).json({ error: err.message });
  }
  return res.status(500).json({ error: err?.message || 'Internal server error' });
}

// ---------------------------------------------------------------------------
// Surface resolver
// ---------------------------------------------------------------------------

/**
 * Decide which signing surface to use for the request. Mirrors the
 * canonical logic from the unified design §3 / feature-flag spec.
 *
 * Returns:
 *   { surface: 'DEJAVOO_TERMINAL', terminalId } when both flags ON +
 *       active terminal available
 *   { surface: 'TABLET' }            when interactiveTC ON but no terminal
 *   { surface: 'LEGACY' }            when either flag OFF (skip to existing single-sig)
 */
async function resolveSurface({ prisma, user, preferTerminalId }) {
  const [tcState, djState] = await Promise.all([
    getTenantFlag(user.tenantId, 'interactiveTC', { prisma }),
    getTenantFlag(user.tenantId, 'dejavooCounter', { prisma }),
  ]);
  const tcOn = resolveFlag(tcState, user);
  const djOn = resolveFlag(djState, user);

  if (!tcOn) {
    return { surface: 'LEGACY', interactiveTC: false, dejavooCounter: false };
  }

  // Find an active terminal (caller may have preferred a specific one)
  let terminal = null;
  if (djOn) {
    if (preferTerminalId) {
      terminal = await prisma.dejavooTerminal.findFirst({
        where: { id: preferTerminalId, tenantId: user.tenantId, status: 'ACTIVE' },
      });
    } else {
      terminal = await prisma.dejavooTerminal.findFirst({
        where: { tenantId: user.tenantId, status: 'ACTIVE' },
        orderBy: { lastSeenAt: 'desc' },
      });
    }
  }

  if (djOn && terminal) {
    return {
      surface: 'DEJAVOO_TERMINAL',
      interactiveTC: true,
      dejavooCounter: true,
      terminalId: terminal.id,
    };
  }
  return { surface: 'TABLET', interactiveTC: true, dejavooCounter: djOn };
}

// ===========================================================================
// POST /api/payment-gateway/counter/start-checkin
// ===========================================================================

counterRouter.post('/start-checkin', requireRole('ADMIN', 'OPS', 'AGENT'), async (req, res) => {
  try {
    const prisma = await resolveDefaultPrisma();
    const body = req.body || {};
    const reservationId = body.reservationId;
    if (!reservationId) {
      return res.status(400).json({ error: 'reservationId is required' });
    }

    // 0. Confirm reservation exists in tenant scope
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, tenantId: req.user.tenantId },
      select: { id: true, signingCompletedAt: true },
    });
    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found in tenant scope' });
    }
    if (reservation.signingCompletedAt) {
      return res.status(409).json({ error: 'Reservation is already signed', code: 'ALREADY_SIGNED' });
    }

    // 1. Resolve surface
    const surfaceInfo = await resolveSurface({
      prisma,
      user: req.user,
      preferTerminalId: body.terminalId || null,
    });

    if (surfaceInfo.surface === 'LEGACY') {
      return res.json({
        surface: 'LEGACY',
        message: 'Interactive T&C is OFF for this tenant — use legacy single-signature flow',
      });
    }

    // 2. Confirm active TermsTemplate exists (both surfaces need it)
    const template = await getActiveTemplateForTenant({ tenantId: req.user.tenantId, prisma });
    if (!template) {
      return res.status(422).json({
        error: 'No active TermsTemplate for this tenant — activate one in Settings first',
        code: 'NO_ACTIVE_TEMPLATE',
      });
    }

    if (surfaceInfo.surface === 'TABLET') {
      return res.json({
        surface: 'TABLET',
        templateId: template.id,
        redirectUrl: `/reservations/${reservationId}/sign?return=checkout-wizard`,
      });
    }

    // 3. DEJAVOO_TERMINAL: enqueue the orchestrator job
    const { jobId } = await enqueueCounterCheckin({
      reservationId,
      terminalId: surfaceInfo.terminalId,
      userSnapshot: {
        sub: req.user?.sub || req.user?.id,
        id: req.user?.id || req.user?.sub,
        role: req.user?.role,
        tenantId: req.user?.tenantId,
      },
      ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
      userAgent: req.headers['user-agent'] || null,
    });

    return res.status(202).json({
      surface: 'DEJAVOO_TERMINAL',
      terminalId: surfaceInfo.terminalId,
      templateId: template.id,
      jobId,
      pollUrl: `/api/reservations/${reservationId}/signing`,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ===========================================================================
// POST /api/payment-gateway/counter/abort
// ===========================================================================

counterRouter.post('/abort', requireRole('ADMIN', 'OPS', 'AGENT'), async (req, res) => {
  try {
    const prisma = await resolveDefaultPrisma();
    const body = req.body || {};
    if (!body.terminalId) {
      return res.status(400).json({ error: 'terminalId is required' });
    }
    const terminal = await prisma.dejavooTerminal.findFirst({
      where: { id: body.terminalId, tenantId: req.user.tenantId },
    });
    if (!terminal) {
      return res.status(404).json({ error: 'Terminal not found in tenant scope' });
    }
    // Decrypt authKey if needed (same logic as orchestrator, but inlined
    // here for the simpler abort case)
    let authKey = terminal.authKeyEnc || '';
    if (authKey.startsWith('enc:v1:')) {
      const { decrypt } = await import('../../lib/integration-crypto.js');
      authKey = decrypt(authKey.slice('enc:v1:'.length));
    }
    const tenantConfig = {
      spinAuthKey: authKey,
      spinTpn: terminal.tpn,
      spinMerchantNumber: terminal.merchantNumber || 1,
      spinSandbox: terminal.sandbox !== false,
    };
    try {
      const result = await spinClient.abort(tenantConfig);
      res.json({ aborted: true, terminalResponse: spinClient.normalizeResponse(result) });
    } catch (err) {
      // Abort failures are usually because no transaction was in progress —
      // return 200 with `aborted: false` rather than 5xx so the agent UI
      // can show "nothing to abort" cleanly.
      res.json({ aborted: false, error: err.message });
    }
  } catch (err) {
    sendError(res, err);
  }
});

// ===========================================================================
// GET /api/reservations/:id/signing — frontend poll endpoint
// ===========================================================================

signingStatusRouter.get('/:id/signing', async (req, res) => {
  try {
    const prisma = await resolveDefaultPrisma();
    const reservationId = req.params.id;

    // Tenant-scoped lookup
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, tenantId: req.user.tenantId },
      select: { id: true, signingCompletedAt: true },
    });
    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found in tenant scope' });
    }

    const signing = await prisma.reservationSigning.findUnique({
      where: { reservationId },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            version: true,
            _count: { select: { fields: true } },
            fields: {
              orderBy: { order: 'asc' },
              select: { id: true, kind: true, markerKey: true, label: true, required: true, order: true },
            },
          },
        },
        fields: {
          orderBy: { signedAt: 'asc' },
          select: { id: true, templateFieldId: true, value: true, signedAt: true },
        },
      },
    });

    if (!signing) {
      return res.json({
        status: 'NOT_STARTED',
        reservationId,
        completedAt: reservation.signingCompletedAt,
      });
    }

    const requiredFields = (signing.template?.fields || []).filter((f) => f.required !== false);
    const signedFieldIds = new Set(signing.fields.map((f) => f.templateFieldId));
    const totalRequired = requiredFields.length;
    const signedCount = requiredFields.filter((f) => signedFieldIds.has(f.id)).length;

    let status = 'IN_PROGRESS';
    if (signing.completedAt) status = 'COMPLETED';
    else if (signing.refusedAt) status = 'REFUSED';
    else if (signedCount === 0) status = 'PENDING';

    res.json({
      status,
      reservationId,
      signingId: signing.id,
      surface: signing.surfaceUsed,
      terminalId: signing.dejavooTerminalId,
      startedAt: signing.startedAt,
      completedAt: signing.completedAt,
      refusedAt: signing.refusedAt,
      refusalReason: signing.refusalReason,
      signedCount,
      totalRequired,
      progressPct: totalRequired === 0 ? 0 : Math.round((signedCount / totalRequired) * 100),
      currentFieldMarkerKey: requiredFields.find((f) => !signedFieldIds.has(f.id))?.markerKey || null,
      customerCardLast4: signing.customerCardLast4,
      signedPdfStoragePath: signing.signedPdfStoragePath,
      template: signing.template
        ? { id: signing.template.id, name: signing.template.name, version: signing.template.version }
        : null,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ===========================================================================
// POST /api/reservations/:id/signing/refuse
// ===========================================================================

signingStatusRouter.post('/:id/signing/refuse', requireRole('ADMIN', 'OPS', 'AGENT'), async (req, res) => {
  try {
    const prisma = await resolveDefaultPrisma();
    const reservationId = req.params.id;
    const reason = (req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: 'reason is required' });
    }

    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, tenantId: req.user.tenantId },
      select: { id: true, signingCompletedAt: true },
    });
    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found in tenant scope' });
    }
    if (reservation.signingCompletedAt) {
      return res.status(409).json({ error: 'Reservation is already signed — cannot refuse' });
    }

    // Either update existing ReservationSigning or create a refusal stub
    const existing = await prisma.reservationSigning.findUnique({
      where: { reservationId },
    });
    if (existing) {
      if (existing.refusedAt) {
        return res.json({ alreadyRefused: true, signing: existing });
      }
      const updated = await prisma.reservationSigning.update({
        where: { id: existing.id },
        data: { refusedAt: new Date(), refusalReason: reason },
      });
      return res.json({ alreadyRefused: false, signing: updated });
    }

    // No signing started — create a minimal refusal record so the audit trail
    // exists. Template snapshot is best-effort.
    const template = await getActiveTemplateForTenant({ tenantId: req.user.tenantId, prisma });
    if (!template) {
      return res.status(422).json({
        error: 'No active TermsTemplate — cannot record refusal without a template id',
      });
    }
    const created = await prisma.reservationSigning.create({
      data: {
        reservationId,
        templateId: template.id,
        templateVersionSnapshot: template.contentHtml,
        surfaceUsed: 'REFUSED',
        agentUserId: req.user?.sub || req.user?.id,
        customerName: 'Refused before signing',
        refusedAt: new Date(),
        refusalReason: reason,
      },
    });
    res.json({ alreadyRefused: false, signing: created });
  } catch (err) {
    sendError(res, err);
  }
});

// ===========================================================================
// POST /api/payment-gateway/counter/start-return
// ===========================================================================

counterRouter.post('/start-return', requireRole('ADMIN', 'OPS', 'AGENT'), async (req, res) => {
  try {
    const prisma = await resolveDefaultPrisma();
    const body = req.body || {};
    if (!body.reservationId) {
      return res.status(400).json({ error: 'reservationId is required' });
    }

    // Reservation must exist + be in tenant scope
    const reservation = await prisma.reservation.findFirst({
      where: { id: body.reservationId, tenantId: req.user.tenantId },
      select: { id: true },
    });
    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found in tenant scope' });
    }

    // Resolve dejavooCounter flag (TC isn't required for return)
    const { getTenantFlag, resolveFlag } = await import('../../lib/feature-flags.js');
    const djState = await getTenantFlag(req.user.tenantId, 'dejavooCounter', { prisma });
    if (!resolveFlag(djState, req.user)) {
      return res.status(403).json({
        error: 'Dejavoo counter is not enabled for this tenant',
        code: 'FLAG_OFF',
      });
    }

    // Resolve terminal
    let terminalId = body.terminalId || null;
    if (!terminalId) {
      const t = await prisma.dejavooTerminal.findFirst({
        where: { tenantId: req.user.tenantId, status: 'ACTIVE' },
        orderBy: { lastSeenAt: 'desc' },
      });
      terminalId = t?.id || null;
    }
    if (!terminalId) {
      return res.status(422).json({
        error: 'No active terminal found for this tenant',
        code: 'NO_TERMINAL',
      });
    }

    // Enqueue
    const { jobId } = await enqueueCounterReturn({
      reservationId: body.reservationId,
      terminalId,
      userSnapshot: {
        sub: req.user?.sub || req.user?.id,
        id: req.user?.id || req.user?.sub,
        role: req.user?.role,
        tenantId: req.user?.tenantId,
      },
      finalAmountCents:
        typeof body.finalAmountCents === 'number' ? body.finalAmountCents : undefined,
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    });

    return res.status(202).json({
      surface: 'DEJAVOO_TERMINAL',
      terminalId,
      jobId,
      // Reuse the signing poll URL — return progress shows up there as new
      // DejavooTransaction rows on the reservation (signing.id is the same
      // session, if it exists from the checkin).
      pollUrl: `/api/payment-gateway/transactions?reservationId=${body.reservationId}`,
    });
  } catch (err) {
    sendError(res, err);
  }
});
