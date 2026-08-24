/**
 * field-crypto.js — application-layer field encryption for customer PII.
 * (Phase 1 of doc/field-level-pii-encryption-design-2026-08-23.md.)
 *
 * WHAT: encrypts the NON-SEARCHED sensitive columns (licence number, customer
 * address, date of birth, signature-image data URLs) in place, as
 * defence-in-depth beyond disk-level encryption at rest. Searched fields
 * (name / email / phone) are deliberately NOT here — encrypting them breaks
 * search/dedup and is Phase 2 (declined for now).
 *
 * HOW: one Prisma client extension (applied in lib/prisma.js) is the single
 * choke point:
 *   - on create/update/upsert/createMany/updateMany of a mapped model, the
 *     mapped string fields are encrypted before the query runs;
 *   - on EVERY read, the result tree is walked and any string carrying the
 *     self-identifying `encf:v<N>:` prefix is decrypted — so nested
 *     include/select relations and $queryRaw rows are covered without a
 *     per-call-site audit, and plaintext (not-yet-backfilled) values pass
 *     through untouched (dual-read, forever).
 *
 * FORMAT: `encf:v1:<base64(iv || authTag || ciphertext)>` — the payload is
 * EXACTLY integration-crypto's AES-256-GCM wire format (random per-write IV),
 * produced by its keyed variant with FIELD_ENC_KEY. The `v1` tag is the KEY
 * VERSION: rotation adds FIELD_ENC_KEY_V2 + bumps the write version, and
 * decrypt picks the key by the tag — no big-bang re-encrypt needed.
 *
 * DATE OF BIRTH is special: it lives in DateTime columns, which cannot hold
 * ciphertext. Each DOB model gets an ADDITIVE nullable `dateOfBirthEnc` TEXT
 * column (migration 20260823_field_encryption_dob). With encryption ON, a
 * write of `dateOfBirth` stores the encrypted ISO string in `dateOfBirthEnc`
 * and nulls the DateTime; the read walker decrypts `dateOfBirthEnc` back into
 * a Date on `dateOfBirth` and removes the Enc field, so every reader keeps
 * seeing a Date and the age rules / contracts / PDFs are untouched. Explicit
 * `select: { dateOfBirth: true }` sites are covered by augmenting the select
 * with `dateOfBirthEnc: true` (recursively, so nested relation selects work).
 *
 * INERT BY DEFAULT:
 *   FIELD_ENCRYPTION_ENABLED=true  — the write switch (default off).
 *   FIELD_ENC_KEY                  — base64 32-byte key (openssl rand -base64 32),
 *                                    same pattern as INTEGRATION_ENC_KEY.
 * Flag off or key missing → writes stay PLAINTEXT (zero behavior change).
 * Flag ON with a missing/malformed key → the write THROWS (loud, never
 * garbage). Reads always dual-read: ciphertext is decrypted whenever the key
 * for its version tag is present, plaintext passes through — so the flag can
 * be rolled back at any point without losing reads of already-encrypted rows.
 *
 * BACKFILL: scripts/backfill-field-encryption.mjs (manual, batched, resumable,
 * idempotent by prefix). NEVER runs on boot.
 *
 * GDPR interplay: erasure nulls / redacts these columns via customer-pii-map —
 * nulling a ciphertext column works unchanged, and `dateOfBirthEnc` is listed
 * in the map beside every `dateOfBirth`. The REDACTION sentinel ('[erased]')
 * is deliberately NOT encrypted on write, so an erased row is verifiably
 * erased by looking at the database, key or no key. The DSAR export reads
 * through the extended client, so it emits DECRYPTED plaintext.
 *
 * Ratchet note: `declinedInsuranceSignatureDataUrl` below is the declined-
 * insurance signature IMAGE column (a reader/crypto concern), NOT the
 * declinedInsurance boolean the insurance-selection gate protects. This file
 * is classified in declined-insurance-and-sign-url.test.mjs's KNOWN list.
 */

import { encryptWithKey, decryptWithKey } from './integration-crypto.js';
import logger from './logger.js';

// ---------------------------------------------------------------------------
// Field map — THE single source of truth for what gets encrypted.
// `strings` are encrypted in place (same column). `dob: true` marks the
// DateTime dateOfBirth + companion dateOfBirthEnc TEXT column pair.
// Keys are prisma delegate names (camelCase), matching extension model keys.
// ---------------------------------------------------------------------------
export const FIELD_ENC_MAP = {
  customer: {
    strings: ['licenseNumber', 'address1', 'address2', 'city', 'state', 'zip'],
    dob: true,
  },
  rentalAgreement: {
    strings: [
      'licenseNumber',
      'customerAddress1', 'customerAddress2', 'customerCity', 'customerState', 'customerZip',
      'tcSignatureDataUrl', 'declinedInsuranceSignatureDataUrl',
    ],
    dob: true,
  },
  agreementDriver: {
    strings: ['licenseNumber'],
    dob: true,
  },
  reservationAdditionalDriver: {
    strings: ['licenseNumber', 'address'],
    dob: true,
  },
  loanerAgreement: {
    strings: ['licenseNumber', 'signatureDataUrl'],
    dob: true,
  },
  reservation: {
    strings: ['signatureDataUrl'],
  },
  rentalAgreementAddendum: {
    strings: ['signatureDataUrl'],
  },
  agreementSectionInitial: {
    strings: ['initialDataUrl'],
  },
  reservationIncident: {
    strings: ['signatureDataUrl'],
  },
  vehicleDamageReport: {
    strings: ['customerAckSignatureDataUrl'],
  },
};

