/**
 * Worker process entry point.
 *
 * Runs in a separate container from the API server. Same image, different
 * command — `node src/worker.js` instead of `node src/main.js`. Workers
 * register job handlers with the queue module and process jobs until
 * SIGTERM.
 *
 * Add new workers by importing them here and calling registerWorker(name, fn).
 * Keep this file thin — registration only, no job logic.
 */

import logger from './lib/logger.js';
import { registerWorker, startWorkers, shutdownQueues, queueEnabled } from './lib/queue/index.js';
import { startAutochargePoll, stopAutochargePoll } from './modules/reservations/autocharge.poll.js';
import { startVehicleDriftSweep, stopVehicleDriftSweep } from './modules/vehicles/vehicle-status-sweep.poll.js';
import { startCommissionResyncSweep, stopCommissionResyncSweep } from './modules/commissions/commission-resync.poll.js';

// =============================================================================
// Bootstrap
// =============================================================================

async function registerAllHandlers() {
  // Pillar 2 — auto-charge after CHECKED_IN_UNPAID.
  // Dynamic import so a broken handler file doesn't crash the whole worker
  // boot. If the handler fails to load, log and continue — other handlers
  // can still run.
  try {
    const mod = await import('./modules/reservations/autocharge.worker.js');
    if (typeof mod.autochargeHandler !== 'function') {
      throw new Error('autocharge.worker.js does not export autochargeHandler');
    }
    registerWorker('reservation.autocharge-after-checkin', mod.autochargeHandler, {
      concurrency: 3
    });
    logger.info('[worker] registered handler: reservation.autocharge-after-checkin');
  } catch (err) {
    logger.warn('[worker] autocharge handler not registered', {
      message: err.message, stack: err.stack
    });
  }

  // TL International franchise sync (round 5)
  // Feature-flagged — registers only if TL_INTEGRATION_ENABLED=true.
  // Workers are cheap so we register unconditionally and let the
  // orchestrator decide whether to enqueue jobs; but keep the guard
  // here so failed imports of TL crypto don't break the whole worker.
  if (String(process.env.TL_INTEGRATION_ENABLED || 'false').toLowerCase() === 'true') {
    try {
      const tlMod = await import('./modules/integrations/tl-international/tl-international.worker.js');
      tlMod.registerTlSyncWorker();
      logger.info('[worker] registered handler: tl-international.sync');
    } catch (err) {
      logger.warn('[worker] tl-international sync worker not registered', {
        message: err.message, stack: err.stack
      });
    }
  }

  // Economy (RezLight) franchise sync (2026-07-05).
  // Feature-flagged — registers only if ECONOMY_INTEGRATION_ENABLED=true.
  // Same posture as TL: keep the flag guard so a failed import can't break
  // the whole worker.
  if (String(process.env.ECONOMY_INTEGRATION_ENABLED || 'false').toLowerCase() === 'true') {
    try {
      const econMod = await import('./modules/integrations/economy/economy.worker.js');
      econMod.registerEconomySyncWorker();
      logger.info('[worker] registered handler: economy.sync');
    } catch (err) {
      logger.warn('[worker] economy sync worker not registered', {
        message: err.message, stack: err.stack
      });
    }
  }

  // NU Car Rentals (affiliates portal) franchise sync (2026-07-09).
  // Feature-flagged — registers only if NU_INTEGRATION_ENABLED=true.
  // Same posture as Economy: keep the flag guard so a failed import can't break
  // the whole worker.
  if (String(process.env.NU_INTEGRATION_ENABLED || 'false').toLowerCase() === 'true') {
    try {
      const nuMod = await import('./modules/integrations/nu/nu.worker.js');
      nuMod.registerNuSyncWorker();
      logger.info('[worker] registered handler: nu.sync');
    } catch (err) {
      logger.warn('[worker] nu sync worker not registered', {
        message: err.message, stack: err.stack
      });
    }
  }

  // Flexways (MobilityPS) franchise sync (2026-07-13).
  // Feature-flagged — registers only if FLEXWAYS_INTEGRATION_ENABLED=true.
  // Same posture as NU: keep the flag guard so a failed import can't break
  // the whole worker.
  if (String(process.env.FLEXWAYS_INTEGRATION_ENABLED || 'false').toLowerCase() === 'true') {
    try {
      const flexMod = await import('./modules/integrations/flexways/flexways.worker.js');
      flexMod.registerFlexwaysSyncWorker();
      logger.info('[worker] registered handler: flexways.sync');
    } catch (err) {
      logger.warn('[worker] flexways sync worker not registered', {
        message: err.message, stack: err.stack
      });
    }
  }

  // Advantage (TSD RezCentral) franchise sync (2026-07-16).
  // Feature-flagged — registers only if ADVANTAGE_INTEGRATION_ENABLED=true.
  // Same posture as NU/Flexways: keep the flag guard so a failed import can't
  // break the whole worker.
  if (String(process.env.ADVANTAGE_INTEGRATION_ENABLED || 'false').toLowerCase() === 'true') {
    try {
      const advMod = await import('./modules/integrations/advantage/advantage.worker.js');
      advMod.registerAdvantageSyncWorker();
      logger.info('[worker] registered handler: advantage.sync');
    } catch (err) {
      logger.warn('[worker] advantage sync worker not registered', {
        message: err.message, stack: err.stack
      });
    }
  }

  // MEX Rent a Car franchise sync (2026-07-26) — sibling of Advantage (same
  // TSD RezCentral portal). Own flag, own queue, same fail-isolated posture.
  if (String(process.env.MEX_INTEGRATION_ENABLED || 'false').toLowerCase() === 'true') {
    try {
      const mexMod = await import('./modules/integrations/mex/mex.worker.js');
      mexMod.registerMexSyncWorker();
      logger.info('[worker] registered handler: mex.sync');
    } catch (err) {
      logger.warn('[worker] mex sync worker not registered', {
        message: err.message, stack: err.stack
      });
    }
  }

  // Future handlers go here. Each in its own try/catch so a broken one
  // doesn't poison the others.
}

