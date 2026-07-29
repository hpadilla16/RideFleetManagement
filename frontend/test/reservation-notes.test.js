/** Unit tests for the notes display helpers (LAX #12/#13). */
import { describe, it, expect } from 'vitest';
import { displayNoteLines, hasDisplayNotes, isRecentNote } from '@/lib/reservation-notes';

describe('displayNoteLines', () => {
  it('keeps human lines and drops system markers', () => {
    const notes = [
      'cliente llega tarde, esperar hasta las 10pm',
      '[UNDERAGE ALERT] Customer age 22 is below alert threshold 25',
      '[RES_CHECKOUT 2026-07-28T10:00:00Z] odometerOut=1000',
      'revisar deposito con el manager',
      '[CANCELLED 2026-07-01T00:00:00Z] by X: dup',
    ].join('\n');
    expect(displayNoteLines(notes)).toEqual([
      'cliente llega tarde, esperar hasta las 10pm',
      'revisar deposito con el manager',
    ]);
  });

  it('keeps VozIA notes, reformatted with the author', () => {
    const notes = '[VOZIA TCK-99 Maria Lopez @2026-07-28T10:00:00Z] el cliente pide silla de bebe';
    expect(displayNoteLines(notes)).toEqual(['el cliente pide silla de bebe — Maria Lopez (VozIA)']);
  });

  it('empty / marker-only notes have nothing to display', () => {
    expect(hasDisplayNotes('')).toBe(false);
    expect(hasDisplayNotes(null)).toBe(false);
    expect(hasDisplayNotes('[UNDERAGE ALERT] Customer age 20 is below alert threshold 21')).toBe(false);
  });
});

describe('isRecentNote', () => {
  it('recent within the window, stale outside, robust to junk', () => {
    expect(isRecentNote(new Date(Date.now() - 3600e3).toISOString())).toBe(true);
    expect(isRecentNote(new Date(Date.now() - 72 * 3600e3).toISOString())).toBe(false);
    expect(isRecentNote(null)).toBe(false);
    expect(isRecentNote('garbage')).toBe(false);
  });
});
