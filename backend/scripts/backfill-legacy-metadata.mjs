import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1);
    if (!key || process.env[key] != null) continue;
    process.env[key] = raw;
  }
}

loadDotEnv();

const prisma = new PrismaClient();

function readJsonBlock(notes, marker) {
  const escaped = String(marker || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(notes || '').match(new RegExp(`\\[${escaped}\\](\\{[^\\n]*\\})`));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseReservationChargesMeta(notes) {
  return readJsonBlock(notes, 'RES_CHARGES_META');
}

function parseDepositMetaFromNotes(notes) {
  const legacy = readJsonBlock(notes, 'RES_DEPOSIT_META');
  if (legacy) {
    const amount = Number(legacy?.depositAmountDue || 0);
    return {
      requireDeposit: !!legacy?.requireDeposit || amount > 0,
      depositMode: legacy?.depositMode ? String(legacy.depositMode).toUpperCase() : null,
      depositValue: legacy?.depositValue != null ? Number(legacy.depositValue) : null,
      depositBasis: Array.isArray(legacy?.depositPercentBasis) ? legacy.depositPercentBasis : [],
      depositAmountDue: Number.isFinite(amount) ? amount : 0
    };
  }
  const meta = parseReservationChargesMeta(notes);
  const amount = Number(meta?.depositMeta?.depositAmountDue || 0);
  return {
    requireDeposit: !!meta?.depositMeta?.requireDeposit || amount > 0,
    depositMode: meta?.depositMeta?.depositMode ? String(meta.depositMeta.depositMode).toUpperCase() : null,
    depositValue: meta?.depositMeta?.depositValue != null ? Number(meta.depositMeta.depositValue) : null,
    depositBasis: Array.isArray(meta?.depositMeta?.depositPercentBasis) ? meta.depositMeta.depositPercentBasis : [],
    depositAmountDue: Number.isFinite(amount) ? amount : 0
  };
}

function parseSecurityDepositMetaFromNotes(notes) {
  const tagged = readJsonBlock(notes, 'SECURITY_DEPOSIT_META');
  if (tagged) {
    const amount = Number(tagged?.securityDepositAmount || 0);
    return {
      requireSecurityDeposit: !!tagged?.requireSecurityDeposit || amount > 0,
      securityDepositAmount: Number.isFinite(amount) ? amount : 0
    };
  }
  const meta = parseReservationChargesMeta(notes);
  const amount = Number(meta?.securityDepositMeta?.securityDepositAmount || 0);
  return {
    requireSecurityDeposit: !!meta?.securityDepositMeta?.requireSecurityDeposit || amount > 0,
    securityDepositAmount: Number.isFinite(amount) ? amount : 0
  };
}

function parseReservationPaymentsFromNotes(notes) {
  const txt = String(notes || '');
  const lines = txt.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const match = line.match(/^\[PAYMENT\s+([^\]]+)\]\s+([^\s]+)\s+paid\s+([0-9]+(?:\.[0-9]+)?)\s+ref=(.+)$/i);
    if (!match) continue;
    const paidAt = new Date(match[1]);
    const gateway = String(match[2] || 'PORTAL').trim().toUpperCase();
    const amount = Number(match[3] || 0);
    const reference = String(match[4] || '').trim();
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.push({
      paidAt: Number.isFinite(paidAt.getTime()) ? paidAt : new Date(),
      gateway,
      amount,
      reference,
      notes: `Backfilled from legacy reservation note (${gateway})`
    });
  }
  return out;
}

function parseAdditionalDriversFromNotes(notes) {
  const block = readJsonBlock(notes, 'RES_ADDITIONAL_DRIVERS');
  return Array.isArray(block?.drivers) ? block.drivers : [];
}

