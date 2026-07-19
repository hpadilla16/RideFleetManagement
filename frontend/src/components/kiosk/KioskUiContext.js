'use client';

/**
 * Shared seam between the KioskShell chrome (app/kiosk/layout.js — header,
 * EN/ES, Help, idle handling) and the wizard page (app/kiosk/page.js).
 *
 * - device / setDevice: paired-device info shown in the header, kept in sync
 *   with localStorage by the page (pairing / 401-unpair).
 * - setSessionActive: the page arms/disarms the shell's 2-minute idle watch
 *   (only mid-session — the WELCOME attract screen never idles out).
 * - onIdleReset: the page registers the wipe-session handler the shell calls
 *   when the K-E1 countdown expires or the customer taps "Start over".
 * - helpTick: bumped by the shell's Help button; the page reacts by opening
 *   the help / escalate sheet.
 */

import { createContext, useContext } from 'react';

// Fired (window CustomEvent) when the shell's boot refresh discovers the
// device token was rotated/revoked (401 → storage wiped) so the wizard page
// can jump to the pairing screen without waiting for its next API call.
export const KIOSK_UNPAIRED_EVENT = 'ride-kiosk-unpaired';

export const KioskUiContext = createContext({
  device: null,
  setDevice: () => {},
  setSessionActive: () => {},
  onIdleReset: () => {},
  helpTick: 0,
  // Footer connectivity dot — the wizard flips this on network failures.
  online: true,
  setOnline: () => {},
  // Per-phase idle-threshold override in ms (null = default 2 min). Used by
  // the B3e name-update code screen: email delivery takes 1-3 min and the
  // default idle wipe would kill the flow mid-wait. Scope overrides narrowly
  // and always reset to null on leave.
  setIdleMs: () => {},
  // Programmatic activity signal — e.g. authenticated VozIA postMessage
  // traffic (B3f): a guest chatting with Chloe generates no shell touches,
  // and the idle wipe must not kill a genuinely live conversation.
  noteActivity: () => {},
});

export function useKioskUi() {
  return useContext(KioskUiContext);
}
