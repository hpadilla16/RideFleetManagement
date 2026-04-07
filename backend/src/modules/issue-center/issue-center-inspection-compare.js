function parsePhotos(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw) || {};
    if (typeof raw === 'object') return raw || {};
  } catch {}
  return {};
}

function normalizeInspection(row) {
  if (!row) return null;
  return {
    phase: row.phase || null,
    at: row.capturedAt || row.at || null,
    exterior: row.exterior || null,
    interior: row.interior || null,
    tires: row.tires || null,
    lights: row.lights || null,
    windshield: row.windshield || null,
    fuelLevel: row.fuelLevel ?? null,
    odometer: row.odometer ?? null,
    damages: row.damages || null,
    notes: row.notes || null,
    photos: parsePhotos(row.photosJson || row.photos || {})
  };
}

function photoKeys(inspection) {
  return Object.keys(inspection?.photos || {}).filter((key) => !!inspection.photos[key]);
}

function comparisonItem(key, label, beforeValue, afterValue) {
  const beforeText = beforeValue == null || beforeValue === '' ? '-' : String(beforeValue);
  const afterText = afterValue == null || afterValue === '' ? '-' : String(afterValue);
  return {
    key,
    label,
    before: beforeText,
    after: afterText,
    changed: beforeText !== afterText
  };
}

export function buildIncidentInspectionCompare(incident) {
  const reservation = incident?.reservation || incident?.trip?.reservation || null;
  const agreement = reservation?.rentalAgreement || null;
  const inspections = Array.isArray(agreement?.inspections) ? agreement.inspections : [];
  const checkout = normalizeInspection(inspections.find((row) => String(row?.phase || '').toUpperCase() === 'CHECKOUT'));
  const checkin = normalizeInspection(inspections.find((row) => String(row?.phase || '').toUpperCase() === 'CHECKIN'));

  if (!checkout && !checkin) {
    return {
      status: 'NO_DATA',
      summary: 'No checkout or check-in inspection is attached to this claim yet.',
      changes: [],
      previews: [],
      photoCoverage: { checkout: 0, checkin: 0, common: 0 },
      links: reservation?.id ? {
        inspectionReportHref: `/reservations/${reservation.id}/inspection-report`
      } : {}
    };
  }

  const checkoutPhotos = photoKeys(checkout);
  const checkinPhotos = photoKeys(checkin);
  const commonPhotoKeys = checkoutPhotos.filter((key) => checkinPhotos.includes(key));
  const changes = [
    comparisonItem('exterior', 'Exterior', checkout?.exterior, checkin?.exterior),
    comparisonItem('interior', 'Interior', checkout?.interior, checkin?.interior),
    comparisonItem('tires', 'Tires', checkout?.tires, checkin?.tires),
    comparisonItem('lights', 'Lights', checkout?.lights, checkin?.lights),
    comparisonItem('windshield', 'Windshield', checkout?.windshield, checkin?.windshield),
    comparisonItem('fuelLevel', 'Fuel Level', checkout?.fuelLevel, checkin?.fuelLevel),
    comparisonItem('odometer', 'Odometer', checkout?.odometer, checkin?.odometer),
    comparisonItem('damages', 'Damages', checkout?.damages, checkin?.damages),
    comparisonItem('notes', 'Notes', checkout?.notes, checkin?.notes)
  ];
  const changedCount = changes.filter((entry) => entry.changed).length;
  const previews = commonPhotoKeys.slice(0, 2).map((key) => ({
    key,
    label: key,
    checkoutSrc: checkout?.photos?.[key] || '',
    checkinSrc: checkin?.photos?.[key] || ''
  }));
  const status = checkout && checkin ? 'COMPARE_READY' : checkout ? 'CHECKOUT_ONLY' : 'CHECKIN_ONLY';
  const summary = status === 'COMPARE_READY'
    ? changedCount > 0
      ? `${changedCount} inspection field(s) changed between checkout and check-in.`
      : 'Checkout and check-in inspections are both present with no field changes detected.'
    : status === 'CHECKOUT_ONLY'
      ? 'Checkout inspection is present, but check-in inspection is still missing.'
      : 'Check-in inspection is present, but checkout inspection is missing.';

  return {
    status,
    summary,
    changedCount,
    changes,
    previews,
    photoCoverage: {
      checkout: checkoutPhotos.length,
      checkin: checkinPhotos.length,
      common: commonPhotoKeys.length
    },
    checkoutAt: checkout?.at || null,
    checkinAt: checkin?.at || null,
    links: reservation?.id ? {
      inspectionReportHref: `/reservations/${reservation.id}/inspection-report`
    } : {}
  };
}