export const FIELD_ENC_PREFIX = 'encf:';
const WRITE_VERSION = 'v1';

// Must equal customer-pii-map.js's REDACTION. Kept as a local constant so lib/
// does not import from modules/ (layering); field-crypto.test.mjs asserts the
// two stay identical.
const REDACTION_SENTINEL = '[erased]';

// key-version tag -> env var holding its base64 32-byte key. Rotation: add
// FIELD_ENC_KEY_V2 here + bump WRITE_VERSION; old rows keep decrypting via v1.
const KEY_ENV_BY_VERSION = {
  v1: 'FIELD_ENC_KEY',
};

const KEY_BYTES = 32;
let keyCache = new Map();

function loadKeyForVersion(version) {
  if (keyCache.has(version)) return keyCache.get(version);
  const envName = KEY_ENV_BY_VERSION[version];
  let key = null;
  const raw = envName ? process.env[envName] : null;
  if (raw && typeof raw === 'string') {
    try {
      const buf = Buffer.from(raw.trim(), 'base64');
      if (buf.length === KEY_BYTES) key = buf;
    } catch {
      key = null;
    }
  }
  keyCache.set(version, key);
  return key;
}

/** True when the write switch is on (says nothing about the key's validity). */
export function isFieldEncryptionEnabled() {
  return String(process.env.FIELD_ENCRYPTION_ENABLED || '').toLowerCase() === 'true';
}

/** True when `value` carries the self-identifying ciphertext prefix. */
export function isFieldEncrypted(value) {
  return typeof value === 'string' && value.startsWith(FIELD_ENC_PREFIX);
}

/**
 * Encrypt one field value. THROWS when the flag is on but FIELD_ENC_KEY is
 * missing/malformed — enabling encryption without a valid key must fail the
 * write loudly, never write garbage or silent plaintext.
 */
export function encryptField(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptField(): plaintext must be a string');
  }
  const key = loadKeyForVersion(WRITE_VERSION);
  if (!key) {
    throw new Error(
      'FIELD_ENCRYPTION_ENABLED is true but FIELD_ENC_KEY is missing or is not a '
      + 'base64-encoded 32-byte key (generate with: openssl rand -base64 32). '
      + 'Refusing to write — fix the key or disable the flag.'
    );
  }
  return `${FIELD_ENC_PREFIX}${WRITE_VERSION}:${encryptWithKey(key, plaintext)}`;
}

/**
 * Dual-read decrypt: ciphertext → plaintext; anything else passes through
 * untouched. Decrypt FAILURE (unknown version, missing key, tamper/wrong key)
 * returns null and logs — a page must not 500 because one row cannot be
 * decrypted, and returning raw ciphertext to a UI/export would be worse.
 */
