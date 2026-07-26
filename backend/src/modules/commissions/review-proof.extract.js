/**
 * Review-proof photo validation (LAX #5, 2026-07-25). MONEY-adjacent: a
 * VALIDATED verdict counts toward the employee's monthly review tier, which
 * sets their commission percent.
 *
 * Same self-contained Anthropic vision pattern as kiosk-id-ocr.extract.js /
 * citation-ocr.extract.js (no shared client exists — third copy by
 * convention). FAIL-CLOSED like the OCR paths: no key → the caller 503s,
 * provider error → the proof stays PENDING_AI for manual review; a failure
 * never auto-VALIDATES.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.REVIEW_PROOF_MODEL
  || process.env.CITATION_OCR_MODEL
  || 'claude-haiku-4-5-20251001';

function imageBlock(buffer, contentType) {
  const data = Buffer.from(buffer).toString('base64');
  const ct = String(contentType || '').toLowerCase();
  const media = ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp' : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: media, data } };
}

function buildPrompt(businessName) {
  return [
    'You are validating whether a photo is a LEGITIMATE screenshot or photo of a posted customer review.',
    `The review must be for the business named "${businessName}" (minor spelling/casing/abbreviation differences are acceptable).`,
    'Look for: a review platform UI (Google, Yelp, Tripadvisor, etc.), a reviewer name, a star rating, review text, and the business name.',
    'NEVER guess. If the image is not a review (a selfie, a car, a menu, a blank screen, a rental agreement), say so.',
    'A screenshot of the review COMPOSE screen (not yet posted) is NOT a posted review — reject it and explain.',
    'Output ONLY compact minified JSON (no markdown, no commentary) exactly matching:',
    '{"isReview":boolean,"platform":string|null,"businessName":string|null,"businessNameMatches":boolean,"rating":number|null,"reviewerName":string|null,"confidence":number,"notes":string|null}',
    'confidence is 0-100 for the OVERALL verdict. When isReview is false, set every other field except notes to null/false and explain in notes.'
  ].join('\n');
}

function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  const unfenced = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(unfenced.slice(start, end + 1));
}

function normalizeVerdict(parsed) {
  const conf = Number(parsed?.confidence);
  const rating = Number(parsed?.rating);
  return {
    isReview: parsed?.isReview === true,
    platform: parsed?.platform ? String(parsed.platform).slice(0, 40) : null,
    businessName: parsed?.businessName ? String(parsed.businessName).slice(0, 120) : null,
    businessNameMatches: parsed?.businessNameMatches === true,
    rating: Number.isFinite(rating) && rating >= 1 && rating <= 5 ? Math.round(rating) : null,
    reviewerName: parsed?.reviewerName ? String(parsed.reviewerName).slice(0, 120) : null,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : null,
    notes: parsed?.notes ? String(parsed.notes).slice(0, 500) : null
  };
}

export async function validateReviewPhoto({ buffer, contentType, businessName, apiKey, model } = {}) {
  if (!buffer || !buffer.length) throw new Error('empty photo buffer');
  if (!apiKey) throw new Error('no review-validation API key (set the tenant OCR key in Settings or ANTHROPIC_API_KEY)');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [imageBlock(buffer, contentType), { type: 'text', text: buildPrompt(String(businessName || 'the rental company')) }]
      }]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return normalizeVerdict(parseJsonLoose(text));
}

export const _internal = { buildPrompt, parseJsonLoose, normalizeVerdict };
