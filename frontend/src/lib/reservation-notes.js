/**
 * Reservation-notes display helpers (2026-07-28, LAX #12/#13).
 *
 * Reservation.notes is a mixed bag: agent-written free text PLUS system
 * marker lines the backend splices in (`[UNDERAGE ALERT] …`, `[VOZIA …] …`,
 * `[CANCELLED …]`, `[RES_CHECKOUT …]`, …). The wizards and the "new note"
 * banner should surface what a PERSON wrote, not the machine log — with one
 * exception: [VOZIA …] lines ARE agent notes (left through the phone bot),
 * so they stay, lightly reformatted.
 */

/** Lines a human should read: free text + VozIA notes; system markers dropped. */
export function displayNoteLines(notes) {
  const lines = String(notes || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (!line.startsWith('[')) { out.push(line); continue; }
    const vozia = line.match(/^\[VOZIA\s+(\S+)\s+([^\]@]+?)\s*@[^\]]*\]\s*(.*)$/i);
    if (vozia) {
      const text = vozia[3].trim();
      if (text) out.push(`${text} — ${vozia[2].trim()} (VozIA)`);
    }
    // every other [TAG …] line is machine log — skip
  }
  return out;
}

/** True when the reservation carries human-readable notes. */
export function hasDisplayNotes(notes) {
  return displayNoteLines(notes).length > 0;
}

/** "New note" recency window for banners/pills (default 48h). */
export function isRecentNote(notesUpdatedAt, hours = 48) {
  if (!notesUpdatedAt) return false;
  const t = new Date(notesUpdatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= hours * 3600 * 1000;
}

/** Short relative label for the banner ("hace 3 h", "hace 2 d"). */
export function relativeNoteAge(notesUpdatedAt) {
  if (!notesUpdatedAt) return '';
  const ms = Date.now() - new Date(notesUpdatedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `hace ${Math.max(1, mins)} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}