export function decryptField(value) {
  if (!isFieldEncrypted(value)) return value;
  const rest = value.slice(FIELD_ENC_PREFIX.length);
  const sep = rest.indexOf(':');
  const version = sep > 0 ? rest.slice(0, sep) : null;
  const payload = sep > 0 ? rest.slice(sep + 1) : '';
  const key = version ? loadKeyForVersion(version) : null;
  if (!key || !payload) {
    logger.error('field-crypto: cannot decrypt field — missing key or malformed payload', {
      version, keyEnv: version ? KEY_ENV_BY_VERSION[version] : undefined,
    });
    return null;
  }
  try {
    return decryptWithKey(key, payload);
  } catch (e) {
    logger.error('field-crypto: field decryption failed (tamper or wrong key)', {
      version, error: e.message,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write-side: encrypt mapped fields inside a Prisma `data` object, in place.
// ---------------------------------------------------------------------------

/** Unwrap a Prisma update value: `{ set: v }` -> v; a bare scalar passes through. */
function resolveSet(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'set' in v) return v.set;
  return v;
}

function writeBack(data, field, original, next) {
  if (original && typeof original === 'object' && !Array.isArray(original) && 'set' in original) {
    data[field] = { set: next };
  } else {
    data[field] = next;
  }
}

/**
 * Mutate one create/update `data` object per the model's spec. Exported pure
 * (data in, data out) so it is unit-testable without Prisma.
 *
 * - `field: undefined` (or absent) → untouched, like Prisma itself.
 * - null / '' / already-encrypted / the REDACTION sentinel → untouched.
 * - flag off / not set → untouched (plaintext write, zero behavior change) —
 *   EXCEPT dateOfBirth, whose companion column must stay in sync either way.
 * - flag on + bad key → throws (from encryptField).
 */
export function applyFieldEncryption(spec, data) {
  if (!spec || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  const enabled = isFieldEncryptionEnabled();

  for (const field of spec.strings || []) {
    if (!(field in data)) continue;
    const original = data[field];
    const value = resolveSet(original);
    if (typeof value !== 'string' || value === '') continue;
    if (isFieldEncrypted(value)) continue;        // idempotent — never double-encrypt
    if (value === REDACTION_SENTINEL) continue;   // erasure stays verifiable in the DB
    if (!enabled) continue;
    writeBack(data, field, original, encryptField(value));
  }

  if (spec.dob && 'dateOfBirth' in data) {
    const original = data.dateOfBirth;
    const value = resolveSet(original);
    if (value === undefined) return data;
    if (value === null) {
      // Clearing DOB clears BOTH columns (erasure / user removal).
      data.dateOfBirth = null;
      data.dateOfBirthEnc = null;
    } else if (enabled) {
      const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
      data.dateOfBirthEnc = encryptField(iso);
      data.dateOfBirth = null;
    } else {
      // Plaintext write — null any stale ciphertext so dual-read (which
      // prefers Enc) can never resurrect an older DOB after a rollback.
      data.dateOfBirthEnc = null;
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Read-side: walk a result tree, decrypting by prefix. Model-agnostic —
// covers nested includes/selects and raw rows because ciphertext is
// self-identifying. Exported for tests.
// ---------------------------------------------------------------------------

function isPlainObject(node) {
  if (!node || typeof node !== 'object') return false;
  const proto = Object.getPrototypeOf(node);
  return proto === Object.prototype || proto === null; // skips Date/Decimal/Buffer/…
}

export function decryptResultTree(node) {
  if (Array.isArray(node)) {
    for (const item of node) decryptResultTree(item);
    return node;
  }
  if (!isPlainObject(node)) return node;

  if ('dateOfBirthEnc' in node) {
    const enc = node.dateOfBirthEnc;
    if (isFieldEncrypted(enc)) {
      const iso = decryptField(enc);
      // Enc wins over the (nulled-on-backfill) DateTime; a failed decrypt
      // must not fabricate a date.
      node.dateOfBirth = iso == null ? null : new Date(iso);
    }
    // Internal column — readers asked for dateOfBirth, not the ciphertext.
    delete node.dateOfBirthEnc;
  }

  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string') {
      if (v.startsWith(FIELD_ENC_PREFIX)) node[k] = decryptField(v);
    } else if (v && typeof v === 'object') {
      decryptResultTree(v);
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Select augmentation: any `select` asking for dateOfBirth must also fetch
// dateOfBirthEnc, or post-backfill those sites would read null. Recursive so
// nested relation selects (`customer: { select: { dateOfBirth: true } }`)
// are covered. Only the five DOB models have a `dateOfBirth` field, and all
// five carry dateOfBirthEnc, so the added key is always valid.
// ---------------------------------------------------------------------------
export function augmentDobSelects(node) {
  if (Array.isArray(node)) {
    for (const item of node) augmentDobSelects(item);
    return node;
  }
  if (!isPlainObject(node)) return node;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (k === 'select' && isPlainObject(v) && v.dateOfBirth === true && !('dateOfBirthEnc' in v)) {
      v.dateOfBirthEnc = true;
    }
    if (v && typeof v === 'object') augmentDobSelects(v);
  }
  return node;
}

// ---------------------------------------------------------------------------
// The Prisma client extension (applied once in lib/prisma.js).
// ---------------------------------------------------------------------------

const WRITE_DATA_KEYS = {
  create: ['data'],
  createMany: ['data'],
  createManyAndReturn: ['data'],
  update: ['data'],
  updateMany: ['data'],
  updateManyAndReturn: ['data'],
  upsert: ['create', 'update'],
};

function encryptWriteArgs(spec, operation, args) {
  const keys = WRITE_DATA_KEYS[operation];
  if (!keys || !args) return;
  for (const key of keys) {
    const payload = args[key];
    if (Array.isArray(payload)) payload.forEach((d) => applyFieldEncryption(spec, d));
    else applyFieldEncryption(spec, payload);
  }
}

export const fieldCryptoExtension = {
  name: 'fieldCrypto',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (args && typeof args === 'object') {
          // select/include only — never recurse into data/where.
          if (args.select) augmentDobSelects({ select: args.select });
          if (args.include) augmentDobSelects(args.include);
          const spec = model
            ? FIELD_ENC_MAP[model.charAt(0).toLowerCase() + model.slice(1)]
            : undefined;
          if (spec) encryptWriteArgs(spec, operation, args);
        }
        const result = await query(args);
        return decryptResultTree(result);
      },
    },
    // Raw reads (e.g. the customers list query) return ciphertext columns and
    // dateOfBirthEnc directly; the same walker restores plaintext shapes.
    async $queryRaw({ args, query }) {
      return decryptResultTree(await query(args));
    },
    async $queryRawUnsafe({ args, query }) {
      return decryptResultTree(await query(args));
    },
  },
};

// Test seam — flush cached keys after process.env mutation.
export function _resetFieldKeyCacheForTests() {
  keyCache = new Map();
}