function parseInspectionReportFromNotes(notes) {
  const block = readJsonBlock(notes, 'INSPECTION_REPORT');
  return {
    checkout: block?.checkout || null,
    checkin: block?.checkin || null
  };
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePaymentMethod(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return 'OTHER';
  if (['CASH', 'CARD', 'ZELLE', 'ATH_MOVIL', 'BANK_TRANSFER', 'OTHER'].includes(value)) return value;
  if (['PORTAL', 'STRIPE', 'SQUARE', 'AUTHORIZENET', 'AUTHORIZE.NET'].includes(value)) return 'CARD';
  return 'OTHER';
}

function paymentKey(row) {
  const paidAt = new Date(row?.paidAt || row?.createdAt || Date.now());
  const stamp = Number.isFinite(paidAt.getTime()) ? paidAt.toISOString().slice(0, 19) : 'invalid';
  return `${stamp}|${Number(toNumber(row?.amount)).toFixed(2)}|${String(row?.reference || '').trim()}`;
}

function summarizeChargeTotals(rows = []) {
  const subtotal = Number((rows
    .filter((row) => String(row?.chargeType || '').toUpperCase() !== 'TAX')
    .reduce((sum, row) => sum + toNumber(row?.total), 0))
    .toFixed(2));
  const taxes = Number((rows
    .filter((row) => String(row?.chargeType || '').toUpperCase() === 'TAX')
    .reduce((sum, row) => sum + toNumber(row?.total), 0))
    .toFixed(2));
  return { subtotal, taxes, total: Number((subtotal + taxes).toFixed(2)) };
}

function normalizeChargeRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row, idx) => ({
    chargeType: ['UNIT', 'DAILY', 'TAX', 'PERCENT', 'DEPOSIT'].includes(String(row?.chargeType || 'UNIT').trim().toUpperCase())
      ? String(row?.chargeType || 'UNIT').trim().toUpperCase()
      : 'UNIT',
    code: row?.code ? String(row.code).trim() : null,
    name: String(row?.name || `Charge ${idx + 1}`).trim(),
    quantity: toNumber(row?.quantity, 1),
    rate: toNumber(row?.rate),
    total: toNumber(row?.total, toNumber(row?.quantity, 1) * toNumber(row?.rate)),
    taxable: !!row?.taxable,
    selected: row?.selected !== false,
    sortOrder: Number.isInteger(row?.sortOrder) ? row.sortOrder : idx,
    source: row?.source ? String(row.source).trim() : 'BACKFILL_NOTE',
    sourceRefId: row?.sourceRefId ? String(row.sourceRefId).trim() : null,
    notes: row?.notes ? String(row.notes) : null
  }));
}

async function recalcAgreementFinancials(tx, agreementId) {
  const agreement = await tx.rentalAgreement.findUnique({
    where: { id: agreementId },
    include: {
      charges: true,
      payments: true
    }
  });
  if (!agreement) return;
  const { subtotal, taxes, total } = summarizeChargeTotals(agreement.charges || []);
  const paidAmount = Number((agreement.payments || [])
    .filter((payment) => String(payment?.status || '').toUpperCase() === 'PAID')
    .reduce((sum, payment) => sum + toNumber(payment.amount), 0)
    .toFixed(2));
  const balance = Number((total - paidAmount).toFixed(2));
  await tx.rentalAgreement.update({
    where: { id: agreementId },
    data: { subtotal, taxes, total, paidAmount, balance }
  });
}

