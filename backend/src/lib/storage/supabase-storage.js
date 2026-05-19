/**
 * Thin wrapper around the Supabase Storage REST API.
 *
 * Uses global `fetch` (Node 20+) — no `@supabase/storage-js` dependency. Auth
 * is the SERVICE ROLE key so backend operations (uploads, signed URLs, deletes)
 * bypass RLS. NEVER expose the service role key to the browser.
 *
 * Foundation for:
 *   - 16l: inspection-photos migration from base64 → Storage
 *   - manual payment receipt uploads (original 16h scope)
 *
 * REST reference: https://supabase.com/docs/reference/javascript/storage-api
 */

// ---------------------------------------------------------------------------
// Env validation. Lazy via _assertEnv() so importing for type/test does not
// crash on env-less CI.
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function _assertEnv() {
  if (!SUPABASE_URL) {
    throw new StorageError(
      'SUPABASE_URL is not set. Add it to backend/.env (e.g. https://<project>.supabase.co).',
      500
    );
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new StorageError(
      'SUPABASE_SERVICE_ROLE_KEY is not set. Get it from Supabase dashboard → Settings → API → service_role secret.',
      500
    );
  }
}

const STORAGE_BASE = () => `${SUPABASE_URL}/storage/v1`;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class StorageError extends Error {
  constructor(message, status = 500, body = null) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.body = body;
  }
}

