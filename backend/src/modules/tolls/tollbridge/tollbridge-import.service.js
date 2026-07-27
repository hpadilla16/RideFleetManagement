/**
 * TollBridge import service (2026-07-27). Polls the partner feed and ingests
 * through the EXISTING toll pipeline — createManualTransactions does the
 * dedup (by externalId), the sede-scoped matcher, the agreement mirror, and
 * the staff alerts we already built. This module only: pulls, maps, and
 * handles VOID refreshes (their point 5). MONEY-ADJACENT (tolls -> charges).
 *
 * Requires a configured TollProviderAccount(provider=TOLLBRIDGE) whose
 * locationId is the sede these tolls belong to (LAX). The account's sede is
 * stamped onto every imported transaction so the matcher never crosses sedes.
 */
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { systemScope } from '../../../lib/tenant-scope.js';
import { tollsService } from '../tolls.service.js';
import { fetchPartnerTolls } from './tollbridge-partner-client.js';
import { TOLLBRIDGE_LOOKBACK_DAYS } from './tollbridge.constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Partner transaction → createManualTransactions row. UTC preserved as-is. */
export function partnerTollToRow(t) {
  return {
    externalId: t.externalId || t.id || null,
    transactionAt: t.transactionAt,               // always UTC ISO-8601 Z
    amount: t.amount,
    location: t.location || null,
    lane: t.lane || null,
    direction: t.direction || null,
    plate: t.plateNormalized || t.plate || null,
    // provider/status are informational on our side — WE match + bill.
  };
}

const VOID_STATUS = 'VOID';

/**
 * One poll cycle for one tenant. Fetches the rolling window, ingests active
 * rows through createManualTransactions (sede-stamped via the TollBridge
 * account), and VOIDs any of our rows whose partner status flipped to VOID.
 */
export async function pollTenant(tenantId, deps = {}) {
  if (!tenantId) throw new Error('tenantId required');
  const scope = systemScope({ tenantId });

  const account = await prisma.tollProviderAccount.findFirst({
    where: { tenantId, provider: 'TOLLBRIDGE' },
    orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
  });
  if (!account) {
    logger.warn('[tollbridge] no TOLLBRIDGE provider account configured — skipping', { tenantId });
    return { tenantId, skipped: 'no_account' };
  }

  const now = deps.now ? deps.now() : new Date();
  const from = new Date(now.getTime() - TOLLBRIDGE_LOOKBACK_DAYS * DAY_MS);
  const { transactions, pages } = await fetchPartnerTolls({ from, to: now }, deps.client || {});

  const active = [];
  const voids = [];
  for (const t of transactions) {
    if (String(t.status || '').toUpperCase() === VOID_STATUS) voids.push(t);
    else active.push(t);
  }

  // Ingest active rows: dedup + match + sede stamp + agreement mirror + alerts.
  let created = 0;
  if (active.length) {
    const out = await tollsService.createManualTransactions(
      active.map(partnerTollToRow),
      scope,
      null,
      { providerAccountId: account.id, locationId: account.locationId || null, sourceType: 'TOLLBRIDGE_POLL' }
    );
    created = Array.isArray(out?.created) ? out.created.length : 0;
  }

  // VOID refresh: never un-void, never touch a fresh non-matching row. Only
  // flip our copy to VOID/WAIVED when the partner marks it voided. Sticky
  // BILLED/DISPUTED stay as-is (a human/billing decision owns those).
  let voided = 0;
  if (voids.length) {
    const extIds = voids.map((t) => t.externalId || t.id).filter(Boolean).map(String);
    if (extIds.length) {
      const res = await prisma.tollTransaction.updateMany({
        where: {
          tenantId,
          externalId: { in: extIds },
          status: { notIn: ['VOID', 'BILLED', 'DISPUTED'] },
        },
        data: { status: 'VOID', billingStatus: 'WAIVED', reviewNotes: 'Voided by TollBridge partner feed' },
      });
      voided = res.count;
    }
  }

  logger.info('[tollbridge] poll complete', { tenantId, pages, fetched: transactions.length, created, voided });
  return { tenantId, pages, fetched: transactions.length, created, voided };
}

/** Sweep every tenant that has a TollBridge account. */
export async function pollAllTenants(deps = {}) {
  const accounts = await prisma.tollProviderAccount.findMany({
    where: { provider: 'TOLLBRIDGE', isActive: true },
    select: { tenantId: true },
    distinct: ['tenantId'],
  });
  const results = [];
  for (const a of accounts) {
    try { results.push(await pollTenant(a.tenantId, deps)); }
    catch (err) { logger.error('[tollbridge] tenant poll failed', { tenantId: a.tenantId, err: String(err?.message || err) }); results.push({ tenantId: a.tenantId, ok: false, error: String(err?.message || err) }); }
  }
  return { processedTenants: results.length, results };
}
