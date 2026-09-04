/**
 * Per-location contract clause overrides — the read/write side of the editor.
 *
 * ── THE STORAGE ALREADY EXISTED ─────────────────────────────────────────────
 * `Location.termsSectionsJson` has held these overrides since 2026-07-24 and
 * `terms-content.js` has resolved them ever since. What did NOT exist was any
 * way to see or change them: the only writer was
 * `backend/scripts/load-location-terms.mjs` (a developer, a file, `--commit`)
 * or someone editing the column by hand. This module is the missing surface,
 * NOT a second home for the data. Every value here still resolves through
 * `parseSectionOverrides` / `sectionsForAgreement`, and the column keeps the
 * exact shape the script writes: a JSON object keyed by sectionKey.
 *
 * ── WHY THE 250 IS NOT A COSMETIC WARNING ───────────────────────────────────
 * Terminal contract signing pushes each clause through `/v2/Common/UserChoice`,
 * whose `Title` is capped at 250 characters, and
 * `assertClausesFitTerminal()` REFUSES to start a terminal contract when a
 * clause is longer — deliberately, because truncating would have the renter
 * pressing "I agree" on a sentence that stops mid-word. So a clause over 250
 * does not merely look bad: it sends every checkout at that branch to the
 * renter's phone. The canonical six run 235–245, and the canonical
 * `declined_insurance` is 274 and ALREADY fails that check.
 *
 * `TERMINAL_TITLE_MAX` is IMPORTED, never redeclared. If the editor's number
 * and the sequencer's number could drift, the editor would be telling admins a
 * comfortable lie about a limit it does not own. Pinned in
 * location-clauses.test.mjs.
 *
 * ── WHY SAVING IS NOT BLOCKED AT 250 ────────────────────────────────────────
 * A tenant may legitimately prefer a long clause and the phone flow — LAX's
 * California deposit wording is longer than the canonical text it replaces for
 * real legal reasons. The editor's job is to make the consequence VISIBLE, not
 * to quietly shorten a legal instrument or to refuse a lawful one. So >250 is
 * reported, loudly, and still saved. `CLAUSE_MAX_BODY` is a sanity bound
 * against a paste accident, an order of magnitude above any real clause.
 *
 * ── WHY NOTHING IS SILENTLY STRIPPED ────────────────────────────────────────
 * `parseSectionOverrides` is deliberately TOLERANT — a malformed blob must not
 * strand a renter mid-signing, so it logs and falls back to canonical text.
 * That is right for the signing path and wrong for an editor: an admin looking
 * at this screen must be told that the stored blob is broken, or which of their
 * keys will never take effect, instead of being shown a screen that says
 * "everything is standard" and then silently overwriting the evidence on save.
 * `inspectStoredOverrides()` exists for exactly that difference. On the write
 * side an unknown key is a 400, never a quiet drop.
 */

import { prisma } from '../../lib/prisma.js';
import { scopeAllowedLocationIds } from '../../lib/tenant-scope.js';
import {
  TC_SECTIONS,
  DECLINED_INSURANCE_SECTION,
  DAMAGE_ACKNOWLEDGEMENT_SECTION,
  parseSectionOverrides,
} from '../checkout-session/terms-content.js';
import { USER_CHOICE_TITLE_MAX, clauseTitle } from '../checkout-session/terminal-contract.service.js';

/** The terminal's real cap, from the module that enforces it. Never redeclared. */
export const TERMINAL_TITLE_MAX = USER_CHOICE_TITLE_MAX;

/**
 * Where "getting close" starts. 20 characters of runway is roughly one more
 * clause-sized phrase — enough that an admin still has room to rephrase rather
 * than being told only after they have already crossed.
 */
export const TERMINAL_WARN_AT = TERMINAL_TITLE_MAX - 20;

/** Sanity bounds. Not the terminal limit — see the header. */
export const CLAUSE_MAX_BODY = 2000;
export const CLAUSE_MAX_LABEL = 120;

/**
 * WHEN each clause is shown, which is the difference between "six clauses" and
 * "eight editable ones". The six always appear; the other two are conditional
 * and reach the renter through different flows entirely.
 */
