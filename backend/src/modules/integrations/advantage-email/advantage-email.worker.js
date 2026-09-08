/**
 * advantage-email.worker.js — one BullMQ job per tenant that drains the
 * Advantage mailbox, parses each confirmation, stages it into
 * ExternalReservation and (when it can) auto-promotes it.
 *
 * THIS IS THE FIRST INBOUND-MAIL PIPELINE IN RFM. Everything downstream of the
 * parse is machinery that already exists and is NOT reimplemented here:
 *   - createPromoter(advantageEmailSourceSpec)  → promote / link (estimatedTotal only)
 *   - evaluatePromotion + findDuplicateReservation (booking-source services)
 *   - maybeCreateCustomerFromSource             → opt-in auto-create (flag-gated)
 *   - resolveImportFranchiseId                  → inside promote.js, no work here
 *
 * ROUTING IS CONFIG, NEVER CODE. The masthead gives the TSD account
 * ("Advantage Orlando (61302)") and `Pickup/Return` gives the branch ("MCO"),
 * which is exactly the (tsdNumber, branch) pair AdvantageLocationConfig is
 * already keyed on for the portal scraper. A message whose pair has no ENABLED
 * config for this tenant is QUARANTINED, not guessed at — that is also the only
 * thing standing between a stranger who emails the mailbox and a reservation.
 *
 * MONEY, STATED ONCE AND HELD EVERYWHERE. The email carries far more than any
 * scraper does: an assigned unit (RASU33), mileage and fuel out, counter extras
 * with prices (PSP prepaid SunPass 16.99/day, DW deposit waiver 39.99/day),
 * card authorizations, and a 381.80 CARD DEPOSIT. ALL of it is parsed and kept
 * in rawJson so it is visible and queryable. NONE of it moves money, becomes a
 * charge or a fee, touches a card, or assigns a vehicle. The ONLY field written
 * to the Reservation is estimatedTotal — same posture as TL/Economy/NU/Flexways
 * /Advantage-portal.
 *
 * AND THE ESTIMATE IS LABELLED. Unlike the portal's `Total Bill` (rate + tax),
 * the email gives a daily rate and a day count, so the estimate is 14.72 x 5 =
 * 73.60: base rate, before tax, before the extras that took the sample's actual
 * card deposit to 381.80. The basis travels into rawJson AND into the
 * reservation's notes line, because an unlabelled 73.60 will be read as the
 * price of the rental by the next person who opens it.
 *
 * CANCELLATION IS RECOGNISED, NEVER INFERRED. See the banner note in
 * advantage-email.constants.js. A cancellation email REJECTS the staged row; a
 * cancellation for a row we ALREADY promoted does NOT touch the live
 * Reservation (cancelling a live rental is an ops/money decision, not an
 * importer's) — it increments `cancelledAfterPromote` and says so in the run
 * notes, exactly as the portal worker does.
 *
 * See doc/advantage-email-ingestion-2026-09-08.md
 */

import { createHash } from 'node:crypto';

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { captureBackendException } from '../../../lib/sentry.js';
import { registerWorker, enqueueJob } from '../../../lib/queue/index.js';
import { SCRAPER_PRIORITY } from '../../../lib/queue/priorities.js';

import { createPromoter } from '../booking-source/promote.js';
import {
  maybeCreateCustomerFromSource,
  autoCreateEnabledFromEnv,
} from '../booking-source/customer-autocreate.js';
import { evaluatePromotion, REVIEW_REASONS } from '../booking-source/promotion-matcher.service.js';

import { extractMessage } from './mime-text.js';
import { parseAdvantageEmail, AdvantageEmailLayoutError } from './advantage-email.parser.js';
import { withMailbox, AdvantageEmailAuthExpiredError } from './advantage-email.service.js';
import {
  SOURCE_SYSTEM,
  RUN_SOURCE_SYSTEM,
  CREDENTIAL_SOURCE_SYSTEM,
  BOOKING_CHANNEL,
  RESERVATION_PREFIX,
  QUEUE_NAME,
  LOG_PREFIX,
  TIME_ZONE,
  DOC_TYPES,
  PROMOTABLE_DOC_TYPES,
  REJECT_REASONS,
  QUARANTINE_REASONS,
  INBOUND_STATUS,
  maxMessagesPerRun,
  allowedSenders,
  senderAllowed,
  extractAddress,
} from './advantage-email.constants.js';

