'use client';

/**
 * Per-tenant Dejavoo terminal admin UI (2026-05-21).
 *
 * SUPER_ADMIN only. Lists DejavooTerminal rows for a tenant. Create + edit
 * + live status ping. The authKey is write-only — the backend never returns
 * it after persist (only authKeyEnc — which we don't surface).
 *
 * Backend: rounds 13-18 (specifically round 18 admin terminal CRUD).
 */

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

export default function TenantTerminalsPage({ params }) {
  return (
    <AuthGate>
      {({ token, me, logout }) => (
        <Inner tenantId={params?.id} token={token} me={me} logout={logout} />
      )}
    </AuthGate>
  );
}

const EMPTY_NEW = {
  name: '',
  tpn: '',
  authKey: '',
  merchantNumber: 1,
  callbackUrl: '',
  sandbox: true,
  notes: '',
};

function Inner({ tenantId, token, me, logout }) {
  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_NEW);
  const [editing, setEditing] = useState(null); // terminal row being edited
  const [statusBusy, setStatusBusy] = useState(null);
  const [saving, setSaving] = useState(false);

  const isSuperAdmin = useMemo(() => {
    return String(me?.role || '').toUpperCase() === 'SUPER_ADMIN';
  }, [me]);

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const out = await api(
        `/api/admin/payment-gateway/terminals?tenantId=${encodeURIComponent(tenantId)}`,
        {},
        token
      );
      setTerminals(out?.terminals || []);
    } catch (e) {
      setError(e.message || 'Failed to load terminals');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tenantId && token && isSuperAdmin) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, token, isSuperAdmin]);

  const submitNew = async () => {
    setError('');
    setMsg('');
    if (!newForm.name?.trim()) return setError('Name is required');
    if (!newForm.tpn?.trim()) return setError('TPN is required');
    if (!newForm.authKey?.trim()) return setError('Auth Key is required');
    setSaving(true);
    try {
      await api(
        `/api/admin/payment-gateway/terminals`,
        {
          method: 'POST',
          body: JSON.stringify({
            tenantId,
            name: newForm.name.trim(),
            tpn: newForm.tpn.trim(),
            authKey: newForm.authKey,
            merchantNumber: Number(newForm.merchantNumber) || 1,
            callbackUrl: newForm.callbackUrl || null,
            sandbox: !!newForm.sandbox,
            notes: newForm.notes || null,
          }),
        },
        token
      );
      setMsg('Terminal created.');
      setNewForm(EMPTY_NEW);
      setShowNew(false);
      await load();
    } catch (e) {
      setError(e.message || 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  const submitEdit = async () => {
    if (!editing) return;
    setError('');
    setMsg('');
    setSaving(true);
    try {
      const body = {
        name: editing.name,
        merchantNumber: editing.merchantNumber,
        callbackUrl: editing.callbackUrl,
        sandbox: editing.sandbox,
        status: editing.status,
        notes: editing.notes,
      };
      if (editing._newAuthKey) {
        body.authKey = editing._newAuthKey;
      }
      await api(
        `/api/admin/payment-gateway/terminals/${editing.id}`,
        { method: 'PUT', body: JSON.stringify(body) },
        token
      );
      setMsg('Terminal updated.');
      setEditing(null);
      await load();
    } catch (e) {
      setError(e.message || 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const pingStatus = async (terminal) => {
    setStatusBusy(terminal.id);
    setError('');
    try {
      const out = await api(
        `/api/admin/payment-gateway/terminals/${terminal.id}/status`,
        {},
        token
      );
      setMsg(
        out?.connected
          ? `${terminal.name}: Connected ✓`
          : `${terminal.name}: ${out?.error || 'Not connected'}`
      );
      // Refresh to pick up lastSeenAt
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setStatusBusy(null);
    }
  };

  if (!isSuperAdmin) {
    return (
      <AppShell me={me} logout={logout}>
        <section className="glass card-lg stack">
          <h2>Forbidden</h2>
          <p className="ui-muted">Only SUPER_ADMIN users can manage Dejavoo terminals.</p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between">
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow">Admin · Dejavoo Terminals</span>
            <h2 style={{ margin: 0 }}>Counter terminals</h2>
            <p className="ui-muted" style={{ marginTop: 4, marginBottom: 0 }}>
              Tenant: <code>{tenantId}</code>
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={load} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button
              className="btn primary"
              onClick={() => setShowNew((v) => !v)}
            >
              {showNew ? 'Cancel' : '+ Add terminal'}
            </button>
          </div>
        </div>

        {error && <div className="app-banner danger">{error}</div>}
        {msg && <div className="app-banner success">{msg}</div>}

        {/* New terminal form */}
        {showNew && (
          <div className="card stack" style={{ gap: 12, padding: 16 }}>
            <h3 style={{ margin: 0 }}>New terminal</h3>
            <FormGrid>
              <Field label="Name">
                <input
                  className="input"
                  value={newForm.name}
                  onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
                  placeholder="Counter — SJU Airport"
                />
              </Field>
              <Field label="TPN (Terminal Profile Number)">
                <input
                  className="input"
                  value={newForm.tpn}
                  onChange={(e) => setNewForm({ ...newForm, tpn: e.target.value })}
                  placeholder="From Dejavoo portal"
                />
              </Field>
              <Field label="Auth Key (encrypted on save)">
                <input
                  className="input"
                  type="password"
                  value={newForm.authKey}
                  onChange={(e) => setNewForm({ ...newForm, authKey: e.target.value })}
                  placeholder="Long secret string"
                />
              </Field>
              <Field label="Merchant Number">
                <input
                  className="input"
                  type="number"
                  min="1"
                  value={newForm.merchantNumber}
                  onChange={(e) =>
                    setNewForm({ ...newForm, merchantNumber: e.target.value })
                  }
                />
              </Field>
              <Field label="Callback URL (optional)">
                <input
                  className="input"
                  value={newForm.callbackUrl}
                  onChange={(e) =>
                    setNewForm({ ...newForm, callbackUrl: e.target.value })
                  }
                  placeholder="Defaults to SPIN_CALLBACK_URL env"
                />
              </Field>
              <Field label="Sandbox?">
                <select
                  className="input"
                  value={newForm.sandbox ? 'true' : 'false'}
                  onChange={(e) =>
                    setNewForm({ ...newForm, sandbox: e.target.value === 'true' })
                  }
                >
                  <option value="true">Yes — sandbox (test.spinpos.net)</option>
                  <option value="false">No — production (api.spinpos.net)</option>
                </select>
              </Field>
            </FormGrid>
            <Field label="Notes (optional)">
              <textarea
                className="input"
                rows={2}
                value={newForm.notes}
                onChange={(e) => setNewForm({ ...newForm, notes: e.target.value })}
              />
            </Field>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setShowNew(false)} disabled={saving}>
                Cancel
              </button>
              <button className="btn primary" onClick={submitNew} disabled={saving}>
                {saving ? 'Creating…' : 'Create terminal'}
              </button>
            </div>
          </div>
        )}

        {/* Terminal list */}
        {!loading && terminals.length === 0 && (
          <p className="ui-muted">No terminals configured for this tenant yet.</p>
        )}
        <div className="stack" style={{ gap: 12 }}>
          {terminals.map((t) => (
            <TerminalCard
              key={t.id}
              terminal={t}
              onEdit={() => setEditing({ ...t, _newAuthKey: '' })}
              onPing={() => pingStatus(t)}
              pinging={statusBusy === t.id}
            />
          ))}
        </div>
      </section>

      {/* Edit modal */}
      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <h3 style={{ marginTop: 0 }}>Edit terminal</h3>
          <p className="ui-muted">
            <code>{editing.tpn}</code> · created{' '}
            {new Date(editing.createdAt).toLocaleString()}
          </p>
          <FormGrid>
            <Field label="Name">
              <input
                className="input"
                value={editing.name || ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Status">
              <select
                className="input"
                value={editing.status}
                onChange={(e) => setEditing({ ...editing, status: e.target.value })}
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="INACTIVE">INACTIVE</option>
              </select>
            </Field>
            <Field label="Merchant Number">
              <input
                className="input"
                type="number"
                value={editing.merchantNumber || 1}
                onChange={(e) =>
                  setEditing({ ...editing, merchantNumber: Number(e.target.value) || 1 })
                }
              />
            </Field>
            <Field label="Callback URL">
              <input
                className="input"
                value={editing.callbackUrl || ''}
                onChange={(e) => setEditing({ ...editing, callbackUrl: e.target.value })}
              />
            </Field>
            <Field label="Sandbox?">
              <select
                className="input"
                value={editing.sandbox ? 'true' : 'false'}
                onChange={(e) =>
                  setEditing({ ...editing, sandbox: e.target.value === 'true' })
                }
              >
                <option value="true">Yes — sandbox</option>
                <option value="false">No — production</option>
              </select>
            </Field>
            <Field label="Rotate Auth Key (leave blank to keep current)">
              <input
                className="input"
                type="password"
                value={editing._newAuthKey || ''}
                onChange={(e) => setEditing({ ...editing, _newAuthKey: e.target.value })}
                placeholder="Paste a new key to rotate"
              />
            </Field>
          </FormGrid>
          <Field label="Notes">
            <textarea
              className="input"
              rows={3}
              value={editing.notes || ''}
              onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
            />
          </Field>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn ghost" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </button>
            <button className="btn primary" onClick={submitEdit} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </Modal>
      )}
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function TerminalCard({ terminal, onEdit, onPing, pinging }) {
  const lastSeen = terminal.lastSeenAt
    ? new Date(terminal.lastSeenAt).toLocaleString()
    : 'Never';
  const isActive = terminal.status === 'ACTIVE';
  return (
    <div className="card stack" style={{ gap: 8, padding: 16 }}>
      <div className="row-between">
        <div className="stack" style={{ gap: 4 }}>
          <h3 style={{ margin: 0 }}>
            {terminal.name}{' '}
            <span
              className={`status-chip ${isActive ? 'good' : ''}`}
              style={{ fontSize: '0.7em', marginLeft: 8 }}
            >
              {terminal.status}
            </span>
            {terminal.sandbox && (
              <span
                className="status-chip warn"
                style={{ fontSize: '0.7em', marginLeft: 4 }}
              >
                SANDBOX
              </span>
            )}
          </h3>
          <p className="ui-muted" style={{ margin: 0, fontSize: '0.9em' }}>
            TPN <code>{terminal.tpn}</code> · Merchant #{terminal.merchantNumber} ·
            Last seen {lastSeen}
          </p>
          {terminal.notes && (
            <p className="ui-muted" style={{ margin: 0, fontSize: '0.85em' }}>
              {terminal.notes}
            </p>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={onPing} disabled={pinging}>
            {pinging ? 'Pinging…' : 'Ping'}
          </button>
          <button className="btn ghost" onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small layout primitives
// ---------------------------------------------------------------------------

function FormGrid({ children }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label
      style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.9em' }}
    >
      <span style={{ fontWeight: 600, color: 'var(--color-fg, #1f2937)' }}>{label}</span>
      {children}
    </label>
  );
}

function Modal({ children, onClose }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-lg"
        style={{
          maxWidth: 720,
          width: '100%',
          padding: 24,
          background: 'white',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        {children}
      </div>
    </div>
  );
}
