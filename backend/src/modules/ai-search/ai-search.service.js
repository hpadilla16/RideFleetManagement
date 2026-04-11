import logger from '../../lib/logger.js';
import { cache } from '../../lib/cache.js';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

function getApiKey() {
  return process.env.OPENAI_API_KEY || '';
}

const SYSTEM_PROMPT = `You are a car sharing search assistant for Ride Car Sharing.
Given a user's natural language search query, extract structured search parameters.
Return ONLY valid JSON with these fields (all optional, omit if not mentioned):
{
  "vehicleType": "sedan|suv|van|truck|luxury|sport|compact|convertible|electric",
  "location": "city name or area",
  "pickupDate": "YYYY-MM-DD or relative like 'tomorrow', 'this weekend', 'friday'",
  "returnDate": "YYYY-MM-DD or relative",
  "days": number,
  "maxPrice": number (daily rate),
  "minPrice": number (daily rate),
  "instantBook": true/false,
  "deliveryNeeded": true/false,
  "features": ["car seat", "gps", "bluetooth", etc],
  "sortBy": "price_low|price_high|rating|newest",
  "passengers": number,
  "query": "cleaned version of what to search for"
}
Always return valid JSON. No explanation, no markdown, just the JSON object.
Today's date is ${new Date().toISOString().slice(0, 10)}.`;

/**
 * Extract search intent from natural language using OpenAI.
 */
export async function extractSearchIntent(userQuery) {
  const apiKey = getApiKey();
  if (!apiKey) {
    // Fallback: return the query as-is for text search
    logger.info('AI search: no API key, falling back to text search', { query: userQuery });
    return { query: userQuery, fallback: true };
  }

  const cacheKey = `ai:search:${userQuery.toLowerCase().trim().slice(0, 100)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userQuery },
        ],
        temperature: 0.1,
        max_tokens: 300,
      }),
    });

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      // Strip markdown code blocks if present
      const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      logger.warn('AI search: failed to parse response', { query: userQuery, content: content.slice(0, 200) });
      return { query: userQuery, fallback: true };
    }

    const result = {
      ...parsed,
      originalQuery: userQuery,
      aiParsed: true,
    };

    // Resolve relative dates
    if (parsed.pickupDate && !/^\d{4}/.test(parsed.pickupDate)) {
      result.pickupDateRaw = parsed.pickupDate;
      result.pickupDate = resolveRelativeDate(parsed.pickupDate);
    }
    if (parsed.returnDate && !/^\d{4}/.test(parsed.returnDate)) {
      result.returnDateRaw = parsed.returnDate;
      result.returnDate = resolveRelativeDate(parsed.returnDate);
    }
    if (parsed.days && result.pickupDate && !result.returnDate) {
      const pickup = new Date(result.pickupDate);
      pickup.setDate(pickup.getDate() + parsed.days);
      result.returnDate = pickup.toISOString().slice(0, 10);
    }

    cache.set(cacheKey, result, 5 * 60 * 1000); // cache 5 min
    logger.info('AI search: intent extracted', { query: userQuery, intent: result });
    return result;

  } catch (err) {
    logger.error('AI search: API call failed', { query: userQuery, error: err.message });
    return { query: userQuery, fallback: true };
  }
}

function resolveRelativeDate(text) {
  const now = new Date();
  const lower = String(text).toLowerCase().trim();

  if (lower === 'today') return now.toISOString().slice(0, 10);
  if (lower === 'tomorrow') { now.setDate(now.getDate() + 1); return now.toISOString().slice(0, 10); }
  if (lower.includes('this weekend') || lower === 'saturday') {
    const day = now.getDay();
    const daysUntilSat = (6 - day + 7) % 7 || 7;
    now.setDate(now.getDate() + daysUntilSat);
    return now.toISOString().slice(0, 10);
  }

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayIdx = dayNames.indexOf(lower);
  if (dayIdx >= 0) {
    const current = now.getDay();
    const diff = (dayIdx - current + 7) % 7 || 7;
    now.setDate(now.getDate() + diff);
    return now.toISOString().slice(0, 10);
  }

  return text; // Return as-is if can't resolve
}
