/**
 * citation-export.service — the citation bundle, as ONE PDF.
 * Plan: doc/citations-documents-export-plan-2026-08-28.md (Option A, chosen).
 *
 * What goes in: a cover carrying the citation (number, agency, violation type,
 * amount, fee, issued/due dates, location, status, billing status), the
 * vehicle, the reservation and its dates, the customer, and the rental
 * agreement reference when one exists — then every attachment appended, plus
 * the ORIGINAL source notice from Citation.documentPath. Leaving that last one
 * out would ship a bundle missing the citation itself.
 *
 * ── WHY THE FUNCTIONS BELOW TAKE ARRAYS ──────────────────────────────────
 * Bulk export ("every citation for this month") is explicitly out of scope for
 * this build, but it is the request that always follows, and retrofitting it
 * would mean rewriting this file. So the seam is here from day one:
 *
 *   gatherBundles(ids, scope)  → BundleModel[]   ← already N
 *   buildCoverHtml(bundles)    → one HTML doc, one cover section per bundle
 *   composeBundlePdf(bundles)  → one PDF, covers then attachments
 *
 * Every step is array-shaped; `exportCitationPdf` is a thin single-id wrapper
 * that passes `[id]`. Adding bulk means a new route that resolves a set of
 * ids (a date range, a status filter) and calls the same three functions —
 * no change to any of them. The single-citation path is just N = 1.
 *
 * ── ATTACHMENTS NEVER REACH AN AI PROVIDER ───────────────────────────────
 * This module reads attachment bytes to EMBED them in a PDF and nothing else.
 * There is no extractor import here and no write to CitationDocument (the OCR
 * queue). See citation-attachments.service.js's header for why that matters,
 * and citation-attachments-ocr-isolation.test.mjs for the test that pins it.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { downloadObject } from '../../lib/storage/index.js';
import { renderReportPdf } from '../reports/reports-export.js';
import { citationLocationWhere } from './citations.service.js';
import { parseStorageRef } from './citation-attachments.service.js';
import { ATTACHMENT_STATUS, isPdfMime, isImageMime, isEmbeddable } from './citation-attachments.js';

/**
 * Hard ceiling on bytes pulled into memory for one export. Two 15MB scans and
 * a 40-page notice is a realistic dispute file; a hundred of them is a
 * bulk-export OOM waiting to happen. When the budget runs out the remaining
 * attachments are LISTED as not included rather than silently dropped — the
 * same treatment a .docx gets, and for the same reason.
 */
const EMBED_BYTE_BUDGET = Math.max(
  8 * 1024 * 1024,
  Number(process.env.CITATION_EXPORT_EMBED_BUDGET_BYTES || 60 * 1024 * 1024) || 60 * 1024 * 1024,
);

