/**
 * useFeatureFlags — frontend resolver for per-tenant feature flags (2026-05-21,
 * SUPER_ADMIN scoping added 2026-05-22 in round 25).
 *
 * Reads from `GET /api/me/feature-flags` which returns the user's effective
 * flag state — the TEST-mode role gate is applied server-side. The hook
 * caches the result in module scope for the session so multiple call sites
 * don't trigger duplicate fetches.
 *
 * Usage:
 *
 *   import { useFeatureFlags, useFeatureFlag } from '../../hooks/useFeatureFlags';
 *
 *   // Normal tenanted user (ADMIN, AGENT, OPS) — JWT tenantId is used:
 *   const { flags, effectiveStates, loading } = useFeatureFlags(token);
 *   if (flags.dejavooCounter) { ... }
 *
 *   // SUPER_ADMIN viewing a specific tenant — pass tenantId so the resolver
 *   // returns THAT tenant's flag state instead of empty {}:
 *   const { flags } = useFeatureFlags(token, reservation.tenantId);
 *
 *   // Single flag (convenience wrapper):
 *   const dejavooOn = useFeatureFlag(token, 'dejavooCounter');
 *   const dejavooOn = useFeatureFlag(token, 'dejavooCounter', tenant.id);
 *
 * Spec: doc/feature-flag-convention.md
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/client';

// Module-scope cache keyed by `${token}|${tenantId||''}` so that SUPER_ADMIN
// can switch tenants without seeing stale flags. Lives until page refresh.
// When the admin flips a flag via PATCH, they should call
// `invalidateFeatureFlags()` to force the next read to re-fetch.
const cache = new Map();
const inflight = new Map();

function keyFor(token, tenantId) {
  return `${token || ''}|${tenantId || ''}`;
}

export function invalidateFeatureFlags() {
  cache.clear();
  inflight.clear();
}

async function fetchFlags(token, tenantId) {
  if (!token) return { flags: {}, effectiveStates: {} };
  const key = keyFor(token, tenantId);
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  // SUPER_ADMIN can pass ?tenantId= to view a specific tenant's flags.
  // Normal users ignore the param (server uses their JWT tenantId).
  const url = tenantId
    ? `/api/me/feature-flags?tenantId=${encodeURIComponent(tenantId)}`
    : '/api/me/feature-flags';
  const p = api(url, {}, token)
    .then((out) => {
      const value = {
        flags: out?.flags || {},
        effectiveStates: out?.effectiveStates || {},
      };
      cache.set(key, value);
      inflight.delete(key);
      return value;
    })
    .catch((err) => {
      inflight.delete(key);
      // Don't cache errors — let the next call retry.
      throw err;
    });
  inflight.set(key, p);
  return p;
}

/**
 * Returns { flags, effectiveStates, loading, error, reload } for the
 * current user's tenant — or for the explicitly-passed tenant if the user
 * is a SUPER_ADMIN viewing another tenant's data.
 *
 *   flags             — { flagName: bool } (TEST-mode role gate applied)
 *   effectiveStates   — { flagName: 'OFF'|'TEST'|'LIVE' } (raw, useful for SUPER_ADMIN UIs)
 *
 * @param {string} token     — JWT from AuthGate
 * @param {string|null} [tenantId] — optional explicit tenant id (SUPER_ADMIN use)
 */
export function useFeatureFlags(token, tenantId = null) {
  const [state, setState] = useState({
    flags: {},
    effectiveStates: {},
    loading: !!token,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setState({ flags: {}, effectiveStates: {}, loading: false, error: null });
      return () => {};
    }
    setState((s) => ({ ...s, loading: true }));
    fetchFlags(token, tenantId)
      .then((value) => {
        if (cancelled) return;
        setState({ ...value, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ flags: {}, effectiveStates: {}, loading: false, error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [token, tenantId]);
  return {
    ...state,
    reload: () => {
      invalidateFeatureFlags();
      setState((s) => ({ ...s, loading: true }));
      fetchFlags(token, tenantId).then((value) => setState({ ...value, loading: false, error: null }));
    },
  };
}

/**
 * Single-flag convenience. Returns boolean.
 *
 * @param {string} token
 * @param {string} name
 * @param {string|null} [tenantId] — optional SUPER_ADMIN tenant scope
 */
export function useFeatureFlag(token, name, tenantId = null) {
  const { flags } = useFeatureFlags(token, tenantId);
  return !!flags[name];
}
