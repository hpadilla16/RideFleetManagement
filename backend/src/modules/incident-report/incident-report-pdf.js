/**
 * Incident report — print HTML builder (light corporate theme).
 *
 * Pure function: takes an assembled report object and returns a print-ready
 * HTML document matching the dispute-ready sample (navy headers, red alert
 * banner, evidence table with CONFIRMED/VIOLATION statuses, charge summary,
 * chargeback rebuttal, captioned photo grid, signed certification).
 *
 * Served via `GET …/incident-report/:id/print` and printed with window.print()
 * (HTML-to-print — the locked Phase-1 mechanism). No DB access here.
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  const num = Number(n);
  return Number.isFinite(num) ? `$${num.toFixed(2)}` : String(n);
}

function row(k, v) {
  return `<tr><td class="k">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
}

/**
 * @param {object} r assembled report
 *   { company:{name}, reportNumber, dateIssued, title, bannerText,
 *     renter:{name}, checkIn, checkOut, periodDays, depositCollected, smokingFeeAssessed,
 *     vehicle:{makeModel, color, plate, company}, preRentalCondition,
 *     incident:{discoveryAt, violationType, odorNoted, conditionAtReturn, chargeApplied},
 *     evidence:[{ordinal, location, description, status}],
 *     clauses:[{section, label, text, amountRange}],
 *     charges:{ lines:[{name,total}], total, depositApplied, balanceDue },
 *     rebuttalText, rebuttalPoints:[..],
 *     photos:[{caption, url}],
 *     certification:{name, title, signatureDataUrl, date},
 *     confidentialFooter }
 */