const DOC_TYPE_LABELS = Object.freeze({
  AGENCY_NOTICE: 'Agency notice',
  PROOF_OF_PAYMENT: 'Proof of payment',
  DISPUTE_LETTER: 'Dispute letter',
  AGENCY_RESPONSE: 'Agency response',
  CUSTOMER_CORRESPONDENCE: 'Customer correspondence',
  RENTAL_DOCUMENT: 'Rental document',
  OTHER: 'Other',
});

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function dateLong(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}
function money(v) { return `$${Number(Number(v || 0).toFixed(2)).toFixed(2)}`; }
function dash(v) { return v == null || v === '' ? '—' : esc(v); }
function kb(n) {
  const b = Number(n || 0);
  if (!b) return '—';
  return b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

/**
 * Read the citations the caller is allowed to export, with everything the
 * cover needs. Scoped exactly like getDetail — tenant AND location — so the
 * export can never become a side door to a branch the caller cannot open.
 *
 * Takes an ARRAY of ids and returns an array. Order follows the ids given.
 */
export async function gatherBundles(ids, scope = {}, db = prisma) {
  if (!scope?.tenantId) {
    const e = new Error('tenantId is required'); e.status = 400; throw e;
  }
  const wanted = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!wanted.length) return [];

  const citations = await db.citation.findMany({
    where: { id: { in: wanted }, tenantId: scope.tenantId, ...citationLocationWhere(scope) },
    include: {
      vehicle: { select: { id: true, plate: true, year: true, make: true, model: true, vin: true } },
      reservation: {
        select: {
          id: true, reservationNumber: true, pickupAt: true, returnAt: true,
          customer: {
            select: {
              id: true, firstName: true, lastName: true, email: true, phone: true,
              address1: true, address2: true, city: true, state: true, zip: true,
              licenseNumber: true, licenseState: true,
            },
          },
          pickupLocation: { select: { id: true, name: true, code: true } },
          rentalAgreement: { select: { id: true, agreementNumber: true, status: true } },
        },
      },
    },
  });

  const byId = new Map(citations.map((c) => [c.id, c]));
  const found = wanted.map((id) => byId.get(id)).filter(Boolean);

  const attachments = found.length
    ? await db.citationAttachment.findMany({
      where: {
        tenantId: scope.tenantId,
        citationId: { in: found.map((c) => c.id) },
        status: ATTACHMENT_STATUS.ACTIVE,
      },
      orderBy: [{ createdAt: 'asc' }],
    })
    : [];

  const byCitation = new Map();
  for (const a of attachments) {
    if (!byCitation.has(a.citationId)) byCitation.set(a.citationId, []);
    byCitation.get(a.citationId).push(a);
  }

  return found.map((citation) => ({
    citation,
    attachments: byCitation.get(citation.id) || [],
    // The ORIGINAL scanned notice, treated as a first-class part of the
    // bundle rather than an afterthought — without it the recipient has our
    // paperwork about a citation but not the citation.
    sourceDocumentPath: citation.documentPath || null,
  }));
}

/**
 * Every part the PDF should try to embed, in bundle order: the original notice
 * first, then attachments oldest-first. Pure — no I/O — so the ordering and
 * the embeddable/listed split are testable without storage.
 */
export function planParts(bundle) {
  const parts = [];
  if (bundle.sourceDocumentPath) {
    parts.push({
      kind: 'SOURCE',
      ref: bundle.sourceDocumentPath,
      label: 'Original citation notice (as received)',
      docType: 'AGENCY_NOTICE',
      // The OCR intake path stores scans as PDF or image and does not persist a
      // mime for Citation.documentPath; sniff from the stored bytes instead.
      mimeType: null,
      fileName: null,
      sizeBytes: null,
      embeddable: true,
    });
  }
  for (const a of bundle.attachments) {
    parts.push({
      kind: 'ATTACHMENT',
      id: a.id,
      ref: a.storagePath,
      label: a.label,
      notes: a.notes,
      docType: a.docType,
      mimeType: a.mimeType,
      fileName: a.fileName,
      sizeBytes: a.sizeBytes,
      createdAt: a.createdAt,
      embeddable: isEmbeddable(a.mimeType),
    });
  }
  return parts;
}

/**
 * Can pdf-lib actually read this PDF? Checked at fetch time so the cover's
 * "Appended" / "not included" listing is decided before it is rendered.
 * `ignoreEncryption` because an agency notice is routinely a "protected" PDF
 * with an empty owner password — refusing those would exclude the single most
 * common attachment type in the feature.
 */
async function pdfIsReadable(buffer) {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount() > 0;
  } catch {
    return false;
  }
}

/** Sniff the real type of downloaded bytes; storage metadata can be absent. */
function sniff(buffer, declared) {
  const head = buffer.subarray(0, 8);
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.toString('hex') === '89504e470d0a1a0a') return 'image/png';
  return String(declared || '').toLowerCase() || null;
}

/**
 * Download the embeddable parts, within the byte budget. Anything that fails
 * to download, exceeds the budget, or turns out not to be embeddable is marked
 * `included: false` with a reason — never silently dropped. A recipient must
 * be able to tell a complete bundle from an incomplete one.
 */