async function backfillReservations(write = false) {
  const reservations = await prisma.reservation.findMany({
    include: {
      pricingSnapshot: true,
      charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      payments: { orderBy: { paidAt: 'asc' } },
      additionalDrivers: { orderBy: { createdAt: 'asc' } },
      rentalAgreement: {
        include: {
          charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
          payments: { orderBy: { paidAt: 'asc' } },
          drivers: { orderBy: { createdAt: 'asc' } }
        }
      }
    }
  });

  const summary = {
    reservationsScanned: reservations.length,
    pricingSnapshotsCreated: 0,
    reservationChargesCreated: 0,
    reservationPaymentsCreated: 0,
    reservationPaymentsLinked: 0,
    reservationAdditionalDriversCreated: 0,
    agreementChargesCreated: 0,
    agreementPaymentsCreated: 0,
    agreementDriversCreated: 0
  };

  for (const reservation of reservations) {
    const notes = String(reservation.notes || '');
    const chargesMeta = parseReservationChargesMeta(notes);
    const depositMeta = parseDepositMetaFromNotes(notes);
    const securityMeta = parseSecurityDepositMetaFromNotes(notes);
    const paymentRows = parseReservationPaymentsFromNotes(notes);
    const driverRows = parseAdditionalDriversFromNotes(notes);
    const normalizedCharges = normalizeChargeRows(chargesMeta?.chargeRows || []);

    const shouldCreateSnapshot =
      !reservation.pricingSnapshot &&
      (
        !!chargesMeta ||
        depositMeta.requireDeposit ||
        securityMeta.requireSecurityDeposit
      );

    const shouldCreateReservationCharges = !reservation.charges.length && normalizedCharges.length > 0;
    const shouldCreateReservationPayments = !reservation.payments.length && paymentRows.length > 0;
    const shouldCreateAdditionalDrivers = !reservation.additionalDrivers.length && driverRows.length > 0;

    if (!shouldCreateSnapshot && !shouldCreateReservationCharges && !shouldCreateReservationPayments && !shouldCreateAdditionalDrivers) {
      continue;
    }

    if (!write) {
      if (shouldCreateSnapshot) summary.pricingSnapshotsCreated += 1;
      if (shouldCreateReservationCharges) {
        summary.reservationChargesCreated += normalizedCharges.length;
        if (reservation.rentalAgreement && !reservation.rentalAgreement.charges.length) {
          summary.agreementChargesCreated += normalizedCharges.length;
        }
      }
      if (shouldCreateReservationPayments) {
        summary.reservationPaymentsCreated += paymentRows.length;
        if (reservation.rentalAgreement) {
          const existingKeys = new Set((reservation.rentalAgreement.payments || []).map(paymentKey));
          for (const payment of paymentRows) {
            if (existingKeys.has(paymentKey(payment))) summary.reservationPaymentsLinked += 1;
            else {
              summary.agreementPaymentsCreated += 1;
              existingKeys.add(paymentKey(payment));
            }
          }
        }
      }
      if (shouldCreateAdditionalDrivers) {
        summary.reservationAdditionalDriversCreated += driverRows.length;
        const nonPrimary = (reservation.rentalAgreement?.drivers || []).filter((row) => !row.isPrimary);
        if (reservation.rentalAgreement && !nonPrimary.length) {
          summary.agreementDriversCreated += driverRows.length;
        }
      }
      continue;
    }

    await prisma.$transaction(async (tx) => {
      if (shouldCreateSnapshot) {
        await tx.reservationPricingSnapshot.create({
          data: {
            reservationId: reservation.id,
            dailyRate: toNullableNumber(chargesMeta?.dailyRate ?? reservation.dailyRate),
            taxRate: toNullableNumber(chargesMeta?.taxRate),
            selectedInsuranceCode: chargesMeta?.selectedInsuranceCode ? String(chargesMeta.selectedInsuranceCode).trim() : null,
            selectedInsuranceName: chargesMeta?.selectedInsuranceName ? String(chargesMeta.selectedInsuranceName).trim() : null,
            depositRequired: depositMeta.requireDeposit,
            depositMode: depositMeta.depositMode,
            depositValue: toNullableNumber(depositMeta.depositValue),
            depositBasisJson: depositMeta.depositBasis?.length ? JSON.stringify(depositMeta.depositBasis) : null,
            depositAmountDue: toNumber(depositMeta.depositAmountDue),
            securityDepositRequired: securityMeta.requireSecurityDeposit,
            securityDepositAmount: toNumber(securityMeta.securityDepositAmount),
            source: 'BACKFILL_NOTE'
          }
        });
        summary.pricingSnapshotsCreated += 1;
      }

      if (shouldCreateReservationCharges) {
        await tx.reservationCharge.createMany({
          data: normalizedCharges.map((row) => ({
            reservationId: reservation.id,
            ...row
          }))
        });
        const totals = summarizeChargeTotals(normalizedCharges);
        await tx.reservation.update({
          where: { id: reservation.id },
          data: {
            dailyRate: toNullableNumber(chargesMeta?.dailyRate ?? reservation.dailyRate),
            estimatedTotal: totals.total
          }
        });
        summary.reservationChargesCreated += normalizedCharges.length;
      }

      const createdReservationPayments = [];
      if (shouldCreateReservationPayments) {
        const agreementPaymentKeyMap = new Map((reservation.rentalAgreement?.payments || []).map((row) => [paymentKey(row), row]));
        for (const payment of paymentRows) {
          const createdReservationPayment = await tx.reservationPayment.create({
            data: {
              reservationId: reservation.id,
              method: normalizePaymentMethod(payment.gateway),
              amount: toNumber(payment.amount),
              reference: payment.reference || null,
              status: 'PAID',
              paidAt: payment.paidAt,
              origin: 'MIGRATED_NOTE',
              gateway: payment.gateway,
              notes: payment.notes
            }
          });
          createdReservationPayments.push(createdReservationPayment);
          summary.reservationPaymentsCreated += 1;

          if (reservation.rentalAgreement?.id) {
            const key = paymentKey(createdReservationPayment);
            const matchedAgreementPayment = agreementPaymentKeyMap.get(key);
            if (matchedAgreementPayment?.id) {
              await tx.reservationPayment.update({
                where: { id: createdReservationPayment.id },
                data: { rentalAgreementPaymentId: matchedAgreementPayment.id }
              });
              summary.reservationPaymentsLinked += 1;
            } else {
              const createdAgreementPayment = await tx.rentalAgreementPayment.create({
                data: {
                  rentalAgreementId: reservation.rentalAgreement.id,
                  method: normalizePaymentMethod(payment.gateway),
                  amount: toNumber(payment.amount),
                  reference: payment.reference || null,
                  status: 'PAID',
                  paidAt: payment.paidAt,
                  notes: payment.notes
                }
              });
              agreementPaymentKeyMap.set(key, createdAgreementPayment);
              await tx.reservationPayment.update({
                where: { id: createdReservationPayment.id },
                data: { rentalAgreementPaymentId: createdAgreementPayment.id }
              });
              summary.agreementPaymentsCreated += 1;
            }
          }
        }
      }

      if (shouldCreateAdditionalDrivers) {
        const normalizedDrivers = driverRows
          .map((driver) => ({
            firstName: String(driver?.firstName || '').trim(),
            lastName: String(driver?.lastName || '').trim(),
            address: driver?.address ? String(driver.address).trim() : null,
            dateOfBirth: driver?.dateOfBirth ? new Date(driver.dateOfBirth) : null,
            licenseNumber: driver?.licenseNumber ? String(driver.licenseNumber).trim() : null,
            licenseImageUploaded: !!driver?.licenseImageUploaded,
            notes: 'Backfilled from legacy reservation note'
          }))
          .filter((driver) => driver.firstName && driver.lastName);

        if (normalizedDrivers.length) {
          await tx.reservationAdditionalDriver.createMany({
            data: normalizedDrivers.map((driver) => ({
              reservationId: reservation.id,
              ...driver
            }))
          });
          summary.reservationAdditionalDriversCreated += normalizedDrivers.length;

          const existingNonPrimary = (reservation.rentalAgreement?.drivers || []).filter((row) => !row.isPrimary);
          if (reservation.rentalAgreement?.id && !existingNonPrimary.length) {
            await tx.agreementDriver.createMany({
              data: normalizedDrivers.map((driver) => ({
                rentalAgreementId: reservation.rentalAgreement.id,
                firstName: driver.firstName,
                lastName: driver.lastName,
                licenseNumber: driver.licenseNumber,
                dateOfBirth: driver.dateOfBirth,
                isPrimary: false
              }))
            });
            summary.agreementDriversCreated += normalizedDrivers.length;
          }
        }
      }

      if (reservation.rentalAgreement?.id) {
        const agreementHasNoCharges = !(reservation.rentalAgreement.charges || []).length;
        const currentReservationCharges = shouldCreateReservationCharges ? normalizedCharges : (reservation.charges || []);
        if (agreementHasNoCharges && currentReservationCharges.length) {
          await tx.rentalAgreementCharge.createMany({
            data: currentReservationCharges.map((row, idx) => ({
              rentalAgreementId: reservation.rentalAgreement.id,
              code: row.code || null,
              name: row.name,
              chargeType: row.chargeType,
              quantity: row.quantity,
              rate: row.rate,
              total: row.total,
              taxable: !!row.taxable,
              selected: row.selected !== false,
              sortOrder: Number.isInteger(row.sortOrder) ? row.sortOrder : idx
            }))
          });
          summary.agreementChargesCreated += currentReservationCharges.length;
        }

        if (agreementHasNoCharges || shouldCreateReservationPayments) {
          await recalcAgreementFinancials(tx, reservation.rentalAgreement.id);
        }
      }
    });
  }

  return summary;
}