export const CLAUSE_SCOPE = Object.freeze({
  ALWAYS: 'ALWAYS',
  DECLINED_INSURANCE: 'DECLINED_INSURANCE',
  DAMAGE_REPORT: 'DAMAGE_REPORT',
});

/**
 * The editable catalog, in the order the renter meets them.
 *
 * `damage_acknowledgement` is included because the SAME column overrides it
 * (see damageAcknowledgementSection) and leaving it out would mean the only way
 * to change it stays "edit the column by hand" — the exact problem this feature
 * exists to end. It is flagged DAMAGE_REPORT because it is never part of
 * sectionsForAgreement: it is signed in the Report Damage wizard, so the
 * terminal cap does not apply to it and the editor must not pretend it does.
 */
export function clauseCatalog() {
  return [
    ...TC_SECTIONS.map((s) => ({ ...s, scope: CLAUSE_SCOPE.ALWAYS })),
    { ...DECLINED_INSURANCE_SECTION, scope: CLAUSE_SCOPE.DECLINED_INSURANCE },
    { ...DAMAGE_ACKNOWLEDGEMENT_SECTION, scope: CLAUSE_SCOPE.DAMAGE_REPORT },
  ];
}

/** Keys the column may legally carry. Anything else can never take effect. */
export function knownClauseKeys() {
  return new Set(clauseCatalog().map((s) => s.key));
}

/** Only clauses that ride the terminal are measured against its cap. */
function ridesTerminal(scope) {
  return scope === CLAUSE_SCOPE.ALWAYS || scope === CLAUSE_SCOPE.DECLINED_INSURANCE;
}

/**
 * Read the stored column the way an EDITOR must: reporting what is wrong with
 * it rather than quietly recovering. Contrast parseSectionOverrides, which is
 * tolerant on purpose because it runs while a renter is standing at a counter.
 *
 * Returns { ok, reason, overrides, unknownKeys, rawLength }. `overrides` is
 * always the same effective map parseSectionOverrides would produce, so the
 * editor can never show one thing while the signing flow renders another.
 */
export function inspectStoredOverrides(raw) {
  const effective = parseSectionOverrides(raw);
  const out = {
    ok: true, reason: null, overrides: effective, unknownKeys: [],
    rawLength: typeof raw === 'string' ? raw.length : null,
  };
  if (raw === null || raw === undefined) return out;
  if (typeof raw === 'string' && !raw.trim()) return out;

  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (err) {
      // The admin has to know. Falling back to canonical text silently is what
      // parseSectionOverrides does for the renter's sake; here it would mean an
      // admin believes the branch wording is live when it is not, and a save
      // from this screen would erase the broken blob before anyone read it.
      return { ...out, ok: false, reason: 'NOT_JSON', detail: String(err?.message || err) };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...out, ok: false, reason: 'NOT_AN_OBJECT', detail: Array.isArray(parsed) ? 'array' : typeof parsed };
  }
  const known = knownClauseKeys();
  const unknownKeys = Object.keys(parsed).filter((k) => !known.has(k));
  return { ...out, unknownKeys };
}

/**
 * Everything the editor needs for one location, per clause.
 *
 * The canonical text ships alongside the override on purpose: "this location
 * uses the standard text" has to be a VISIBLE, restorable state, and an admin
 * cannot judge an override they cannot see the original of.
 */
