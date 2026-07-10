#!/usr/bin/env node
/**
 * NU Car Rentals (portal de afiliados) — PoC de login autónomo  ·  Fase 0.
 *   Portal: https://affiliates.nucarrentals.com/AffiliateLOGIN.aspx  (ASP.NET WebForms)
 *
 * OBJETIVO: confirmar que un login server-side (Login ID + password) funciona DESDE EL
 * DROPLET (IP de NYC), obtiene una sesión válida (cookie de forms-auth), y reportar la
 * estructura de la página autenticada para ubicar dónde viven las reservas — es decir, que
 * NU puede correr AUTÓNOMO como Economy (a diferencia de TL que amarra la cookie al IP).
 *
 * WebForms vs MVC: a diferencia de Economy (RezLight MVC + __RequestVerificationToken),
 * ASP.NET WebForms exige RE-POSTEAR los hidden con su VALOR real (__VIEWSTATE,
 * __VIEWSTATEGENERATOR, __EVENTVALIDATION) + el name/value del botón de submit. Este PoC
 * captura TODOS los hidden con valor y los reenvía.
 *
 * SEGURIDAD / PRIVACIDAD:
 *   - Credenciales SOLO desde variables de entorno (nunca hardcodeadas, nunca impresas).
 *   - NO imprime password, cookies, tokens, __VIEWSTATE ni datos personales de clientes.
 *     Solo reporta: éxito/fallo por paso, NOMBRES de campos (estructura), y counts.
 *   - Correr SOLO en el droplet (para probar autonomía desde ese IP).
 *
 * USO (en el droplet):
 *   export NU_USER='loginid'
 *   export NU_PASS='password'
 *   # opcional si el login vive en otra ruta:
 *   export NU_LOGIN_URL='https://affiliates.nucarrentals.com/AffiliateLOGIN.aspx'
 *   node ops/nu-poc/login-poc.mjs
 *
 * Requiere Node 18+ (fetch nativo). Pega la salida completa aquí — no lleva secretos.
 */

const LOGIN_URL = (process.env.NU_LOGIN_URL || 'https://affiliates.nucarrentals.com/AffiliateLOGIN.aspx').trim();
const ORIGIN = new URL(LOGIN_URL).origin;
const USER = process.env.NU_USER || '';
const PASS = process.env.NU_PASS || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

if (!USER || !PASS) {
  console.error('FALTAN credenciales: export NU_USER y NU_PASS antes de correr.');
  process.exit(2);
}

// ---- cookie jar mínimo (name=value; …) ---------------------------------------
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
function cookieNames() { return Array.from(jar.keys()); }
function abs(url) { return url.startsWith('http') ? url : ORIGIN + (url.startsWith('/') ? url : '/' + url); }

