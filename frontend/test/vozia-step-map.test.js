// Every kiosk screen that can hold a guest must resolve to a co-presence step — or be a deliberate
// overlay that reuses the last real one.
//
// 2026-09-03: the agent's Kiosk tab read "no state reported" for an entire live session. Cause:
// `postVoziaState` did `if (!step) return`, and SCREEN_TO_STEP was missing six of the fifteen
// screens the kiosk actually drives — including WELCOME, where a guest most naturally taps Ayuda,
// and ESCALATED, which is literally the help screen. Measured in Valet's database: of eleven kiosk
// conversations ever created, exactly ONE carried a state, from the July E2E.
//
// This test reads the screen names out of the kiosk page itself, so a screen added later cannot
// quietly reintroduce the silence: it must be classified as a funnel step or as an overlay.
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VOZIA_STEPS, voziaStepForScreen } from '../src/lib/voziaBridge.js';

/** Screens that are NOT positions in the funnel: they can happen at any step, so they map to null
 *  on purpose and the caller reports the last real step instead of inventing one. */
// WALKUP_SOON salio de aqui: su UNICO predecesor es WELCOME, asi que
// find_reservation es verdad y un walk-up que pide ayuda ya no queda mudo.
const OVERLAY_SCREENS = new Set(['ESCALATED', 'PAIRING', 'OUT_OF_SERVICE']);

const page = readFileSync(resolve('src/app/kiosk/page.js'), 'utf8');
const screens = [...new Set([
  ...[...page.matchAll(/setScreen\('([A-Z_]+)'\)/g)].map((m) => m[1]),
  'BOOT', // the initial useState, never reached through setScreen
])].sort();

test('every screen the kiosk drives is either a funnel step or a declared overlay', () => {
  const unclassified = screens.filter((s) => !voziaStepForScreen(s) && !OVERLAY_SCREENS.has(s));
  expect(unclassified, `these screens report NOTHING and are not declared overlays: ${unclassified.join(', ')}`).toEqual([]);
});

test('the screens a guest asks for help from resolve to a real step', () => {
  // WELCOME and BOOT are the start of the funnel: the guest has not found their reservation yet.
  expect(voziaStepForScreen('WELCOME')).toBe('find_reservation');
  expect(voziaStepForScreen('BOOT')).toBe('find_reservation');
});

test('overlays map to null ON PURPOSE — inventing a step would lie about where the guest is', () => {
  for (const s of OVERLAY_SCREENS) {
    expect(voziaStepForScreen(s), `${s} must not claim a funnel position`).toBe(null);
  }
});

test('every mapped step is a value the contract accepts (Valet 400s on anything else)', () => {
  for (const s of screens) {
    const step = voziaStepForScreen(s);
    if (step) expect(VOZIA_STEPS.includes(step), `${s} → ${step} is not in the contract enum`).toBe(true);
  }
});
