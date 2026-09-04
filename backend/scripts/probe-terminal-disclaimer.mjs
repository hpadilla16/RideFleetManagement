/**
 * Probe: can the QD2 show contract text and give us back an ink signature?
 * (2026-09-04, for the US terminal checkout at LAX.)
 *
 *   node scripts/probe-terminal-disclaimer.mjs --tenant "International Rental Corp"
 *   node scripts/probe-terminal-disclaimer.mjs --tenant "..." --step 3
 *   node scripts/probe-terminal-disclaimer.mjs --tenant "..." --no-callback
 *   node scripts/probe-terminal-disclaimer.mjs --tenant "Corpusa" --location LAX
 *
 *   --step N        run only step N (1–4). Default: all, stopping at the first failure.
 *   --no-callback   drop CallbackInfo from the payload. See "the 2201 trap" below.
 *   --clause KEY    step 4 uses this TC_SECTIONS key instead of the longest one.
 *   --location X    which COUNTER to probe — a Location code (LAX) or id. Required
 *                   for a tenant running per-location registers: without it the
 *                   resolver refuses to guess which of five terminals you meant,
 *                   and this probe occupies a real device. Prints the register it
 *                   resolved and why.
 *   --register ID   pin an exact register, for a branch with two counters.
 *
 * NO MONEY. Every call here puts text on a screen and waits for an ink
 * stroke. Nothing is authorized, captured, tokenized or voided. The terminal
 * is occupied while a step runs, so do not do this mid-rental.
 *
 * WHY IT EXISTS
 *
 * Terminal-side contract signing rests on one undemonstrated assumption:
 * that POST /v2/Common/Disclaimer works on OUR terminal, with OUR clause
 * text. The May 2026 attempt used the portal-configured inline disclaimer —
 * a different mechanism — and it never appeared on screen. This endpoint has
 * never been called from RFM.
 *
 * Four questions, four steps, in the order that stops wasting your time
 * soonest:
 *
 *   1  TerminalStatus         Is the terminal reachable at all?    (read-only)
 *   2  Disclaimer, ~60 chars  Does the call work AT ALL?
 *   3  Disclaimer, 250 chars  Does the documented UserChoice cap bind here?
 *   4  Disclaimer, real clause  Do OUR sections fit, and how are they rendered?
 *
 * Step 4 is the one that decides the design. If the text scrolls or
 * paginates, the six full clauses go on the terminal. If it truncates, the
 * terminal shows a short binding summary per clause and the full text stays
 * on the printed and emailed agreement.
 *
 * THE 2201 TRAP
 *
 * spinRequest adds CallbackInfo whenever a callbackUrl is configured. On
 * 2026-05-30 unrecognized fields made the gateway reject a Sale with
 * StatusCode 2201 BEFORE the terminal saw it — nothing on screen, nothing in
 * the portal. If a step fails with 2201 and a blank terminal, re-run it with
 * --no-callback before concluding the endpoint is unsupported.
 */
import { spinClient } from '../src/modules/payment-gateway/spin-client.js';
import { resolveTenantTerminalConfig, toSpinClientConfig, maskTpn } from '../src/modules/payment-gateway/tenant-terminal-config.js';
import { TC_SECTIONS } from '../src/modules/checkout-session/terms-content.js';
import { prisma } from '../src/lib/prisma.js';

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TENANT_NAME = arg('--tenant');
const TENANT_ID = arg('--tenant-id');
const ONLY_STEP = Number(arg('--step', '0')) || 0;
const NO_CALLBACK = process.argv.includes('--no-callback');
const CLAUSE_KEY = arg('--clause');
const LOCATION = arg('--location');
const REGISTER_ID = arg('--register');

const SHORT = 'Test from RideFleet. Please sign to confirm you can see this.';
const MEDIUM = ('This is a 250-character length test for the terminal disclaimer screen. '
  + 'It exists to find out whether the documented UserChoice cap of 250 also binds '
  + 'the Disclaimer text, and how the QD2 lays out a paragraph of this size. Sign.').slice(0, 250);

