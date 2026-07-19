/**
 * Quotes module (2026-07-17) — native, saved price quotes. Approved plan:
 * doc/quotes-module-plan-2026-07-17.md (Hector 2026-07-17: TTL 72h, own module
 * toggle, VozIA can create AND convert, Q-#### format, rental only).
 *
 * PRICING RULE: this service NEVER computes prices. It calls the SAME engine the
 * public site uses (bookingEngineService.searchRental — tax-aware + revenue
 * pricing) and SNAPSHOTS the result. Reading a quote never recomputes; expiresAt
 * is the business protection against stale rates.
 *
 * MONEY RULE: a quote moves no money and holds no inventory. convert() creates a
 * plain reservation (status NEW, no vehicle hold beyond the normal availability
 * path, no payment) via reservationsService.create — the same validations staff
 * creation runs (doNotRent, location windows, vehicle conflict).
 *
 * REPORTING GUARDRAIL (beta.296 lesson): quotes are INTENT — they must never be
 * summed into revenue/sales/commission reports.
 *
 * deps are injectable for fake-db tests (quotes.service.test.mjs): { prisma,
 * bookingEngine, reservations, now, resolveTz, randHex }.
 */
import crypto from 'node:crypto';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { parseDateTimeInTz } from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';
import { isQuoteNumber, normalizeQuoteNumber, quoteNumberCandidate } from './quote-number.js';

const DEFAULT_TTL_HOURS = 72;

function ttlHours() {
  const raw = Number.parseInt(process.env.QUOTE_TTL_HOURS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_HOURS;
}

function err(message, code, status) {
  const e = new Error(message);
  if (code) e.code = code;
  if (status) e.status = status;
  return e;
}

function tenantWhere(scope) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : {};
}

async function defaultBookingEngine() {
  const mod = await import('../booking-engine/booking-engine.service.js');
  return mod.bookingEngineService;
}

async function defaultReservations() {
  const mod = await import('../reservations/reservations.service.js');
  return mod.reservationsService;
}

/** Mirror of booking-engine's generateReservationNumber, RES-prefixed. */
export function conversionReservationNumber(nowMs, randHex) {
  return `RES-${String(nowMs).slice(-8)}${String(randHex).toUpperCase()}`;
}

