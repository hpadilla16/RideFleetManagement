/**
 * Translation keys for the curriculum, derived rather than stored.
 *
 * WHY DERIVED (2026-08-14): every one of the 99 strings could carry its own
 * `tKey` field, and then the curriculum would hold each string twice — once as
 * English, once as a key naming it — with nothing keeping the two in step. A
 * renamed module would leave a key pointing at the old name and the copy would
 * silently fall back to English, in the language the team does not read.
 *
 * So the key is computed from the identity the entry already has: its module
 * key, and for a step its ANCHOR. Both are unique, both are already pinned by
 * tests, and neither is positional — reordering the steps of a module cannot
 * shuffle its translations the way an index-based key would.
 *
 * The English text in curriculum.js stays exactly where it is and serves as
 * the i18next default, which is the pattern this codebase already uses in 69
 * places: t(key, 'English default'). A missing Spanish string degrades to
 * readable English rather than to a raw key.
 */

const NS = 'training';

/** `training.courses.<courseKey>.<field>` */
export function courseKey(course, field) {
  return `${NS}.courses.${course?.key || 'unknown'}.${field}`;
}

/** `training.modules.<moduleKey>.<field>` — title, summary, gotcha */
export function moduleKey(module, field) {
  return `${NS}.modules.${module?.key || 'unknown'}.${field}`;
}

/**
 * `training.modules.<moduleKey>.steps.<anchor>.<field>` — title, body, and for
 * the kiosk course's richer steps a dotted path: `callouts.0`, `check.question`,
 * `check.options.A.text`, `check.options.A.why`.
 *
 * CALLOUTS ARE THE ONE POSITIONAL KEY HERE, on purpose. A callout is "what the
 * numbered marker N on the drawing means" — its identity IS its number, the same
 * number drawn on the figure — so reordering callouts without redrawing the
 * figure would be wrong regardless of translation. The i18n test asserts the
 * Spanish index set equals the curriculum's (no missing, no extras), which is
 * the drift the positional key could otherwise hide.
 */
export function stepKey(module, step, field) {
  const mk = typeof module === 'string' ? module : module?.key;
  return `${NS}.modules.${mk || 'unknown'}.steps.${step?.anchor || 'unknown'}.${field}`;
}

/**
 * Translate a curriculum string, falling back to the English already in the
 * data file.
 *
 * @param {Function} t   the i18next t from useTranslation()
 * @param {string} key   from one of the helpers above
 * @param {string} fallback  the English text carried by the curriculum entry
 */
export function trainingText(t, key, fallback) {
  if (typeof t !== 'function') return fallback || '';
  return t(key, fallback || '');
}
