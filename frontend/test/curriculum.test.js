import { describe, it, expect } from 'vitest';
import {
  COURSES,
  TOUR_TRACKS,
  allModules,
  findModule,
  modulesFor,
  pointsAvailable,
  stepsForTrack,
  stepsForModule,
} from '../src/lib/training/curriculum.js';

const AGENT = { role: 'AGENT' };
const ADMIN = { role: 'ADMIN' };

describe('curriculum integrity', () => {
  it('every module key is unique — progress is stored against it', () => {
    const keys = allModules().map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every step names an anchor, and every module names roles and points', () => {
    for (const m of allModules()) {
      expect(Array.isArray(m.roles) && m.roles.length, `${m.key} roles`).toBeTruthy();
      expect(Number.isFinite(m.points), `${m.key} points`).toBe(true);
      expect(Array.isArray(m.steps) && m.steps.length, `${m.key} steps`).toBeTruthy();
      for (const s of m.steps) {
        expect(typeof s.anchor === 'string' && s.anchor.length, `${m.key} step anchor`).toBeTruthy();
        expect(typeof s.title === 'string' && s.title.length, `${m.key} step title`).toBeTruthy();
        expect(typeof s.body === 'string' && s.body.length, `${m.key} step body`).toBeTruthy();
      }
    }
  });

  it('a verifiable module is never also a read-only one', () => {
    for (const m of allModules()) {
      if (m.verify) expect(['ON_DEMAND', 'OPPORTUNISTIC']).toContain(m.kind);
    }
  });

  it('nothing that writes to the business can be done on demand', () => {
    // The rule that keeps training from manufacturing work: a module you can
    // pass "right now" must not be one that holds inventory or moves money.
    // Both of the offenders were ON_DEMAND when first written.
    for (const m of allModules()) {
      if (m.verify) {
        expect(m.kind, `${m.key} would have trainees creating real records to earn points`).toBe('OPPORTUNISTIC');
      }
    }
  });

  it('every module gate is a real tenant module', () => {
    // A typo here silently hides a module from everyone, forever.
    const known = new Set(['reservations', 'reports', 'settings', 'people', 'marketIntelligence',
      'dashboard', 'quotes', 'planner', 'vehicles', 'customers', 'tolls', 'citations', 'maintenance']);
    for (const m of allModules()) {
      if (m.gate) expect(known, `${m.key} gates on an unknown module: ${m.gate}`).toContain(m.gate);
    }
  });

  it('a super admin sees everything an admin sees', () => {
    // users-and-locations shipped listing ADMIN only — an oversight nothing
    // caught, because the suite only pinned ADMIN > AGENT.
    const admin = new Set(modulesFor({ role: 'ADMIN' }).map((m) => m.key));
    const missing = [...admin].filter((k) => !modulesFor({ role: 'SUPER_ADMIN' }).some((m) => m.key === k));
    expect(missing, `A super admin cannot see: ${missing.join(', ')}`).toEqual([]);
  });

  it('showcase positions are unique so the demo order is deterministic', () => {
    const pos = allModules().map((m) => m.showcase).filter((n) => Number.isFinite(n));
    expect(new Set(pos).size).toBe(pos.length);
  });
});

describe('role filtering — an agent must never be toured through Settings', () => {
  it('excludes admin-only modules for an agent', () => {
    const keys = modulesFor(AGENT).map((m) => m.key);
    expect(keys).not.toContain('users-and-locations');
    expect(keys).not.toContain('incoming-bookings');
    expect(keys).not.toContain('market-pricing');
  });

  it('keeps the counter modules for an agent', () => {
    const keys = modulesFor(AGENT).map((m) => m.key);
    expect(keys).toContain('create-reservation');
    expect(keys).toContain('check-in');
  });

  it('gives an admin strictly more than an agent', () => {
    expect(modulesFor(ADMIN).length).toBeGreaterThan(modulesFor(AGENT).length);
  });
});

describe('tenant module gating', () => {
  it('drops modules whose tenant module is off', () => {
    const noMarket = { role: 'ADMIN', isModuleEnabled: (g) => g !== 'marketIntelligence' };
    expect(modulesFor(noMarket).map((m) => m.key)).not.toContain('market-pricing');
  });

  it('an ungated module survives every gate being off', () => {
    const nothing = { role: 'AGENT', isModuleEnabled: () => false };
    expect(modulesFor(nothing).map((m) => m.key)).toContain('the-workspace');
  });
});

describe('points', () => {
  it('weights money-touching work above navigation', () => {
    expect(findModule('check-out').points).toBeGreaterThan(findModule('find-reservation').points);
    expect(findModule('create-reservation').points).toBeGreaterThan(findModule('the-workspace').points);
  });

  it('an agent has a smaller total than an admin', () => {
    expect(pointsAvailable(AGENT)).toBeLessThan(pointsAvailable(ADMIN));
    expect(pointsAvailable(AGENT)).toBeGreaterThan(0);
  });
});

describe('tracks', () => {
  it('showcase ignores role and runs in its own order', () => {
    const steps = stepsForTrack(TOUR_TRACKS.SHOWCASE, AGENT);
    const order = [];
    for (const s of steps) if (!order.includes(s.moduleKey)) order.push(s.moduleKey);
    // 1 workspace, 2 incoming bookings, 3 create, 4 checkout, 5 checkin, 6 overdue, 7 market
    expect(order[0]).toBe('the-workspace');
    expect(order[1]).toBe('incoming-bookings');
    expect(order[order.length - 1]).toBe('market-pricing');
    // admin-only content is present even though the viewer is an agent
    expect(order).toContain('market-pricing');
  });

  it('onboarding respects the viewer', () => {
    const steps = stepsForTrack(TOUR_TRACKS.ONBOARDING, AGENT);
    expect(steps.every((s) => s.moduleKey !== 'market-pricing')).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });

  it('a single module returns just its own steps', () => {
    const steps = stepsForModule('create-reservation');
    expect(steps.length).toBe(findModule('create-reservation').steps.length);
    expect(steps.every((s) => s.moduleKey === 'create-reservation')).toBe(true);
  });

  it('an unknown module key is empty, not an exception', () => {
    expect(stepsForModule('nope')).toEqual([]);
    expect(findModule('nope')).toBeNull();
  });
});

describe('courses', () => {
  it('every course has a key, a title and at least one module', () => {
    for (const c of COURSES) {
      expect(c.key).toBeTruthy();
      expect(c.title).toBeTruthy();
      expect(c.modules.length).toBeGreaterThan(0);
    }
  });
});
