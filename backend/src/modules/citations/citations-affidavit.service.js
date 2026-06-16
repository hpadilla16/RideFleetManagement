// Citations — Affidavit of Transfer of Liability (PDF).
// Fase D #4. NOT money. Generates a printable, notarizable affidavit that the vehicle
// OWNER (the rental company) submits to the issuing authority to transfer liability for a
// citation to the renter who had care, custody, and control of the vehicle at the time of
// the violation. Models Fla. Stat. § 316.0083 requirements for leased/rented vehicles:
// the affidavit must include the renter's name, address, date of birth, and (if known)
// driver license number, and be furnished within 30 days of the citation's issuance.
//
// Pattern reused from reports: build a self-contained HTML string → renderReportPdf().
// Company (owner) letterhead comes from the same config the rental agreement uses.

import { prisma } from '../../lib/prisma.js';
import { renderReportPdf } from '../reports/reports-export.js';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function dateLong(v) {
  if (!v) return '____________________';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}
function money(v) { return `$${Number(Number(v || 0).toFixed(2)).toFixed(2)}`; }
function orLine(v) { return v == null || v === '' ? '____________________' : esc(v); }

function rentalPeriod(reservation) {
  if (!reservation) return '____________________';
  const a = reservation.pickupAt ? dateLong(reservation.pickupAt) : '____________';
  const b = reservation.returnAt ? dateLong(reservation.returnAt) : '____________';
  return `${a} &ndash; ${b}`;
}

function renterAddress(cu) {
  if (!cu) return '____________________';
  const line1 = [cu.address1, cu.address2].filter(Boolean).join(', ');
  const line2 = [cu.city, cu.state, cu.zip].filter(Boolean).join(', ');
  const full = [line1, line2].filter(Boolean).join(', ');
  return full ? esc(full) : '____________________';
}

/**
 * Build the self-contained affidavit HTML for one citation.
 * @param {object} citation — citation with vehicle, reservation.customer joined
 * @param {object} cfg — { companyName, companyAddress, companyPhone }
 */