export { QUEUE_NAME };

// ---------------------------------------------------------------------------
// The sourceSpec for the shared promoter.
// ---------------------------------------------------------------------------

/**
 * Advantage is 100% Pay on Arrival (confirmed with Advantage 2026-07-14 for the
 * portal account, and consistent with this document: TOTAL CHARGES 0.00 and the
 * only money on it is a counter-taken CARD DEPOSIT). Every promoted row
 * therefore carries the structured isPrepaid=false plus the shared
 * "(pay-at-destination)" notes suffix — the counter collects at handoff. If an
 * account ever sells prepaid, that becomes per-rate-code CONFIG, not code;
 * `rateCode` is already in rawJson.
 */
export const advantageEmailSourceSpec = Object.freeze({
  reservationPrefix: RESERVATION_PREFIX,
  bookingChannel: BOOKING_CHANNEL,
  sourceLabel: 'Advantage (email)',
  logPrefix: LOG_PREFIX,
  defaultTimeZone: TIME_ZONE,
  buildReservationExtras: (fresh) => ({
    isPrepaid: false,
    notes: `Imported from Advantage (email) — ${fresh.externalRef} (pay-at-destination)`
      + estimateCaveat(fresh?.rawJson?.estimatedTotalBasis),
  }),
});

/**
 * The sentence that stops someone reading estimatedTotal as the price. Exported
 * so the test can assert the exact wording rather than that "a note exists".
 */
export function estimateCaveat(basis) {
  if (basis === 'daily_rate_x_days_pre_tax') {
    return ' — estimate is the daily rate x days, BEFORE tax and any counter extras';
  }
  if (!basis || basis === 'unavailable') {
    return ' — no rate estimate available from the email';
  }
  return ` — no usable rate estimate (${basis})`;
}

const { promoteAutomatically, promoteWithMappings } = createPromoter(advantageEmailSourceSpec);
export { promoteAutomatically, promoteWithMappings };

/**
 * Auto-create is OFF by default, its OWN flag, and deliberately not the portal
 * worker's. ADVANTAGE_AUTO_CREATE_CUSTOMERS is false in production because the
 * T&M report carries no phone and no email on ~50% of rows, so auto-creating
 * from it manufactures contactless customer records. THIS source is the
 * opposite case — the email carries a name, a Home Phone and usually an email
 * address — so turning it on here is a much smaller decision. It still is not
 * ours to turn on.
 */
