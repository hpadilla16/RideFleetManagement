#!/usr/bin/env node
/**
 * Economy (RezLight) — PoC de login autónomo  ·  Fase 0 del plan de integración.
 *   doc/economy-integration-plan-2026-07-05.md
 *
 * OBJETIVO: confirmar que un login server-side (username/password) funciona DESDE EL
 * DROPLET (IP de NYC), obtiene una sesión válida, y que esa sesión puede leer el endpoint
 * JSON de reservas — es decir, que Economy puede correr AUTÓNOMO (a diferencia de TL, que
 * amarra la cookie al IP residencial de PR vía CloudFlare).
 *
 * SEGURIDAD / PRIVACIDAD:
 *   - Las credenciales se leen de VARIABLES DE ENTORNO (nunca hardcodeadas, nunca impresas).
 *   - El script NO imprime password, cookies, tokens ni datos personales de clientes.
 *     Solo reporta: éxito/fallo de cada paso, nombres de campos (estructura), y counts.
 *   - Correr SOLO en el droplet (no en tu Mac) para probar la autonomía desde ese IP.
 *
 * USO (en el droplet):
 *   export ECONOMY_USER='usuario'
 *   export ECONOMY_PASS='password'
 *   # opcional si el login vive en otra ruta que la base:
 *   export ECONOMY_BASE='https://rezlight.economyrentacar.com/Production'
 *   node ops/economy-poc/login-poc.mjs
 *
 * Requiere Node 18+ (usa fetch nativo). Pega la salida completa aquí — no lleva secretos.
 */

const BASE = (process.env.ECONOMY_BASE || 'https://rezlight.economyrentacar.com/Production').replace(/\/$/, '');
const USER = process.env.ECONOMY_USER || '';
const PASS = process.env.ECONOMY_PASS || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

if (!USER || !PASS) {
  console.error('FALTAN credenciales: export ECONOMY_USER y ECONOMY_PASS antes de correr.');
  process.exit(2);
}

