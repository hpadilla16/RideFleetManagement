#!/usr/bin/env node
/**
 * NU Car Rentals (portal de afiliados) — PoC de fetch de lista + parser · Fase 2.
 *   Portal: https://affiliates.nucarrentals.com  (ASP.NET WebForms + Telerik)
 *
 * OBJETIVO: sobre el login ya PROBADO (login-poc.mjs), validar el POSTBACK de
 * rango de fechas en affiliates.aspx (RadDatePicker START/END + su ClientState +
 * RadRadioButtonList1=Rental Date + __EVENTTARGET=btnRefreshGrid) y el PARSER del
 * RadGrid — para que Hector confirme, DESDE EL DROPLET, que la consulta y el
 * parseo funcionan antes del go-live. El ClientState del RadDatePicker puede
 * necesitar UNA pasada de afinación, igual que la afinó el login.
 *
 * PRIVACIDAD: NO imprime NINGÚN PII — ni nombres, ni confirmaciones, ni montos,
 * ni cookies/tokens/viewstate. Solo reporta:
 *   - rowsParsed   (cuántas filas parseó el RadGrid)
 *   - classesSeen  (códigos ACRISS distintos vistos)
 *   - codeCounts   (conteo de PP / OP / blank — para validar la regla isPrepaid)
 *   - parseOk      (si el parser encontró la tabla y ≥0 filas coherentes)
 *
 * USO (en el droplet):
 *   export NU_USER='loginid'
 *   export NU_PASS='password'
 *   node ops/nu-poc/list-fetch-poc.mjs
 *
 * Requiere Node 18+ (fetch nativo). Pega la salida completa aquí — no lleva secretos.
 */

const ORIGIN = (process.env.NU_BASE || 'https://affiliates.nucarrentals.com').replace(/\/$/, '');
const LOGIN_URL = ORIGIN + (process.env.NU_LOGIN_PATH || '/AffiliateLOGIN.aspx');
const RES_URL = ORIGIN + (process.env.NU_RESERVATIONS_PATH || '/affiliates.aspx');
const USER = process.env.NU_USER || '';
const PASS = process.env.NU_PASS || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

if (!USER || !PASS) {
  console.error('FALTAN credenciales: export NU_USER y NU_PASS antes de correr.');
  process.exit(2);
}