// ---- parseo del <form> de WebForms -------------------------------------------
function parseForm(html) {
  const form = (html.match(/<form[\s\S]*?<\/form>/i) || [''])[0];
  const action = (form.match(/action=["']([^"']*)["']/i) || [, ''])[1];
  // todos los <input ...> con name + value (value puede faltar en visibles)
  const inputs = [];
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name=["']([^"']*)["']/i) || [, ''])[1];
    if (!name) continue;
    const type = (tag.match(/type=["']([^"']*)["']/i) || [, 'text'])[1].toLowerCase();
    const value = (tag.match(/value=["']([\s\S]*?)["']/i) || [, ''])[1];
    inputs.push({ name, type, value });
  }
  return { action, inputs };
}

async function main() {
  const report = { loginUrl: LOGIN_URL, steps: {} };

  // 1) GET login page
  const r1 = await fetch(LOGIN_URL, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  absorb(r1);
  const loginHtml = await r1.text();
  const { action, inputs } = parseForm(loginHtml);
  const names = inputs.map(i => i.name);
  const hiddenNames = inputs.filter(i => i.type === 'hidden').map(i => i.name);
  const submit = inputs.find(i => i.type === 'submit' || i.type === 'image');
  report.steps.getLogin = {
    status: r1.status,
    cookiesSoFar: cookieNames(),
    formAction: action || '(self)',
    inputNames: names,
    hiddenFields: hiddenNames,
    hasViewState: hiddenNames.some(n => /__VIEWSTATE$/i.test(n)),
    hasEventValidation: hiddenNames.some(n => /__EVENTVALIDATION/i.test(n)),
    submitButton: submit ? submit.name : null,
  };

  // Campos confirmados en el recon 2026-07-09 (Telerik WebForms):
  //   usuario = txtLoginID · password = txtPSWD · submit = Button1
  // Overridable por ENV por si cambian. La heurística vieja fallaba porque
  // "RadScriptManagerLogin_TSM" contiene "Login" y ningún campo contiene "pass".
  const uName = process.env.NU_USER_FIELD
    || (names.includes('txtLoginID') ? 'txtLoginID'
        : names.find(n => /^txt.*(login|user|affil)/i.test(n)) || 'txtLoginID');
  const pName = process.env.NU_PASS_FIELD
    || (names.includes('txtPSWD') ? 'txtPSWD'
        : names.find(n => /^txt.*(pswd|pass|pwd)/i.test(n)) || 'txtPSWD');
  const cookiesBefore = new Set(cookieNames());

  // 2) POST credenciales — reenviar TODOS los hidden con su valor real (WebForms)
  const body = new URLSearchParams();
  for (const i of inputs) {
    if (i.type === 'submit' || i.type === 'image') continue; // el botón se añade abajo
    body.set(i.name, i.value || '');
  }
  body.set(uName, USER);
  body.set(pName, PASS);
  // Telerik RadTextBox lee el valor del hidden *_ClientState (JSON), NO del input plano.
  // El GET trae el ClientState vacío → el server ve "LoginID Is Required". Hay que
  // embeber el valor en el ClientState de cada campo.
  const radClientState = (v) => JSON.stringify({
    enabled: true, emptyMessage: '', validationText: v, valueAsString: v, lastSetTextBoxValue: v,
  });
  if (names.includes(uName + '_ClientState')) body.set(uName + '_ClientState', radClientState(USER));
  if (names.includes(pName + '_ClientState')) body.set(pName + '_ClientState', radClientState(PASS));
  if (submit && submit.name) body.set(submit.name, submit.value || 'Submit');

  const actionUrl = action ? abs(action.replace(/^\.\//, '/')) : LOGIN_URL;
  const r2 = await fetch(actionUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA, cookie: cookieHeader(),
      'content-type': 'application/x-www-form-urlencoded',
      'origin': ORIGIN, 'referer': LOGIN_URL,
    },
    body: body.toString(), redirect: 'manual',
  });
  absorb(r2);
  const r2loc = r2.headers.get('location') || '';
  const bouncedToLogin = /login/i.test(r2loc);
  const newCookies = cookieNames().filter(n => !cookiesBefore.has(n));
  const postBody = await r2.text();
  // ¿POR QUÉ no autenticó? Diagnóstico del cuerpo del POST:
  const stillLoginForm = /txtPSWD|txtLoginID/i.test(postBody);
  // texto de error visible (label rojo / ValidationSummary / RadWindow alert / palabra clave)
  let errorText = null;
  const errM = postBody.match(/<span[^>]*id=["'][^"']*(?:lbl|msg|err|Valid)[^"']*["'][^>]*>([\s\S]{1,180}?)<\/span>/i)
    || postBody.match(/(invalid|incorrect|failed|not\s+valid|denied|locked|disabled|wrong|no\s+existe|inv[aá]lid)[^<]{0,120}/i);
  if (errM) errorText = String(errM[1] || errM[0]).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  // redirect por JS o meta refresh (algunas apps redirigen client-side tras login)
  const cr = postBody.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i)
    || postBody.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*url=([^"'>\s]+)/i);
  const clientRedirect = cr ? cr[1] : null;
  report.steps.postLogin = {
    status: r2.status,
    redirectedTo: r2loc ? r2loc.replace(ORIGIN, '') : null,
    cookiesAfter: cookieNames(),
    newCookiesAfterLogin: newCookies,
    usedUserField: uName, usedPassField: pName,
    submitSent: submit ? { name: submit.name, value: submit.value || '(default Login)' } : null,
    gotAuthCookie: cookieNames().some(n => /aspxauth|auth|affil/i.test(n))
      || newCookies.some(n => !/^ASP\.NET_SessionId$/i.test(n)),
    stillShowsLoginForm: stillLoginForm,
    errorTextSeen: errorText,
    clientRedirect,
    bodyLength: postBody.length,
  };

  // 3) landing: la sesión ya está autenticada (auth por ASP.NET_SessionId, NO forms-cookie).
  // Seguir la cadena de redirects hasta la primera página 200 y escanear su estructura.
  const firstUrl = r2loc ? abs(r2loc) : (clientRedirect ? abs(clientRedirect) : null);
  let landingHtml = postBody, r3status = r2.status, r3url = actionUrl;
  const redirectChain = [];
  let cur = firstUrl, hops = 0;
  while (cur && hops < 6) {
    const rr = await fetch(cur, { headers: { 'User-Agent': UA, cookie: cookieHeader() }, redirect: 'manual' });
    absorb(rr);
    redirectChain.push({ url: cur.replace(ORIGIN, ''), status: rr.status });
    if (rr.status >= 300 && rr.status < 400 && rr.headers.get('location')) {
      cur = abs(rr.headers.get('location')); hops++; continue;
    }
    r3status = rr.status; r3url = cur;
    landingHtml = rr.status < 400 ? await rr.text() : '';
    break;
  }
  const landedOnLogin = /AffiliateLOGIN|txtPSWD|Login ID/i.test(landingHtml) || /login/i.test(String(r3url));
  const links = Array.from(new Set(
    Array.from(landingHtml.matchAll(/href=["']([^"']+\.aspx[^"']*)["']/gi)).map(m => m[1].split('?')[0])
  )).slice(0, 60);
  const forms = Array.from(landingHtml.matchAll(/<form[^>]*action=["']([^"']*)["']/gi)).map(m => m[1]).slice(0, 10);
  // texto de menú/opciones (nombres de secciones — sin PII) para ubicar reservas
  const menuText = Array.from(new Set(
    Array.from(landingHtml.matchAll(/>([^<>]{3,40})<\/a>/gi)).map(m => m[1].trim())
  )).filter(t => /res|book|rental|report|arriv|pickup|voucher|new|list|manage|search/i.test(t)).slice(0, 25);
  report.steps.landing = {
    finalUrl: String(r3url).replace(ORIGIN, ''),
    finalStatus: r3status,
    redirectChain,
    landedOnLogin,
    aspxLinks: links,
    formActions: forms,
    reservationHints: links.filter(l => /res|book|rental|report|arriv|pickup|voucher|affil/i.test(l)),
    reservationMenuText: menuText,
  };

  // 4) recon del portal autenticado (/affiliates.aspx): controles que manejan las reservas.
  // SOLO nombres de controles / columnas / títulos — sin datos de filas (PII).
  function scanControls(html) {
    const form = (html.match(/<form[\s\S]*?<\/form>/i) || [html])[0];
    const inputs = Array.from(form.matchAll(/<input\b[^>]*>/gi)).map(t => ({
      name: (t[0].match(/name=["']([^"']+)["']/i) || [, ''])[1],
      type: (t[0].match(/type=["']([^"']+)["']/i) || [, 'text'])[1].toLowerCase(),
    })).filter(i => i.name && !/^__|_ClientState$|_TSM$/.test(i.name)).slice(0, 40);
    const selects = Array.from(form.matchAll(/<select\b[^>]*name=["']([^"']+)["'][\s\S]*?<\/select>/gi)).map(m => ({
      name: m[1], options: (m[0].match(/<option/gi) || []).length,
    })).slice(0, 20);
    const buttons = Array.from(form.matchAll(/<(?:input[^>]*type=["'](?:submit|button)["'][^>]*|button[^>]*)>/gi)).map(t => ({
      name: (t[0].match(/name=["']([^"']+)["']/i) || [, ''])[1],
      value: (t[0].match(/value=["']([^"']*)["']/i) || [, ''])[1],
    })).filter(b => b.name).slice(0, 20);
    return { inputs, selects, buttons };
  }
  report.steps.portal = {
    pageTitle: (landingHtml.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim(),
    controls: scanControls(landingHtml),
    hasRadGrid: /RadGrid|rgMasterTable|rgClip|GridDataItem/i.test(landingHtml),
    hasRadScheduler: /RadScheduler/i.test(landingHtml),
    usesRadAjax: /RadAjaxManager|RadAjaxPanel|__CALLBACKID|Sys\.WebForms/i.test(landingHtml),
    webServiceHints: Array.from(new Set(
      Array.from(landingHtml.matchAll(/["']([^"']+\.asmx(?:\/[A-Za-z0-9_]+)?)["']/gi)).map(m => m[1])
    )).slice(0, 10),
    iframes: Array.from(landingHtml.matchAll(/<iframe[^>]*src=["']([^"']+)["']/gi)).map(m => m[1]).slice(0, 5),
    tableHeaders: Array.from(new Set(
      Array.from(landingHtml.matchAll(/<th[^>]*>([\s\S]{1,40}?)<\/th>/gi)).map(m => m[1].replace(/<[^>]*>/g, '').trim()).filter(Boolean)
    )).slice(0, 30),
    bodyLen: landingHtml.length,
  };

  // ---- veredicto ----
  // NU autentica por SESIÓN (ASP.NET_SessionId), NO setea forms-cookie. Éxito = el POST
  // redirigió (302) a una página que NO es login, sin error, y la página final carga 200.
  const authOk = report.steps.postLogin.status >= 300 && report.steps.postLogin.status < 400
    && !bouncedToLogin && !landedOnLogin && r3status < 400 && !report.steps.postLogin.errorTextSeen;
  report.VERDICT = authOk
    ? 'PASS — login server-side autónomo funciona desde este IP; hay sesión y la página autenticada carga. Próximo: ubicar el endpoint/página de reservas (ver landing.reservationHints).'
    : 'REVISAR — no se confirmó la sesión. Ver getLogin.inputNames (¿nombres de campos distintos?), postLogin.gotAuthCookie y landing.landedOnLogin.';

  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => { console.error('ERROR PoC:', e?.message || e); process.exit(1); });