export class NotFoundError extends StorageError {
  constructor(message = 'Storage object not found', body = null) {
    super(message, 404, body);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends StorageError {
  constructor(message = 'Storage request unauthorized', body = null, status = 401) {
    super(message, status, body);
    this.name = 'UnauthorizedError';
  }
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Build a sanitized object path. Strips leading slashes, collapses empty
 * segments, rejects `..` segments and control chars. Use for any path that
 * mixes caller-controlled input (tenant id, vehicle id, filename).
 *
 *   safePath('inspections', tenantId, 'before.jpg')
 *     → 'inspections/<tenantId>/before.jpg'
 */
export function safePath(...parts) {
  const segments = [];
  for (const raw of parts) {
    if (raw === null || raw === undefined) continue;
    const s = String(raw);
    for (const seg of s.split('/')) {
      const trimmed = seg.trim();
      if (trimmed === '' || trimmed === '.') continue;
      if (trimmed === '..') {
        throw new StorageError('Invalid path segment ".." in safePath input', 400);
      }
      if (/[\x00-\x1f]/.test(trimmed)) {
        throw new StorageError(`Invalid control character in path segment "${trimmed}"`, 400);
      }
      segments.push(trimmed);
    }
  }
  if (segments.length === 0) {
    throw new StorageError('safePath produced empty path', 400);
  }
  return segments.join('/');
}

// ---------------------------------------------------------------------------
// Internal request helper
// ---------------------------------------------------------------------------

async function _request(method, urlPath, { headers = {}, body = undefined } = {}) {
  _assertEnv();
  const url = `${STORAGE_BASE()}${urlPath}`;
  const finalHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...headers,
  };

  let res;
  try {
    res = await fetch(url, { method, headers: finalHeaders, body });
  } catch (err) {
    throw new StorageError(`Storage network error: ${err.message}`, 502, null);
  }

  if (!res.ok) {
    let errBody = null;
    try {
      const ct = (res.headers.get && res.headers.get('content-type')) || '';
      errBody = ct.includes('application/json') ? await res.json() : await res.text();
    } catch {
      errBody = null;
    }
    const msg =
      (errBody && typeof errBody === 'object' && (errBody.message || errBody.error)) ||
      (typeof errBody === 'string' && errBody) ||
      `Storage ${method} ${urlPath} failed with ${res.status}`;
    if (res.status === 404) throw new NotFoundError(msg, errBody);
    if (res.status === 401 || res.status === 403) throw new UnauthorizedError(msg, errBody, res.status);
    throw new StorageError(msg, res.status, errBody);
  }

  return res;
}

function _encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload a Buffer/stream as an object.
 *
 * @param {Object} args
 * @param {string} args.bucket
 * @param {string} args.path
 * @param {Buffer|Uint8Array|ReadableStream} args.body
 * @param {string} args.contentType
 * @param {boolean} [args.upsert=false] - overwrite if exists
 * @returns {Promise<{ path: string, size: number|null, etag: string|null, contentType: string }>}
 */
export async function uploadObject({ bucket, path, body, contentType, upsert = false }) {
  if (!bucket) throw new StorageError('uploadObject: bucket is required', 400);
  if (!path) throw new StorageError('uploadObject: path is required', 400);
  if (!body) throw new StorageError('uploadObject: body is required', 400);
  if (!contentType) throw new StorageError('uploadObject: contentType is required', 400);

  const size = body instanceof Buffer || body instanceof Uint8Array ? body.byteLength : null;

  const res = await _request('POST', `/object/${encodeURIComponent(bucket)}/${_encodePath(path)}`, {
    headers: {
      'Content-Type': contentType,
      'x-upsert': upsert ? 'true' : 'false',
    },
    body,
  });

  let json = null;
  try { json = await res.json(); } catch { /* tolerate empty body */ }

  return {
    path: (json && (json.Key || json.path)) || `${bucket}/${path}`,
    size,
    etag: (res.headers.get && res.headers.get('etag')) || null,
    contentType,
  };
}

/**
 * Download an object's bytes.
 *
 * @returns {Promise<{ body: Buffer, contentType: string, size: number }>}
 * @throws {NotFoundError} when the object does not exist
 */
export async function downloadObject({ bucket, path }) {
  if (!bucket) throw new StorageError('downloadObject: bucket is required', 400);
  if (!path) throw new StorageError('downloadObject: path is required', 400);

  const res = await _request('GET', `/object/${encodeURIComponent(bucket)}/${_encodePath(path)}`);
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  return {
    body: buf,
    contentType: (res.headers.get && res.headers.get('content-type')) || 'application/octet-stream',
    size: buf.byteLength,
  };
}

/**
 * Mint a time-limited signed URL for a private object. Use for serving
 * inspection photos to authenticated clients without exposing the service
 * role key.
 *
 * @returns {Promise<string>} fully-qualified signed URL
 */
export async function getSignedUrl({ bucket, path, expiresIn = 3600 }) {
  if (!bucket) throw new StorageError('getSignedUrl: bucket is required', 400);
  if (!path) throw new StorageError('getSignedUrl: path is required', 400);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new StorageError('getSignedUrl: expiresIn must be a positive number of seconds', 400);
  }

  const res = await _request('POST', `/object/sign/${encodeURIComponent(bucket)}/${_encodePath(path)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  const json = await res.json();
  const rel = json.signedURL || json.signedUrl || json.signed_url;
  if (!rel) {
    throw new StorageError('getSignedUrl: response missing signedURL field', 500, json);
  }
  if (rel.startsWith('http')) return rel;
  // Older API returns paths like "/object/sign/<bucket>/<path>?token=..."
  // Newer returns "object/sign/...". Normalize against STORAGE_BASE.
  const trimmed = rel.startsWith('/') ? rel.slice(1) : rel;
  return `${STORAGE_BASE()}/${trimmed.replace(/^storage\/v1\//, '')}`;
}

/**
 * Build the canonical public URL for an object. Only resolvable if the
 * bucket itself is marked public — otherwise prefer getSignedUrl.
 */
export function getPublicUrl({ bucket, path }) {
  if (!bucket) throw new StorageError('getPublicUrl: bucket is required', 400);
  if (!path) throw new StorageError('getPublicUrl: path is required', 400);
  _assertEnv();
  return `${STORAGE_BASE()}/object/public/${encodeURIComponent(bucket)}/${_encodePath(path)}`;
}

/**
 * Delete an object. Idempotent — 404 is swallowed so retries are safe.
 */
export async function deleteObject({ bucket, path }) {
  if (!bucket) throw new StorageError('deleteObject: bucket is required', 400);
  if (!path) throw new StorageError('deleteObject: path is required', 400);
  try {
    await _request('DELETE', `/object/${encodeURIComponent(bucket)}/${_encodePath(path)}`);
    return { deleted: true };
  } catch (err) {
    if (err instanceof NotFoundError) return { deleted: false, reason: 'not-found' };
    throw err;
  }
}

/**
 * List objects under a prefix. Supabase's list endpoint is POST with a JSON
 * body — quirky but documented.
 *
 * @returns {Promise<Array<{ name: string, size: number|null, lastModified: string|null, contentType: string|null }>>}
 */
export async function listObjects({ bucket, prefix = '', limit = 100, offset = 0 }) {
  if (!bucket) throw new StorageError('listObjects: bucket is required', 400);
  const res = await _request('POST', `/object/list/${encodeURIComponent(bucket)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit, offset, sortBy: { column: 'name', order: 'asc' } }),
  });
  const arr = await res.json();
  if (!Array.isArray(arr)) return [];
  return arr.map((row) => ({
    name: row.name,
    size: row.metadata?.size ?? null,
    lastModified: row.updated_at || row.last_accessed_at || row.created_at || null,
    contentType: row.metadata?.mimetype || null,
  }));
}

// ---------------------------------------------------------------------------
// Default export — convenient single-import pattern.
// ---------------------------------------------------------------------------
export default {
  uploadObject,
  downloadObject,
  getSignedUrl,
  getPublicUrl,
  deleteObject,
  listObjects,
  safePath,
  StorageError,
  NotFoundError,
  UnauthorizedError,
};