export function buildAffidavitHtml(citation, cfg = {}) {
  const c = citation || {};
  const veh = c.vehicle || {};
  const resv = c.reservation || null;
  const cu = resv?.customer || null;
  // Owner = the dedicated affidavit owner setting (the registered legal entity), falling
  // back to the rental-agreement company config when the tenant hasn't set it.
  const companyName = cfg.affidavitOwnerName || cfg.companyName || 'The Vehicle Owner';
  const companyAddress = cfg.affidavitOwnerAddress || cfg.companyAddress || '';
  const companyPhone = cfg.affidavitOwnerPhone || cfg.companyPhone || '';
  const vehicleDesc = [veh.year, veh.make, veh.model].filter(Boolean).join(' ') || '—';
  const plate = veh.plate || c.plateNormalized || c.plateRaw || '—';
  const plateState = c.plateState || '';
  const renterName = cu ? `${cu.firstName || ''} ${cu.lastName || ''}`.trim() : '';
  const dob = cu?.dateOfBirth ? dateLong(cu.dateOfBirth) : '____________________';
  const dl = cu?.licenseNumber ? `${esc(cu.licenseNumber)}${cu.licenseState ? ` (${esc(cu.licenseState)})` : ''}` : 'Not known to affiant';
  const total = Number(c.amount || 0) + Number(c.fee || 0);
  const generatedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const ownerBlock = `${esc(companyName)}${companyAddress ? `<br>${esc(companyAddress)}` : ''}${companyPhone ? `<br>${esc(companyPhone)}` : ''}`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;}
  body{font-family:'Times New Roman',Georgia,serif;color:#111;margin:0;padding:0;font-size:12.5px;line-height:1.5;}
  .pg{padding:54px 64px 48px;}
  .lh{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:6px;}
  .lh .co{font-size:15px;font-weight:700;}
  .lh .ca{font-size:10.5px;color:#333;margin-top:2px;line-height:1.35;}
  .lh .rt{font-size:10px;color:#555;text-align:right;}
  h1{font-size:16px;text-align:center;letter-spacing:.06em;margin:22px 0 4px;text-transform:uppercase;}
  .sub{text-align:center;font-size:10.5px;color:#444;margin:0 0 16px;}
  .ven{font-size:11px;margin:10px 0 16px;}
  .ven b{display:inline-block;min-width:140px;}
  p.s{margin:9px 0;text-align:justify;}
  .num{margin:9px 0;text-align:justify;padding-left:26px;text-indent:-26px;}
  .num .n{display:inline-block;width:18px;font-weight:700;}
  table.box{width:100%;border-collapse:collapse;margin:10px 0 6px;font-size:11px;}
  table.box td{border:0.7px solid #999;padding:5px 8px;vertical-align:top;}
  table.box td.k{background:#f1f1ee;width:34%;font-weight:700;color:#222;}
  .sec{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin:18px 0 4px;color:#222;border-bottom:0.7px solid #bbb;padding-bottom:2px;}
  .sig{margin-top:30px;}
  .sigrow{margin-top:26px;display:flex;gap:40px;}
  .sigrow .f{flex:1;}
  .sigline{border-top:1px solid #111;padding-top:3px;font-size:10px;color:#444;}
  .notary{margin-top:26px;border:0.7px solid #999;padding:12px 14px;font-size:11px;}
  .notary .nt{font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.05em;margin-bottom:6px;}
  .ft{margin-top:22px;border-top:0.5px solid #ccc;padding-top:6px;font-size:8.5px;color:#888;display:flex;justify-content:space-between;}
  .fill{display:inline-block;border-bottom:1px solid #111;min-width:120px;}
  </style></head><body><div class="pg">

  <div class="lh">
    <div><div class="co">${esc(companyName)}</div>${companyAddress ? `<div class="ca">${esc(companyAddress)}</div>` : ''}${companyPhone ? `<div class="ca">${esc(companyPhone)}</div>` : ''}</div>
    <div class="rt">Citation&nbsp;#${esc(c.citationNo || '—')}<br>Generated ${esc(generatedAt)}</div>
  </div>

  <h1>Affidavit of Transfer of Liability</h1>
  <div class="sub">Leased / Rented Motor Vehicle &middot; Pursuant to applicable Florida law, including § 316.0083, Fla. Stat.</div>

  <div class="ven">
    <div><b>STATE OF FLORIDA</b></div>
    <div><b>COUNTY OF</b> <span class="fill">&nbsp;</span></div>
  </div>

  <p class="s">BEFORE ME, the undersigned authority, personally appeared the affiant named below, who, being
  first duly sworn, deposes and states:</p>

  <p class="num"><span class="n">1.</span> The affiant is an authorized representative of <b>${esc(companyName)}</b> (the &ldquo;Owner&rdquo;), the
  registered owner / lessor of the motor vehicle identified below.</p>

  <p class="num"><span class="n">2.</span> The motor vehicle was, at all times relevant hereto, leased or rented by the Owner to the
  person identified below (the &ldquo;Renter&rdquo;) under a written rental agreement.</p>

  <p class="num"><span class="n">3.</span> At the time of the alleged violation, the Renter had exclusive care, custody, and control of
  the motor vehicle. The Owner did not operate the vehicle and was not in control of it at that time.</p>

  <p class="num"><span class="n">4.</span> Pursuant to § 316.0083, Fla. Stat., and other applicable law, the Owner hereby submits this
  affidavit to transfer liability for the citation identified below to the Renter, and provides the Renter's
  name, address, date of birth, and driver license number (if known) below.</p>

  <div class="sec">Motor Vehicle</div>
  <table class="box">
    <tr><td class="k">Vehicle</td><td>${esc(vehicleDesc)}</td><td class="k">License Plate</td><td>${esc(plate)}${plateState ? ` &middot; ${esc(plateState)}` : ''}</td></tr>
  </table>

  <div class="sec">Citation / Notice</div>
  <table class="box">
    <tr><td class="k">Citation / Notice #</td><td>${orLine(c.citationNo)}</td><td class="k">Issuing Agency</td><td>${orLine(c.agency)}</td></tr>
    <tr><td class="k">Date of Violation</td><td>${dateLong(c.issuedAt)}</td><td class="k">Violation Type</td><td>${orLine(c.violationType)}</td></tr>
    <tr><td class="k">Location</td><td colspan="3">${orLine(c.location)}</td></tr>
    <tr><td class="k">Amount</td><td>${money(c.amount)}</td><td class="k">Total (incl. fees)</td><td>${money(total)}</td></tr>
  </table>

  <div class="sec">Renter (Person in Care, Custody &amp; Control)</div>
  <table class="box">
    <tr><td class="k">Full Name</td><td colspan="3">${orLine(renterName)}</td></tr>
    <tr><td class="k">Address</td><td colspan="3">${renterAddress(cu)}</td></tr>
    <tr><td class="k">Date of Birth</td><td>${dob}</td><td class="k">Driver License #</td><td>${dl}</td></tr>
    <tr><td class="k">Rental Period</td><td colspan="3">${rentalPeriod(resv)}${resv?.reservationNumber ? ` &middot; Agreement ${esc(resv.reservationNumber)}` : ''}</td></tr>
  </table>

  <p class="s" style="margin-top:14px;">FURTHER AFFIANT SAYETH NAUGHT. The affiant declares under penalty of perjury that the
  foregoing is true and correct to the best of the affiant's knowledge and belief.</p>

  <div class="sig">
    <div class="sigrow">
      <div class="f"><div style="height:24px;"></div><div class="sigline">Signature of Affiant (Authorized Representative)</div></div>
      <div class="f"><div style="height:24px;"></div><div class="sigline">Date</div></div>
    </div>
    <div class="sigrow">
      <div class="f"><div style="height:24px;"></div><div class="sigline">Printed Name</div></div>
      <div class="f"><div style="height:24px;"></div><div class="sigline">Title &middot; on behalf of ${esc(companyName)}</div></div>
    </div>
  </div>

  <div class="notary">
    <div class="nt">Notary Acknowledgment</div>
    Sworn to (or affirmed) and subscribed before me by means of &#9633; physical presence or &#9633; online
    notarization, this <span class="fill">&nbsp;</span> day of <span class="fill">&nbsp;</span>, 20<span class="fill" style="min-width:40px;">&nbsp;</span>,
    by <span class="fill" style="min-width:220px;">&nbsp;</span>, who is personally known to me or who has produced
    <span class="fill" style="min-width:160px;">&nbsp;</span> as identification.
    <div class="sigrow" style="margin-top:22px;">
      <div class="f"><div style="height:18px;"></div><div class="sigline">Notary Public &middot; State of Florida</div></div>
      <div class="f"><div style="height:18px;"></div><div class="sigline">My Commission Expires</div></div>
    </div>
  </div>

  <div class="ft">
    <span>Affidavit of Transfer of Liability &middot; Citation ${esc(c.citationNo || '—')}</span>
    <span>RideFleet Manager &middot; Generated ${esc(generatedAt)}</span>
  </div>

  </div></body></html>`;
}

/**
 * Fetch the citation (+ renter PII + owner config) and render the affidavit to a PDF buffer.
 * Throws a 400 if the citation has no matched reservation/renter (an affidavit requires the
 * person who had care, custody, and control).
 */
export async function affidavitPdfBuffer(id, scope = {}) {
  const citation = await prisma.citation.findFirst({
    where: { id, tenantId: scope.tenantId },
    include: {
      vehicle: { select: { id: true, plate: true, year: true, make: true, model: true } },
      reservation: {
        select: {
          id: true, reservationNumber: true, pickupAt: true, returnAt: true,
          customer: {
            select: {
              id: true, firstName: true, lastName: true,
              address1: true, address2: true, city: true, state: true, zip: true,
              dateOfBirth: true, licenseNumber: true, licenseState: true,
            },
          },
        },
      },
    },
  });
  if (!citation) {
    const err = new Error('Citation not found');
    err.status = 404;
    throw err;
  }
  if (!citation.reservation || !citation.reservation.customer) {
    const err = new Error('Affidavit requires a citation matched to a reservation with a renter on file.');
    err.status = 400;
    throw err;
  }

  // Owner (company) letterhead — same config the rental agreement uses.
  let cfg = {};
  try {
    const { settingsService } = await import('../settings/settings.service.js');
    cfg = await settingsService.getRentalAgreementConfig({ tenantId: scope.tenantId }) || {};
  } catch { /* fall back to defaults below */ }

  const html = buildAffidavitHtml(citation, cfg);
  const buffer = await renderReportPdf(html, { landscape: false, format: 'Letter', marginTop: '0in', marginBottom: '0in', marginLeft: '0in', marginRight: '0in' });
  return { buffer, citationNo: citation.citationNo };
}
