/**
 * VozIA Fase 4 (2026-07-03) — pure helpers for POST /reservations/:id/notes.
 * Split from reservations.routes.js so the validation matrix + marker format
 * are unit-testable (vozia-note.test.mjs) without the routes' import graph.
 */

export const VOZIA_TICKET_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const VOZIA_NOTE_TEXT_MAX = 2000;
export const VOZIA_NOTE_AUTHOR_MAX = 120;

/**
 * Validate + normalize the note payload. Returns { errors, value } —
 * errors is a list of human-readable strings (route responds 400 with
 * details when non-empty), value carries the trimmed fields.
 */
export function validateVoziaNotePayload(body = {}) {
  const errors = [];

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) errors.push('text is required (1-2000 characters)');
  else if (text.length > VOZIA_NOTE_TEXT_MAX) errors.push(`text must be ${VOZIA_NOTE_TEXT_MAX} characters or fewer`);

  const author = typeof body.author === 'string' ? body.author.trim() : '';
  if (!author) errors.push('author is required');
  else if (author.length > VOZIA_NOTE_AUTHOR_MAX) errors.push(`author must be ${VOZIA_NOTE_AUTHOR_MAX} characters or fewer`);

  const ticketId = typeof body.ticketId === 'string' ? body.ticketId.trim() : '';
  if (!ticketId || !VOZIA_TICKET_ID_RE.test(ticketId)) {
    errors.push('ticketId is required and must match ^[A-Za-z0-9._-]{1,64}$');
  }

  return { errors, value: { text, author, ticketId } };
}

/**
 * Marker format appended to Reservation.notes:
 *   [VOZIA <ticketId> <author> @<ISO>] <text>
 */
export function buildVoziaNoteLine({ ticketId, author, text, at } = {}) {
  const iso = (at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date()).toISOString();
  return `[VOZIA ${ticketId} ${author} @${iso}] ${text}`;
}