export async function fetchParts(bundles, deps = {}) {
  const download = deps.downloadObject || downloadObject;
  let spent = 0;
  for (const bundle of bundles) {
    bundle.parts = planParts(bundle);
    for (const part of bundle.parts) {
      if (!part.embeddable) {
        part.included = false;
        part.reason = 'FORMAT';
        continue;
      }
      // Citation.documentPath may hold an external http(s) URL rather than a
      // stored object (getDocumentUrl passes those straight through). We do not
      // fetch arbitrary URLs into an export, so it is listed, not embedded.
      if (/^https?:\/\//i.test(String(part.ref))) {
        part.included = false;
        part.reason = 'EXTERNAL';
        continue;
      }
      const ref = parseStorageRef(part.ref);
      if (!ref) { part.included = false; part.reason = 'MISSING'; continue; }
      if (spent >= EMBED_BYTE_BUDGET) { part.included = false; part.reason = 'BUDGET'; continue; }
      try {
        // eslint-disable-next-line no-await-in-loop
        const { body, contentType } = await download(ref);
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
        if (!buffer.byteLength) { part.included = false; part.reason = 'MISSING'; continue; }
        if (spent + buffer.byteLength > EMBED_BYTE_BUDGET) {
          part.included = false; part.reason = 'BUDGET'; continue;
        }
        const mime = sniff(buffer, part.mimeType || contentType);
        if (!isEmbeddable(mime)) { part.included = false; part.reason = 'FORMAT'; continue; }
        // Prove a PDF actually parses BEFORE the cover is rendered. Discovering
        // it at merge time would leave the cover claiming "Appended" for a page
        // that never made it — the cover's completeness promise is the whole
        // point of the listing, so it must be settled first.
        if (isPdfMime(mime)) {
          // eslint-disable-next-line no-await-in-loop
          const ok = await pdfIsReadable(buffer);
          if (!ok) { part.included = false; part.reason = 'UNREADABLE'; continue; }
        }
        spent += buffer.byteLength;
        part.buffer = buffer;
        part.resolvedMime = mime;
        part.included = true;
        if (!part.sizeBytes) part.sizeBytes = buffer.byteLength;
      } catch (e) {
        // Never fail the whole export because one object is unreachable —
        // ship the rest and say plainly which part is missing.
        part.included = false;
        part.reason = 'MISSING';
        logger.warn('[citation-export] part unavailable', {
          citationId: bundle.citation.id, kind: part.kind, message: String(e?.message || e),
        });
      }
    }
  }
  return bundles;
}

const CSS = `
*{box-sizing:border-box;}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#111;margin:0;font-size:12px;line-height:1.5;}
.pg{padding:48px 56px;page-break-after:always;}
.pg:last-child{page-break-after:auto;}
.lh{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:9px;}
.lh .co{font-size:15px;font-weight:700;}
.lh .rt{font-size:9.5px;color:#555;text-align:right;line-height:1.4;}
h1{font-size:17px;margin:18px 0 2px;letter-spacing:.02em;}
.sub{font-size:10.5px;color:#555;margin:0 0 16px;}
.sec{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:18px 0 5px;color:#222;border-bottom:0.7px solid #bbb;padding-bottom:2px;}
table.box{width:100%;border-collapse:collapse;margin:0 0 4px;font-size:11px;}
table.box td{border:0.7px solid #b9b9b9;padding:5px 8px;vertical-align:top;}
table.box td.k{background:#f2f2ef;width:22%;font-weight:600;color:#222;}
table.lst{width:100%;border-collapse:collapse;font-size:10.5px;margin-top:2px;}
table.lst th{text-align:left;background:#f2f2ef;border:0.7px solid #b9b9b9;padding:5px 8px;font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;}
table.lst td{border:0.7px solid #b9b9b9;padding:5px 8px;vertical-align:top;}
.warn{border:1px solid #a8760f;background:#fdf4e3;padding:9px 11px;margin-top:10px;font-size:10.5px;color:#5d420a;}
.warn b{display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em;font-size:9.5px;}
.ok{font-size:10.5px;color:#33691e;margin-top:8px;}
.ft{margin-top:20px;border-top:0.5px solid #ccc;padding-top:6px;font-size:8.5px;color:#888;display:flex;justify-content:space-between;}
.att{padding:34px 44px;page-break-after:always;}
.att .cap{font-size:10px;color:#555;border-bottom:0.7px solid #ccc;padding-bottom:5px;margin-bottom:10px;display:flex;justify-content:space-between;}
.att img{max-width:100%;max-height:8.6in;display:block;margin:0 auto;}
`;

