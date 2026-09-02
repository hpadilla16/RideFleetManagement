/**
 * checkin-audit-t2.extract — vision-LLM comparison of one checkout↔checkin
 * photo pair into a structured damage verdict. Provider-agnostic; default =
 * Anthropic (Claude vision, the citation-ocr.extract.js precedent, followed
 * line for line). Design: design/mockups/checkin-audit-NOTES.md §2 Tier 2
 * (the pair prompt, "Never invent") + damage-baseline-NOTES.md §D2(a) (the
 * known-damage prompt context, KNOWN_DAMAGE/matchedKnownId verdict).
 *
 * Env:
 *   CHECKIN_AUDIT_T2_PROVIDER=anthropic  (only 'anthropic' implemented today)
 *   CHECKIN_AUDIT_T2_MODEL=claude-haiku-4-5-20251001  (default; per-tenant
 *                                        override in checkinAuditConfig)
 *
 * The CALLER supplies the credential and it is used verbatim — this module
 * has no opinion about where a key comes from and NO access to one of its
 * own. There is deliberately no `|| process.env.ANTHROPIC_API_KEY` anywhere
 * in this file: resolution belongs to
 * settingsService.resolveCitationOcrCredential({...}, {feature:
 * 'checkin-audit'}) and nowhere else (the 2026-08-27 Corpusa lesson,
 * lib/tenant-provider-credential.js).
 *
 * PII posture (citation-ocr.scheduler.js:15 precedent): callers never log
 * verdict JSON or image bytes — counts/ids only.
 */
import logger from '../../lib/logger.js';

const DEFAULT_PROVIDER = (process.env.CHECKIN_AUDIT_T2_PROVIDER || 'anthropic').toLowerCase();
export const DEFAULT_T2_MODEL = process.env.CHECKIN_AUDIT_T2_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export const PAIR_VERDICTS = Object.freeze(['NO_CHANGE', 'POSSIBLE_DAMAGE', 'KNOWN_DAMAGE', 'UNREADABLE']);
const DAMAGE_KINDS = ['scratch', 'dent', 'scuff', 'crack', 'glass', 'missing_part', 'stain', 'other'];

// Rough $/M-token rates for the spend KPI (checkin-audit-NOTES.md §2 cost
// table). An ESTIMATE for the cost-transparency tile, never a bill; unknown
// models estimate at the Haiku rate rather than showing $0 (which would hide
// spend — the one thing the tile exists to show).
const MODEL_RATES = [
  { match: /haiku/i, inPerM: 1, outPerM: 5 },
  { match: /sonnet/i, inPerM: 3, outPerM: 15 },
];

export function estimateCostUsd(model, inputTokens = 0, outputTokens = 0) {
  const rate = MODEL_RATES.find((r) => r.match.test(String(model || ''))) || MODEL_RATES[0];
  const usd = (Number(inputTokens) || 0) * (rate.inPerM / 1e6) + (Number(outputTokens) || 0) * (rate.outPerM / 1e6);
  return Number(usd.toFixed(6));
}

/**
 * The pair prompt (NOTES §2 verbatim shape + the baseline NOTES' known-damage
 * block). `knownDamages` = the vehicle's ACTIVE ledger entries for this
 * angle's view ({ id, description, kind?, sinceDate }); the list ANNOTATES —
 * a match comes back as KNOWN_DAMAGE with matchedKnownIds, it is never a
 * reason to hide anything from the caller.
 */
export function buildPairPrompt({ angle, knownDamages = [] } = {}) {
  const lines = [
    `You are comparing two photos of the SAME vehicle angle (${angle || 'unknown'}): photo 1 was taken at rental checkout (baseline), photo 2 at return (check-in).`,
    'Return ONLY minified JSON, no prose, with this exact shape:',
    '{"verdict":"NO_CHANGE|POSSIBLE_DAMAGE|KNOWN_DAMAGE|UNREADABLE","confidence":0-100,',
    '"description":string|null,"region":{"x":0-1,"y":0-1,"w":0-1,"h":0-1}|null,',
    `"kind":"${DAMAGE_KINDS.join('|')}"|null,"matchedKnownIds":[string]}`,
  ];
  if (knownDamages.length) {
    lines.push('Known pre-existing damage on this vehicle, this view — these are already documented, do NOT report them as new:');
    for (const kd of knownDamages) {
      lines.push(`- [${kd.id}] ${kd.description || kd.kind || 'documented mark'}${kd.sinceDate ? `, on record since ${kd.sinceDate}` : ''}`);
    }
    lines.push('If a mark in photo 2 matches a known entry, return verdict "KNOWN_DAMAGE" with its id(s) in matchedKnownIds.');
  }
  lines.push(
    'Rules: lighting, angle, rain, dirt, water spots, reflections and shadows differ between handheld sessions — do NOT report those as damage.',
    'Report POSSIBLE_DAMAGE only for a mark visible in photo 2 that is neither in photo 1 nor in the known list.',
    'region is photo-2-relative (fractions of width/height) and is a pointer, not a measurement.',
    'If either photo is too poor to compare, verdict UNREADABLE. Never estimate cost. Never invent.',
    'Output ONLY compact minified JSON (no markdown, no commentary).',
  );
  return lines.join('\n');
}

