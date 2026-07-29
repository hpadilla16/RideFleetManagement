/**
 * NU FTP transport bridge (2026-07-27). Pins that a parsed .REZ record maps to
 * the SAME list-row shape the RadGrid scraper produces, so the worker seam is
 * a straight swap. Pure — no SFTP, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNuFtpFile } from './nu-ftp-parser.js';
import { ftpRecordToListRow } from './nu-ftp-transport.js';
import { mapRowToExternalReservation } from './nu.worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = fs.readFileSync(path.resolve(__dirname, '../../../../../doc/nu-ftp/FTPsample.txt'), 'utf8');

test('NU verbatim sample: record → list row → ExternalReservation, fields intact', () => {
  const { records, errors } = parseNuFtpFile(SAMPLE);
  assert.equal(errors.length, 0, `no parse errors (${JSON.stringify(errors)})`);
  assert.ok(records.length >= 1);

  const row = ftpRecordToListRow(records[0]);
  // The sample's first record: CNF 6170105480, NAM MARRYSHAW,LESROY, PUL FLL,
  // VTP CFAR, MOP BC, PVA 17.88, 1TP 17.88.
  assert.equal(row.confirmation, '6170105480NU');
  assert.equal(row.lastName, 'MARRYSHAW');
  assert.equal(row.firstName, 'LESROY');
  assert.equal(row.pu, 'FLL');
  assert.equal(row.acriss, 'CFAR');
  assert.ok(row.pickupAt instanceof Date, 'pickupAt is a Date');
  assert.equal(row.total, 17.88);
  // PVA 17.88 > 0 → NU collected → prepaid (definitive MOP/PVA rule).
  assert.equal(row.isPrepaid, true);

  // The existing worker mapper must consume it unchanged.
  const ext = mapRowToExternalReservation(row);
  assert.equal(ext.externalRef, '6170105480NU');
  assert.equal(ext.customerLastName, 'MARRYSHAW');
  assert.equal(ext.vehicleAcriss, 'CFAR');
  assert.equal(ext.pickupLocation, 'FLL');
  assert.equal(ext.totalAmount, 17.88);
  assert.equal(ext.isPrepaid, true);
  assert.equal(ext.status, 'CONFIRMED');
});

test('ftpRecordToListRow tolerates a bare/empty record', () => {
  const row = ftpRecordToListRow({ reservation: {} });
  assert.equal(row.confirmation, null);
  assert.equal(row.pickupAt, null);
  assert.equal(row.isPrepaid, null);
});

// ── remotePath (2026-07-29, first live NU file) ─────────────────────────────
// NU's SFTP server resolves './x.REZ' to the DIRECTORY (mode 40777) instead of
// the file, so `get` returned "Permission denied" and every sweep silently
// downloaded nothing while the file sat on the server. A dot/empty dir means
// "the login directory" → emit the bare name.
test('remotePath: a dot/empty drop dir yields the BARE name (never ./name)', async () => {
  const { remotePath } = await import('./nu-sftp-client.js');
  assert.equal(remotePath('.', 'A.REZ'), 'A.REZ');
  assert.equal(remotePath('./', 'A.REZ'), 'A.REZ');
  assert.equal(remotePath('', 'A.REZ'), 'A.REZ');
  assert.equal(remotePath(undefined, 'A.REZ'), 'A.REZ');
  assert.equal(remotePath('  .  ', 'A.REZ'), 'A.REZ');
});

test('remotePath: a real dir still joins, with or without a trailing slash', async () => {
  const { remotePath } = await import('./nu-sftp-client.js');
  assert.equal(remotePath('cor616usa', 'A.REZ'), 'cor616usa/A.REZ');
  assert.equal(remotePath('cor616usa/', 'A.REZ'), 'cor616usa/A.REZ');
  assert.equal(remotePath('/drop/616', 'A.REZ'), '/drop/616/A.REZ');
});
