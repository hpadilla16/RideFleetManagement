'use client';

/**
 * Settings → Access → Two-Factor Authentication policy (2026-08-22).
 *
 * GET/PUT /api/settings/two-factor-policy. ADMIN sets the policy for their
 * tenant; a SUPER_ADMIN (unscoped) sets the GLOBAL default that applies to any
 * tenant without its own override. The policy compels the selected roles to
 * enroll in 2FA at login — it never affects users whose role is not listed, and
 * an empty/disabled policy is a full no-op (login is unchanged).
 */

import { useEffect, useState } from 'react';
import { api } from '../../lib/client';

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPS', 'AGENT'];

export function TwoFactorPolicySettings({ token, scopedPath }) {
  const [enabled, setEnabled] = useState(false);
  const [requiredRoles, setRequiredRoles] = useState([]);
  const [graceUntil, setGraceUntil] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const path = () => (scopedPath ? scopedPath('/api/settings/two-factor-policy') : '/api/settings/two-factor-policy');

  const load = async () => {
    try {
      const out = await api(path(), { bypassCache: true }, token);
      setEnabled(!!out.enabled);
      setRequiredRoles(Array.isArray(out.requiredRoles) ? out.requiredRoles : []);
      setGraceUntil(out.graceUntil ? String(out.graceUntil).slice(0, 10) : '');
    } catch (e) {
      setMsg(e.message);
    }
  };
  useEffect(() => { load(); }, [token]);

  const toggleRole = (role) => {
    setRequiredRoles((cur) => (cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role]));
  };

  const save = async () => {
    setMsg('');
    try {
      setBusy(true);
      const out = await api(path(), {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          requiredRoles,
          graceUntil: graceUntil ? new Date(`${graceUntil}T23:59:59`).toISOString() : null
        })
      }, token);
      setEnabled(!!out.enabled);
      setRequiredRoles(Array.isArray(out.requiredRoles) ? out.requiredRoles : []);
      setMsg('Two-factor policy saved.');
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h2>Two-Factor Authentication Policy</h2>
      <div className="surface-note">
        When enabled, staff in the selected roles must set up an authenticator app before they can
        use the workspace. Already-enrolled users are always prompted for a code at login. Roles that
        are not selected — and a disabled policy — are unaffected.
      </div>
      {msg ? <div className="label">{msg}</div> : null}
      <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require two-factor authentication
      </label>
      <div className="label">Required roles</div>
      <div className="service-checks-grid">
        {ROLES.map((role) => (
          <label key={role} className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            <input
              type="checkbox"
              checked={requiredRoles.includes(role)}
              onChange={() => toggleRole(role)}
              disabled={!enabled}
            /> {role}
          </label>
        ))}
      </div>
      <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
        Grace period until (optional)
        <input type="date" value={graceUntil} onChange={(e) => setGraceUntil(e.target.value)} disabled={!enabled} />
      </label>
      <div className="inline-actions">
        <button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save two-factor policy'}</button>
      </div>
    </div>
  );
}

export default TwoFactorPolicySettings;