export function autoCreateCustomersEnabled() {
  return autoCreateEnabledFromEnv('ADVANTAGE_EMAIL_AUTO_CREATE_CUSTOMERS');
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the DB-free suite
// ---------------------------------------------------------------------------

/** sha256 of the normalized body. Same bytes in → same hash. */
export function hashBody(text) {
  return createHash('sha256')
    .update(String(text ?? '').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

/** Is this document a live booking (as opposed to a cancellation)? */
export function isPromotableDoc(doc) {
  return PROMOTABLE_DOC_TYPES.includes(doc?.docType);
}

/** The AdvantageLocationConfig key a parsed document routes on. */
export function routeKey(tsdNumber, branch) {
  return `${String(tsdNumber ?? '').trim()}.${String(branch ?? '').trim().toUpperCase()}`;
}

/**
 * Build the (tsdNumber, branch) → locationId map for a tenant's ENABLED
 * configs. Same table the portal worker sweeps, same key.
 */
export function buildRouteMap(configs) {
  const map = new Map();
  for (const c of configs || []) {
    if (!c?.locationId) continue;
    map.set(routeKey(c.tsdNumber, c.branch), c.locationId);
  }
  return map;
}

/**
 * Parsed document → the ExternalReservation shape.
 *
 * PURE. Exported for tests. Note what does and does not travel:
 *   - customerPhone IS staged here (unlike the portal path, which stages null
 *     because the T&M report has no phone at all). This is the renter's real
 *     `Home Phone`, which is a legitimate matcher key. The agency's switchboard
 *     from the Booking Source block lives in rawJson.bookingSource.phone and is
 *     NEVER treated as contact data — see the parser's header note.
 *   - totalAmount is the LABELLED estimate; `estimatedTotalBasis` rides beside
 *     it so the caveat can be rendered wherever the number is.
 *   - the whole document goes into rawJson: unit, mileage, fuel, extras,
 *     authorizations, the deposit, the activity trail. Visible, queryable, and
 *     inert.
 */
export function mapDocToExternalReservation(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const email = (d.customerEmail || '').trim() || null;
  const phone = (d.customerPhone || '').trim() || null;

  return {
    externalRef: String(d.externalRef || '').trim(),
    // The GDS/OTA the booking came through ("AMADEUS"), i.e. the same meaning
    // the portal path puts in `channel`.
    channel: d.channel || null,
    subBrand: 'ADVANTAGE',
    supplierRef: d.pnr || null,
    status: d.docType || null,
    customerFirstName: d.customerFirstName || null,
    customerLastName: d.customerLastName || null,
    customerEmail: email,
    customerPhone: phone,
    customerCountry: null,
    flightNumber: null,
    vehicleAcriss: d.vehicleAcriss || null,
    vehicleDescription: d.agreement?.yearMakeModel || null,
    pickupAt: d.pickupAt instanceof Date ? d.pickupAt : null,
    pickupLocation: routeKey(d.tsdNumber, d.pickupBranch),
    dropoffAt: d.dropoffAt instanceof Date ? d.dropoffAt : null,
    dropoffLocation: routeKey(d.tsdNumber, d.dropoffBranch || d.pickupBranch),
    // MONEY: the labelled estimate, and nothing else.
    totalAmount: d.estimatedTotal ?? null,
    currency: d.currency || 'USD',
    isPrepaid: false,
    rawJson: {
      transport: 'email',
      docType: d.docType,
      docTypeRaw: d.docTypeRaw,
      brand: d.brand,
      tsdNumber: d.tsdNumber,
      pickupBranch: d.pickupBranch,
      dropoffBranch: d.dropoffBranch,
      rateCode: d.rateCode ?? null,
      pnr: d.pnr ?? null,
      bookedAt: d.bookedAt ? d.bookedAt.toISOString() : null,
      bookedBy: d.bookedBy ?? null,
      renterIp: d.renterIp ?? null,
      transmission: d.transmission ?? null,
      notes: d.notes ?? null,
      rate: d.rate ?? null,
      estimatedTotal: d.estimatedTotal ?? null,
      estimatedTotalBasis: d.estimatedTotalBasis ?? null,
      // Everything below here is READ-ONLY intelligence. Nothing consumes it.
      bookingSource: d.bookingSource ?? null,
      agreement: d.agreement ?? null,
      charges: d.charges ?? null,
      payments: d.payments ?? null,
      activity: d.activity ?? null,
      history: d.history ?? null,
      unknownSections: d.unknownSections ?? [],
    },
  };
}

/** Message-ID, or a stable synthetic one when the server omitted it. */
export function messageKey(headerMessageId, { mailbox, uid }) {
  const id = String(headerMessageId || '').trim();
  if (id) return id;
  return `uid:${mailbox}:${uid}`;
}

// ---------------------------------------------------------------------------
// The job handler
// ---------------------------------------------------------------------------

/**
 * Job payload: { tenantId, triggeredBy }.
 */
export async function advantageEmailSyncHandler(job) {
  const { tenantId, triggeredBy = 'schedule' } = job?.data || {};
  if (!tenantId) throw new Error('advantage-email.sync: job.data.tenantId is required');

  logger.info(`${LOG_PREFIX} starting run`, { tenantId, triggeredBy });

  const configs = await prisma.advantageLocationConfig.findMany({
    where: { tenantId, enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { tsdNumber: true, branch: true, locationId: true },
  });
  const routes = buildRouteMap(configs);

  const startedAt = new Date();
  const runRow = await prisma.externalSyncRun.create({
    data: {
      tenantId,
      sourceSystem: RUN_SOURCE_SYSTEM,
      status: 'OK',
      notes: `Triggered by: ${triggeredBy}`,
    },
  });

  let pickupsFound = 0;       // messages that parsed into a booking
  let newlyInserted = 0;
  let updatedExisting = 0;
  let autoPromoted = 0;
  let needsReview = 0;
  let errorsCount = 0;
  let messagesSeen = 0;
  let duplicates = 0;
  let quarantined = 0;
  let rejectedCancelled = 0;
  let cancelledAfterPromote = 0;
  let skippedCrossTenant = 0;
  let finalStatus = 'OK';
  let mailboxLabel = null;

  const quarantineCounts = new Map();
  const errorSamples = [];
  const quarantineSamples = [];
  const senders = allowedSenders();

  /** Record a message we refused to import, with the reason, and count it. */
  const quarantine = async (ledger, reason, detail) => {
    quarantined += 1;
    quarantineCounts.set(reason, (quarantineCounts.get(reason) || 0) + 1);
    if (quarantineSamples.length < 5) {
      quarantineSamples.push(`${reason}${detail ? `: ${detail}` : ''}`);
    }
    logger.warn(`${LOG_PREFIX} message quarantined`, {
      tenantId, runId: runRow.id, reason, detail, messageId: ledger.messageId,
    });
    await recordInbound(tenantId, {
      ...ledger,
      status: INBOUND_STATUS.QUARANTINED,
      failureReason: reason,
      failureDetail: detail ? String(detail).slice(0, 500) : null,
    });
  };

  try {
    if (configs.length === 0) {
      logger.info(`${LOG_PREFIX} no enabled AdvantageLocationConfig for tenant — every message will quarantine`, { tenantId });
    }

    await withMailbox(tenantId, async (session) => {
      mailboxLabel = `${session.settings.host}/${session.settings.mailbox}`;
      const all = await session.listUnseen();
      const cap = maxMessagesPerRun();
      const uids = all.slice(0, cap);
      if (all.length > cap) {
        errorSamples.push(`${all.length} unread messages, capped at ${cap} this run (the rest drain on the next runs)`);
      }

      for (const uid of uids) {
        messagesSeen += 1;
        let ledger = { messageId: `uid:${session.settings.mailbox}:${uid}`, bodyHash: '', receivedAt: new Date() };

        try {
          const raw = await session.fetch(uid);
          if (!raw || !raw.length) {
            await quarantine(ledger, QUARANTINE_REASONS.NO_TEXT_BODY, 'the server returned an empty message');
            await session.complete(uid);
            continue;
          }

          const msg = extractMessage(raw);
          ledger = {
            messageId: messageKey(msg.messageId, { mailbox: session.settings.mailbox, uid }),
            bodyHash: hashBody(msg.text || raw.toString('binary')),
            receivedAt: msg.date || new Date(),
            fromAddress: extractAddress(msg.from),
            subject: msg.subject ? String(msg.subject).slice(0, 500) : null,
            rawBody: msg.text || null,
          };

          // --- gates, cheapest and most decisive first ---------------------

          if (!senderAllowed(msg.from, senders)) {
            await quarantine(ledger, QUARANTINE_REASONS.SENDER_NOT_ALLOWED, ledger.fromAddress || 'no From header');
            await session.complete(uid);
            continue;
          }

          if (!msg.text) {
            await quarantine(ledger, QUARANTINE_REASONS.NO_TEXT_BODY, 'no text/plain part in the message');
            await session.complete(uid);
            continue;
          }

          // Message-level idempotency. An identical re-delivery is a no-op; the
          // SAME Message-ID with a CHANGED body is a regenerated snapshot and
          // is re-parsed (the supplied sample is exactly such a snapshot).
          const prior = await prisma.advantageInboundEmail.findUnique({
            where: { tenantId_messageId: { tenantId, messageId: ledger.messageId } },
            select: { bodyHash: true, status: true },
          });
          if (prior && prior.bodyHash === ledger.bodyHash && prior.status === INBOUND_STATUS.IMPORTED) {
            duplicates += 1;
            await session.complete(uid);
            continue;
          }

          // --- parse --------------------------------------------------------

          let doc;
          try {
            doc = parseAdvantageEmail(msg.text, { timeZone: TIME_ZONE });
          } catch (err) {
            if (err instanceof AdvantageEmailLayoutError) {
              await quarantine(ledger, QUARANTINE_REASONS.LAYOUT, err.message);
              await session.complete(uid);
              continue;
            }
            throw err;
          }

          ledger = {
            ...ledger,
            docType: doc.docType,
            docTypeRaw: doc.docTypeRaw,
            externalRef: doc.externalRef,
            tsdNumber: doc.tsdNumber,
            branch: doc.pickupBranch,
            parsedJson: JSON.parse(JSON.stringify(doc)),
          };

          if (doc.docType === DOC_TYPES.UNKNOWN) {
            await quarantine(
              ledger,
              QUARANTINE_REASONS.UNKNOWN_DOC_TYPE,
              `banner token ${doc.docTypeRaw ? `"${doc.docTypeRaw}"` : '(missing)'} is not in the known vocabulary`,
            );
            await session.complete(uid);
            continue;
          }

          // --- route --------------------------------------------------------

          const key = routeKey(doc.tsdNumber, doc.pickupBranch);
          const targetLocationId = routes.get(key);
          if (!targetLocationId) {
            await quarantine(
              ledger,
              QUARANTINE_REASONS.LOCATION_NOT_CONFIGURED,
              `no enabled AdvantageLocationConfig for ${key}`,
            );
            await session.complete(uid);
            continue;
          }

          // --- stage --------------------------------------------------------

          const externalRef = doc.externalRef;
          const existing = await prisma.externalReservation.findUnique({
            where: { source_ref_unique: { sourceSystem: SOURCE_SYSTEM, externalRef } },
            select: { tenantId: true, promotionStatus: true },
          });

          if (existing && existing.tenantId !== tenantId) {
            // The unique is (sourceSystem, externalRef) with no tenantId, so
            // another tenant already owns this confirmation number. Same
            // posture as the portal worker: skip loudly, never overwrite.
            skippedCrossTenant += 1;
            await quarantine(
              ledger,
              QUARANTINE_REASONS.CROSS_TENANT,
              `${externalRef} is already staged under a different tenant`,
            );
            await session.complete(uid);
            continue;
          }

          const wasKnown = !!existing;
          const alreadyPromoted = existing?.promotionStatus === 'AUTO_PROMOTED'
            || existing?.promotionStatus === 'PROMOTED';

          const mapped = mapDocToExternalReservation(doc);
          const upserted = await prisma.externalReservation.upsert({
            where: { source_ref_unique: { sourceSystem: SOURCE_SYSTEM, externalRef } },
            create: { ...mapped, tenantId, sourceSystem: SOURCE_SYSTEM },
            update: { ...mapped, lastSyncedAt: new Date(), syncRunCount: { increment: 1 } },
          });

          pickupsFound += 1;
          if (wasKnown) updatedExisting += 1; else newlyInserted += 1;

          // --- cancellation --------------------------------------------------

          if (!isPromotableDoc(doc)) {
            if (alreadyPromoted) {
              // Deliberate inaction, made VISIBLE. Cancelling a live rental is
              // an ops/money decision; the importer records the fact and stops.
              cancelledAfterPromote += 1;
              logger.warn(`${LOG_PREFIX} cancellation email for an already-promoted reservation — live Reservation left untouched`, {
                tenantId, externalRef, runId: runRow.id,
              });
            } else if (upserted.promotionStatus !== 'REJECTED'
              || upserted.rejectedReason !== REJECT_REASONS.SOURCE_CANCELLED) {
              rejectedCancelled += 1;
              await prisma.externalReservation.update({
                where: { id: upserted.id },
                data: {
                  promotionStatus: 'REJECTED',
                  rejectedReason: REJECT_REASONS.SOURCE_CANCELLED,
                  rejectedAt: new Date(),
                  needsReviewReason: null,
                },
              });
            }
            await recordInbound(tenantId, { ...ledger, status: INBOUND_STATUS.IMPORTED });
            await session.complete(uid);
            continue;
          }

          if (alreadyPromoted) {
            // Idempotent: the staged row was refreshed above (a later snapshot
            // carries the unit, the fuel, the deposit), and the live
            // Reservation is left exactly as it is.
            await recordInbound(tenantId, { ...ledger, status: INBOUND_STATUS.IMPORTED });
            await session.complete(uid);
            continue;
          }

          // --- promote --------------------------------------------------------

          const promoOpts = { prisma, overrideLocationId: targetLocationId };
          let decision = await evaluatePromotion(upserted, promoOpts);

          if (decision.decision === 'MANUAL_REVIEW'
            && decision.reason === REVIEW_REASONS.CUSTOMER_NOT_FOUND
            && autoCreateCustomersEnabled()) {
            try {
              const newCust = await maybeCreateCustomerFromSource(prisma, upserted, {
                logPrefix: LOG_PREFIX, sourceName: 'Advantage (email)',
              });
              // Hand the customer id straight to the re-evaluation. Re-running
              // the matcher to FIND what we just created is how the portal path
              // once created a customer per sweep, forever.
              if (newCust) {
                decision = await evaluatePromotion(upserted, { ...promoOpts, overrideCustomerId: newCust.id });
              }
            } catch (createErr) {
              logger.warn(`${LOG_PREFIX} auto-create customer failed; MANUAL_REVIEW`, {
                tenantId, externalRef, message: createErr.message,
              });
            }
          }

          if (decision.decision === 'AUTO') {
            try {
              await promoteAutomatically(upserted, decision, {
                locationId: targetLocationId, timeZone: TIME_ZONE,
              });
              autoPromoted += 1;
            } catch (promoErr) {
              errorsCount += 1;
              errorSamples.push(`${externalRef}: promote failed: ${promoErr.message}`);
              captureBackendException(promoErr, {
                integration: { source: RUN_SOURCE_SYSTEM, tenantId, externalRef },
              });
            }
          } else {
            needsReview += 1;
            await prisma.externalReservation.update({
              where: { id: upserted.id },
              data: { promotionStatus: 'MANUAL_REVIEW', needsReviewReason: decision.reason || null },
            });
          }

          await recordInbound(tenantId, { ...ledger, status: INBOUND_STATUS.IMPORTED });
          await session.complete(uid);
        } catch (err) {
          if (err instanceof AdvantageEmailAuthExpiredError) throw err;
          // The message is NOT flagged \Seen — it comes back on the next run.
          // A duplicate import is free (the upsert is keyed on the confirmation
          // number); a lost reservation is not.
          errorsCount += 1;
          errorSamples.push(`uid ${uid}: ${err.message}`);
          logger.error(`${LOG_PREFIX} message failed; leaving it unread for the next run`, {
            tenantId, runId: runRow.id, uid, message: err.message,
          });
          await recordInbound(tenantId, {
            ...ledger,
            status: INBOUND_STATUS.FAILED,
            failureReason: 'exception',
            failureDetail: String(err.message).slice(0, 500),
          }).catch(() => {});
          captureBackendException(err, { integration: { source: RUN_SOURCE_SYSTEM, tenantId, uid } });
        }
      }
    });

    // A message we refused to read is not an error, but it IS unfinished work
    // that only a human can finish, so it must not present as a green run.
    if (quarantined > 0) finalStatus = 'ATTENTION';
    if (errorsCount > 0 && (newlyInserted + updatedExisting) > 0) finalStatus = 'PARTIAL';
    if (errorsCount > 0 && (newlyInserted + updatedExisting) === 0) finalStatus = 'FAILED';
  } catch (err) {
    if (err instanceof AdvantageEmailAuthExpiredError) {
      finalStatus = 'AUTH_EXPIRED';
      logger.warn(`${LOG_PREFIX} mailbox login failed`, { tenantId, runId: runRow.id, message: err.message });
      await prisma.integrationCredential.updateMany({
        where: { tenantId, sourceSystem: CREDENTIAL_SOURCE_SYSTEM },
        data: { lastTestStatus: 'EXPIRED', lastTestedAt: new Date() },
      }).catch(() => {});
      captureBackendException(err, { integration: { source: RUN_SOURCE_SYSTEM, tenantId }, level: 'warning' });
    } else {
      finalStatus = 'FAILED';
      logger.error(`${LOG_PREFIX} fatal error`, {
        tenantId, runId: runRow.id, message: err.message, stack: err.stack,
      });
      captureBackendException(err, { integration: { source: RUN_SOURCE_SYSTEM, tenantId } });
    }
  }

  // ---- run notes, most urgent first ---------------------------------------
  const noteParts = [];
  if (quarantined > 0) {
    const breakdown = [...quarantineCounts.entries()].map(([r, n]) => `${r} x${n}`);
    noteParts.push(`QUARANTINED ${quarantined} message(s) — ${breakdown.join(', ')}`);
    if (quarantineSamples.length) noteParts.push(quarantineSamples.join(' | '));
  }
  if (cancelledAfterPromote > 0) {
    noteParts.push(
      `${cancelledAfterPromote} cancellation email(s) arrived for reservation(s) already promoted `
      + '— the live Reservation was NOT touched; review and cancel manually if correct',
    );
  }
  if (errorSamples.length) noteParts.push(errorSamples.slice(0, 5).join(' | '));
  noteParts.push(
    `Mailbox ${mailboxLabel || '(not opened)'}: ${messagesSeen} unread handled, `
    + `${pickupsFound} parsed, ${duplicates} duplicate re-delivery(ies), `
    + `${newlyInserted} new / ${updatedExisting} updated, `
    + `senders ${senders.length ? senders.join('+') : 'UNRESTRICTED'}`,
  );
  const notes = noteParts.join(' || ');

  const finishedAt = new Date();
  await prisma.externalSyncRun.update({
    where: { id: runRow.id },
    data: {
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status: finalStatus,
      pickupsFound,
      newlyInserted,
      updatedExisting,
      autoPromoted,
      needsReview,
      errorsCount,
      notes,
    },
  });

  return {
    runId: runRow.id,
    status: finalStatus,
    messagesSeen,
    pickupsFound,
    newlyInserted,
    updatedExisting,
    autoPromoted,
    needsReview,
    errorsCount,
    duplicates,
    quarantined,
    rejectedCancelled,
    cancelledAfterPromote,
    skippedCrossTenant,
  };
}

/**
 * Upsert the transport ledger row. Best-effort by design at the call sites that
 * wrap it — losing the ledger entry must never lose the reservation — but the
 * write itself is deliberate: it is what makes a re-delivery a no-op.
 */
async function recordInbound(tenantId, row) {
  const data = {
    bodyHash: row.bodyHash || '',
    receivedAt: row.receivedAt || new Date(),
    fromAddress: row.fromAddress ?? null,
    subject: row.subject ?? null,
    docType: row.docType ?? null,
    docTypeRaw: row.docTypeRaw ?? null,
    externalRef: row.externalRef ?? null,
    tsdNumber: row.tsdNumber ?? null,
    branch: row.branch ?? null,
    status: row.status,
    failureReason: row.failureReason ?? null,
    failureDetail: row.failureDetail ?? null,
    rawBody: row.rawBody ?? null,
    parsedJson: row.parsedJson ?? null,
  };
  return prisma.advantageInboundEmail.upsert({
    where: { tenantId_messageId: { tenantId, messageId: row.messageId } },
    create: { tenantId, messageId: row.messageId, ...data },
    update: data,
  });
}

/** Convenience: enqueue a one-off poll (the panel's "Check mailbox now"). */
export async function enqueueOneOffSync(tenantId, triggeredBy = 'manual') {
  return enqueueJob(QUEUE_NAME, { tenantId, triggeredBy }, {
    jobId: `advantage-email-sync:${tenantId}:${Date.now()}`,
    priority: 5,
  });
}

/** Register the worker with BullMQ. Idempotent — call once at worker boot. */
export function registerAdvantageEmailSyncWorker() {
  registerWorker(QUEUE_NAME, advantageEmailSyncHandler, {
    concurrency: 1,
    priority: SCRAPER_PRIORITY,
  });
  logger.info(`${LOG_PREFIX} worker registered`, { queue: QUEUE_NAME });
}
