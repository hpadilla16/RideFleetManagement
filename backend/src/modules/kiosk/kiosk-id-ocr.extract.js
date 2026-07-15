/**
 * kiosk-id-ocr.extract — vision-LLM extraction of a US/PR driver-license
 * FRONT photo into the verify-id field shape (Fase B3d: after Hector's iPad
 * re-test the pdf417 scanner is demoted — photo + OCR becomes the PRIMARY ID
 * path; the extraction is ADVISORY and the customer confirms on screen).
 *
 * Mirrors the citation OCR pattern (citations/citation-ocr.extract.js):
 * same Anthropic HTTP call shape, same key resolution order (per-tenant
 * Settings key → ANTHROPIC_API_KEY env, resolved by the CALLER), haiku
 * default with KIOSK_ID_OCR_MODEL override falling back to the citation
 * model env.
 *
 * Returns { fields, confidence, notes } — fields are null when unreadable
 * (the prompt forbids guessing); throws only on hard provider/config errors.
 */

const DEFAULT_MODEL = process.env.KIOSK_ID_OCR_MODEL
  || process.env.CITATION_OCR_MODEL
  || 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const PROMPT = [
  'You are extracting fields from a photo of the FRONT of a US or Puerto Rico driver license.',
  'Return ONLY a JSON object, no prose, with this exact shape:',
  '{"fields":{"firstName":string|null,"lastName":string|null,"dateOfBirth":string|null,',
  '"licenseNumber":string|null,"licenseState":string|null,"licenseExpiry":string|null},',
  '"confidence":number,"notes":string|null}',
  'Rules: dates as ISO 8601 (YYYY-MM-DD). licenseState = the 2-letter US state/territory code (PR for Puerto Rico).',
  'firstName = the given name(s) only; lastName = the family name(s) as printed.',
  'If a field is not CLEARLY readable, use null for it. NEVER guess or invent a value.',
  'If the photo is not the front of a driver license, return every field as null and explain in notes.',
  'confidence = your overall 0-100 confidence in the extraction.',
  'Output ONLY compact minified JSON (no markdown, no commentary).',
].join(' ');

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

function cleanField(value, max) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim().slice(0, max) || null;
}

function normalizeResult(obj) {
  const f = obj?.fields && typeof obj.fields === 'object' ? obj.fields : {};
  return {
    fields: {
      firstName: cleanField(f.firstName, 80),
      lastName: cleanField(f.lastName, 80),
      dateOfBirth: cleanField(f.dateOfBirth, 32),
      licenseNumber: cleanField(f.licenseNumber, 40),
      licenseState: f.licenseState ? String(f.licenseState).trim().toUpperCase().slice(0, 4) : null,
      licenseExpiry: cleanField(f.licenseExpiry, 32),
    },
    confidence: Number.isFinite(Number(obj?.confidence)) ? Number(obj.confidence) : null,
    notes: cleanField(obj?.notes, 200),
  };
}

/**
 * Extract license-front fields from an image buffer. apiKey/model come from
 * the caller (tenant Settings → env fallback, same as citation OCR).
 */
export async function extractLicenseFront({ buffer, contentType, apiKey, model } = {}) {
  if (!buffer || !buffer.length) throw new Error('empty photo buffer');
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
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [imageBlock(buffer, contentType), { type: 'text', text: PROMPT }],
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

export default { extractLicenseFront };
