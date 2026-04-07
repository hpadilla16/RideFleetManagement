import { money, safeParse, sortHistoryEntriesDesc } from './issue-center-core.js';

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(money(value));
}

function formatDateTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

function packetFilename(incident) {
  const ref = incident?.trip?.tripCode || incident?.reservation?.reservationNumber || incident?.id || 'claim';
  const safeRef = String(ref || 'claim').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `claims-packet-${safeRef}.html`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function summarizeVehicle(vehicle = null) {
  if (!vehicle) return '-';
  return [
    vehicle.internalNumber ? `Unit ${vehicle.internalNumber}` : '',
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.plate ? `Plate ${vehicle.plate}` : ''
  ].filter(Boolean).join(' | ') || '-';
}

function sanitizeInlineData(value, depth = 0) {
  if (depth > 4) return '[depth limit]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeInlineData(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        key === 'dataUrl' ? '[inline attachment omitted from packet]' : sanitizeInlineData(nested, depth + 1)
      ])
    );
  }
  if (typeof value === 'string' && value.startsWith('data:')) {
    return '[inline attachment omitted from packet]';
  }
  return value;
}

function buildSummaryRows(incident) {
  return [
    ['Incident ID', incident?.id || '-'],
    ['Title', incident?.title || '-'],
    ['Type', incident?.type || '-'],
    ['Status', incident?.status || '-'],
    ['Priority', incident?.priority || '-'],
    ['Severity', incident?.severity || '-'],
    ['Owner', incident?.ownerUser?.fullName || incident?.ownerUser?.email || '-'],
    ['Due At', formatDateTime(incident?.dueAt)],
    ['Resolution Code', incident?.resolutionCode || '-'],
    ['Liability Decision', incident?.liabilityDecision || '-'],
    ['Charge Decision', incident?.chargeDecision || '-'],
    ['Recovery Stage', incident?.recoveryStage || '-'],
    ['Customer Charge Ready', incident?.customerChargeReady ? 'YES' : 'NO'],
    ['Waive Reason', incident?.waiveReason || '-'],
    ['Next Best Action', incident?.nextBestAction?.label || '-'],
    ['Next Action Detail', incident?.nextBestAction?.detail || '-'],
    ['Amount Claimed', formatMoney(incident?.amountClaimed)],
    ['Amount Resolved', formatMoney(incident?.amountResolved)],
    ['Created At', formatDateTime(incident?.createdAt)],
    ['Resolved At', formatDateTime(incident?.resolvedAt)],
    ['Description', String(incident?.description || '').trim() || '-']
  ];
}

function buildContextRows(incident) {
  const reservation = incident?.reservation || null;
  const trip = incident?.trip || null;
  const guest = incident?.guestCustomer || trip?.guestCustomer || null;
  const host = trip?.hostProfile || null;
  const listingVehicle = trip?.listing?.vehicle || null;
  return [
    ['Subject Type', incident?.subjectType || '-'],
    ['Reservation Number', reservation?.reservationNumber || '-'],
    ['Reservation Status', reservation?.status || '-'],
    ['Pickup At', formatDateTime(reservation?.pickupAt || trip?.scheduledPickupAt)],
    ['Return At', formatDateTime(reservation?.returnAt || trip?.scheduledReturnAt)],
    ['Pickup Location', reservation?.pickupLocation?.name || trip?.listing?.location?.name || '-'],
    ['Return Location', reservation?.returnLocation?.name || '-'],
    ['Trip Code', trip?.tripCode || '-'],
    ['Trip Status', trip?.status || '-'],
    ['Guest', guest ? [guest.firstName, guest.lastName].filter(Boolean).join(' ') || guest.email || '-' : '-'],
    ['Guest Email', guest?.email || '-'],
    ['Host', host?.displayName || '-'],
    ['Vehicle', listingVehicle ? [listingVehicle.year, listingVehicle.make, listingVehicle.model].filter(Boolean).join(' ') : '-']
  ];
}

