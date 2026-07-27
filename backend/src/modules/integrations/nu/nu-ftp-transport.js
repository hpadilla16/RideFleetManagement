/**
 * NU FTP transport bridge (2026-07-27). Turns the .REZ files NU drops over
 * SFTP into the SAME normalized "list row" shape the RadGrid scraper
 * (`fetchReservationList`) produces, so everything downstream — the worker's
 * mapRowToExternalReservation, the promoter, the idempotent upsert — is
 * reused UNCHANGED. Only the SOURCE of the rows changes.
 *
 * Cutover is behind NU_TRANSPORT: 'http' (default, scraper) | 'sftp'.
 */
import { parseNuFtpFile } from './nu-ftp-parser.js';
import { drainRezFiles } from './nu-sftp-client.js';

/** 'YYYY-MM-DD' + 'HH:MM' → Date (naive local components). TZ parity vs the
 * scraper is the explicit job of the NU_TRANSPORT shadow-diff period. */
function combineDateTime(isoDate, time) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T${(time || '00:00')}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parser `reservation` object → the scraper's list-row shape that
 * mapRowToExternalReservation(row) consumes: { confirmation, pu, firstName,
 * lastName, phone, flight, acriss, pickupAt, dropoffAt, total, isPrepaid }.
 */
export function ftpRecordToListRow(record) {
  const r = record?.reservation || {};
  return {
    confirmation: r.confirmation || null,
    altConfirmation: null,
    pu: r.pickupLocation || null,
    firstName: r.firstName || null,
    lastName: r.lastName || null,
    phone: r.phone || null,
    flight: null,                        // NU FTP carries no flight tag
    acriss: r.vehicleClass || null,      // /VTP is the ACRISS class
    pickupAt: combineDateTime(r.pickupDate, r.pickupTime),
    dropoffAt: combineDateTime(r.dropoffDate, r.dropoffTime),
    total: r.totalPrice ?? null,         // /1TP total price
    isPrepaid: typeof r.isPrepaid === 'boolean' ? r.isPrepaid : null,
    // Full parsed record kept for rawJson + debugging; action drives the
    // transactional feed (CR/MR = create/modify, XL/CU = cancel).
    action: r.action || null,
    _record: record,
  };
}

/**
 * SFTP drop-in for fetchReservationList. Drains every .REZ file, parses it,
 * maps to list rows, and DELETES the file on success. Returns an array of
 * normalized rows with a `.diagnostics` tail (same contract the scraper's
 * filtered array carries), so the worker seam is a straight swap.
 */
export async function fetchReservationListViaSftp(tenantId, { creds, host, port, dir, maxFiles } = {}) {
  if (!creds?.username) throw new Error('NU SFTP credentials are required');
  const rows = [];
  const parseErrors = [];
  const stats = await drainRezFiles(creds, async (name, content) => {
    const { records, errors } = parseNuFtpFile(content);
    for (const rec of records) rows.push(ftpRecordToListRow(rec));
    for (const e of errors) parseErrors.push({ file: name, ...e });
  }, { host, port, dir, maxFiles });

  rows.diagnostics = {
    transport: 'sftp',
    downloaded: stats.downloaded,
    deleted: stats.deleted,
    downloadFailures: stats.failures,
    parseErrors,
  };
  return rows;
}