async function backfillAgreementInspections(write = false) {
  const agreements = await prisma.rentalAgreement.findMany({
    include: {
      inspections: true
    }
  });

  const summary = {
    agreementsScanned: agreements.length,
    agreementInspectionsCreated: 0
  };

  for (const agreement of agreements) {
    const report = parseInspectionReportFromNotes(agreement.notes);
    const existingPhases = new Set((agreement.inspections || []).map((row) => String(row.phase || '').toUpperCase()));
    const pending = [];

    if (report.checkout && !existingPhases.has('CHECKOUT')) {
      pending.push({ phase: 'CHECKOUT', data: report.checkout });
    }
    if (report.checkin && !existingPhases.has('CHECKIN')) {
      pending.push({ phase: 'CHECKIN', data: report.checkin });
    }
    if (!pending.length) continue;

    if (!write) {
      summary.agreementInspectionsCreated += pending.length;
      continue;
    }

    for (const item of pending) {
      const photos = item.data?.photos && typeof item.data.photos === 'object' ? item.data.photos : {};
      const capturedAt = item.data?.at ? new Date(item.data.at) : new Date();
      await prisma.rentalAgreementInspection.create({
        data: {
          rentalAgreementId: agreement.id,
          phase: item.phase,
          capturedAt: Number.isFinite(capturedAt.getTime()) ? capturedAt : new Date(),
          actorUserId: item.data?.actorUserId ? String(item.data.actorUserId) : null,
          actorIp: item.data?.ip ? String(item.data.ip) : null,
          exterior: item.data?.exterior ? String(item.data.exterior) : null,
          interior: item.data?.interior ? String(item.data.interior) : null,
          tires: item.data?.tires ? String(item.data.tires) : null,
          lights: item.data?.lights ? String(item.data.lights) : null,
          windshield: item.data?.windshield ? String(item.data.windshield) : null,
          fuelLevel: item.data?.fuelLevel ? String(item.data.fuelLevel) : null,
          odometer: item.data?.odometer == null || item.data?.odometer === '' ? null : Number(item.data.odometer),
          damages: item.data?.damages ? String(item.data.damages) : null,
          notes: item.data?.notes ? String(item.data.notes) : 'Backfilled from legacy agreement note',
          photosJson: JSON.stringify(photos)
        }
      });
      summary.agreementInspectionsCreated += 1;
    }
  }

  return summary;
}

async function main() {
  const write = process.argv.includes('--write');

  const reservationSummary = await backfillReservations(write);
  const inspectionSummary = await backfillAgreementInspections(write);

  console.log(JSON.stringify({
    ok: true,
    mode: write ? 'write' : 'dry-run',
    reservationSummary,
    inspectionSummary
  }, null, 2));
}

main()
  .catch(async (error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