function renderKeyValueGrid(rows = []) {
  return `
    <div class="kv-grid">
      ${rows.map(([label, value]) => `
        <div class="kv-row">
          <div class="kv-label">${escapeHtml(label)}</div>
          <div class="kv-value">${escapeHtml(value)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderChecklist(checklist = null) {
  if (!checklist) {
    return '<p class="empty">No evidence checklist has been generated for this claim yet.</p>';
  }
  const items = Array.isArray(checklist.items) ? checklist.items : [];
  return `
    <div class="pill-row">
      <span class="pill">${escapeHtml(checklist.status || '-')}</span>
      <span class="pill">${escapeHtml(`${checklist.completionPct ?? 0}% complete`)}</span>
    </div>
    <p>${escapeHtml(checklist.summary || '-')}</p>
    <div class="checklist">
      ${items.map((item) => `
        <div class="check-item ${item.complete ? 'good' : 'warn'}">
          <strong>${escapeHtml(item.label || 'Checklist Item')}</strong>
          <div>${escapeHtml(item.complete ? 'COMPLETE' : 'MISSING')}</div>
          <div class="muted">${escapeHtml(item.detail || '-')}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderEvidenceCapture(evidenceCapture = null) {
  if (!evidenceCapture) {
    return '<p class="empty">No evidence capture summary has been generated for this claim yet.</p>';
  }
  const slots = Array.isArray(evidenceCapture.slots) ? evidenceCapture.slots : [];
  return `
    <div class="pill-row">
      <span class="pill">${escapeHtml(evidenceCapture.status || '-')}</span>
      <span class="pill">${escapeHtml(`${evidenceCapture.completionPct ?? 0}% complete`)}</span>
    </div>
    <p>${escapeHtml(evidenceCapture.summary || '-')}</p>
    <div class="checklist">
      ${slots.map((entry) => `
        <div class="check-item ${entry.ready ? 'good' : 'warn'}">
          <strong>${escapeHtml(entry.label || 'Evidence Slot')}</strong>
          <div>${escapeHtml(entry.status || (entry.ready ? 'READY' : 'MISSING'))}</div>
          <div class="muted">${escapeHtml(entry.guidance || '-')}</div>
          <div class="muted">Sources: ${escapeHtml(Array.isArray(entry.sourceLabels) && entry.sourceLabels.length ? entry.sourceLabels.join(' | ') : '-')}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderInspectionCompare(compare = null) {
  if (!compare) {
    return '<p class="empty">No inspection compare summary is attached to this claim yet.</p>';
  }
  const changed = (Array.isArray(compare.changes) ? compare.changes : []).filter((entry) => entry.changed);
  return `
    <div class="pill-row">
      <span class="pill">${escapeHtml(compare.status || '-')}</span>
      <span class="pill">${escapeHtml(`${compare.changedCount ?? 0} changed field(s)`)}</span>
    </div>
    <p>${escapeHtml(compare.summary || '-')}</p>
    <div class="kv-grid">
      <div class="kv-row"><div class="kv-label">Checkout Photos</div><div class="kv-value">${escapeHtml(compare?.photoCoverage?.checkout ?? 0)}</div></div>
      <div class="kv-row"><div class="kv-label">Check-In Photos</div><div class="kv-value">${escapeHtml(compare?.photoCoverage?.checkin ?? 0)}</div></div>
      <div class="kv-row"><div class="kv-label">Comparable Photos</div><div class="kv-value">${escapeHtml(compare?.photoCoverage?.common ?? 0)}</div></div>
      <div class="kv-row"><div class="kv-label">Inspection Report</div><div class="kv-value">${compare?.links?.inspectionReportHref ? `<a href="${escapeHtml(compare.links.inspectionReportHref)}">${escapeHtml(compare.links.inspectionReportHref)}</a>` : '-'}</div></div>
    </div>
    ${changed.length ? `
      <div class="checklist">
        ${changed.map((entry) => `
          <div class="check-item warn">
            <strong>${escapeHtml(entry.label || 'Field')}</strong>
            <div class="muted">${escapeHtml(`${entry.before} -> ${entry.after}`)}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderOperationalContext(operationalContext = null) {
  if (!operationalContext) {
    return '<p class="empty">No connected operational context is attached to this claim yet.</p>';
  }
  const turnReady = operationalContext.turnReady || null;
  const inspection = operationalContext.inspection || null;
  const telematics = operationalContext.telematics || null;
  const rows = [
    ['Vehicle', summarizeVehicle(operationalContext.vehicle || null)],
    ['Swap Count', operationalContext.swapCount ?? 0],
    ['Turn-Ready Status', turnReady?.status || '-'],
    ['Turn-Ready Score', turnReady?.score ?? '-'],
    ['Turn-Ready Summary', turnReady?.summary || '-'],
    ['Inspection Status', inspection?.status || '-'],
    ['Inspection Summary', inspection?.summary || '-'],
    ['Damage Severity', inspection?.damageTriage?.severity || 'NONE'],
    ['Damage Confidence', inspection?.damageTriage?.confidence || '-'],
    ['Damage Action', inspection?.damageTriage?.recommendedAction || '-'],
    ['Telematics Status', telematics?.status || '-'],
    ['Telematics Summary', telematics?.summary || '-'],
    ['Fuel Status', telematics?.fuelStatus || '-'],
    ['GPS Status', telematics?.gpsStatus || '-'],
    ['Odometer Status', telematics?.odometerStatus || '-']
  ];
  const notes = [
    ...(Array.isArray(turnReady?.blockers) ? turnReady.blockers : []),
    ...(Array.isArray(telematics?.alerts) ? telematics.alerts : [])
  ];
  return `
    ${renderKeyValueGrid(rows)}
    ${notes.length ? `
      <div class="note-list">
        ${notes.map((entry) => `<div class="note-item">${escapeHtml(entry)}</div>`).join('')}
      </div>
    ` : ''}
  `;
}

function renderEvidenceSummary(incident) {
  const evidence = sanitizeInlineData(safeParse(incident?.evidenceJson) || {});
  const hasEvidence = evidence && typeof evidence === 'object' && Object.keys(evidence).length;
  if (!hasEvidence) {
    return '<p class="empty">No structured evidence captured yet.</p>';
  }
  return `<pre class="code-block">${escapeHtml(JSON.stringify(evidence, null, 2))}</pre>`;
}

function renderCommunications(communications = []) {
  if (!communications.length) {
    return '<p class="empty">No communications logged yet.</p>';
  }
  return communications.map((entry) => {
    const attachments = Array.isArray(entry.attachments)
      ? entry.attachments.map((file = {}, index) => ({
          name: file.name || `Attachment ${index + 1}`,
          mimeType: file.type || file.mimeType || '',
          size: file.size ?? null,
          value: String(file.dataUrl || file.url || file.href || '').startsWith('data:')
            ? '[inline attachment omitted from packet]'
            : String(file.dataUrl || file.url || file.href || '')
        }))
      : [];
    return `
      <div class="timeline-card">
        <div class="row-between">
          <strong>${escapeHtml(entry.subject || `${entry.direction || ''} ${entry.channel || ''}`.trim() || 'Communication')}</strong>
          <span class="muted">${escapeHtml(formatDateTime(entry.createdAt))}</span>
        </div>
        <div class="muted">${escapeHtml([entry.direction, entry.channel, entry.recipientType].filter(Boolean).join(' | ') || '-')}</div>
        <p>${escapeHtml(String(entry.message || '').trim() || '-')}</p>
        ${attachments.length ? `
          <div class="subsection">
            <div class="mini-title">Attachments</div>
            <ul class="list">
              ${attachments.map((file) => `<li>${escapeHtml([file.name, file.mimeType, file.size != null ? `${file.size} bytes` : '', file.value].filter(Boolean).join(' | '))}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderHistory(history = []) {
  const rows = sortHistoryEntriesDesc(history);
  if (!rows.length) {
    return '<p class="empty">No incident history recorded yet.</p>';
  }
  return rows.map((entry) => `
    <div class="timeline-card">
      <div class="row-between">
        <strong>${escapeHtml(entry.eventType || 'EVENT')}</strong>
        <span class="muted">${escapeHtml(formatDateTime(entry.eventAt))}</span>
      </div>
      <div class="muted">${escapeHtml(`${entry.actorType || 'SYSTEM'}${entry.actorRefId ? ` (${entry.actorRefId})` : ''}`)}</div>
      ${entry.notes ? `<p>${escapeHtml(entry.notes)}</p>` : ''}
      ${entry.metadata && typeof entry.metadata === 'object' && Object.keys(entry.metadata).length ? `
        <pre class="code-block">${escapeHtml(JSON.stringify(entry.metadata, null, 2))}</pre>
      ` : ''}
    </div>
  `).join('');
}

export function buildIncidentClaimsPacketHtml(incident) {
  const title = incident?.title || 'Claims Packet';
  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)} - Claims Packet</title>
        <style>
          :root {
            color-scheme: light;
            --ink: #1e1633;
            --muted: #6d6485;
            --line: #ddd5ea;
            --panel: #ffffff;
            --panel-alt: #f7f3fc;
            --accent: #2e8b57;
            --warn: #b26a00;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: "Inter", "Segoe UI", sans-serif;
            color: var(--ink);
            background: #f3eef9;
          }
          .page {
            max-width: 980px;
            margin: 0 auto;
            padding: 28px;
          }
          .hero, .section {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 20px;
            padding: 20px 22px;
            margin-bottom: 18px;
          }
          .hero h1, .section h2 {
            margin: 0 0 10px;
          }
          .hero h1 { font-size: 28px; }
          .muted { color: var(--muted); }
          .pill-row {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin: 10px 0 14px;
          }
          .pill {
            border: 1px solid var(--line);
            background: var(--panel-alt);
            border-radius: 999px;
            padding: 6px 10px;
            font-size: 12px;
            font-weight: 700;
          }
          .kv-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
          }
          .kv-row {
            border: 1px solid var(--line);
            background: var(--panel-alt);
            border-radius: 14px;
            padding: 10px 12px;
          }
          .kv-label {
            color: var(--muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            margin-bottom: 6px;
          }
          .kv-value {
            white-space: pre-wrap;
            word-break: break-word;
          }
          .checklist, .note-list {
            display: grid;
            gap: 10px;
            margin-top: 12px;
          }
          .check-item, .note-item, .timeline-card {
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 12px 14px;
            background: var(--panel-alt);
          }
          .check-item.good { border-color: rgba(46, 139, 87, 0.35); }
          .check-item.warn { border-color: rgba(178, 106, 0, 0.35); }
          .code-block {
            background: #1f1830;
            color: #f7f3ff;
            border-radius: 14px;
            padding: 14px;
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-word;
          }
          .row-between {
            display: flex;
            justify-content: space-between;
            align-items: start;
            gap: 12px;
          }
          .mini-title {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--muted);
            margin-bottom: 8px;
          }
          .list {
            margin: 0;
            padding-left: 18px;
          }
          .empty {
            color: var(--muted);
            margin: 0;
          }
          @media print {
            body { background: #fff; }
            .page { max-width: none; padding: 0; }
            .hero, .section {
              border-radius: 0;
              border-left: 0;
              border-right: 0;
              break-inside: avoid;
            }
          }
        </style>
      </head>
      <body>
        <main class="page">
          <section class="hero">
            <div class="row-between">
              <div>
                <h1>Ride Fleet Claims Packet</h1>
                <div class="muted">Generated at ${escapeHtml(formatDateTime(new Date()))}</div>
              </div>
              <div class="pill-row">
                <span class="pill">${escapeHtml(incident?.status || '-')}</span>
                <span class="pill">${escapeHtml(incident?.type || '-')}</span>
                <span class="pill">${escapeHtml(incident?.priority || '-')}</span>
              </div>
            </div>
            <p>${escapeHtml(incident?.title || '-')}</p>
          </section>

          <section class="section">
            <h2>Case Summary</h2>
            ${renderKeyValueGrid(buildSummaryRows(incident))}
          </section>

          <section class="section">
            <h2>Reservation And Trip Context</h2>
            ${renderKeyValueGrid(buildContextRows(incident))}
          </section>

          <section class="section">
            <h2>Connected Ops Context</h2>
            ${renderOperationalContext(incident?.operationalContext || null)}
          </section>

          <section class="section">
            <h2>Evidence Checklist</h2>
            ${renderChecklist(incident?.evidenceChecklist || null)}
          </section>

          <section class="section">
            <h2>Evidence Capture</h2>
            ${renderEvidenceCapture(incident?.evidenceCapture || null)}
          </section>

          <section class="section">
            <h2>Inspection Compare</h2>
            ${renderInspectionCompare(incident?.inspectionCompare || null)}
          </section>

          <section class="section">
            <h2>Evidence Summary</h2>
            ${renderEvidenceSummary(incident)}
          </section>

          <section class="section">
            <h2>Communications</h2>
            ${renderCommunications(incident?.communications || [])}
          </section>

          <section class="section">
            <h2>Incident History</h2>
            ${renderHistory(incident?.history || [])}
          </section>
        </main>
      </body>
    </html>
  `;
  return {
    filename: packetFilename(incident),
    contentType: 'text/html; charset=utf-8',
    body: html
  };
}
