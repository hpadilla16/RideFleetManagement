/**
 * People screen — module access defaults (2026-07-25).
 *
 * The bug: buildDefaultUserModuleAccess used to be four hand-written object
 * literals that were missing every module added after they were written. The
 * checkbox rendered `!== false`, so a missing key showed CHECKED, and saving a
 * new person PUT the whole map back — persisting an explicit `true` override
 * for modules the role was never meant to have. Only the CREATE path was
 * affected; editing loads the effective config from the API.
 *
 * These tests pin the shape (never partial, never fail-open). The value-level
 * agreement with the backend's roleAllowedModuleMap is pinned separately by
 * backend/src/lib/module-access-frontend-defaults.test.mjs, which is the only
 * place both halves can be loaded at once.
 */

import { describe, it, expect } from 'vitest';
import {
  MODULE_DEFINITIONS,
  ROLE_DEFAULT_MODULES,
  buildDefaultUserModuleAccess
} from '../src/lib/moduleAccess';

const ALL_KEYS = MODULE_DEFINITIONS.map((item) => item.key);

// (personType, role) as the People form passes them.
const CASES = [
  ['HOST', ['HOST', 'AGENT']],
  ['ADMIN', ['ADMIN', 'ADMIN']],
  ['OPS', ['EMPLOYEE', 'OPS']],
  ['AGENT', ['EMPLOYEE', 'AGENT']]
];

describe('buildDefaultUserModuleAccess', () => {
  it.each(CASES)('%s returns every module key as an explicit boolean', (_label, args) => {
    const map = buildDefaultUserModuleAccess(...args);
    for (const key of ALL_KEYS) {
      expect(map, `missing key: ${key}`).toHaveProperty(key);
      expect(typeof map[key], `key ${key} is not a boolean`).toBe('boolean');
    }
    // No stray keys either — the map is PUT verbatim to the API.
    expect(Object.keys(map).sort()).toEqual([...ALL_KEYS].sort());
  });

  it('grants a HOST only dashboard and hostApp', () => {
    const map = buildDefaultUserModuleAccess('HOST', 'AGENT');
    expect(ALL_KEYS.filter((key) => map[key]).sort()).toEqual(['dashboard', 'hostApp']);
  });

  it('does not grant an AGENT the modules that used to leak in', () => {
    const map = buildDefaultUserModuleAccess('EMPLOYEE', 'AGENT');
    expect(map.paymentActions).toBe(false);
    expect(map.tolls).toBe(false);
    expect(map.kiosk).toBe(false);
    expect(map.reports).toBe(false);
    expect(map.settings).toBe(false);
    expect(map.security).toBe(false);
    expect(map.people).toBe(false);
  });

  it('never grants tenants from this screen', () => {
    for (const [, args] of CASES) {
      expect(buildDefaultUserModuleAccess(...args).tenants).toBe(false);
    }
  });

  it('falls back to the AGENT default for an unknown role', () => {
    expect(buildDefaultUserModuleAccess('EMPLOYEE', 'SOMETHING_NEW')).toEqual(
      buildDefaultUserModuleAccess('EMPLOYEE', 'AGENT')
    );
  });

  it('treats personType HOST as a host regardless of the role dropdown', () => {
    // The form can hold role=ADMIN while personType flips to HOST.
    expect(buildDefaultUserModuleAccess('HOST', 'ADMIN')).toEqual(
      buildDefaultUserModuleAccess('HOST', 'AGENT')
    );
  });

  it('is case- and blank-tolerant on both arguments', () => {
    const agent = buildDefaultUserModuleAccess('EMPLOYEE', 'AGENT');
    expect(buildDefaultUserModuleAccess('employee', 'agent')).toEqual(agent);
    expect(buildDefaultUserModuleAccess('', '')).toEqual(agent);
    expect(buildDefaultUserModuleAccess()).toEqual(agent);
  });

  it('a module added to the registry is OFF for every role until opted in', () => {
    // The safe direction, and the reason the map is derived rather than typed
    // out. Every name in ROLE_DEFAULT_MODULES must be a real key, or a typo
    // would silently deny a module instead of granting it.
    for (const [role, keys] of Object.entries(ROLE_DEFAULT_MODULES)) {
      const unknown = keys.filter((key) => !ALL_KEYS.includes(key));
      expect(unknown, `${role} lists non-existent module(s): ${unknown.join(', ')}`).toEqual([]);
    }
  });
});
