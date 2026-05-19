// Canonical Terms & Conditions version metadata.
//
// The TC_VERSION string is what we stamp onto every reservation when a
// customer accepts the agreement. The 281 reservations sitting with
// autochargeBlocked=true were signed BEFORE this version landed — they
// lack the explicit card-on-file authorization (Section 11),
// delayed-charges procedure (Section 12), and post-rental data retention
// disclosure (Section 13) introduced in this revision.
//
// IMPORTANT: bump TC_VERSION every time you change the substantive
// language of tc-2026-05-19.html (or its successor). Cosmetic
// changes — typography, CSS, layout — should NOT bump the version.
// The version string is a legal marker, not a build artifact.
//
// Format: ISO date (YYYY-MM-DD). Lexicographic ordering matches
// chronological ordering, which is what we use elsewhere when comparing
// stored termsVersion strings.

export const TC_VERSION = '2026-05-19';

// Effective date: the calendar day this version becomes the canonical
// agreement language. Reservations created on or after this date are
// expected to accept TC_VERSION. Reservations created before are eligible
// for the unblock script (scripts/unblock-pre-terms-reservations.mjs).
export const TC_EFFECTIVE_DATE = new Date('2026-05-19T00:00:00.000Z');

// Filename of the canonical HTML rendering. Kept here so the renderer
// and the unblock script agree on which file is "current" without having
// to scan the directory.
export const TC_HTML_FILENAME = 'tc-2026-05-19.html';
