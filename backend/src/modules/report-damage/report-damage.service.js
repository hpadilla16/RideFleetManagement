/**
 * Report Damage orchestrator (Feature 3, 2026-07-10).
 *
 * A THIN orchestrator — it does NOT reimplement any of the three modules it
 * stitches together, it calls them in order:
 *
 *   1. customerInspectionService.addManualDamage  → a HARD_APPROVED
 *      VehicleDamageReport on the vehicle profile, now carrying reservation /
 *      customer / estimate / who-pays context (permanent damage record).
 *   2. reservationPricingService.addManualCharge  → the damage charge on the
 *      CONTRACT (source 'DAMAGE_CHARGE'). This is the ONLY path money moves;
 *      balance recomputes solely through syncAgreementCharges. No gateway / card.
 *   3. Vehicle.status                              → set to the chosen value.
 *   4. incidentReportService.create (DRAFT)        → auto-created DAMAGE incident,
 *      damage photos attached as evidence, the charge referenced in chargeIdsJson
 *      (DOCUMENT-ONLY — incident §6 never writes charges, so no double-bill). NOT
 *      auto-issued and NO email — the agent completes + certifies it later.
 *
 * ACCESS CONTROL (Hector's scoped exception): the route is gated to AGENT / OPS /
 * ADMIN / SUPER_ADMIN and calls addManualCharge INTERNALLY. Agents therefore get
 * the damage charge ONLY through this flow — the general Admin Corrections charge
 * gate (canDoAdminCorrections = ADMIN/SUPER_ADMIN) is untouched.
 *
 * WHO-PAYS → charge amount:
 *   CUSTOMER | CUSTOMER_INSURANCE → damageCostCents (full repair) → on the contract
 *   OUR_INSURANCE                 → ourDeductibleCents (deductible only) → on the contract
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { customerInspectionService } from '../customer-inspection/customer-inspection.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';
import { incidentReportService } from '../incident-report/incident-report.service.js';
import { resolveVoziaCeiling } from '../rental-agreements/service-payment-guards.js';

const RESPONSIBLE_PARTIES = ['CUSTOMER', 'CUSTOMER_INSURANCE', 'OUR_INSURANCE'];
// Hector's decision: the dropdown offers ALL VehicleStatus values, default IN_MAINTENANCE.
const VEHICLE_STATUSES = ['AVAILABLE', 'RESERVED', 'ON_RENT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD'];
const VIEW_LABELS = { FRONT: 'Front', REAR: 'Rear', LEFT: 'Left', RIGHT: 'Right', INTERIOR: 'Interior' };

// FIX D (Innovation SHOULD) — defense-in-depth per-line ceiling for the agent-
// initiated damage charge. Configurable per tenant via the SAME AppSetting/ceiling
// primitive VozIA uses (resolveVoziaCeiling reads `tenant:<id>:<key>` in DOLLARS and
// fails safe to the default on any miss/parse error). The default is deliberately
// HIGH ($10,000) so a legitimate repair is never blocked — the ceiling only stops a
// fat-fingered / runaway amount; a genuinely larger charge is added by an admin from
// Admin Corrections (which has no such cap).
const DAMAGE_CHARGE_CEILING_SETTING_KEY = 'damageChargeMaxAmount';
const DEFAULT_DAMAGE_CHARGE_CEILING = 10000; // USD
// FIX E (Innovation SHOULD) — short-window idempotency guard. A duplicate submit
// (double-click, client retry, agent re-run) with the SAME reservation + SAME charge
// amount inside this window returns the PRIOR result instead of billing a second time.
const DUPLICATE_CHARGE_WINDOW_MS = 60 * 1000;

function err(msg, status = 400, code) { const e = new Error(msg); e.status = status; if (code) e.code = code; return e; }
function toCents(v) { return (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Math.round(Number(v)); }

export const reportDamageService = {
  /**
   * Orchestrate a reservation-launched damage report. `ctx = { user, scope }`.
   * Returns { damageReportId, chargeId, chargeAmount, incidentId, vehicleStatus, responsibleParty }.
   */
  async reportDamage(reservationId, body = {}, ctx = {}) {
    const { user = null, scope = {} } = ctx;
    const tenantId = scope?.tenantId ?? user?.tenantId ?? null;

    // --- 0. Load + tenant-scope the reservation (existence + isolation) ---
    const reservation = await prisma.reservation.findFirst({
      where: { id: String(reservationId), ...(tenantId ? { tenantId } : {}) },
      select: { id: true, tenantId: true, reservationNumber: true, vehicleId: true }
    });
    if (!reservation) throw err('Reservation not found', 404);
    if (!reservation.vehicleId) throw err('Reservation has no vehicle to record damage against', 400);

    // --- validate inputs up front (fail before any write) ---
    const responsibleParty = String(body?.responsibleParty || '').toUpperCase();
    if (!RESPONSIBLE_PARTIES.includes(responsibleParty)) {
      throw err(`responsibleParty must be one of ${RESPONSIBLE_PARTIES.join(', ')}`, 400);
    }
    const vehicleStatus = String(body?.vehicleStatus || 'IN_MAINTENANCE').toUpperCase();
    if (!VEHICLE_STATUSES.includes(vehicleStatus)) {
      throw err(`vehicleStatus must be one of ${VEHICLE_STATUSES.join(', ')}`, 400);
    }
    const damagePhotos = (Array.isArray(body?.damagePhotos) ? body.damagePhotos : [])
      .filter((p) => typeof p === 'string' && p.length);
    if (damagePhotos.length < 1) throw err('At least one damage photo is required', 400, 'PHOTO_REQUIRED');

    const damageCostCents = toCents(body?.damageCostCents);
    const ourDeductibleCents = toCents(body?.ourDeductibleCents);
    // Who-pays → what lands on the contract. For OUR_INSURANCE we STILL record the
    // full repair (damageCostCents) on the damage report, but only the deductible is
    // billed to the renter — the full estimate is filed on our policy.
    const chargeAmountCents = responsibleParty === 'OUR_INSURANCE' ? ourDeductibleCents : damageCostCents;
    if (chargeAmountCents != null && chargeAmountCents < 0) throw err('charge amount must be >= 0', 400);

    const actorUserId = user?.id || user?.sub || null;
    const description = body?.description ? String(body.description) : null;

    // --- FIX D: ceiling check (BEFORE any write, so an over-limit request never
    // leaves an orphan damage record). Only the amount that actually hits the
    // contract is capped. ---
    if (chargeAmountCents && chargeAmountCents > 0) {
      const ceiling = await resolveVoziaCeiling(
        reservation.tenantId,
        DAMAGE_CHARGE_CEILING_SETTING_KEY,
        DEFAULT_DAMAGE_CHARGE_CEILING
      );
      const ceilingCents = Math.round(Number(ceiling) * 100);
      if (Number.isFinite(ceilingCents) && chargeAmountCents > ceilingCents) {
        throw err(
          `Amount exceeds the damage-charge limit ($${Number(ceiling).toLocaleString()}); have an admin add a larger charge.`,
          400,
          'DAMAGE_CHARGE_CEILING'
        );
      }
    }

    // --- FIX E: short-window idempotency guard. If an identical DAMAGE_CHARGE
    // (same agreement + same amount) was committed in the last minute, this is a
    // duplicate submit — return that PRIOR result instead of billing again. ---
    if (chargeAmountCents && chargeAmountCents > 0) {
      const priorAgreement = await prisma.rentalAgreement.findFirst({
        where: { reservationId: reservation.id, ...(tenantId ? { tenantId } : {}) },
        orderBy: { createdAt: 'desc' },
        select: { id: true }
      });
      if (priorAgreement) {
        const recentCharge = await prisma.rentalAgreementCharge.findFirst({
          where: {
            rentalAgreementId: priorAgreement.id,
            source: 'DAMAGE_CHARGE',
            selected: true,
            total: chargeAmountCents / 100,
            createdAt: { gte: new Date(Date.now() - DUPLICATE_CHARGE_WINDOW_MS) }
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true }
        });
        if (recentCharge) {
          const prior = await prisma.vehicleDamageReport.findFirst({
            where: { reservationChargeId: recentCharge.id },
            select: { id: true, incidentId: true, responsibleParty: true }
          });
          logger.warn('[report-damage] duplicate submit suppressed (returning prior result, no second charge)', {
            reservationId: reservation.id, chargeId: recentCharge.id, damageReportId: prior?.id || null
          });
          return {
            damageReportId: prior?.id || null,
            chargeId: recentCharge.id,
            chargeAmount: chargeAmountCents / 100,
            incidentId: prior?.incidentId || null,
            vehicleStatus,
            responsibleParty: prior?.responsibleParty || responsibleParty,
            duplicate: true,
          };
        }
      }
    }

    // --- 1. HARD_APPROVED VehicleDamageReport (reuse addManualDamage) ---
    const dmgScope = { tenantId: reservation.tenantId, userId: actorUserId };
    const damage = await customerInspectionService.addManualDamage(reservation.vehicleId, {
      view: body?.view,
      xPct: body?.xPct,
      yPct: body?.yPct,
      description,
      photoDataUrl: damagePhotos[0], // the diagram carries one photo; the rest go to the incident
      estimatePhotoDataUrl: body?.estimatePhoto || null,
      reservationId: reservation.id,
      reservationNumber: reservation.reservationNumber,
      damageCostCents,
      ourDeductibleCents,
      responsibleParty,
    }, dmgScope);
    const damageReportId = damage.id;

    // --- 2. Contract charge (agent-scoped exception; DAMAGE_CHARGE source) ---
    let chargeId = null;
    let chargeAmount = 0;
    try {
      if (chargeAmountCents && chargeAmountCents > 0) {
        const label = responsibleParty === 'OUR_INSURANCE'
          ? 'Damage (deductible)'
          : `Damage — ${(description || 'repair').slice(0, 60)}`;
        const reason = `Report Damage flow · ${responsibleParty} · damage ${damageReportId}`;
        const meta = await reservationPricingService.addManualCharge(
          reservation.id,
          { name: label, amount: chargeAmountCents / 100, source: 'DAMAGE_CHARGE' },
          { reason, actorUserId, returnMeta: true },
          { tenantId: reservation.tenantId }
        );
        chargeId = meta?.chargeId || null;
        chargeAmount = chargeAmountCents / 100;
        // FIX A: the link-back is BEST-EFFORT. The charge is already committed at
        // this point, so if this update threw it would trip the rollback catch
        // below and DELETE the damage record while the charge stays orphaned on the
        // contract — the agent then re-submits and DOUBLE-charges. Swallowing here
        // (exactly like the incidentId link-back further down) means the rollback
        // catch only ever fires on a genuine addManualCharge failure (before any
        // money moved), so no committed charge can be left behind by an API error.
        if (chargeId) {
          await prisma.vehicleDamageReport.update({
            where: { id: damageReportId },
            data: { reservationChargeId: chargeId }
          }).catch((e) => logger.warn('[report-damage] charge link-back failed (charge kept)', { chargeId, damageReportId, err: e.message }));
        }
      }
    } catch (e) {
      // addManualCharge itself failed — NO money moved (it is transactional +
      // recomputes the balance only on success). Roll back the just-created damage
      // record so we never leave an orphan HARD_APPROVED with no charge. Nothing
      // after this has run yet, so a delete fully unwinds the flow.
      await prisma.vehicleDamageReport.delete({ where: { id: damageReportId } }).catch(() => {});
      throw e;
    }

    // --- 3. Vehicle status (best-effort; the money record above is the source of truth) ---
    try {
      await prisma.vehicle.update({ where: { id: reservation.vehicleId }, data: { status: vehicleStatus } });
    } catch (e) {
      logger.error('[report-damage] vehicle status update failed', { vehicleId: reservation.vehicleId, err: e.message });
    }

    // --- 4. Auto-create the Incident Report DRAFT (best-effort) ---
    let incidentId = null;
    try {
      const incidentUser = { id: actorUserId, tenantId: reservation.tenantId, role: user?.role };
      const incident = await incidentReportService.create(incidentUser, reservation.id, { type: 'DAMAGE' });
      incidentId = incident?.id || null;
      if (incidentId) {
        const viewLabel = VIEW_LABELS[String(body?.view || '').toUpperCase()] || 'Damage';
        for (const photo of damagePhotos) {
          // eslint-disable-next-line no-await-in-loop
          await incidentReportService.addEvidence(incidentUser, incidentId, {
            photoDataUrl: photo,
            location: `${viewLabel} damage`,
            description: description || 'Damage photo',
          }).catch((e) => logger.warn('[report-damage] addEvidence failed', { err: e.message }));
        }
        // Reference the charge on the incident (DOCUMENT-ONLY — §6 never re-bills).
        if (chargeId) {
          await incidentReportService.update(incidentUser, incidentId, { chargeIds: [chargeId] })
            .catch((e) => logger.warn('[report-damage] incident chargeIds set failed', { err: e.message }));
        }
        await prisma.vehicleDamageReport.update({ where: { id: damageReportId }, data: { incidentId } }).catch(() => {});
      }
    } catch (e) {
      // Non-money-critical: the permanent damage record + the contract charge are
      // already committed and consistent. Surface the failure but do not unwind.
      logger.error('[report-damage] incident DRAFT creation failed (damage + charge kept)', { err: e.message });
    }

    logger.info('[report-damage] complete', {
      reservationId: reservation.id, damageReportId, chargeId, incidentId, vehicleStatus, responsibleParty
    });
    // Surface BOTH money figures so the confirmation screen reconciles: for
    // OUR_INSURANCE the renter is billed only ourDeductibleCents while the FULL
    // repair (damageCostCents) is what we filed on our policy — returning both keeps
    // "why is the charge less than the estimate?" from looking like an under-charge.
    return {
      damageReportId, chargeId, chargeAmount, incidentId, vehicleStatus, responsibleParty,
      damageCostCents: damageCostCents ?? null,
      ourDeductibleCents: ourDeductibleCents ?? null,
    };
  },

  // ---------------------------------------------------------------------------
  // FAILSAFE (ADMIN / SUPER_ADMIN only, gated at the route) — edit + delete a
  // VehicleDamageReport. These did NOT exist before. Every action is audited.
  // ---------------------------------------------------------------------------

  /** Correct description / cost / responsibleParty on a damage record. When the
   *  correction changes the EFFECTIVE charge amount (cost for CUSTOMER/
   *  CUSTOMER_INSURANCE, deductible for OUR_INSURANCE) AND the record has a linked
   *  DAMAGE_CHARGE, RE-SYNC the contract (FIX F): void the old charge and add a new
   *  one for the corrected amount so the balance always matches the record — never a
   *  silent desync. Both the void and the add write their own AuditLog; this method
   *  writes the edit audit. Audited. */
  async editDamageReport(reportId, patch = {}, ctx = {}) {
    const { user = null, scope = {} } = ctx;
    const tenantId = scope?.tenantId ?? user?.tenantId ?? null;
    const actorUserId = user?.id || user?.sub || null;
    const report = await prisma.vehicleDamageReport.findFirst({
      where: { id: String(reportId), ...(tenantId ? { tenantId } : {}) },
      select: { id: true, tenantId: true, reservationId: true, reservationChargeId: true, description: true, damageCostCents: true, ourDeductibleCents: true, responsibleParty: true }
    });
    if (!report) throw err('Damage report not found', 404);

    const data = {};
    if ('description' in patch) data.description = patch.description ? String(patch.description).slice(0, 500) : null;
    if ('damageCostCents' in patch) data.damageCostCents = toCents(patch.damageCostCents);
    if ('ourDeductibleCents' in patch) data.ourDeductibleCents = toCents(patch.ourDeductibleCents);
    if ('responsibleParty' in patch) {
      const rp = patch.responsibleParty ? String(patch.responsibleParty).toUpperCase() : null;
      if (rp && !RESPONSIBLE_PARTIES.includes(rp)) throw err(`responsibleParty must be one of ${RESPONSIBLE_PARTIES.join(', ')}`, 400);
      data.responsibleParty = rp;
    }
    if (!Object.keys(data).length) throw err('Nothing to update', 400);

    // Effective charge = what actually hits the contract, before vs. after the edit.
    const effectiveCents = (rp, cost, ded) => (String(rp).toUpperCase() === 'OUR_INSURANCE' ? ded : cost);
    const newRp = 'responsibleParty' in data ? data.responsibleParty : report.responsibleParty;
    const newCost = 'damageCostCents' in data ? data.damageCostCents : report.damageCostCents;
    const newDed = 'ourDeductibleCents' in data ? data.ourDeductibleCents : report.ourDeductibleCents;
    const oldEffective = effectiveCents(report.responsibleParty, report.damageCostCents, report.ourDeductibleCents);
    const newEffective = effectiveCents(newRp, newCost, newDed);

    const updated = await prisma.vehicleDamageReport.update({ where: { id: report.id }, data });

    // FIX F — re-sync the linked contract charge when the effective amount changed.
    let chargeResync = null;
    if (report.reservationChargeId && report.reservationId && Number(oldEffective || 0) !== Number(newEffective || 0)) {
      const resyncScope = { tenantId: report.tenantId ?? tenantId };
      const resyncReason = patch.reason ? String(patch.reason).slice(0, 500) : `Damage record ${report.id} corrected`;
      let voided = null;
      let newChargeId = null;
      try {
        // Void the stale charge (reuse the existing primitive — it recomputes the balance).
        await reservationPricingService.voidAgreementCharge(
          report.reservationId, report.reservationChargeId,
          { reason: resyncReason, actorUserId }, resyncScope
        );
        voided = report.reservationChargeId;
      } catch (e) {
        // Already voided is fine; record it and still (re)issue the corrected charge.
        logger.warn('[report-damage] edit re-sync: old charge void failed', { chargeId: report.reservationChargeId, err: e?.message });
      }
      if (newEffective && Number(newEffective) > 0) {
        const label = newRp === 'OUR_INSURANCE'
          ? 'Damage (deductible)'
          : `Damage — ${(data.description ?? report.description ?? 'repair' ).toString().slice(0, 60)}`;
        const meta = await reservationPricingService.addManualCharge(
          report.reservationId,
          { name: label, amount: Number(newEffective) / 100, source: 'DAMAGE_CHARGE' },
          { reason: `${resyncReason} · corrected amount`, actorUserId, returnMeta: true },
          resyncScope
        );
        newChargeId = meta?.chargeId || null;
      }
      // Re-point the record at the corrected charge (null when the new amount is 0).
      await prisma.vehicleDamageReport.update({ where: { id: report.id }, data: { reservationChargeId: newChargeId } })
        .catch((e) => logger.warn('[report-damage] edit re-sync: charge re-link failed', { newChargeId, err: e?.message }));
      chargeResync = { voided, newChargeId, oldEffectiveCents: oldEffective ?? 0, newEffectiveCents: newEffective ?? 0 };
    }

    await prisma.auditLog.create({ data: {
      tenantId: report.tenantId || tenantId || null,
      reservationId: report.reservationId || null,
      action: 'ADMIN_OVERRIDE',
      actorUserId,
      reason: patch.reason ? String(patch.reason).slice(0, 500) : null,
      metadata: JSON.stringify({
        kind: 'damage_report_edit',
        damageReportId: report.id,
        before: { description: report.description, damageCostCents: report.damageCostCents, ourDeductibleCents: report.ourDeductibleCents, responsibleParty: report.responsibleParty },
        after: data,
        chargeResync,
        note: chargeResync
          ? 'Linked charge RE-SYNCED to the corrected amount (old charge voided, new charge added).'
          : 'Effective charge amount unchanged — linked charge (if any) left as-is.'
      })
    }});
    return { ok: true, id: updated.id, chargeResync };
  },

  /** Delete a HARD_APPROVED damage record. If it has a linked contract charge,
   *  VOID that charge too (reuse voidAgreementCharge) so the balance is corrected.
   *  The incident DRAFT (if any) is left for the admin to handle. Audited. */
  async deleteDamageReport(reportId, opts = {}, ctx = {}) {
    const { user = null, scope = {} } = ctx;
    const tenantId = scope?.tenantId ?? user?.tenantId ?? null;
    const actorUserId = user?.id || user?.sub || null;
    const reason = opts.reason ? String(opts.reason).slice(0, 500) : null;

    const report = await prisma.vehicleDamageReport.findFirst({
      where: { id: String(reportId), ...(tenantId ? { tenantId } : {}) },
      select: { id: true, tenantId: true, vehicleId: true, reservationId: true, reservationChargeId: true, incidentId: true, status: true, description: true }
    });
    if (!report) throw err('Damage report not found', 404);

    // Void the linked charge first (so the deletion also unwinds the money).
    let chargeVoided = null;
    let chargeVoidError = null;
    if (report.reservationId && report.reservationChargeId) {
      try {
        await reservationPricingService.voidAgreementCharge(
          report.reservationId,
          report.reservationChargeId,
          { reason: reason || `Damage record ${report.id} deleted`, actorUserId },
          { tenantId: report.tenantId ?? tenantId }
        );
        chargeVoided = report.reservationChargeId;
      } catch (e) {
        // Already voided is fine; anything else is recorded but does not block the delete.
        chargeVoidError = e?.message || String(e);
        logger.warn('[report-damage] linked charge void failed on delete', { chargeId: report.reservationChargeId, err: chargeVoidError });
      }
    }

    await prisma.vehicleDamageReport.delete({ where: { id: report.id } });
    await prisma.auditLog.create({ data: {
      tenantId: report.tenantId || tenantId || null,
      reservationId: report.reservationId || null,
      action: 'ADMIN_OVERRIDE',
      actorUserId,
      reason,
      metadata: JSON.stringify({
        kind: 'damage_report_delete',
        damageReportId: report.id,
        vehicleId: report.vehicleId,
        description: report.description,
        chargeVoided,
        chargeVoidError,
        incidentId: report.incidentId || null,
        note: report.incidentId ? 'Linked incident DRAFT left intact — handle it separately.' : null
      })
    }});
    return { ok: true, id: report.id, chargeVoided, chargeVoidError };
  },
};

export const __test = { RESPONSIBLE_PARTIES, VEHICLE_STATUSES, toCents };