async function main() {
  if (!queueEnabled()) {
    logger.error('[worker] REDIS_URL not set — worker process cannot start');
    process.exit(1);
  }

  // Register handlers BEFORE startWorkers — otherwise handlers map is empty
  // when startWorkers reads it and no Worker instances are created.
  await registerAllHandlers();

  const started = await startWorkers();
  logger.info('[worker] started', { count: started.length, names: started });

  // Pillar 2 — DB safety-net poll for autocharge.
  // Catches jobs evicted from Upstash Redis (Fixed plan uses allkeys-lru).
  // Runs every 5min by default, checks DB directly, calls the same handler.
  startAutochargePoll();

  // beta.116 — hourly Vehicle.status drift sweep (KII873 incident): repairs
  // ON_RENT/AVAILABLE drift against reservation truth and WARNs when it does.
  startVehicleDriftSweep();

  // 2026-06-15 — daily commission-snapshot self-heal sweep. Re-runs
  // syncAgreementCommissionSnapshot for every agreement with a CHECKOUT
  // inspection (all tenants), so commission $ never silently freezes at a
  // stale value again. Idempotent + preserves PAID/APPROVED; WARNs on drift.
  startCommissionResyncSweep();

  // Graceful shutdown

  // Loaner program — return-due reminder sweep (Phase 2). Texts borrowers when
  // an ACTIVE loaner agreement is due back soon or overdue (cache-deduped).
  try {
    const loanerRemMod = await import('./modules/dealership-loaner/loaner-reminders.scheduler.js');
    loanerRemMod.startLoanerRemindersScheduler();
    logger.info('[worker] started: loaner-reminders scheduler');
  } catch (err) {
    logger.warn('[worker] loaner-reminders scheduler not started', {
      message: err.message,
    });
  }

  // Customer CHECK-IN inspection — D-1 reminder sweep (Fase D). The day before
  // a rental's return, emails the customer a self-inspection link (DB-deduped).
  try {
    const checkinRemMod = await import('./modules/customer-inspection/checkin-reminders.scheduler.js');
    checkinRemMod.startCheckinReminders();
    logger.info('[worker] started: checkin-inspection reminders scheduler');
  } catch (err) {
    logger.warn('[worker] checkin-inspection reminders scheduler not started', {
      message: err.message,
    });
  }

  // Pre-check-in auto-invite sweep (2026-06-28). Opt-in per tenant: emails the
  // customer the pre-check-in link N hours before pickup (+ optional reminder),
  // column-deduped. Dynamic import so a broken import chain can't kill worker boot.
  try {
    const precheckinInviteMod = await import('./modules/reservations/precheckin-invite.scheduler.js');
    precheckinInviteMod.startPrecheckinInviteScheduler();
    logger.info('[worker] started: precheckin-invite scheduler');
  } catch (err) {
    logger.warn('[worker] precheckin-invite scheduler not started', {
      message: err.message,
    });
  }

  // Disk-space watchdog (2026-08-03). The droplet once hit 0 bytes free and
  // the only symptom users saw was "Failed to fetch" — with EMPTY logs, since
  // the server could not write them. Warn to Sentry while there is still room.
  try {
    const diskMod = await import('./modules/ops/disk-space.scheduler.js');
    diskMod.startDiskCheckScheduler();
    logger.info('[worker] started: disk-space watchdog');
  } catch (err) {
    logger.warn('[worker] disk-space watchdog not started', { message: err.message });
  }

  // Delayed post-check-in email sweep (2026-07-28, LAX #8). Locations with
  // checkinEmailDelayHours defer the receipt/invoice email at checkin-close;
  // this sweep delivers due ones (column-deduped, receipt-vs-invoice decided
  // from the balance at send time).
  try {
    const checkinEmailMod = await import('./modules/rental-agreements/checkin-email.scheduler.js');
    await checkinEmailMod.startCheckinEmailScheduler();
    logger.info('[worker] started: checkin-email scheduler');
  } catch (err) {
    logger.warn('[worker] checkin-email scheduler not started', {
      message: err.message,
    });
  }

  // Long-term (monthly) plans — P2 cycle-billing sweep. Hourly: renewal
  // reminders (48h/24h), cycle close + card-on-file auto-charge, retry +
  // overdue dunning, auto-clear on payment (cache-deduped sends).
  try {
    const ltBillingMod = await import('./modules/long-term/long-term-billing.scheduler.js');
    ltBillingMod.startLongTermBillingScheduler();
    logger.info('[worker] started: long-term-billing scheduler');
  } catch (err) {
    logger.warn('[worker] long-term-billing scheduler not started', {
      message: err.message,
    });
  }

  // Shuttle fast poll (2026-08-15) — demand-driven: fast only while a
  // customer tracker page is open or a shuttle request is pending. The only
  // consumer of the VoltSwitch client above the tenant sync.
  try {
    const shuttlePollMod = await import('./modules/shuttle/shuttle-fast-poll.scheduler.js');
    shuttlePollMod.startShuttleFastPollScheduler();
    logger.info('[worker] started: shuttle fast-poll scheduler');
  } catch (err) {
    logger.warn('[worker] shuttle fast-poll scheduler not started', { message: err.message });
  }

  // Shuttle tracker link invites (2026-08-15) — mints the per-reservation
  // expiring link and delivers it by email + SMS inside the pickup window.
  // Naturally inert until a location's tracker is switched on.
  try {
    const shuttleInviteMod = await import('./modules/shuttle/shuttle-link-invite.scheduler.js');
    shuttleInviteMod.startShuttleLinkInviteScheduler();
    logger.info('[worker] started: shuttle link-invite scheduler');
  } catch (err) {
    logger.warn('[worker] shuttle link-invite scheduler not started', { message: err.message });
  }

  // Voltswitch GPS periodic pull (2026-08-13). Per-tenant interval from
  // Settings > Telematics; only tenants with the connector fully configured
  // (provider VOLTSWITCH + enabled + credentials) are touched. Each tenant
  // sync is timeout-bounded so one slow tenant cannot stall the loop.
  try {
    const voltswitchMod = await import('./modules/vehicles/telematics-voltswitch.scheduler.js');
    voltswitchMod.startVoltswitchScheduler();
    logger.info('[worker] started: voltswitch scheduler');
  } catch (err) {
    logger.warn('[worker] voltswitch scheduler not started', { message: err.message });
  }

  // Phase 0 (2026-06-09) — toll auto-sync sweep MOVED here from the API
  // container (main.js). Each sweep scrapes SunPass/AutoExpreso with headless
  // Chromium; that RAM/CPU spike now lives in this container, under the
  // global page cap (PUPPETEER_MAX_CONCURRENT_PAGES, see compose). Dynamic
  // import so a broken tolls import chain can't kill the worker boot.
  try {
    const tollsMod = await import('./modules/tolls/tolls.scheduler.js');
    tollsMod.startTollAutoSyncScheduler();
    logger.info('[worker] started: toll-auto-sync scheduler');
  } catch (err) {
    logger.warn('[worker] toll-auto-sync scheduler not started', {
      message: err.message,
    });
  }

  // TollBridge partner poller (2026-07-27) — own flag/timer; dormant unless
  // TOLLBRIDGE_IMPORT_ENABLED=true. Fail-isolated like the scrapers.
  try {
    const tbMod = await import('./modules/tolls/tollbridge/tollbridge.scheduler.js');
    tbMod.startTollBridgeImportScheduler();
    logger.info('[worker] started: tollbridge import scheduler (if enabled)');
  } catch (err) {
    logger.warn('[worker] tollbridge import scheduler not started', { message: err.message });
  }

  // OUTBOUND rate push to the Economy franchise portal (2026-07-28) — own
  // flag/timer; dormant unless ECONOMY_RATE_PUSH_MODE is DRY_RUN or LIVE.
  try {
    const rpMod = await import('./modules/integrations/economy/economy-rate-push.scheduler.js');
    rpMod.startEconomyRatePushScheduler();
    logger.info('[worker] started: economy rate-push scheduler (if enabled)');
  } catch (err) {
    logger.warn('[worker] economy rate-push scheduler not started', { message: err.message });
  }

  // Citations OCR mail intake (2026-06-15, Fase B) — processes uploaded/emailed
  // citation-notice scans (CitationDocument PENDING) via vision-LLM → ingestBatch.
  // No-ops unless CITATION_OCR_ENABLED + provider key are set. Dynamic import so a
  // broken import chain can't kill the worker boot.
  try {
    const ocrMod = await import('./modules/citations/citation-ocr.scheduler.js');
    ocrMod.startCitationOcrScheduler();
    logger.info('[worker] started: citation-ocr scheduler');
  } catch (err) {
    logger.warn('[worker] citation-ocr scheduler not started', {
      message: err.message,
    });
  }

  // Economy (RezLight) autonomous sync scheduler (2026-07-05). Gated by the
  // same ECONOMY_INTEGRATION_ENABLED flag (checked inside start...). Dynamic
  // import so a broken import chain can't kill the worker boot.
  try {
    const econSchedMod = await import('./modules/integrations/economy/economy.scheduler.js');
    econSchedMod.startEconomySyncScheduler();
    logger.info('[worker] started: economy sync scheduler (if enabled)');
  } catch (err) {
    logger.warn('[worker] economy sync scheduler not started', {
      message: err.message,
    });
  }

  // NU Car Rentals (affiliates portal) autonomous sync scheduler (2026-07-09).
  // Gated by the same NU_INTEGRATION_ENABLED flag (checked inside start...).
  // Dynamic import so a broken import chain can't kill the worker boot.
  try {
    const nuSchedMod = await import('./modules/integrations/nu/nu.scheduler.js');
    nuSchedMod.startNuSyncScheduler();
    logger.info('[worker] started: nu sync scheduler (if enabled)');
  } catch (err) {
    logger.warn('[worker] nu sync scheduler not started', {
      message: err.message,
    });
  }

  // Flexways (MobilityPS) autonomous sync scheduler (2026-07-13).
  // Gated by the same FLEXWAYS_INTEGRATION_ENABLED flag (checked inside start...).
  // Dynamic import so a broken import chain can't kill the worker boot.
  try {
    const flexSchedMod = await import('./modules/integrations/flexways/flexways.scheduler.js');
    flexSchedMod.startFlexwaysSyncScheduler();
    logger.info('[worker] started: flexways sync scheduler (if enabled)');
  } catch (err) {
    logger.warn('[worker] flexways sync scheduler not started', {
      message: err.message,
    });
  }

  // Advantage (TSD RezCentral) autonomous sync scheduler (2026-07-16).
  // Gated by the same ADVANTAGE_INTEGRATION_ENABLED flag (checked inside start...).
  // Dynamic import so a broken import chain can't kill the worker boot.
  try {
    const advSchedMod = await import('./modules/integrations/advantage/advantage.scheduler.js');
    advSchedMod.startAdvantageSyncScheduler();
    logger.info('[worker] started: advantage sync scheduler (if enabled)');
  } catch (err) {
    logger.warn('[worker] advantage sync scheduler not started', {
      message: err.message,
    });
  }

  // MEX autonomous sync scheduler (2026-07-26) — gated by MEX_INTEGRATION_ENABLED.
  try {
    const mexSchedMod = await import('./modules/integrations/mex/mex.scheduler.js');
    mexSchedMod.startMexSyncScheduler();
    logger.info('[worker] started: mex sync scheduler (if enabled)');
  } catch (err) {
    logger.warn('[worker] mex sync scheduler not started', {
      message: err.message,
    });
  }

  const shutdown = async (signal) => {
    logger.info('[worker] shutting down', { signal });
    stopAutochargePoll();
    stopVehicleDriftSweep();
    stopCommissionResyncSweep();
    try {
      const loanerRemMod = await import('./modules/dealership-loaner/loaner-reminders.scheduler.js');
      loanerRemMod.stopLoanerRemindersScheduler();
    } catch {}
    try {
      const ltBillingMod = await import('./modules/long-term/long-term-billing.scheduler.js');
      ltBillingMod.stopLongTermBillingScheduler();
    } catch {}
    try {
      const diskMod = await import('./modules/ops/disk-space.scheduler.js');
      diskMod.stopDiskCheckScheduler();
    } catch {}
    try {
      const checkinEmailMod = await import('./modules/rental-agreements/checkin-email.scheduler.js');
      checkinEmailMod.stopCheckinEmailScheduler();
    } catch {}
    try {
      const tollsMod = await import('./modules/tolls/tolls.scheduler.js');
      tollsMod.stopTollAutoSyncScheduler();
    } catch {}
    try {
      const tbMod = await import('./modules/tolls/tollbridge/tollbridge.scheduler.js');
      tbMod.stopTollBridgeImportScheduler();
    } catch {}
    try {
      const rpMod = await import('./modules/integrations/economy/economy-rate-push.scheduler.js');
      rpMod.stopEconomyRatePushScheduler();
    } catch {}
    try {
      const ocrMod = await import('./modules/citations/citation-ocr.scheduler.js');
      ocrMod.stopCitationOcrScheduler();
    } catch {}
    try {
      const econSchedMod = await import('./modules/integrations/economy/economy.scheduler.js');
      econSchedMod.stopEconomySyncScheduler();
    } catch {}
    try {
      const nuSchedMod = await import('./modules/integrations/nu/nu.scheduler.js');
      nuSchedMod.stopNuSyncScheduler();
    } catch {}
    try {
      const flexSchedMod = await import('./modules/integrations/flexways/flexways.scheduler.js');
      flexSchedMod.stopFlexwaysSyncScheduler();
    } catch {}
    try {
      const advSchedMod = await import('./modules/integrations/advantage/advantage.scheduler.js');
      advSchedMod.stopAdvantageSyncScheduler();
    } catch {}
    try {
      const mexSchedMod = await import('./modules/integrations/mex/mex.scheduler.js');
      mexSchedMod.stopMexSyncScheduler();
    } catch {}
    // Close the Chromium singleton if a toll sweep ever launched it here.
    // Lazy import keeps puppeteer out of the boot graph.
    try {
      const pb = await import('./lib/puppeteer-browser.js');
      await pb.closeBrowser();
    } catch {}
    await shutdownQueues();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Keep the process alive — BullMQ workers run on their own connection
  // but the Node event loop doesn't have anything else queued. A long
  // setInterval is the conventional way to keep the process alive cheaply.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  logger.error('[worker] fatal startup error', { message: err.message, stack: err.stack });
  process.exit(1);
});
