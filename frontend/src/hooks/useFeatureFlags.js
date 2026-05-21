/**
 * useFeatureFlags — frontend resolver for per-tenant feature flags (2026-05-21).
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
 *   // Multi-flag read:
 *   const { flags, effectiveStates, loading } = useFeatureFlags(token);
 *   if (flags.dejavooCounter) { ... }
 *
 *   // Single flag (convenience wrapper):
 *   const dejavooOn = useFeatureFlag(token, 'dejavooCounter');
 *
 * Spec: doc/feature-flag-convention.md
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/client';

// Module-scope cache keyed by token. Lives until page refresh. When the
// admin flips a flag via PATCH, they should call `invalidateFeatureFlags()`
// to force the next read to re-fetch.
const cache = new Map();
const inflight = new Map();

export function invalidateFeatureFlags() {
  cache.clear();
  inflight.clear();
}

async function fetchFlags(token) {
  if (!token) return { flags: {}, effectiveStates: {} };
  if (cache.has(token)) return cache.get(token);
  if (inflight.has(token)) return inflight.get(token);
  const p = api('/api/me/feature-flags', {}, token)
    .then((out) => {
      const value = {
        flags: out?.flags || {},
        effectiveStates: out?.effectiveStates || {},
      };
      cache.set(token, value);
      inflight.delete(token);
      return value;
    })
    .catch((err) => {
      inflight.delete(token);
      // Don't cache errors — let the next call retry.
      throw err;
    });
  inflight.set(token, p);
  return p;
}

/**
 * Returns { flags, effectiveStates, loading, error, reload } for the
 * current user's tenant.
 *
 *   flags             — { flagName: bool } (TEST-mode role gate applied)
 *   effectiveStates   — { flagName: 'OFF'|'TEST'|'LIVE' } (raw, useful for SUPER_ADMIN UIs)
 *
 * @param {string} token  — JWT from AuthGate
 */
export function useFeatureFlags(token) {
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
    fetchFlags(token)
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
  }, [token]);
  return {
    ...state,
    reload: () => {
      invalidateFeatureFlags();
      setState((s) => ({ ...s, loading: true }));
      fetchFlags(token).then((value) => setState({ ...value, loading: false, error: null }));
    },
  };
}

/**
 * Single-flag convenience. Returns boolean.
 */
export function useFeatureFlag(token, name) {
  const { flags } = useFeatureFlags(token);
  return !!flags[name];
}