// ---- cookie jar mínimo (name=value; …) ---------------------------------------
const jar = new Map();
function absorb(res) {
  // Node fetch expone getSetCookie() (Node 20+) o headers.get('set-cookie')
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
function cookieNames() { return Array.from(jar.keys()); }

function tokenFrom(html) {
  const m = html.match(/name=["']__RequestVerificationToken["']\s+[^>]*value=["']([^"']+)["']/i)
        || html.match(/value=["']([^"']+)["']\s+name=["']__RequestVerificationToken["']/i);
  return m ? m[1] : null;
}
function inspectLoginForm(html) {
  // reportar (sin valores) los names de inputs del primer <form>
  const form = (html.match(/<form[\s\S]*?<\/form>/i) || [''])[0];
  const action = (form.match(/action=["']([^"']*)["']/i) || [,''])[1];
  const names = Array.from(form.matchAll(/<input[^>]*name=["']([^"']+)["']/gi)).map(m => m[1]);
  return { action, inputNames: Array.from(new Set(names)) };
}

async function main() {
  const report = { base: BASE, steps: {} };

  // 1) GET login page
  const r1 = await fetch(BASE + '/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  absorb(r1);
  let loginHtml = await r1.text();
  // seguir un redirect al login si aplica
  if (r1.status >= 300 && r1.status < 400) {
    const loc = r1.headers.get('location');
    if (loc) {
      const url = loc.startsWith('http') ? loc : BASE + (loc.startsWith('/') ? loc : '/' + loc);
      const r1b = await fetch(url, { headers: { 'User-Agent': UA, cookie: cookieHeader() }, redirect: 'manual' });
      absorb(r1b); loginHtml = await r1b.text();
      report.steps.loginRedirect = url.replace(BASE, '');
    }
  }
  const form = inspectLoginForm(loginHtml);
  const token1 = tokenFrom(loginHtml);
  report.steps.getLogin = { status: r1.status, cookiesSoFar: cookieNames(), formAction: form.action, formInputs: form.inputNames, foundAntiForgeryToken: !!token1 };

  // detectar nombres de campos user/pass por heurística
  const uName = form.inputNames.find(n => /user|login|email/i.test(n)) || 'UserName';
  const pName = form.inputNames.find(n => /pass/i.test(n)) || 'Password';

  // 2) POST credenciales
  const body = new URLSearchParams();
  for (const n of form.inputNames) body.set(n, ''); // preservar hidden fields vacíos
  if (token1) body.set('__RequestVerificationToken', token1);
  body.set(uName, USER);
  body.set(pName, PASS);
  const actionUrl = form.action
    ? (form.action.startsWith('http') ? form.action : BASE + (form.action.startsWith('/') ? form.action.replace(/^\/Production/i,'') : '/' + form.action))
    : BASE + '/';
  const r2 = await fetch(actionUrl, {
    method: 'POST',
    headers: { 'User-Agent': UA, cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual'
  });
  absorb(r2);
  const r2loc = r2.headers.get('location') || '';
  const loggedIn = (r2.status === 302 || r2.status === 303) && !/login/i.test(r2loc);
  report.steps.postLogin = { status: r2.status, redirectedTo: r2loc.replace(BASE, '') || null, looksLoggedIn: loggedIn, cookiesAfter: cookieNames(), usedUserField: uName, usedPassField: pName };

  // 3) cargar una página autenticada para refrescar token del data-POST
  const r3 = await fetch(BASE + '/RezAlliance/Reservations', { headers: { 'User-Agent': UA, cookie: cookieHeader() }, redirect: 'manual' });
  absorb(r3);
  const pageHtml = r3.status < 400 ? await r3.text() : '';
  const token2 = tokenFrom(pageHtml) || token1;
  const bouncedToLogin = r3.status >= 300 && /login/i.test(r3.headers.get('location') || '');
  report.steps.authedPage = { status: r3.status, bouncedToLogin, foundTokenForDataPost: !!token2 };

  // 4) POST al endpoint de lista (DataTables). Payload EXACTO capturado del portal
  // (2026-07-05): 3 params — el token, jsonPaginationParameters con las 13 columnas
  // rg*, y el CLAVE pFilter={"docType":"R"} (R=Reservation). Sin pFilter el endpoint
  // devuelve 0 filas — por eso el primer PoC dio recordsTotal:0.
  const COLS = ['rgConfirmation','rgDateBooked','rgClass','rgLocPickup','rgLocDropOff',
    'rgDatePickup','rgDateDropOff','rgRate','rgLastName','rgName','rgEmail','rgIata','rgStatus']
    .map((data) => ({ data, name: '', searchable: true, orderable: false, search: { value: '', regex: false } }));
  const dtParams = JSON.stringify({ draw: 1, columns: COLS, order: [], start: 0, length: 10, search: { value: '', regex: false } });
  const lbody = new URLSearchParams();
  if (token2) lbody.set('__RequestVerificationToken', token2);
  lbody.set('jsonPaginationParameters', dtParams);
  lbody.set('pFilter', JSON.stringify({ docType: 'R' }));
  const r4 = await fetch(BASE + '/RezAlliance/Reservations/GetReservationLookupRecords', {
    method: 'POST',
    headers: { 'User-Agent': UA, cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: lbody.toString(), redirect: 'manual'
  });
  let listShape = { status: r4.status };
  try {
    const t = await r4.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    if (j) {
      listShape.recordsTotal = j.recordsTotal ?? null;
      listShape.recordsFiltered = j.recordsFiltered ?? null;
      const arr = j.data || j.aaData || (Array.isArray(j) ? j : null);
      listShape.rowCount = Array.isArray(arr) ? arr.length : null;
      // SOLO nombres de campos + set de códigos de pickup (área) — sin datos personales
      if (arr && arr.length) {
        listShape.rowFieldNames = Array.isArray(arr[0]) ? ('array[' + arr[0].length + ']') : Object.keys(arr[0]);
        const areas = new Set();
        for (const row of arr) {
          const loc = row.rgLocPickup || (Array.isArray(row) ? row[3] : '');
          if (loc) areas.add(String(loc).slice(0, 3).toUpperCase());
        }
        listShape.pickupAreasSeen = Array.from(areas);
      }
    } else {
      listShape.note = 'respuesta no-JSON (¿login falló o token inválido?)';
      listShape.first120 = t.slice(0, 120).replace(/\s+/g, ' ');
    }
  } catch (e) { listShape.err = String(e); }
  report.steps.listFetch = listShape;

  // ---- veredicto ----
  // La auth se confirma por la cookie .AspNet.ApplicationCookie (RezLight NO hace 302
  // post-login, responde 200) + la página autenticada que no rebota + el endpoint con datos.
  const authOk = jar.has('.AspNet.ApplicationCookie') && !bouncedToLogin && report.steps.authedPage.status === 200;
  const ok = authOk && listShape.status === 200 && listShape.rowFieldNames && (listShape.recordsTotal ?? 0) > 0;
  report.VERDICT = ok
    ? 'PASS — login server-side autónomo funciona desde este IP; la sesión lee el endpoint de reservas.'
    : 'REVISAR — algún paso no cerró; ver los detalles arriba (posible IP-binding, campos de login distintos, o token).';

  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => { console.error('ERROR PoC:', e?.message || e); process.exit(1); });