function coverPage(bundle, cfg, index, total) {
  const c = bundle.citation;
  const veh = c.vehicle;
  const resv = c.reservation;
  const cu = resv?.customer;
  const ag = resv?.rentalAgreement;
  const parts = bundle.parts || planParts(bundle);
  const included = parts.filter((p) => p.included);
  const excluded = parts.filter((p) => !p.included);
  const generatedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const companyName = cfg.companyName || 'RideFleet Manager';
  const vehicleDesc = veh ? [veh.year, veh.make, veh.model].filter(Boolean).join(' ') : '';
  const renter = cu ? `${cu.firstName || ''} ${cu.lastName || ''}`.trim() : '';
  const addr = cu
    ? [[cu.address1, cu.address2].filter(Boolean).join(', '), [cu.city, cu.state, cu.zip].filter(Boolean).join(', ')]
      .filter(Boolean).join(' · ')
    : '';

  const reasonText = {
    FORMAT: 'Not a PDF or image — cannot be appended',
    MISSING: 'File could not be retrieved from storage',
    BUDGET: 'Omitted — export size limit reached',
    UNREADABLE: 'File is damaged and could not be read',
    EXTERNAL: 'Held at an external link, not in this system',
  };

  return `<div class="pg">
  <div class="lh">
    <div><div class="co">${esc(companyName)}</div><div style="font-size:10px;color:#555;">Citation file</div></div>
    <div class="rt">Citation&nbsp;#${esc(c.citationNo || '—')}<br>Generated ${esc(generatedAt)}${total > 1 ? `<br>Citation ${index + 1} of ${total}` : ''}</div>
  </div>

  <h1>Citation ${esc(c.citationNo || '—')}</h1>
  <div class="sub">${dash(c.agency)}${c.violationType ? ` &middot; ${esc(c.violationType)}` : ''}</div>

  <div class="sec">Citation</div>
  <table class="box">
    <tr><td class="k">Citation #</td><td>${dash(c.citationNo)}</td><td class="k">Issuing agency</td><td>${dash(c.agency)}</td></tr>
    <tr><td class="k">Violation type</td><td>${dash(c.violationType)}</td><td class="k">Location</td><td>${dash(c.location)}</td></tr>
    <tr><td class="k">Issued</td><td>${dateLong(c.issuedAt)}</td><td class="k">Due</td><td>${dateLong(c.dueAt)}</td></tr>
    <tr><td class="k">Amount</td><td>${money(c.amount)}</td><td class="k">Processing fee</td><td>${money(c.fee)}</td></tr>
    <tr><td class="k">Total</td><td><b>${money(Number(c.amount || 0) + Number(c.fee || 0))}</b></td><td class="k">Plate on notice</td><td>${dash(c.plateNormalized || c.plateRaw)}${c.plateState ? ` &middot; ${esc(c.plateState)}` : ''}</td></tr>
    <tr><td class="k">Status</td><td>${dash(String(c.status || '').replace(/_/g, ' '))}</td><td class="k">Billing status</td><td>${dash(String(c.billingStatus || '').replace(/_/g, ' '))}</td></tr>
  </table>

  <div class="sec">Vehicle</div>
  <table class="box">
    ${veh
    ? `<tr><td class="k">Vehicle</td><td>${dash(vehicleDesc)}</td><td class="k">Plate</td><td>${dash(veh.plate)}</td></tr>
       <tr><td class="k">VIN</td><td colspan="3">${dash(veh.vin)}</td></tr>`
    : '<tr><td colspan="4">Not matched to a vehicle in the fleet.</td></tr>'}
  </table>

  <div class="sec">Rental</div>
  <table class="box">
    ${resv
    ? `<tr><td class="k">Reservation</td><td>${dash(resv.reservationNumber)}</td><td class="k">Branch</td><td>${dash(resv.pickupLocation?.name)}</td></tr>
       <tr><td class="k">Picked up</td><td>${dateLong(resv.pickupAt)}</td><td class="k">Returned</td><td>${dateLong(resv.returnAt)}</td></tr>
       <tr><td class="k">Rental agreement</td><td colspan="3">${ag ? `${esc(ag.agreementNumber)}${ag.status ? ` &middot; ${esc(String(ag.status).replace(/_/g, ' '))}` : ''}` : 'No agreement on file'}</td></tr>`
    : '<tr><td colspan="4">Not matched to a rental. No reservation covered the citation date.</td></tr>'}
  </table>

  <div class="sec">Renter</div>
  <table class="box">
    ${cu
    ? `<tr><td class="k">Name</td><td colspan="3">${dash(renter)}</td></tr>
       <tr><td class="k">Address</td><td colspan="3">${dash(addr)}</td></tr>
       <tr><td class="k">Driver licence</td><td>${dash(cu.licenseNumber)}${cu.licenseState ? ` (${esc(cu.licenseState)})` : ''}</td><td class="k">Contact</td><td>${dash([cu.email, cu.phone].filter(Boolean).join(' · '))}</td></tr>`
    : '<tr><td colspan="4">No renter matched to this citation.</td></tr>'}
  </table>

  <div class="sec">Documents in this file</div>
  <table class="lst">
    <tr><th>Document</th><th>Type</th><th>File</th><th>Size</th><th>Included</th></tr>
    ${parts.length
    ? parts.map((p) => `<tr>
        <td>${esc(p.label || '—')}${p.notes ? `<div style="color:#666;">${esc(p.notes)}</div>` : ''}</td>
        <td>${esc(DOC_TYPE_LABELS[p.docType] || p.docType || '—')}</td>
        <td>${esc(p.fileName || (p.kind === 'SOURCE' ? 'Original notice' : '—'))}</td>
        <td>${kb(p.sizeBytes)}</td>
        <td>${p.included ? 'Appended' : `<b>No</b> — ${esc(reasonText[p.reason] || 'Not included')}`}</td>
      </tr>`).join('')
    : '<tr><td colspan="5">No documents on file for this citation.</td></tr>'}
  </table>

  ${excluded.length
    ? `<div class="warn"><b>This file is incomplete</b>
       ${excluded.length} of ${parts.length} document${parts.length === 1 ? '' : 's'} could not be appended to this PDF and ${excluded.length === 1 ? 'is' : 'are'} listed above by name only. ${excluded.some((p) => p.reason === 'FORMAT') ? 'Formats other than PDF, JPEG and PNG cannot be embedded — request them separately. ' : ''}Do not treat this bundle as the complete record.</div>`
    : (included.length ? `<div class="ok">All ${included.length} document${included.length === 1 ? '' : 's'} on file ${included.length === 1 ? 'is' : 'are'} appended after this page.</div>` : '')}

  <div class="ft">
    <span>Citation file &middot; ${esc(c.citationNo || '—')}</span>
    <span>${esc(companyName)} &middot; Generated ${esc(generatedAt)}</span>
  </div>
</div>`;
}