export function buildClauseView(termsSectionsJson) {
  const stored = inspectStoredOverrides(termsSectionsJson);
  const clauses = clauseCatalog().map((canonical) => {
    const o = stored.overrides[canonical.key] || null;
    const body = o?.body ?? canonical.body;
    const label = o?.label ?? canonical.label;
    // The EXACT string the terminal would receive — same function the
    // sequencer calls, so the preview cannot flatter the real thing.
    const terminalText = clauseTitle({ body });
    const length = terminalText.length;
    const onTerminal = ridesTerminal(canonical.scope);
    return {
      key: canonical.key,
      scope: canonical.scope,
      label,
      body,
      canonicalLabel: canonical.label,
      canonicalBody: canonical.body,
      canonicalLength: clauseTitle(canonical).length,
      isOverridden: !!o,
      bodyOverridden: typeof o?.body === 'string',
      labelOverridden: typeof o?.label === 'string',
      length,
      terminalText,
      ridesTerminal: onTerminal,
      // The consequence, precomputed once so every surface says the same thing.
      fitsTerminal: onTerminal ? length <= TERMINAL_TITLE_MAX : null,
      nearTerminalLimit: onTerminal ? length > TERMINAL_WARN_AT && length <= TERMINAL_TITLE_MAX : false,
      // TRUE when the canonical text itself is over the cap — nobody at the
      // counter can fix that by editing a setting (declined_insurance is 274).
      canonicalOverTerminal: onTerminal ? clauseTitle(canonical).length > TERMINAL_TITLE_MAX : false,
    };
  });
  const blockedKeys = clauses.filter((c) => c.ridesTerminal && c.fitsTerminal === false).map((c) => c.key);
  return {
    clauses,
    terminal: {
      max: TERMINAL_TITLE_MAX,
      warnAt: TERMINAL_WARN_AT,
      blockedKeys,
      // What it COSTS, not merely that it is over: this is the sentence the UI
      // turns into words for the admin.
      terminalSigningAvailable: blockedKeys.length === 0,
    },
    limits: { maxBody: CLAUSE_MAX_BODY, maxLabel: CLAUSE_MAX_LABEL },
    storage: {
      ok: stored.ok, reason: stored.reason, detail: stored.detail ?? null,
      unknownKeys: stored.unknownKeys, rawLength: stored.rawLength,
    },
  };
}

export class ClauseValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ClauseValidationError';
    this.statusCode = 400;
    this.details = details;
  }
}

/**
 * Validate and normalise the override map an admin submitted.
 *
 * FULL REPLACE, not a merge: the editor holds every editable clause on screen,
 * so the map it sends is the whole intended state. That is what makes
 * restore-to-standard ONE action — the key is simply absent (or explicitly
 * null) — instead of "delete the text until it looks empty", which would land
 * as `{ body: '' }` and be dropped by parseSectionOverrides anyway, leaving the
 * admin unable to tell an intentional restore from a failed save.
 *
 * Rejects rather than strips. An unknown key can never take effect, so quietly
 * dropping one would hide a typo and leave the admin believing wording is live
 * that never will be.
 */
export function validateClauseOverrides(input) {
  if (input === null || input === undefined) {
    throw new ClauseValidationError('overrides is required (send {} to clear every override)');
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ClauseValidationError('overrides must be an object keyed by sectionKey');
  }
  const known = knownClauseKeys();
  const errors = [];
  const out = {};

  for (const [key, val] of Object.entries(input)) {
    if (!known.has(key)) {
      errors.push({ key, error: 'UNKNOWN_SECTION_KEY' });
      continue;
    }
    // null / undefined is the restore-to-standard signal, and it is explicit.
    if (val === null || val === undefined) continue;

    const raw = typeof val === 'string' ? { body: val } : val;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ key, error: 'INVALID_SHAPE' });
      continue;
    }
    const entry = {};

    if (raw.body !== undefined && raw.body !== null) {
      if (typeof raw.body !== 'string') { errors.push({ key, field: 'body', error: 'NOT_A_STRING' }); continue; }
      const body = raw.body.trim();
      if (!body) { errors.push({ key, field: 'body', error: 'EMPTY' }); continue; }
      if (body.length > CLAUSE_MAX_BODY) {
        // Reported with the real numbers so the message is actionable, and
        // NEVER truncated to fit: shortening a legal instrument on the
        // admin's behalf is the one thing this editor must not do.
        errors.push({ key, field: 'body', error: 'TOO_LONG', length: body.length, max: CLAUSE_MAX_BODY });
        continue;
      }
      entry.body = body;
    }
    if (raw.label !== undefined && raw.label !== null) {
      if (typeof raw.label !== 'string') { errors.push({ key, field: 'label', error: 'NOT_A_STRING' }); continue; }
      const label = raw.label.trim();
      if (!label) { errors.push({ key, field: 'label', error: 'EMPTY' }); continue; }
      if (label.length > CLAUSE_MAX_LABEL) {
        errors.push({ key, field: 'label', error: 'TOO_LONG', length: label.length, max: CLAUSE_MAX_LABEL });
        continue;
      }
      entry.label = label;
    }
    // An entry with neither field is not a restore — it is a request that says
    // nothing. Treating it as a restore would let a UI bug wipe an override.
    if (!Object.keys(entry).length) { errors.push({ key, error: 'NO_FIELDS' }); continue; }
    out[key] = entry;
  }

  if (errors.length) {
    const unknown = errors.filter((e) => e.error === 'UNKNOWN_SECTION_KEY').map((e) => e.key);
    throw new ClauseValidationError(
      unknown.length
        ? `Unknown clause key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. `
          + `Valid keys: ${[...known].join(', ')}.`
        : 'One or more clause overrides are invalid.',
      errors,
    );
  }
  return out;
}