// ---- cookie jar mínimo -------------------------------------------------------
const jar = new Map();
function absorb(res) {
  let cookies = [];
  try { cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []; } catch {}
  if (!cookies.length) { const sc = res.headers.get('set-cookie'); if (sc) cookies = [sc]; }
  for (const c of cookies) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader() { return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; '); }
function abs(url) { return url.startsWith('http') ? url : ORIGIN + (url.startsWith('/') ? url : '/' + url); }

// ---- WebForms form parse (all hidden+visible inputs con valor) ---------------
function parseForm(html) {
  const form = (String(html).match(/<form[\s\S]*?<\/form>/i) || [''])[0];
  const action = (form.match(/action=["']([^"']*)["']/i) || [, ''])[1];
  const fields = {};
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name=["']([^"']*)["']/i) || [, ''])[1];
    if (!name) continue;
    const type = (tag.match(/type=["']([^"']*)["']/i) || [, 'text'])[1].toLowerCase();
    const value = (tag.match(/value=["']([\s\S]*?)["']/i) || [, ''])[1];
    if (!(name in fields)) fields[name] = { value, type };
  }
  return { action, fields };
}

const pad2 = (n) => String(n).padStart(2, '0');

// RadTextBox (login) ClientState: el RadTextBox lee su valor de aquí, no del
// input plano. Mismo truco que login-poc.mjs para txtLoginID / txtPSWD.
function radClientState(v) {
  return JSON.stringify({
    enabled: true, emptyMessage: '', validationText: v, valueAsString: v, lastSetTextBoxValue: v,
  });
}

// Full coordinated RadDatePicker override set (mirror backend
// nu.service.radDatePickerOverrides). The server reads the
// *_dateInput_ClientState blob — setting only $dateInput returns 0 rows.
function radDatePickerOverrides(pickerId, d) {
  const Y = d.getFullYear(), M = d.getMonth() + 1, D = d.getDate();
  const iso = `${Y}-${pad2(M)}-${pad2(D)}`;
  const display = `${pad2(M)}/${D}/${Y}`;
  const stamped = `${iso}-00-00-00`;
  const clientState = JSON.stringify({
    enabled: true, emptyMessage: '', validationText: stamped, valueAsString: stamped,
    minDateStr: '1980-01-01-00-00-00', maxDateStr: '2099-12-31-00-00-00', lastSetTextBoxValue: display,
  });
  const calendarAd = JSON.stringify([[1980, 1, 1], [2099, 12, 30], [Y, M, D]]);
  return [
    { suffix: `$${pickerId}$dateInput`, value: display },
    { suffix: `${pickerId}_dateInput_ClientState`, value: clientState },
    { suffix: `${pickerId}_calendar_AD`, value: calendarAd },
    { suffix: `${pickerId}_calendar_SD`, value: '[]' },
    { suffix: `$${pickerId}`, value: iso },
  ];
}
function isoOf(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

// ---- RadGrid parser (misma lógica que backend nu.service.parseRadGrid) -------
function cellText(raw) {
  return String(raw || '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}
// Header-anchor drift check (mirror backend HEADER_ANCHORS / parseRadGrid FIX A):
// verify the money/prepaid-critical columns sit where the positional mapping
// expects. Returns { ok, headerFound, mismatches } — a shifted header means the
// grid layout DRIFTED (importing would corrupt Total / isPrepaid).
const HEADER_ANCHORS = { 2: 'Confirmation', 13: 'Class', 14: 'Status', 15: 'Total', 16: 'Code' };
function headerAnchorCheck(html) {
  const s = String(html || '');
  let scope = s;
  const byClass = s.match(/<table[^>]*class=["'][^"']*rgMasterTable[^"']*["'][\s\S]*?<\/table>/i);
  const byId = s.match(/<table[^>]*id=["'][^"']*RadGrid1[^"']*["'][\s\S]*?<\/table>/i);
  if (byClass) scope = byClass[0]; else if (byId) scope = byId[0];
  let inner = (scope.match(/<tr\b[^>]*class=["'][^"']*\brgHeader\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/i) || [])[1];
  if (inner == null) {
    for (const m of scope.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) { if (/<th\b/i.test(m[1])) { inner = m[1]; break; } }
  }
  if (inner == null) return { ok: null, headerFound: false, mismatches: [] };
  const cells = [];
  for (const m of inner.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)) cells.push(cellText(m[1]));
  const mismatches = Object.entries(HEADER_ANCHORS)
    .filter(([i, label]) => !(cells[Number(i)] || '').toLowerCase().includes(label.toLowerCase()))
    .map(([i, label]) => ({ idx: Number(i), expected: label, got: cells[Number(i)] ?? null }));
  return { ok: mismatches.length === 0, headerFound: true, mismatches };
}
// Telerik pager total (mirror backend parsePagerInfo): "items 1 to N of TOTAL".
function pagerTotal(html) {
  const s = String(html || '');
  const info = (s.match(/<[^>]*class=["'][^"']*rgInfoPart[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i) || [, ''])[1] || '';
  const t = cellText(info);
  const m = t.match(/\bto\s+[\d,]+\s+of\s+([\d,]+)/i) || t.match(/\bof\s+([\d,]+)\s+items?\b/i) || t.match(/\b([\d,]+)\s+items?\b/i);
  return m ? Number(m[1].replace(/[^0-9]/g, '')) : null;
}
function parseRadGrid(html) {
  const s = String(html || '');
  let scope = s;
  const byClass = s.match(/<table[^>]*class=["'][^"']*rgMasterTable[^"']*["'][\s\S]*?<\/table>/i);
  const byId = s.match(/<table[^>]*id=["'][^"']*RadGrid1[^"']*["'][\s\S]*?<\/table>/i);
  if (byClass) scope = byClass[0]; else if (byId) scope = byId[0];
  const rows = [];
  const rowRe = /<tr\b[^>]*class=["'][^"']*\brg(?:Row|AltRow)\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
  for (const m of scope.matchAll(rowRe)) {
    const cells = [];
    for (const c of m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) cells.push(cellText(c[1]));
    // 20 cells: [0,1] structural; 2 conf; 13 class; 15 total;
    // 16 COMBINED "Code + rate" ("OP 39","PP 40","36" pay-at-dest,"PP 70");
    // 17 ratePlan (SYS…); 18 altConf; 19 phone.
    if (cells.length < 20 || !cells[2]) continue;
    const raw16 = cells[16] || '';
    const codeMatch = raw16.match(/\b(PP|OP)\b/i);
    const code = codeMatch ? codeMatch[1].toUpperCase() : '';   // '' = pay-at-destination
    const rate = (raw16.match(/(\d+)\s*$/) || [])[1] || '';
    rows.push({ acriss: (cells[13] || '').toUpperCase(), code, rate, _cells: cells });
  }
  return rows;
}

async function main() {
  const report = { steps: {} };

  // 1) LOGIN (mecánica probada del login-poc) --------------------------------
  const r1 = await fetch(LOGIN_URL, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  absorb(r1);
  const loginHtml = await r1.text();
  const { action, fields } = parseForm(loginHtml);
  const body = new URLSearchParams();
  for (const [n, meta] of Object.entries(fields)) {
    if (meta.type === 'submit' || meta.type === 'image') continue;
    body.set(n, meta.value || '');
  }
  body.set('txtLoginID', USER);
  body.set('txtPSWD', PASS);
  body.set('txtLoginID_ClientState', radClientState(USER));
  body.set('txtPSWD_ClientState', radClientState(PASS));
  body.set('Button1', fields.Button1?.value || 'Submit');
  const loginAction = action ? abs(action.replace(/^\.\//, '/')) : LOGIN_URL;
  const r2 = await fetch(loginAction, {
    method: 'POST',
    headers: { 'User-Agent': UA, cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, referer: LOGIN_URL },
    body: body.toString(), redirect: 'manual',
  });
  absorb(r2);
  await r2.text().catch(() => {});
  const loc = r2.headers.get('location') || '';
  report.steps.login = {
    status: r2.status,
    redirectedTo: loc ? loc.replace(ORIGIN, '') : null,
    hasSession: jar.has('ASP.NET_SessionId'),
    bounced: /AffiliateLOGIN|login/i.test(loc),
  };
  // seguir la cadena hasta 200
  let cur = loc ? abs(loc) : null, hops = 0;
  while (cur && hops < 6) {
    const rr = await fetch(cur, { headers: { 'User-Agent': UA, cookie: cookieHeader() }, redirect: 'manual' });
    absorb(rr);
    if (rr.status >= 300 && rr.status < 400 && rr.headers.get('location')) { cur = abs(rr.headers.get('location')); hops++; continue; }
    await rr.text().catch(() => {});
    break;
  }

  // 2) GET affiliates.aspx (viewstate fresco) --------------------------------
  const rg = await fetch(RES_URL, { headers: { 'User-Agent': UA, cookie: cookieHeader() }, redirect: 'manual' });
  absorb(rg);
  const resHtml = rg.status < 400 ? await rg.text() : '';
  const bouncedRes = /AffiliateLOGIN\.aspx|name=["']txtPSWD["']/i.test(resHtml);
  const { action: resAction, fields: resFields } = parseForm(resHtml);
  report.steps.reservationsPage = {
    status: rg.status,
    bouncedToLogin: bouncedRes,
    hasRadGrid: /RadGrid1|rgMasterTable/i.test(resHtml),
    hiddenFieldCount: Object.keys(resFields).length,
  };

  // 3) POSTBACK de rango de fechas (hoy .. +30) ------------------------------
  //    Preserva TODOS los hidden scrapeados (incl. RadRadioButtonList1 =
  //    "Rental Date" por defecto), sobrescribe SOLO los campos coordinados de
  //    los RadDatePicker START/END por SUFIJO de nombre, y dispara btnRefreshGrid.
  const PREFIX = 'ctl00$ContentPlaceHolder1$';
  const now = new Date();
  const startDate = now;
  const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const from = isoOf(startDate);
  const to = isoOf(endDate);
  const overrideRules = [
    ...radDatePickerOverrides('RadDatePickerSTART', startDate),
    ...radDatePickerOverrides('RadDatePickerEND', endDate),
  ];
  const pb = new URLSearchParams();
  for (const [n, meta] of Object.entries(resFields)) {
    if (meta.type === 'submit' || meta.type === 'image') continue;
    const rule = overrideRules.find((r) => n.endsWith(r.suffix));
    pb.set(n, rule ? rule.value : (meta.value || ''));
  }
  pb.set('__EVENTTARGET', `${PREFIX}btnRefreshGrid`);
  pb.set('__EVENTARGUMENT', '');
  const pbAction = resAction ? abs(resAction.replace(/^\.\//, '/')) : RES_URL;
  const rp = await fetch(pbAction, {
    method: 'POST',
    headers: { 'User-Agent': UA, cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, referer: RES_URL },
    body: pb.toString(), redirect: 'manual',
  });
  absorb(rp);
  const gridHtml = rp.status < 400 ? await rp.text() : '';
  const bouncedPb = /AffiliateLOGIN\.aspx|name=["']txtPSWD["']/i.test(gridHtml);

  // 4) PARSE + reporte agregado (SIN PII) ------------------------------------
  const rows = parseRadGrid(gridHtml);
  const classesSeen = Array.from(new Set(rows.map((r) => r.acriss).filter(Boolean))).sort();
  const codeCounts = { PP: 0, OP: 0, blank: 0, other: 0 };
  for (const r of rows) {
    const c = (r.code || '').toUpperCase();
    if (c === 'PP') codeCounts.PP++;
    else if (c === 'OP') codeCounts.OP++;
    else if (c === '') codeCounts.blank++;
    else codeCounts.other++;
  }
  // Alignment sanity (SOLO la 1ª fila, SIN PII): confirma que las columnas
  // caen donde el parser las espera — conf en idx2 (…-NU), ACRISS en idx13
  // (4 letras), dinero en idx15 (\d+.\d\d) — sin filtrar ningún dato.
  const c0 = rows[0]?._cells || [];
  const alignment = {
    confAtIdx2: /-NU$/.test((c0[2] || '').trim()),
    classAtIdx13: /^[A-Z]{4}$/.test((c0[13] || '').trim().toUpperCase()),
    moneyAtIdx15: /^\d+\.\d{2}$/.test((c0[15] || '').replace(/[^0-9.]/g, '')),
  };
  // Header-anchor drift + pager-total cross-check (mirror backend FIX A / FIX B).
  const headerCheck = headerAnchorCheck(gridHtml);
  const totalCount = pagerTotal(gridHtml);
  const truncated = totalCount != null && totalCount > rows.length;
  report.steps.dateRangePostback = {
    status: rp.status,
    window: { from, to, dateType: 'Rental Date (preserved default)' },
    bouncedToLogin: bouncedPb,
    foundGrid: /RadGrid1|rgMasterTable/i.test(gridHtml),
    rowsParsed: rows.length,
    classesSeen,
    codeCounts, // PP/OP → prepago; blank → pago a destino
    alignment,  // sanity de alineación de columnas (1ª fila, sin PII)
    headerAnchors: headerCheck, // { ok, headerFound, mismatches } — drift = layout cambió
    totalCount, // total del pager Telerik (null = desconocido)
    truncated,  // total > filas renderizadas → el postback NO trajo todo
    parseOk: /RadGrid1|rgMasterTable/i.test(gridHtml) && !bouncedPb && headerCheck.ok !== false && !truncated,
  };

  report.VERDICT = (report.steps.login.hasSession && !report.steps.login.bounced
    && !bouncedRes && !bouncedPb && report.steps.dateRangePostback.foundGrid)
    ? `PASS — sesión OK, postback de rango de fechas devolvió el RadGrid; parser leyó ${rows.length} fila(s). Revisa codeCounts (PP/OP/blank) para validar isPrepaid.`
    : 'REVISAR — ver steps.login (¿sesión?), reservationsPage.bouncedToLogin, y dateRangePostback (¿el ClientState del RadDatePicker necesita afinación? ¿foundGrid=false?).';

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('ERROR PoC:', e?.message || e); process.exit(1); });
