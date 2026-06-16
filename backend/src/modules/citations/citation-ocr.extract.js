/**
 * citation-ocr.extract — vision-LLM extraction of a mailed/scanned citation
 * notice into structured fields. Provider-agnostic; default = Anthropic (Claude
 * vision, strong on structured documents, native PDF). Swappable via env.
 * Plan: doc/citations-ocr-mail-intake-plan-2026-06-15.md (Fase B).
 *
 * Env:
 *   CITATION_OCR_ENABLED=true        gate (worker no-ops if not 'true')
 *   CITATION_OCR_PROVIDER=anthropic  (only 'anthropic' implemented today)
 *   ANTHROPIC_API_KEY=...            required for anthropic
 *   CITATION_OCR_MODEL=claude-haiku-4-5-20251001  (default; sonnet for harder scans)
 *
 * Returns { citations: [...], confidence } — never throws for "no data"; throws
 * only on a hard provider/config error so the worker can mark the doc FAILED.
 */
import logger from '../../lib/logger.js';

const DEFAULT_PROVIDER = (process.env.CITATION_OCR_PROVIDER || 'anthropic').toLowerCase();
const DEFAULT_MODEL = process.env.CITATION_OCR_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const PROMPT = [
  'You are extracting fields from a US parking/traffic/camera CITATION notice (mailed to a vehicle owner).',
  'Return ONLY a JSON object, no prose, with this exact shape:',
  '{"citations":[{"citationNo":string,"plate":string|null,"plateState":string|null,"agency":string|null,',
  '"violationType":string|null,"issuedAt":string|null,"dueAt":string|null,"amount":number,"fee":number,',
  '"location":string|null,"paymentUrl":string|null,',
  '"paymentFields":[{"label":string,"value":string}],"paymentPhone":string|null}],',
  '"confidence":number}',
  'Rules: a single notice may list multiple citations → one array entry each.',
  'Dates as ISO 8601 (YYYY-MM-DD or full) or null if not clearly printed.',
  'amount = the fine/violation amount (number, no $). fee = any separate admin/late fee, else 0.',
  'plateState = 2-letter US state if shown. confidence = your overall 0-100 confidence in the extraction.',
  'If a field is not clearly present, use null (or 0 for amount/fee). Do not invent values.',
  'paymentUrl = the website printed on the notice to pay/dispute, or null.',
  'paymentFields = the EXACT pieces of info the notice says you need to PAY this citation online,',
  'as label/value pairs copied verbatim (e.g. {"label":"Notice #","value":"877998253"}, {"label":"PIN","value":"4821"},',
  'Account #, Reference #, Web ID, ZIP). Empty array [] if none are printed. paymentPhone = the phone to pay/call, or null.',
  'Output ONLY compact minified JSON (no markdown, no pretty-printing, no commentary).',
].join(' ');

function contentBlockFor(buffer, contentType) {
  const data = Buffer.from(buffer).toString('base64');
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('pdf')) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  const media = ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp' : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: media, data } };
}

function parseJsonLoose(text) {
  const t = String(text || '').trim();
  // Strip ```json fences and grab the first {...} block.
  const fenced = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(fenced.slice(start, end + 1));
}

function normalizeResult(obj) {
  const list = Array.isArray(obj?.citations) ? obj.citations : [];
  const citations = list.map((c) => ({
    citationNo: c.citationNo ? String(c.citationNo).trim() : '',
    plate: c.plate ? String(c.plate).trim() : null,
    plateState: c.plateState ? String(c.plateState).trim().toUpperCase().slice(0, 4) : null,
    agency: c.agency ? String(c.agency).trim() : null,
    violationType: c.violationType ? String(c.violationType).trim() : null,
    issuedAt: c.issuedAt || null,
    dueAt: c.dueAt || null,
    amount: Number.isFinite(Number(c.amount)) ? Number(c.amount) : 0,
    fee: Number.isFinite(Number(c.fee)) ? Number(c.fee) : 0,
    location: c.location ? String(c.location).trim() : null,
    paymentUrl: c.paymentUrl ? String(c.paymentUrl).trim() : null,
    paymentFields: Array.isArray(c.paymentFields)
      ? c.paymentFields
          .filter((x) => x && x.value)
          .map((x) => ({ label: String(x.label || '').trim().slice(0, 48), value: String(x.value || '').trim().slice(0, 96) }))
          .slice(0, 8)
      : [],
    paymentPhone: c.paymentPhone ? String(c.paymentPhone).trim().slice(0, 48) : null,
  })).filter((c) => c.citationNo);
  const confidence = Number.isFinite(Number(obj?.confidence)) ? Number(obj.confidence) : null;
  return { citations, confidence };
}

async function extractAnthropic({ buffer, contentType, apiKey, model }) {
  if (!apiKey) throw new Error('no OCR API key (set the tenant key in Settings or ANTHROPIC_API_KEY)');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [contentBlockFor(buffer, contentType), { type: 'text', text: PROMPT }],
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return normalizeResult(parseJsonLoose(text));
}

/**
 * Extract citation fields from a document buffer. Throws only on hard errors.
 * Credentials/provider/model come from the caller (per-tenant Settings), falling
 * back to env (ANTHROPIC_API_KEY / CITATION_OCR_PROVIDER / CITATION_OCR_MODEL).
 */
export async function extractCitationFields({ buffer, contentType, apiKey, provider, model } = {}) {
  if (!buffer || !buffer.length) throw new Error('empty document buffer');
  const prov = String(provider || DEFAULT_PROVIDER).toLowerCase();
  const key = apiKey || process.env.ANTHROPIC_API_KEY || null;
  if (prov === 'anthropic') return extractAnthropic({ buffer, contentType, apiKey: key, model });
  throw new Error(`unsupported OCR provider: ${prov}`);
}

export default { extractCitationFields };
