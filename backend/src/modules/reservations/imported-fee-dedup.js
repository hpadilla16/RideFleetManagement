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