/**
 * What CHANGED, for the audit row — keys and lengths, never the text.
 *
 * The wording of a clause is a legal instrument, and an audit table is neither
 * where it belongs nor where anyone would look for it. The trail has to answer
 * "who changed WHICH clauses at WHICH branch, and did that break terminal
 * signing" — every one of which is answerable from a key and a length.
 */
export function clauseChangeSummary(before = {}, after = {}) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = [];
  for (const key of keys) {
    const b = before[key] || null;
    const a = after[key] || null;
    const bBody = b?.body ?? null;
    const aBody = a?.body ?? null;
    const bLabel = b?.label ?? null;
    const aLabel = a?.label ?? null;
    if (bBody === aBody && bLabel === aLabel) continue;
    changed.push({
      key,
      change: !b ? 'SET' : (!a ? 'CLEARED' : 'UPDATED'),
      bodyLength: aBody === null ? null : aBody.length,
      previousBodyLength: bBody === null ? null : bBody.length,
      labelLength: aLabel === null ? null : aLabel.length,
      previousLabelLength: bLabel === null ? null : bLabel.length,
    });
  }
  return changed;
}

/** Which of the resulting clauses no longer fit the terminal, by key. */
export function blockedTerminalKeys(overrides = {}) {
  return buildClauseView(overrides).terminal.blockedKeys;
}

// ── DB-facing ───────────────────────────────────────────────────────────────

/**
 * Same scope check as locations.service.update, and for the same reason: a
 * branch-restricted ADMIN must not be able to rewrite another branch's
 * contract wording. Checked BEFORE the query rather than spread into `where`,
 * so a second `id` key can never silently widen the match. 404 (not 403) for a
 * branch outside scope — the API must not confirm that it exists.
 */
async function loadLocation(id, scope = {}) {
  const allowed = scopeAllowedLocationIds(scope);
  if (allowed && !allowed.includes(String(id))) return null;
  return prisma.location.findFirst({
    where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
    select: { id: true, code: true, name: true, tenantId: true, termsSectionsJson: true },
  });
}

export const locationClausesService = {
  async get(id, scope = {}) {
    const loc = await loadLocation(id, scope);
    if (!loc) return null;
    return {
      location: { id: loc.id, code: loc.code, name: loc.name },
      ...buildClauseView(loc.termsSectionsJson),
    };
  },

  async update(id, body, scope = {}) {
    const loc = await loadLocation(id, scope);
    if (!loc) return null;

    const next = validateClauseOverrides(body?.overrides);
    const before = inspectStoredOverrides(loc.termsSectionsJson).overrides;

    // Stored EXACTLY as scripts/load-location-terms.mjs stores it — a JSON
    // object keyed by sectionKey, pretty-printed so the column stays readable
    // to the next person who opens it with psql. An empty map is written as
    // NULL, not "{}" : "no overrides" and "an override document that happens to
    // be empty" must not be two different states of the same branch.
    const serialized = Object.keys(next).length ? JSON.stringify(next, null, 2) : null;
    await prisma.location.update({ where: { id: loc.id }, data: { termsSectionsJson: serialized } });

    const view = buildClauseView(serialized);
    return {
      location: { id: loc.id, code: loc.code, name: loc.name, tenantId: loc.tenantId },
      changed: clauseChangeSummary(before, next),
      ...view,
    };
  },
};