export function buildIncidentReportHtml(r = {}) {
  const company = r.company?.name || 'Ride Fleet';
  const evidenceRows = (r.evidence || []).map((e) => {
    const isViolation = String(e.status).toUpperCase() === 'VIOLATION';
    const cls = isViolation ? 'v' : 'c';
    const label = isViolation ? 'VIOLATION' : 'CONFIRMED';
    return `<tr class="${cls}"><td class="num">${escapeHtml(e.ordinal)}</td><td class="loc">${escapeHtml(e.location)}</td><td>${escapeHtml(e.description)}</td><td><span class="dev-stat ${cls}">${label}</span></td></tr>`;
  }).join('');

  const clauseItems = (r.clauses || []).map((c) => {
    const amt = c.amountRange ? ` · ${escapeHtml(c.amountRange)}` : '';
    const sec = c.section ? ` (§${escapeHtml(c.section)})` : '';
    return `<li><b>${escapeHtml(c.label)}${sec}${amt}:</b> ${escapeHtml(c.text)}</li>`;
  }).join('');

  const rebuttalItems = (r.rebuttalPoints && r.rebuttalPoints.length)
    ? r.rebuttalPoints.map((p) => `<li>${escapeHtml(p)}</li>`).join('')
    : (r.rebuttalText ? `<li>${escapeHtml(r.rebuttalText)}</li>` : '');

  const chargeRows = (r.charges?.lines || []).map((l) => row(l.name, fmtMoney(l.total))).join('');

  const photoCells = (r.photos || []).map((p) => `
    <div class="photo">
      ${p.url ? `<div class="img" style="background-image:url('${escapeHtml(p.url)}')"></div>` : `<div class="img"></div>`}
      <div class="cap">${escapeHtml(p.caption)}</div>
    </div>`).join('');

  const cert = r.certification || {};
  const sigImg = cert.signatureDataUrl
    ? `<img src="${escapeHtml(cert.signatureDataUrl)}" alt="signature" style="max-height:54px"/>`
    : `<div class="sig-script">${escapeHtml(cert.name || '')}</div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(r.reportNumber || 'Incident Report')}</title>
<style>
  :root{--navy:#1f3a5f;--red:#c0392b;--redbg:#fdecea;--line:#d6d9e0;--grey:#f3f4f7;--green:#1f8a4c;}
  *{box-sizing:border-box}
  body{margin:0;background:#fff;color:#222;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:12.5px}
  .pad{max-width:760px;margin:0 auto;padding:30px 38px}
  .title{text-align:center;color:var(--navy);font-weight:850;font-size:20px;letter-spacing:.3px}
  .sub{text-align:center;color:#5a6577;font-size:11px;border-bottom:2px solid var(--navy);padding-bottom:10px;margin-top:2px}
  .band{display:flex;justify-content:space-between;background:var(--navy);color:#fff;font-weight:800;font-size:12px;padding:9px 14px;margin-top:14px;border-radius:3px}
  .alert{background:var(--redbg);border:1px solid #efb4ad;color:var(--red);font-weight:800;font-size:11.5px;padding:11px 13px;margin-top:10px;border-radius:3px;line-height:1.4}
  .h{color:var(--navy);font-weight:850;font-size:12.5px;letter-spacing:.04em;border-bottom:1.5px solid var(--navy);padding-bottom:5px;margin:20px 0 9px;text-transform:uppercase}
  table.doc{width:100%;border-collapse:collapse;font-size:11.5px}
  table.doc td{border:1px solid var(--line);padding:7px 10px;vertical-align:top}
  table.doc td.k{background:var(--grey);font-weight:800;width:38%;color:#33415c}
  table.dev{width:100%;border-collapse:collapse;font-size:11px}
  table.dev th{background:var(--navy);color:#fff;text-align:left;padding:7px 9px;font-size:10.5px}
  table.dev td{border:1px solid var(--line);padding:7px 9px;vertical-align:top}
  table.dev td.num{text-align:center;font-weight:800;width:26px}
  table.dev td.loc{font-weight:800;width:140px;color:#33415c}
  .dev-stat{font-weight:850;font-size:10px}.dev-stat.v{color:var(--red)}.dev-stat.c{color:var(--green)}
  tr.v td{background:#fdf2f1}tr.c td{background:#f1f9f4}
  ul.bul{margin:6px 0;padding-left:18px;font-size:11.5px;line-height:1.55}ul.bul li{margin-bottom:6px}ul.bul b{color:var(--navy)}
  .photogrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:8px}
  .photo{border:1px solid var(--line);border-radius:4px;overflow:hidden}
  .photo .img{height:150px;background:#e9ecf1 center/cover no-repeat}
  .photo .cap{font-size:10px;color:#5a6577;padding:6px 8px;text-align:center;font-style:italic}
  .sigline{margin-top:26px;display:grid;grid-template-columns:1.4fr 1fr;gap:30px}
  .sigline .l{border-top:1px solid #333;padding-top:4px;font-size:10px;color:#5a6577}
  .sig-script{font-family:"Snell Roundhand","Brush Script MT",cursive;font-size:22px;color:#1a2b44;transform:rotate(-3deg)}
  .foot{text-align:center;color:#9aa3b2;font-size:9.5px;border-top:1px solid var(--line);padding:10px 0;margin-top:18px}
  @media print{.noprint{display:none}}
</style></head>
<body><div class="pad">
  <div class="title">${escapeHtml(company)}</div>
  <div class="sub">${escapeHtml(r.title || 'VEHICLE INCIDENT REPORT')}</div>
  <div class="band"><span>REPORT NO: ${escapeHtml(r.reportNumber || '')}</span><span>DATE ISSUED: ${escapeHtml(r.dateIssued || '')}</span></div>
  ${r.bannerText ? `<div class="alert">⚠ ${escapeHtml(r.bannerText)}</div>` : ''}

  <div class="h">1. Rental Agreement Information</div>
  <table class="doc">
    ${row('Renter Full Name', r.renter?.name || '')}
    ${row('Check-In / Check-Out', `${r.checkIn || '-'} → ${r.checkOut || '-'}${r.periodDays ? ` (${r.periodDays} days)` : ''}`)}
    ${row('Deposit Collected', fmtMoney(r.depositCollected))}
    ${row('Fee Assessed', r.smokingFeeAssessed || '—')}
  </table>

  <div class="h">2. Vehicle Information</div>
  <table class="doc">
    ${row('Make & Model / Color', `${r.vehicle?.makeModel || ''}${r.vehicle?.color ? ` — ${r.vehicle.color}` : ''}`)}
    ${row('License Plate', r.vehicle?.plate || '')}
    ${row('Rental Company', r.vehicle?.company || company)}
    ${row('Pre-Rental Condition', r.preRentalCondition || '—')}
  </table>

  <div class="h">3. Incident Details — Discovery</div>
  <table class="doc">
    ${row('Discovery Date', r.incident?.discoveryAt || '')}
    ${row('Violation / Damage Type', r.incident?.violationType || '')}
    ${r.incident?.odorNoted ? row('Odor Noted', r.incident.odorNoted) : ''}
    ${r.incident?.conditionAtReturn ? row('Condition at Return', r.incident.conditionAtReturn) : ''}
    ${r.incident?.chargeApplied ? row('Charge Applied', r.incident.chargeApplied) : ''}
  </table>

  <div class="h">4. Evidence &amp; Violation Documentation</div>
  <table class="dev"><thead><tr><th>#</th><th>Location</th><th>Evidence Description</th><th>Status</th></tr></thead>
  <tbody>${evidenceRows || '<tr><td colspan="4" style="text-align:center;color:#9aa3b2;padding:14px">No evidence rows recorded.</td></tr>'}</tbody></table>

  ${clauseItems ? `<div class="h">5. Rental Agreement Policy Violations</div><ul class="bul">${clauseItems}</ul>` : ''}

  <div class="h">6. Charge Summary &amp; Deposit Application</div>
  <table class="doc">
    ${chargeRows}
    ${r.charges?.total != null ? `<tr><td class="k">Total</td><td><b>${fmtMoney(r.charges.total)}</b></td></tr>` : ''}
    ${r.charges?.depositApplied != null ? row('Deposit Applied', `– ${fmtMoney(r.charges.depositApplied)}`) : ''}
    ${r.charges?.balanceDue != null ? `<tr><td class="k">Balance Due</td><td><b>${fmtMoney(r.charges.balanceDue)}</b></td></tr>` : ''}
  </table>

  ${rebuttalItems ? `<div class="h">7. Chargeback Dispute Rebuttal — Preemptive Evidence Summary</div><ul class="bul">${rebuttalItems}</ul>` : ''}

  ${photoCells ? `<div class="h">8. Photographic Evidence</div><div class="photogrid">${photoCells}</div>` : ''}

  <div class="h">9. Declaration &amp; Certification</div>
  <div class="sigline">
    <div>${sigImg}<div class="l">Authorized Representative Signature</div></div>
    <div><div style="font-size:13px;padding-top:2px">${escapeHtml(cert.date || '')}</div><div class="l">Date</div></div>
  </div>
  ${cert.name ? `<div style="font-size:11px;margin-top:8px">${escapeHtml(cert.name)}${cert.title ? ` — ${escapeHtml(cert.title)}` : ''}</div>` : ''}

  <div class="foot">${escapeHtml(r.confidentialFooter || `CONFIDENTIAL — FOR INTERNAL & DISPUTE RESOLUTION USE ONLY · ${r.reportNumber || ''}`)}</div>
</div></body></html>`;
}

export const __test = { escapeHtml, fmtMoney };
