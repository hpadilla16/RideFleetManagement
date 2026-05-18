#!/usr/bin/env node
// scripts/backfill-card-metadata.mjs
//
// Pillar 2 — Backfill cardLast4/cardBrand for existing customers that have
// CIM tokens (authnetCustomerProfileId) but no denormalized card metadata.
//
// Run:
//   node scripts/backfill-card-metadata.mjs              # dry run (default)
//   node scripts/backfill-card-metadata.mjs --apply       # actually update rows
//
// Throttles to 1 AuthNet API call per 500ms to avoid rate limiting.
// Safe to re-run — only touches rows where cardLast4 IS NULL.
// Logs progress as it goes.

import { prisma } from '../src/lib/prisma.js';

const APPLY = process.argv.includes('--apply');
const THROTTLE_MS = 500;
const LIMIT = Number(process.env.BACKFILL_LIMIT || 1000);

console.log(`[backfill] mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`[backfill] limit: ${LIMIT}`);

// Find candidates
const candidates = await prisma.customer.findMany({
  where: {
    authnetCustomerProfileId: { not: null },
    cardLast4: null
  },
  select: {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    tenantId: true,
    authnetCustomerProfileId: true
  },
  take: LIMIT
});

console.log(`[backfill] found ${candidates.length} customers needing metadata\n`);

if (candidates.length === 0) {
  console.log('[backfill] nothing to do');
  process.exit(0);
}

// Dynamic import to avoid loading the whole rental-agreements service if
// we're just dry-running. The helpers we need are not exported, so we'll
// inline the AuthNet call here for the backfill case.
const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));

async function authNetGetCustomerProfile(profileId, scope) {
  const { settingsService } = await import('../src/modules/settings/settings.service.js');
  const paymentConfig = await settingsService.getPaymentGatewayConfig(scope);
  const env = String(paymentConfig?.authorizenet?.environment || process.env.AUTHNET_ENV || 'sandbox').toLowerCase();
  const api = env === 'production'
    ? 'https://api2.authorize.net/xml/v1/request.api'
    : 'https://apitest.authorize.net/xml/v1/request.api';
  const loginId = String(paymentConfig?.authorizenet?.loginId || process.env.AUTHNET_API_LOGIN_ID || '').trim();
  const transactionKey = String(paymentConfig?.authorizenet?.transactionKey || process.env.AUTHNET_TRANSACTION_KEY || '').trim();
  if (!loginId || !transactionKey) throw new Error('AuthNet not configured');

  const body = JSON.stringify({
    getCustomerProfileRequest: {
      merchantAuthentication: { name: loginId, transactionKey },
      customerProfileId: String(profileId)
    }
  });

  const res = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  // AuthNet returns text with BOM — clean it
  const text = await res.text();
  const clean = text.replace(/^﻿/, '');
  return JSON.parse(clean);
}

function extractCardMetadata(profileResp) {
  const profile = profileResp?.profile || profileResp?.customerProfile || null;
  const paymentProfiles = Array.isArray(profile?.paymentProfiles)
    ? profile.paymentProfiles
    : profile?.paymentProfiles ? [profile.paymentProfiles] : [];
  const first = paymentProfiles[0] || null;
  const cc = first?.payment?.creditCard || null;
  if (!cc) return null;
  const last4Match = String(cc.cardNumber || '').match(/(\d{4})\s*$/);
  const cardLast4 = last4Match ? last4Match[1] : null;
  const cardBrand = String(cc.cardType || '').trim() || null;
  if (!cardLast4) return null;
  return { cardLast4, cardBrand };
}

let stats = { processed: 0, updated: 0, skipped: 0, errors: 0 };

for (const customer of candidates) {
  stats.processed++;
  const label = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || customer.email || customer.id;
  process.stdout.write(`[${stats.processed}/${candidates.length}] ${label}: `);

  try {
    const scope = customer.tenantId ? { tenantId: customer.tenantId } : {};
    const resp = await authNetGetCustomerProfile(customer.authnetCustomerProfileId, scope);
    const meta = extractCardMetadata(resp);
    if (!meta) {
      console.log('no card metadata in response — skipping');
      stats.skipped++;
      continue;
    }
    if (APPLY) {
      await prisma.customer.update({
        where: { id: customer.id },
        data: {
          cardLast4: meta.cardLast4,
          cardBrand: meta.cardBrand,
          cardUpdatedAt: new Date()
        }
      });
      console.log(`${meta.cardBrand || 'Card'} ****${meta.cardLast4} ✓ updated`);
    } else {
      console.log(`${meta.cardBrand || 'Card'} ****${meta.cardLast4} (would update)`);
    }
    stats.updated++;
  } catch (err) {
    console.log(`ERROR — ${err.message}`);
    stats.errors++;
  }

  // Throttle
  await new Promise((r) => setTimeout(r, THROTTLE_MS));
}

console.log('\n[backfill] done');
console.log(`  processed: ${stats.processed}`);
console.log(`  updated:   ${stats.updated} ${APPLY ? '' : '(dry run — re-run with --apply)'}`);
console.log(`  skipped:   ${stats.skipped}`);
console.log(`  errors:    ${stats.errors}`);

await prisma.$disconnect();
