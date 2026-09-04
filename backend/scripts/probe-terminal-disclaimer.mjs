/**
 * Probe: can the QD2 show contract text and give us back an ink signature?
 * (2026-09-04, for the US terminal checkout at LAX.)
 *
 *   node scripts/probe-terminal-disclaimer.mjs --tenant "International Rental Corp"
 *   node scripts/probe-terminal-disclaimer.mjs --tenant "..." --step 3
 *   node scripts/probe-terminal-disclaimer.mjs --tenant "..." --no-callback
 *
 *   --step N        run only step N (1–4). Default: all, stopping at the first failure.
 *   --no-callback   drop CallbackInfo from the payload. See "the 2201 trap" below.
 *   --clause KEY    step 4 uses this TC_SECTIONS key instead of the longest one.
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

  const resolved = await resolveTenantTerminalConfig(tenant.id);
  const cfg = toSpinClientConfig(resolved);
  if (NO_CALLBACK) delete cfg.spinCallbackUrl;

  console.log(`\nTenant     ${tenant.name}`);
  console.log(`Terminal   ${maskTpn(resolved.tpn)}  (source: ${resolved.source}${resolved.reason ? ` · ${resolved.reason}` : ''})`);
  console.log(`Callback   ${NO_CALLBACK ? 'OMITTED (--no-callback)' : (resolved.callbackUrl ? 'sent' : 'none configured')}`);
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
      console.log(`\n  ✖ threw: ${e?.message || e}`);
      console.log('    A timeout here means the terminal never answered — check that it woke up.');
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