function longestClause() {
  if (CLAUSE_KEY) {
    const picked = TC_SECTIONS.find((s) => s.key === CLAUSE_KEY);
    if (!picked) throw new Error(`No TC_SECTIONS key "${CLAUSE_KEY}". Have: ${TC_SECTIONS.map((s) => s.key).join(', ')}`);
    return picked;
  }
  return TC_SECTIONS.reduce((a, b) => (b.body.length > a.body.length ? b : a));
}

/** What came back, said plainly. The whole point is the readout. */
function report(label, res) {
  const gr = res?.GeneralResponse || res?.generalResponse || {};
  const sig = res?.Signature || res?.signature || null;
  console.log(`\n  ── ${label}`);
  console.log(`     ResultCode   ${gr.ResultCode ?? '(none)'}`);
  console.log(`     StatusCode   ${gr.StatusCode ?? '(none)'}`);
  console.log(`     Message      ${gr.Message ?? gr.DetailedMessage ?? '(none)'}`);
  if (sig) {
    console.log(`     Signature    YES — ${sig.length} chars of base64 (~${Math.round(sig.length * 0.75 / 1024)} KB PNG)`);
  } else {
    console.log(`     Signature    no`);
  }
  const extra = Object.keys(res || {}).filter((k) => !/^(GeneralResponse|generalResponse|Signature|signature)$/.test(k));
  if (extra.length) console.log(`     Other keys   ${extra.join(', ')}`);
  // The raw body, minus the signature blob which would drown the console.
  const redacted = { ...(res || {}) };
  for (const k of ['Signature', 'signature']) if (redacted[k]) redacted[k] = `<${String(redacted[k]).length} chars>`;
  console.log(`     RAW          ${JSON.stringify(redacted)}`);
  // Approved is ResultCode 0 / StatusCode 0000; anything else is the answer we came for.
  const ok = String(gr.ResultCode ?? '') === '0' && String(gr.StatusCode ?? '') === '0000';
  if (String(gr.StatusCode ?? '') === '2201') {
    console.log('     ⚠ 2201 — the GATEWAY rejected this before the terminal saw it.');
    if (!NO_CALLBACK) console.log('       Nothing appeared on screen? Re-run with --no-callback.');
  }
  return { ok, sig: !!sig };
}