function imageBlock(buffer, contentType) {
  const data = Buffer.from(buffer).toString('base64');
  const ct = String(contentType || '').toLowerCase();
  const media = ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp' : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: media, data } };
}

function parseJsonLoose(text) {
  const t = String(text || '').trim();
  const fenced = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(fenced.slice(start, end + 1));
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v)));

/** Normalize a raw model object into the strict verdict contract. Garbage
 *  degrades to UNREADABLE/nulls — a bad model answer must never throw a
 *  half-processed check-in into FAILED. */
export function normalizeVerdict(obj = {}) {
  const rawVerdict = String(obj?.verdict || '').toUpperCase();
  const verdict = PAIR_VERDICTS.includes(rawVerdict) ? rawVerdict : 'UNREADABLE';
  const confRaw = Number(obj?.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(100, Math.round(confRaw))) : 0;
  let region = null;
  const r = obj?.region;
  if (r && typeof r === 'object' && [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(Number(v)))) {
    region = { x: clamp01(r.x), y: clamp01(r.y), w: clamp01(r.w), h: clamp01(r.h) };
  }
  const kind = DAMAGE_KINDS.includes(String(obj?.kind || '').toLowerCase()) ? String(obj.kind).toLowerCase() : null;
  const matchedKnownIds = Array.isArray(obj?.matchedKnownIds)
    ? obj.matchedKnownIds.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    verdict,
    confidence,
    description: obj?.description ? String(obj.description).trim().slice(0, 500) : null,
    region,
    kind,
    matchedKnownIds,
  };
}

async function analyzeAnthropic({ checkoutBuffer, checkoutContentType, checkinBuffer, checkinContentType, prompt, apiKey, model, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_T2_MODEL,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          imageBlock(checkoutBuffer, checkoutContentType),
          imageBlock(checkinBuffer, checkinContentType),
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const usage = {
    inputTokens: Number(json?.usage?.input_tokens) || 0,
    outputTokens: Number(json?.usage?.output_tokens) || 0,
  };
  let verdict;
  try {
    verdict = normalizeVerdict(parseJsonLoose(text));
  } catch (err) {
    // A model that answered prose instead of JSON: unreadable, not a failure.
    logger.warn('[checkin-audit-t2] model output was not parseable JSON — pair recorded UNREADABLE', {
      message: String(err?.message || err),
    });
    verdict = normalizeVerdict({ verdict: 'UNREADABLE', confidence: 0 });
  }
  return {
    ...verdict,
    usage,
    estimatedCostUsd: estimateCostUsd(model || DEFAULT_T2_MODEL, usage.inputTokens, usage.outputTokens),
  };
}

/**
 * Analyze one checkout↔checkin pair. Throws only on hard provider/config
 * errors (missing key, HTTP failure) so the sweep can mark the scan FAILED;
 * "the model said something odd" degrades to UNREADABLE instead.
 */
export async function analyzePhotoPair({
  checkoutBuffer,
  checkoutContentType,
  checkinBuffer,
  checkinContentType,
  angle,
  knownDamages = [],
  apiKey,
  provider,
  model,
  fetchImpl,
} = {}) {
  if (!checkoutBuffer?.length || !checkinBuffer?.length) throw new Error('empty photo buffer');
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('no photo-AI credential supplied — refusing to call the provider');
  const prov = String(provider || DEFAULT_PROVIDER).toLowerCase();
  const prompt = buildPairPrompt({ angle, knownDamages });
  if (prov === 'anthropic') {
    return analyzeAnthropic({ checkoutBuffer, checkoutContentType, checkinBuffer, checkinContentType, prompt, apiKey: key, model, fetchImpl });
  }
  throw new Error(`unsupported photo-AI provider: ${prov}`);
}

export default { analyzePhotoPair, buildPairPrompt, normalizeVerdict, estimateCostUsd, DEFAULT_T2_MODEL, PAIR_VERDICTS };