export function createQuotesService(deps = {}) {
  const db = deps.prisma || defaultPrisma;
  const now = deps.now || (() => new Date());
  const getEngine = deps.bookingEngine ? async () => deps.bookingEngine : defaultBookingEngine;
  // Tenant wall-clock normalization (Innovation MC-3): TZ-less strings would parse
  // as container-UTC and land 4h off — same bug class the staff form fixed.
  const resolveTz = deps.resolveTz || ((scope) => resolveTenantTimeZone(scope?.tenantId));
  const getReservations = deps.reservations ? async () => deps.reservations : defaultReservations;

  /** Run the live engine for one (location, window); returns per-class rows. */
  async function engineSearch({ pickupLocationId, pickupAt, returnAt }, scope) {
    if (!scope?.tenantId) throw err('Tenant scope is required', 'NO_TENANT', 400);
    const engine = await getEngine();
    const payload = await engine.searchRental({
      tenantId: scope.tenantId,
      pickupLocationId,
      pickupAt,
      returnAt
    });
    return Array.isArray(payload?.results) ? payload.results : [];
  }

  /** Map one engine row to the quote-facing shape (price + availability). */
  function mapEngineRow(row) {
    const q = row?.quote || {};
    return {
      vehicleTypeId: row?.vehicleType?.id || null,
      vehicleTypeCode: row?.vehicleType?.code || null,
      vehicleTypeName: row?.vehicleType?.name || null,
      available: !!row?.availability?.available,
      availableUnits: Number(row?.availability?.availableUnits || 0),
      days: Number(q.days || 0),
      dailyRate: Number(q.dailyRate || 0),
      subtotal: Number(q.subtotal || 0),
      fees: Number(q.fees || 0),
      taxes: Number(q.taxes || 0),
      total: Number(q.total || 0),
      pricingSource: q.source || 'GLOBAL',
      revenuePricingApplied: !!q.revenuePricingApplied
    };
  }

  /** Lazy expiry: flip ACTIVE quotes whose expiresAt passed. Best-effort. The
   * updateMany is id-scoped (not tenant-scoped) on purpose: the ids always come
   * from a tenant-scoped read a few lines above, so they can't cross tenants. */
  async function lazyExpire(rows) {
    const cutoff = now();
    const stale = rows.filter((r) => r.status === 'ACTIVE' && r.expiresAt && r.expiresAt < cutoff);
    if (!stale.length) return rows;
    try {
      await db.quote.updateMany({
        where: { id: { in: stale.map((r) => r.id) }, status: 'ACTIVE' },
        data: { status: 'EXPIRED' }
      });
    } catch { /* cosmetic — reads must not fail on the flip */ }
    const staleIds = new Set(stale.map((r) => r.id));
    return rows.map((r) => (staleIds.has(r.id) ? { ...r, status: 'EXPIRED' } : r));
  }

  /**
   * Innovation MC-1: a supplied customerId must exist IN THIS TENANT. convert is
   * service-account reachable, so an unchecked id would let a foreign tenant's
   * customer be attached to the reservation (and its PII echoed back). Throws 422.
   */
  async function ensureCustomerInTenant(customerId, scope) {
    const found = await db.customer.findFirst({
      where: { id: String(customerId), ...tenantWhere(scope) },
      select: { id: true }
    });
    if (!found) throw err('Customer not found in this tenant', 'CUSTOMER_NOT_FOUND', 422);
    return found.id;
  }

  /**
   * UI enrichment: stamp vehicleTypeName/Code onto quote rows (the table is
   * relation-free by design, so names come from one lookup per call).
   */
  async function withVehicleTypeNames(rows) {
    const list = Array.isArray(rows) ? rows : [rows];
    const ids = [...new Set(list.map((r) => r?.vehicleTypeId).filter(Boolean))];
    if (!ids.length) return rows;
    let types = [];
    try {
      types = await db.vehicleType.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, name: true }
      });
    } catch { return rows; /* enrichment is cosmetic — never fail a read */ }
    const byId = Object.fromEntries(types.map((t) => [t.id, t]));
    const stamp = (r) => (r && byId[r.vehicleTypeId]
      ? { ...r, vehicleTypeCode: byId[r.vehicleTypeId].code, vehicleTypeName: byId[r.vehicleTypeId].name }
      : r);
    return Array.isArray(rows) ? list.map(stamp) : stamp(rows);
  }

  const service = {
    /**
     * Compute WITHOUT saving. vehicleTypeId optional — omitted returns every
     * class (price + availability), which also answers checkAvailability.
     */
    async preview({ pickupLocationId, returnLocationId, vehicleTypeId, pickupAt, returnAt } = {}, scope = {}) {
      if (!pickupLocationId) throw err('pickupLocationId is required', 'VALIDATION', 400);
      if (!scope?.tenantId) throw err('Tenant scope is required', 'NO_TENANT', 400);
      if (!pickupAt || !returnAt) throw err('pickupAt and returnAt are required', 'VALIDATION', 400);
      const tz = await resolveTz(scope);
      const pickupDate = parseDateTimeInTz(pickupAt, tz);
      const returnDate = parseDateTimeInTz(returnAt, tz);
      if (!pickupDate || !returnDate || returnDate <= pickupDate) {
        throw err('pickupAt and returnAt must be valid dates with returnAt after pickupAt', 'VALIDATION', 400);
      }
      const rows = await engineSearch({ pickupLocationId, pickupAt: pickupDate, returnAt: returnDate }, scope);
      const mapped = rows.map(mapEngineRow).filter((r) => r.vehicleTypeId);
      const results = vehicleTypeId ? mapped.filter((r) => r.vehicleTypeId === vehicleTypeId) : mapped;
      return {
        pickupLocationId,
        returnLocationId: returnLocationId || pickupLocationId,
        pickupAt: pickupDate,
        returnAt: returnDate,
        currency: 'USD',
        ttlHours: ttlHours(),
        results
      };
    },

    /** Compute AND save → the speakable Quote (Q-1042). */
    async create(data = {}, scope = {}, actor = {}) {
      const { pickupLocationId, returnLocationId, vehicleTypeId, pickupAt, returnAt } = data;
      if (!vehicleTypeId) throw err('vehicleTypeId is required', 'VALIDATION', 400);
      const previewOut = await service.preview(
        { pickupLocationId, returnLocationId, vehicleTypeId, pickupAt, returnAt },
        scope
      );
      const row = previewOut.results[0];
      if (!row) throw err('No rate available for that vehicle class', 'NO_RATE', 422);
      if (!row.available) throw err('That vehicle class is sold out for those dates', 'QUOTE_UNAVAILABLE', 422);
      if (data.customerId) await ensureCustomerInTenant(data.customerId, scope);

      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + ttlHours() * 3600 * 1000);
      const base = {
        tenantId: scope.tenantId,
        customerId: data.customerId || null,
        contactName: (data.contactName || '').trim() || null,
        contactPhone: (data.contactPhone || '').trim() || null,
        contactEmail: (data.contactEmail || '').trim() || null,
        pickupLocationId,
        returnLocationId: returnLocationId || pickupLocationId,
        vehicleTypeId,
        pickupAt: previewOut.pickupAt,
        returnAt: previewOut.returnAt,
        days: row.days,
        dailyRate: row.dailyRate,
        subtotal: row.subtotal,
        fees: row.fees,
        taxes: row.taxes,
        total: row.total,
        currency: 'USD',
        pricingSource: row.pricingSource,
        revenuePricingApplied: row.revenuePricingApplied,
        engineSnapshotJson: JSON.stringify(row),
        expiresAt,
        source: data.source === 'VOZIA' || data.source === 'PORTAL' ? data.source : 'STAFF',
        createdByUserId: actor?.userId || null,
        author: (data.author || '').trim() || null,
        ticketId: (data.ticketId || '').trim() || null
      };

      // Per-tenant sequential number with retry on race (unique (tenantId, quoteNumber)).
      const count = await db.quote.count({ where: { tenantId: scope.tenantId } });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const created = await db.quote.create({
            data: { ...base, quoteNumber: quoteNumberCandidate(count, attempt) }
          });
          return withVehicleTypeNames(created);
        } catch (e) {
          if (e?.code !== 'P2002' || attempt === 4) throw e;
        }
      }
      throw err('Could not allocate a quote number', 'QUOTE_NUMBER_RACE', 500);
    },

    /** By id or by "Q-1042" (tenant-scoped either way). Lazy-expires on read. */
    async getById(idOrNumber, scope = {}) {
      const where = isQuoteNumber(idOrNumber)
        ? { quoteNumber: normalizeQuoteNumber(idOrNumber), ...tenantWhere(scope) }
        : { id: String(idOrNumber || ''), ...tenantWhere(scope) };
      const row = await db.quote.findFirst({ where });
      if (!row) return null;
      const [fresh] = await lazyExpire([row]);
      return withVehicleTypeNames(fresh);
    },

    async list({ customerId, status, limit } = {}, scope = {}) {
      // QA m1: a bogus status would hit the Prisma enum and 500 — validate to 400.
      const VALID_STATUS = ['ACTIVE', 'EXPIRED', 'CONVERTED', 'CANCELLED'];
      if (status && !VALID_STATUS.includes(String(status).toUpperCase())) {
        throw err(`status must be one of ${VALID_STATUS.join(', ')}`, 'VALIDATION', 400);
      }
      const normalizedStatus = status ? String(status).toUpperCase() : undefined;
      const take = Math.min(200, Math.max(1, Number.parseInt(String(limit ?? 50), 10) || 50));
      const rows = await db.quote.findMany({
        where: {
          ...tenantWhere(scope),
          ...(customerId ? { customerId } : {}),
          ...(normalizedStatus ? { status: normalizedStatus } : {})
        },
        orderBy: { createdAt: 'desc' },
        take
      });
      return withVehicleTypeNames(await lazyExpire(rows));
    },

    /** Cancel an ACTIVE quote (non-money; humans only — route/allowlist enforce). */
    async cancel(idOrNumber, scope = {}) {
      const row = await service.getById(idOrNumber, scope);
      if (!row) throw err('Quote not found', 'NOT_FOUND', 404);
      if (row.status !== 'ACTIVE') throw err(`Quote is ${row.status}`, 'QUOTE_NOT_ACTIVE', 422);
      return db.quote.update({ where: { id: row.id }, data: { status: 'CANCELLED' } });
    },

    /**
     * Re-quote (Hector, 2026-07-17): duplicate ANY quote with FRESH engine prices
     * → a new Q-# (ACTIVE, new 72h window). Not price editing — the price always
     * comes from the engine; sold-out still rejects. Carries contact/customer over.
     * Humans-only surface (not on the service-account allowlist — VozIA composes
     * the same thing through create).
     */
    async requote(idOrNumber, scope = {}, actor = {}) {
      const old = await service.getById(idOrNumber, scope);
      if (!old) throw err('Quote not found', 'NOT_FOUND', 404);
      return service.create(
        {
          pickupLocationId: old.pickupLocationId,
          returnLocationId: old.returnLocationId,
          vehicleTypeId: old.vehicleTypeId,
          pickupAt: old.pickupAt,
          returnAt: old.returnAt,
          customerId: old.customerId,
          contactName: old.contactName,
          contactPhone: old.contactPhone,
          contactEmail: old.contactEmail,
          source: 'STAFF'
        },
        scope,
        actor
      );
    },

    /**
     * Convert an ACTIVE, unexpired quote into a reservation AT THE QUOTED PRICE.
     * Idempotent: converting an already-CONVERTED quote returns the existing
     * reservation reference instead of creating a duplicate (safe for VozIA
     * retries). Re-checks availability; honors the snapshot price (that's the
     * promise of a quote).
     */
    async convert(idOrNumber, input = {}, scope = {}, actor = {}) {
      const quote = await service.getById(idOrNumber, scope);
      if (!quote) throw err('Quote not found', 'NOT_FOUND', 404);
      if (quote.status === 'CONVERTED' && quote.convertedReservationId) {
        return { alreadyConverted: true, quote, reservationId: quote.convertedReservationId };
      }
      if (quote.status === 'EXPIRED') throw err('Quote expired — create a fresh quote', 'QUOTE_EXPIRED', 422);
      if (quote.status !== 'ACTIVE') throw err(`Quote is ${quote.status}`, 'QUOTE_NOT_ACTIVE', 422);

      // Availability re-check (a quote never held a car).
      const fresh = await service.preview(
        {
          pickupLocationId: quote.pickupLocationId,
          vehicleTypeId: quote.vehicleTypeId,
          pickupAt: quote.pickupAt,
          returnAt: quote.returnAt
        },
        scope
      );
      const freshRow = fresh.results[0];
      if (!freshRow || !freshRow.available) {
        throw err('That vehicle class is no longer available for those dates', 'QUOTE_UNAVAILABLE', 422);
      }

      // Resolve the customer: explicit id → quote's id → create from contact.
      // Any EXPLICIT id is verified against THIS tenant (Innovation MC-1).
      let customerId = input.customerId || quote.customerId || null;
      if (customerId) {
        customerId = await ensureCustomerInTenant(customerId, scope);
      } else {
        const name = String(input.contactName || quote.contactName || '').trim();
        const phone = String(input.contactPhone || quote.contactPhone || '').trim();
        const email = String(input.contactEmail || quote.contactEmail || '').trim() || null;
        if (!name || !phone) {
          throw err('customerId, or contact name + phone, is required to convert', 'CUSTOMER_REQUIRED', 422);
        }
        const [firstName, ...rest] = name.split(/\s+/);
        const lastName = rest.join(' ') || firstName;
        // Dedupe by email, exact phone, then digits-only phone — voice input makes
        // "(787) 555-1234" vs "7875551234" the norm. (Real fix = phoneNormalized
        // column, parked in its own workstream — don't drag it in.)
        const phoneDigits = phone.replace(/\D/g, '');
        let existing = await db.customer.findFirst({
          where: { ...tenantWhere(scope), ...(email ? { email } : { phone }) },
          select: { id: true }
        });
        if (!existing && !email && phoneDigits && phoneDigits !== phone) {
          existing = await db.customer.findFirst({
            where: { ...tenantWhere(scope), phone: phoneDigits },
            select: { id: true }
          });
        }
        if (existing) {
          customerId = existing.id;
        } else {
          const created = await db.customer.create({
            data: { tenantId: scope.tenantId, firstName, lastName, phone, email }
          });
          customerId = created.id;
        }
      }

      const reservations = await getReservations();
      const nowMs = now().getTime();
      const rand = (deps.randHex || (() => crypto.randomBytes(2).toString('hex')))();
      const author = (input.author || quote.author || actor?.author || '').trim();
      // sourceRef ties the reservation to this quote (Innovation MC-4): if a prior
      // convert crashed AFTER creating the reservation but BEFORE flipping the
      // quote, reservationsService.create's own sourceRef dedupe rejects the
      // duplicate and we self-heal below instead of double-booking.
      const sourceRef = `QUOTE:${quote.id}`;
      let reservation;
      try {
        reservation = await reservations.create(
          {
            reservationNumber: conversionReservationNumber(nowMs, rand),
            sourceRef,
            customerId,
            vehicleTypeId: quote.vehicleTypeId,
            pickupLocationId: quote.pickupLocationId,
            returnLocationId: quote.returnLocationId || quote.pickupLocationId,
            pickupAt: quote.pickupAt,
            returnAt: quote.returnAt,
            // Honor the SNAPSHOT price — the whole point of a quote.
            dailyRate: quote.dailyRate,
            estimatedTotal: quote.total,
            bookingChannel: quote.source === 'VOZIA' ? 'VOZIA' : 'STAFF',
            status: 'NEW',
            notes: `[QUOTE ${quote.quoteNumber} converted${author ? ` by ${author}` : ''} @${now().toISOString()}]`
          },
          scope
        );
      } catch (e) {
        const msg = String(e?.message || '');
        if (/already exists/i.test(msg)) {
          // Crash-window recovery: the reservation from the earlier attempt exists.
          const orphan = await db.reservation.findFirst({
            where: { sourceRef, ...tenantWhere(scope) },
            select: { id: true }
          });
          if (orphan) {
            const healed = await db.quote.update({
              where: { id: quote.id },
              data: { status: 'CONVERTED', convertedReservationId: orphan.id }
            });
            return { alreadyConverted: true, quote: healed, reservationId: orphan.id };
          }
        }
        // Map known business failures to speakable 422s for VozIA (plain 500s otherwise).
        if (/DO NOT RENT/i.test(msg)) throw err(msg, 'DO_NOT_RENT', 422);
        // QA m2: auto-assign race — availability re-check passed but the car got taken.
        if (/vehicle conflict/i.test(msg)) throw err(msg, 'QUOTE_UNAVAILABLE', 422);
        if (/closed|window|hours/i.test(msg)) throw err(msg, 'LOCATION_CLOSED', 422);
        throw e;
      }

      const updated = await db.quote.update({
        where: { id: quote.id },
        data: { status: 'CONVERTED', convertedReservationId: reservation.id }
      });
      return { alreadyConverted: false, quote: updated, reservationId: reservation.id, reservation };
    }
  };

  return service;
}

export const quotesService = createQuotesService();
