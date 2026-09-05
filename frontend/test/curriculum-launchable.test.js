/**
 * Every module must be LAUNCHABLE from Ride University.
 *
 * The bug this exists for (Hector, 2026-08-17: "show me again no está
 * reiniciando"): check-out, check-in and take-payment walk you through a
 * single reservation's own page, so their anchors cannot exist until one is
 * open. Started from Ride University the state machine correctly ended them
 * as BROKEN — and the host rendered nothing for BROKEN, so the button looked
 * dead. Three of the four hands-on modules, silently unreachable.
 *
 * The rule: a first step with no `route` means the walkthrough lives inside a
 * record, and the module must say where to find one. The host renders that as
 * guidance instead of dying.
 */
import { describe, it, expect } from 'vitest';
import { allModules, stepsForModule, isVirtualStep } from '../src/lib/training/curriculum.js';
import { startTour, settleStart, advance, waitForRecord, resumeAt, TOUR_END } from '../src/lib/training/tour-state.js';

describe('every module can be started from Ride University', () => {
  it('a module whose first step has no route declares where to find a record', () => {
    const stranded = allModules()
      .filter((m) => {
        const first = (m.steps || [])[0];
        // A drawn or asked first step lives inside the tour card — it is present
        // on every page, so the module can always start (kiosk course, 2026-09-04).
        return first && !first.route && !m.needsRecord && !isVirtualStep(first);
      })
      .map((m) => m.key);
    expect(
      stranded,
      'These modules start on an anchor that only exists inside an open record, '
      + 'but do not say where to find one — launching them from Ride University '
      + 'would end as BROKEN with nothing on screen:\n  ' + stranded.join('\n  '),
    ).toEqual([]);
  });

  it('needsRecord modules do end as BROKEN when launched cold — the host must handle it', () => {
    // Pins the contract the host's guidance card depends on: away from the
    // record, these resolve to BROKEN and carry a moduleKey to explain with.
    const recordScoped = allModules().filter((m) => m.needsRecord);
    expect(recordScoped.length).toBeGreaterThan(0);
    for (const m of recordScoped) {
      const steps = stepsForModule(m.key);
      const settled = settleStart(startTour({ track: 'MODULE', steps, moduleKey: m.key }), steps, () => false);
      expect(settled.endedAs, `${m.key} should be BROKEN when no anchor is present`).toBe(TOUR_END.BROKEN);
      expect(settled.moduleKey, `${m.key} must carry its key so the card can name it`).toBe(m.key);
    }
  });

  it('needsRecord points at a route the curriculum itself uses', () => {
    const routes = new Set();
    for (const m of allModules()) for (const s of m.steps || []) if (s.route) routes.add(s.route);
    for (const m of allModules().filter((x) => x.needsRecord)) {
      expect(routes.has(m.needsRecord), `${m.key}.needsRecord (${m.needsRecord}) is not a route the app tours`).toBe(true);
    }
  });
});

describe('a parked tour resumes wherever the person actually is', () => {
  it('picks up at the step on screen, not always the first', () => {
    const steps = stepsForModule('check-out');
    const parked = waitForRecord(startTour({ track: 'MODULE', steps, moduleKey: 'check-out' }));

    // Nothing open yet: keep waiting rather than resume or break.
    expect(resumeAt(parked, steps, () => false)).toBeNull();

    // On the reservation page — the first step's button is there.
    const onReservation = resumeAt(parked, steps, (a) => a === steps[0].anchor);
    expect(onReservation.index).toBe(0);
    expect(onReservation.waiting).toBeUndefined();

    // They pressed the button and moved into the wizard: the first step's
    // anchor is GONE and later ones exist. This is the case that left the
    // tour waiting forever on a page full of its own anchors.
    const inWizard = resumeAt(parked, steps, (a) => a === steps[1].anchor);
    expect(inWizard.index).toBe(1);
    expect(inWizard.endedAs).toBeNull();
  });

  it('resuming clears the parked flag so the host stops polling', () => {
    const steps = stepsForModule('take-payment');
    const parked = waitForRecord(startTour({ track: 'MODULE', steps, moduleKey: 'take-payment' }));
    expect(parked.waiting).toBe(true);
    const resumed = resumeAt(parked, steps, () => true);
    expect('waiting' in resumed).toBe(false);
  });
});

describe('a record-scoped tour parks mid-flight instead of breaking', () => {
  it('advancing past the on-screen step parks rather than ending BROKEN', () => {
    const steps = stepsForModule('check-out');
    // On the reservation page: step 0 visible, the wizard steps are not.
    const onReservation = (a) => a === steps[0].anchor;
    let state = settleStart(startTour({ track: 'MODULE', steps, moduleKey: 'check-out' }), steps, onReservation);
    expect(state.index).toBe(0);

    // Pressing Next looks for step 1, which lives inside the check-out
    // wizard — the screen they have not opened yet.
    const advanced = advance(state, steps, onReservation);
    expect(advanced.endedAs).toBe(TOUR_END.BROKEN);

    // The host must convert that into a park, flagged as mid-tour so the copy
    // says "open the next screen", not "open a reservation" — they are in one.
    const parked = waitForRecord(advanced, { midTour: true });
    expect(parked.waiting).toBe(true);
    expect(parked.midTour).toBe(true);
    expect(parked.endedAs).toBeNull();

    // And once they reach the wizard, the guide resumes on its own step.
    const inWizard = resumeAt(parked, steps, (a) => a === steps[1].anchor);
    expect(inWizard.index).toBe(1);
  });

  it('parking before anything was shown is NOT flagged mid-tour', () => {
    const steps = stepsForModule('check-in');
    const cold = settleStart(startTour({ track: 'MODULE', steps, moduleKey: 'check-in' }), steps, () => false);
    const parked = waitForRecord(cold, { midTour: (cold.index || 0) > 0 });
    expect(parked.midTour).toBe(false);
  });
});