async function main() {
  if (!TENANT_NAME && !TENANT_ID) throw new Error('Pass --tenant "<name>" or --tenant-id <id>.');
  const tenant = await prisma.tenant.findFirst({
    where: TENANT_ID ? { id: TENANT_ID } : { name: TENANT_NAME },
    select: { id: true, name: true },
  });
  if (!tenant) throw new Error(`Tenant not found: ${TENANT_ID || TENANT_NAME}`);

  // --location takes a human-friendly CODE (LAX) or a raw id. Resolve it here,
  // once, and scoped to THIS tenant: a code is only unique within a tenant, and
  // probing another tenant's branch is exactly what this script must not do.
  let location = null;
  if (LOCATION) {
    location = await prisma.location.findFirst({
      where: { tenantId: tenant.id, OR: [{ id: LOCATION }, { code: LOCATION }] },
      select: { id: true, code: true, name: true },
    });
    if (!location) {
      const known = await prisma.location.findMany({
        where: { tenantId: tenant.id }, select: { code: true }, orderBy: { code: 'asc' },
      });
      throw new Error(`No location "${LOCATION}" under ${tenant.name}. Have: ${known.map((l) => l.code).join(', ') || '(none)'}`);
    }
  }

  const resolved = await resolveTenantTerminalConfig(tenant.id, {
    locationId: location?.id || null,
    registerId: REGISTER_ID || null,
  });
  const cfg = toSpinClientConfig(resolved);
  if (NO_CALLBACK) delete cfg.spinCallbackUrl;

  console.log(`\nTenant     ${tenant.name}`);
  console.log(`Location   ${location ? `${location.code} — ${location.name}` : '(none given)'}`);
  // WHICH register answered, and WHY — the whole point of the flag. A blank
  // register with a TENANT source means this tenant is still on the single
  // legacy terminal; a NONE source means nothing would have charged here.
  console.log(`Register   ${resolved.registerId ? `${resolved.registerName || '(unnamed)'} · ${resolved.registerId}` : '(none — single tenant terminal)'}`);
  console.log(`Terminal   ${maskTpn(resolved.tpn)}  (source: ${resolved.source}${resolved.reason ? ` · ${resolved.reason}` : ''})`);
  console.log(`Callback   ${NO_CALLBACK ? 'OMITTED (--no-callback)' : (resolved.callbackUrl ? 'sent' : 'none configured')}`);

  if (resolved.reason === 'NO_REGISTER_FOR_LOCATION') {
    console.log('\n⚠ This tenant runs per-location registers and has NONE for that location.');
    console.log('  A charge here would be refused, and so is this probe — reaching for another');
    console.log('  branch\'s terminal is the failure the registers exist to prevent.');
    console.log('  Add a register for it in Settings → Payment Gateway → Registers.\n');
    return;
  }
  if (resolved.reason === 'AMBIGUOUS_REGISTER_NO_LOCATION') {
    console.log('\n⚠ This tenant has several terminal registers and you did not say which counter.');
    console.log('  Re-run with --location <code> (or --register <id>). This probe occupies a real');
    console.log('  device; picking one for you is not a favour.\n');
    return;
  }

  // Credential SHAPE — lengths and character classes only, never the values.
  // SPIn's own rejection sentence is about shape ("Authkey must be a string
  // with a minimum length of 10 and a maximum length of 10"), so shape is
  // exactly what a diagnostic may show and all it needs to show.
  const shape = (s) => {
    const v = String(s || '');
    if (!v) return 'EMPTY';
    const cls = /^[0-9]+$/.test(v) ? 'digits' : /^[A-Za-z0-9]+$/.test(v) ? 'alphanumeric' : 'mixed/other';
    return `${v.length} chars, ${cls}`;
  };
  const authShape = shape(resolved.authKey);
  const tpnShape = shape(resolved.tpn);
  console.log(`Authkey    ${authShape}${String(resolved.authKey || '').length === 10 ? '' : '   ← SPIn requires EXACTLY 10'}`);
  console.log(`Tpn        ${tpnShape}`);
  if (String(resolved.authKey || '').length !== 10) {
    console.log('\n⚠ The Auth Key is not 10 characters, and SPIn rejects anything else with');
    console.log('  StatusCode 2201 before the terminal is involved. That is a credential');
    console.log('  problem, not a Disclaimer problem — fix it in Settings → Payment Gateway');
    console.log('  → SPIn Terminal (the key is in the iPOSpays portal under the TPN), then');
    console.log('  re-run. The steps below will fail identically until then.\n');
  }
  if (resolved.source !== 'TENANT') {
    console.log('\n⚠ This tenant has no terminal of its own — the probe would use the PLATFORM terminal.');
    console.log('  Refusing: a probe is not worth touching somebody else\'s device.\n');
    return;
  }

  const steps = [
    { n: 1, name: 'TerminalStatus — is it reachable?', run: async () => {
      const res = await spinClient.terminalStatus(cfg);
      console.log(`\n  ── TerminalStatus`);
      console.log(`     Status  ${res?.TerminalStatus ?? '(none)'}`);
      console.log(`     Tpn     ${res?.Tpn ? maskTpn(res.Tpn) : '(none)'}`);
      if (res?.ErrorDescription) console.log(`     Error   ${res.ErrorDescription}`);
      const online = String(res?.TerminalStatus || '').toLowerCase() === 'online';
      if (!online) {
        // ALWAYS show what actually came back. A probe that hides the response
        // when it does not match expectations is worse than no probe: it turns
        // "unexpected shape" and "endpoint down" into the same blank line.
        console.log(`     RAW     ${JSON.stringify(res)}`);
        console.log('\n     ⚠ Not "Online" — but this step does NOT gate the rest.');
        console.log('       TerminalStatus is a convenience endpoint with its own quirks (no');
        console.log('       GeneralResponse, GET with request.* params, and possibly a');
        console.log('       different host — see open question D-1). Disclaimer is what we');
        console.log('       came to test, so the probe continues to step 2 regardless.');
      }
      // Deliberately never fatal.
      return { ok: true, sig: false, soft: !online };
    } },
    { n: 2, name: `Disclaimer, ${SHORT.length} chars — does the call work at all?`, run: async () =>
      report('Disclaimer (short)', await spinClient.disclaimer({ title: SHORT }, cfg)) },
    { n: 3, name: `Disclaimer, ${MEDIUM.length} chars — does the 250 cap bind?`, run: async () =>
      report('Disclaimer (250)', await spinClient.disclaimer({ title: MEDIUM }, cfg)) },
    { n: 4, name: null, run: async () => {
      const clause = longestClause();
      console.log(`     clause "${clause.key}" — ${clause.body.length} chars`);
      return report(`Disclaimer (${clause.key})`, await spinClient.disclaimer({ title: clause.body }, cfg));
    } },
  ];

  for (const step of steps) {
    if (ONLY_STEP && step.n !== ONLY_STEP) continue;
    const clause = step.n === 4 ? longestClause() : null;
    const name = step.name || `Disclaimer, real clause (${clause.body.length} chars) — do OUR sections fit?`;
    console.log(`\n▶ Step ${step.n}: ${name}`);
    if (step.n > 1) console.log('  Look at the terminal now, then sign. Watching for a response…');
    let out;
    try {
      out = await step.run();
    } catch (e) {
      // spinRequest hangs the whole body off the error (err.spinResponse); the
      // Message field is often just "Error" and the DetailedMessage is the
      // sentence that actually names what is wrong. Print both.
      console.log(`\n  ✖ threw: ${e?.message || e}`);
      if (e?.spinStatusCode) console.log(`    StatusCode ${e.spinStatusCode}`);
      const gr = e?.spinResponse?.GeneralResponse;
      if (gr?.DetailedMessage) console.log(`    DETAIL     ${gr.DetailedMessage}`);
      if (e?.spinResponse) console.log(`    RAW        ${JSON.stringify(e.spinResponse)}`);
      if (String(e?.spinStatusCode || '') === '2201') {
        console.log('\n    2201 is the GATEWAY refusing the request — the terminal never saw it,');
        console.log('    so a blank screen here is expected and means nothing about Disclaimer.');
        console.log('    Read the DETAIL line: it names the field it did not like.');
      }
      if (String(e?.spinStatusCode || '') === '2001') {
        console.log('\n    2001 is GOOD NEWS wearing a bad hat: the gateway ACCEPTED the request');
        console.log('    and our credentials, went looking for the terminal, and did not find it.');
        console.log('    Everything from RFM to Dejavoo works. What is left is the device:');
        console.log('      · powered on, on Wi-Fi or data;');
        console.log('      · SPIn enabled for this TPN in "Cloud" mode (portal, S.T.E.A.M);');
        console.log('      · a parameter download (or a restart) so it picks that up and');
        console.log('        registers with the proxy.');
        console.log('    Step 1 will say "Online" when it has. Re-run then.');
      }
      break;
    }
    if (!out.ok) {
      console.log(`\n  ✖ Step ${step.n} did not come back approved. Stopping — later steps would tell you nothing new.`);
      break;
    }
    console.log(`  ✔ Step ${step.n} OK`);
  }

  console.log('\nWhat to write down: did the text APPEAR, was it SCROLLABLE or cut off,');
  console.log('and did signing return an image. Step 4 decides whether the six clauses');
  console.log('go on the terminal whole, or as summaries with the full text on paper.\n');
}

main()
  .catch((e) => { console.error(`\n${e?.message || e}\n`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
