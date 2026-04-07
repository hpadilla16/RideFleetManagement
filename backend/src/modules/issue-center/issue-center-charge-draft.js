function toAmount(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : fallback;
}

export function buildIncidentChargeDraft(incident, payload = {}) {
  const amount = toAmount(
    payload?.amount,
    toAmount(incident?.amountResolved, toAmount(incident?.amountClaimed, 0))
  );
  if (!(amount > 0)) {
    throw new Error('Claim amount must be greater than 0 to create a charge draft');
  }

  const title = String(incident?.title || 'Claim Charge').trim() || 'Claim Charge';
  const type = String(incident?.type || 'OTHER').trim().toUpperCase();
  const name = String(payload?.name || `${title} (${type})`).trim().slice(0, 120);
  const notes = String(payload?.notes || '').trim() || `Issue Center claim draft for ${incident?.id}`;

  return {
    amount,
    charge: {
      code: 'ISSUE_CLAIM',
      name,
      chargeType: 'UNIT',
      quantity: 1,
      rate: amount,
      total: amount,
      taxable: false,
      selected: true,
      source: 'ISSUE_CENTER',
      sourceRefId: incident?.id || null,
      notes
    }
  };
}