/**
 * One HTML document: a cover section per bundle, then a page per embeddable
 * IMAGE. PDF attachments are not here — they are merged as real pages in
 * composeBundlePdf, because rasterising a PDF into an <img> would destroy its
 * text layer and its resolution.
 */
export function buildCoverHtml(bundles, cfg = {}) {
  const covers = bundles.map((b, i) => coverPage(b, cfg, i, bundles.length)).join('\n');
  const imagePages = bundles.flatMap((b) => (b.parts || [])
    .filter((p) => p.included && isImageMime(p.resolvedMime))
    .map((p) => `<div class="att">
      <div class="cap"><span>${esc(b.citation.citationNo || '')} &middot; ${esc(p.label || '')}</span><span>${esc(DOC_TYPE_LABELS[p.docType] || p.docType || '')}</span></div>
      <img src="data:${esc(p.resolvedMime)};base64,${p.buffer.toString('base64')}" alt="">
    </div>`));
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${covers}${imagePages.join('\n')}</body></html>`;
}

/**
 * Render the covers + image pages, then append every embeddable PDF part as
 * real pages.
 *
 * pdf-lib is the one new dependency this feature adds. There is no PDF-merging
 * capability anywhere in this repo today (pdfkit is declared but unused and
 * cannot import existing PDFs), and every other "extra pages" case is solved
 * by splicing HTML before </body> — which works for images and cannot work for
 * a PDF without rasterising it. Since agency notices and dispute letters
 * arrive as PDFs, listing them instead of appending them would empty the
 * feature of its purpose.
 */
export async function composeBundlePdf(bundles, cfg = {}) {
  const html = buildCoverHtml(bundles, cfg);
  const coverPdf = await renderReportPdf(html, {
    landscape: false, format: 'Letter',
    marginTop: '0in', marginBottom: '0in', marginLeft: '0in', marginRight: '0in',
  });

  const pdfParts = bundles.flatMap((b) => (b.parts || []).filter((p) => p.included && isPdfMime(p.resolvedMime)));
  if (!pdfParts.length) return Buffer.from(coverPdf);

  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.load(coverPdf);
  for (const part of pdfParts) {
    try {
      // Already proven readable in fetchParts, so the cover's listing and what
      // this loop appends agree. The try/catch is belt-and-braces: one damaged
      // attachment must never take down an export whose cover is already
      // rendered and whose other pages are fine.
      // eslint-disable-next-line no-await-in-loop
      const src = await PDFDocument.load(part.buffer, { ignoreEncryption: true });
      // eslint-disable-next-line no-await-in-loop
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    } catch (e) {
      logger.warn('[citation-export] attachment pdf failed to merge after passing validation', {
        citationId: bundles.find((b) => (b.parts || []).includes(part))?.citation?.id,
        message: String(e?.message || e),
      });
    }
  }
  return Buffer.from(await out.save());
}

async function loadCompanyConfig(scope) {
  try {
    const { settingsService } = await import('../settings/settings.service.js');
    return await settingsService.getRentalAgreementConfig({ tenantId: scope.tenantId }) || {};
  } catch {
    return {};
  }
}

/**
 * Export ONE citation as a single PDF.
 *
 * A thin wrapper over the array-shaped pipeline above — see this file's header
 * for why. A future `exportCitationsPdf(filters, scope)` resolves ids and calls
 * exactly the same three steps.
 */
export async function exportCitationPdf(id, scope = {}, deps = {}) {
  const bundles = await gatherBundles([id], scope, deps.db || prisma);
  if (!bundles.length) {
    const e = new Error('Citation not found'); e.status = 404; throw e;
  }
  await fetchParts(bundles, deps);
  const cfg = deps.cfg || await loadCompanyConfig(scope);
  const buffer = await composeBundlePdf(bundles, cfg);
  const parts = bundles[0].parts || [];
  logger.info('[citation-export] bundle generated', {
    tenantId: scope.tenantId,
    citationId: bundles[0].citation.id,
    parts: parts.length,
    included: parts.filter((p) => p.included).length,
  });
  return { buffer, citationNo: bundles[0].citation.citationNo, bundles };
}

export default { gatherBundles, planParts, fetchParts, buildCoverHtml, composeBundlePdf, exportCitationPdf };
