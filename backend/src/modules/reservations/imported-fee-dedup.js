/**
 * Don't charge a fee the franchise already charged.
 *
 * THE RULE (Hector, 2026-08-09): "MEX si ya tiene el fee no se lo duplicas."
 *
 * A MEX booking arrives with the portal's own fee lines imported as
 * IMPORTED_FEE rows (source MEX_IMPORT). Separately, reservation pricing
 * auto-applies the pickup location's mandatory fees. Nothing connected the
 * two, so a booking that already carried, say, an airport concession fee from
 * the portal got RFM's identical one stacked on top — the customer billed
 * twice for one fee, on the franchise's own paperwork.
 *
 * PER FEE, NOT ALL-OR-NOTHING. It would be simpler to suppress every mandatory
 * fee on any imported booking, and wrong: the portal's sheet is not
 * necessarily complete, and a fee the franchise does NOT charge is still ours
 * to collect. Only the overlap is dropped, so the failure direction is
 * "charged once" rather than "charged never".
 *
 * Matching is by NAME, normalised — those are the only two things the two
 * systems share. There is no common id, and there cannot be: the portal's
 * lines are free text typed by whoever set up the rate.
 */

/** Fold a fee name to its comparable core. */
export function normalizeFeeName(name) {
  return String(name || '')
    .toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // CARGO POR LICENCIA === CARGO POR LICENCIA
    .replace(/[^A-Z0-9 ]+/g, ' ')
    // Words that carry no meaning in a fee name and differ freely between the
    // two systems ("Vehicle License Fee" vs "VEHICLE LICENSE").
    .replace(/\b(FEE|CHARGE|CARGO|TARIFA|POR|DE|DEL|LA|EL|THE|AND|Y)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Charge rows that came from a franchise import rather than from us. */
export function importedFeeNames(charges = [], importSources = ['MEX_IMPORT']) {
  const sources = importSources.map((s) => String(s).toUpperCase());
  return new Set(
    (Array.isArray(charges) ? charges : [])
      .filter((row) => row
        && row.selected !== false
        && sources.includes(String(row.source || '').toUpperCase()))
      .map((row) => normalizeFeeName(row.name))
      .filter(Boolean)
  );
}

/**
 * Drop the mandatory fees the import already covers.
 *
 * @param {Array<{id: string, name: string}>} mandatoryFees the location's fees
 * @param {Array<{name: string, source: string, selected?: boolean}>} charges
 *        the reservation's existing charge rows
 * @returns {{keep: Array, skipped: Array<{id, name, matched}>}}
 */
export function dropFeesAlreadyImported(mandatoryFees = [], charges = [], importSources) {
  const imported = importedFeeNames(charges, importSources);
  if (!imported.size) return { keep: mandatoryFees || [], skipped: [] };

  const keep = [];
  const skipped = [];
  for (const fee of mandatoryFees || []) {
    const key = normalizeFeeName(fee?.name);
    if (key && imported.has(key)) skipped.push({ id: fee.id, name: fee.name, matched: key });
    else keep.push(fee);
  }
  return { keep, skipped };
}

/**
 * Fee ids the HUMAN already put on this reservation.
 *
 * THE BUG (VPH, 2026-08-10, RES-913785): the location's Vehicle License Fee
 * did not show on the new-reservation form, so the agent added it by hand in
 * the charge editor. Then the mandatory-fee sync ran, looked ONLY at rows with
 * source MANDATORY_FEE/UNDERAGE_FEE, did not see the manual FEE row — same
 * sourceRefId, different source — and created a second one. $22.50 charged
 * twice, on the same fee id, in the same minute.
 *
 * A human row and a sync row for the same fee are the same money. The human
 * row wins (it may carry priceOverridden); the sync must neither duplicate it
 * nor touch it.
 *
 * Matched by sourceRefId first (the editor writes the catalog fee id there),
 * normalized name as fallback for rows added before refs existed.
 */
export function manuallyCoveredFeeIds(charges = [], fees = [], syncOwnedSources = ['MANDATORY_FEE', 'UNDERAGE_FEE', 'TOLL_MODULE', 'TOLL_POLICY']) {
  const owned = new Set(syncOwnedSources.map((x) => String(x).toUpperCase()));
  const manualRows = (Array.isArray(charges) ? charges : []).filter((row) => row
    && row.selected !== false
    && !owned.has(String(row.source || '').toUpperCase()));
  const refIds = new Set(manualRows.map((r) => String(r.sourceRefId || '')).filter(Boolean));
  const names = new Set(manualRows
    .map((r) => normalizeFeeName(String(r.name || '').replace(/^Fee:\s*/i, '')))
    .filter(Boolean));
  const covered = new Set();
  for (const fee of fees || []) {
    if (refIds.has(String(fee?.id))) { covered.add(String(fee.id)); continue; }
    const key = normalizeFeeName(fee?.name);
    if (key && names.has(key)) covered.add(String(fee.id));
  }
  return covered;
}
