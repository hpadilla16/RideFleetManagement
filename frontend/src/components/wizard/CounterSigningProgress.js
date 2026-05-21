'use client';

/**
 * CounterSigningProgress — full-screen progress UI while the customer
 * signs the agreement on the Dejavoo P1 terminal (2026-05-21).
 *
 * Flow:
 *   1. On mount, POST /api/payment-gateway/counter/start-checkin
 *      → returns { surface, terminalId, jobId, pollUrl }
 *   2. If surface === 'DEJAVOO_TERMINAL' → poll GET /reservations/:id/signing
 *      every POLL_INTERVAL_MS until status === 'COMPLETED' | 'REFUSED'
 *   3. If surface === 'TABLET' → tablet UX is Phase P5 (deferred). For V1
 *      we render a banner explaining the fallback + offer to abort.
 *   4. If surface === 'LEGACY' → bubble up via onSurfaceResolved(LEGACY)
 *      so the parent wizard can fall through to the existing single-sig
 *      step.
 *
 * Props:
 *   reservationId      — string (required)
 *   token              — JWT (required)
 *   onComplete(result) — called when signing.status === 'COMPLETED'
 *                        result includes { signedPdfStoragePath, customerCardLast4, ... }
 *   onSurfaceResolved(surface, info) — called once with the surface decision
 *                        (LEGACY caller falls back; TABLET shows redirect helper)
 *   onAbort()          — agent clicked "Cancel & abort terminal"
 *
 * Reuses: backend endpoints from rounds 13-18.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/client';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60; // ~2 minutes — generous; orchestrator usually finishes in 30-60s

export function CounterSigningProgress({
  reservationId,
  token,
  terminalId,
  preAuthAmountCents,
  preAuthOverrideReason,
  onComplete,
  onSurfaceResolved,
  onAbort,
}) {
  const [phase, setPhase] = useState('STARTING'); // STARTING | WAITING | COMPLETED | REFUSED | ERROR
  const [surface, setSurface] = useState(null);
  const [signing, setSigning] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [pollCount, setPollCount] = useState(0);
  const pollTimer = useRef(null);
  const startedRef = useRef(false);

  // Kick off the flow once on mount.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        const body = JSON.stringify({
          reservationId,
          ...(terminalId ? { terminalId } : {}),
          ...(typeof preAuthAmountCents === 'number'
            ? { preAuthAmountCents: Math.round(preAuthAmountCents) }
            : {}),
          ...(preAuthOverrideReason ? { preAuthOverrideReason } : {}),
        });
        const out = await api(
          '/api/payment-gateway/counter/start-checkin',
          { method: 'POST', body },
          token
        );
        setSurface(out?.surface);
        if (onSurfaceResolved) onSurfaceResolved(out?.surface, out);
        if (out?.surface === 'DEJAVOO_TERMINAL') {
          setPhase('WAITING');
        }
        // For TABLET/LEGACY the caller decides what to do; we just render
        // the appropriate placeholder until they unmount us.
      } catch (err) {
        setPhase('ERROR');
        setErrorMsg(err?.message || 'Failed to start counter checkin');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling loop for DEJAVOO_TERMINAL.
  useEffect(() => {
    if (phase !== 'WAITING') return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const out = await api(`/api/reservations/${reservationId}/signing`, {}, token);
        if (cancelled) return;
        setSigning(out);
        setPollCount((c) => c + 1);
        if (out?.status === 'COMPLETED') {
          setPhase('COMPLETED');
          if (onComplete) onComplete(out);
          return; // stop polling
        }
        if (out?.status === 'REFUSED') {
          setPhase('REFUSED');
          return;
        }
      } catch (err) {
        // Don't fail the whole flow on transient poll errors — log + retry
        // unless we've exhausted MAX_POLLS.
        if (pollCount + 1 >= MAX_POLLS) {
          setPhase('ERROR');
          setErrorMsg(err?.message || 'Polling failed');
          return;
        }
      }
      pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleAbort = async () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    try {
      // Resolve a terminalId we can pass — prefer signing.terminalId, then prop
      const tid = signing?.terminalId || terminalId;
      if (tid) {
        await api(
          '/api/payment-gateway/counter/abort',
          { method: 'POST', body: JSON.stringify({ terminalId: tid }) },
          token
        );
      }
    } catch {
      // ignore — abort is best-effort
    }
    if (onAbort) onAbort();
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (phase === 'STARTING') {
    return (
      <div style={panel}>
        <Spinner />
        <h2 style={{ marginTop: 16 }}>Starting counter checkin…</h2>
        <p style={muted}>Resolving terminal + active T&C template…</p>
      </div>
    );
  }

  if (phase === 'ERROR') {
    return (
      <div style={panel}>
        <div style={{ fontSize: 48 }}>⚠️</div>
        <h2 style={{ marginTop: 12 }}>Counter checkin failed</h2>
        <p style={{ ...muted, color: '#b91c1c' }}>{errorMsg}</p>
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => window.location.reload()}>Try again</button>
          {onAbort && <button className="btn ghost" onClick={onAbort}>Cancel</button>}
        </div>
      </div>
    );
  }

  if (phase === 'REFUSED') {
    return (
      <div style={panel}>
        <div style={{ fontSize: 48 }}>🚫</div>
        <h2 style={{ marginTop: 12 }}>Customer declined to sign</h2>
        <p style={muted}>{signing?.refusalReason || 'No reason provided.'}</p>
        {onAbort && (
          <button className="btn" style={{ marginTop: 16 }} onClick={onAbort}>
            Return to wizard
          </button>
        )}
      </div>
    );
  }

  if (phase === 'COMPLETED') {
    const auth = signing?.auth || null;
    const cardLast4 = auth?.cardLast4 || signing?.customerCardLast4;
    const cardBrand = auth?.cardBrand || '';
    const entry = auth?.cardEntryType || '';
    const holdDollars = auth?.amountCents != null
      ? (auth.amountCents / 100).toFixed(2)
      : null;
    return (
      <div style={panel}>
        <div style={{ fontSize: 56 }}>✅</div>
        <h2 style={{ marginTop: 12 }}>Signed & pre-authorized</h2>
        <p style={muted}>
          {signing?.signedCount}/{signing?.totalRequired} fields signed.
        </p>
        {auth && (
          <div
            style={{
              marginTop: 20,
              padding: 16,
              background: '#ecfdf5',
              border: '1px solid #a7f3d0',
              borderRadius: 10,
              maxWidth: 480,
              textAlign: 'left',
            }}
          >
            <div style={{ fontSize: '0.85em', color: '#065f46', fontWeight: 600, marginBottom: 8 }}>
              CARD ON FILE — PRE-AUTH APPROVED
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <KV label="Card">
                {cardBrand ? `${cardBrand} ` : ''}
                ending in <strong>{cardLast4 || '—'}</strong>
              </KV>
              <KV label="Entry">{entry || '—'}</KV>
              <KV label="Hold">
                {holdDollars != null ? <strong>${holdDollars}</strong> : '—'}
              </KV>
              <KV label="Auth code">{auth.authCode || '—'}</KV>
            </div>
            <div style={{ fontSize: '0.8em', color: '#065f46', marginTop: 10 }}>
              Hold will be captured / voided / topped-up at vehicle return.
            </div>
          </div>
        )}
      </div>
    );
  }

  if (surface === 'TABLET') {
    // Phase P5 deferred — show fallback explanation.
    return (
      <div style={panel}>
        <div style={{ fontSize: 48 }}>📱</div>
        <h2 style={{ marginTop: 12 }}>Tablet flow not yet available</h2>
        <p style={muted}>
          The Dejavoo terminal isn&apos;t configured for this tenant. The tablet
          signing UX is scheduled for a later release. For now, please use the
          legacy single-signature flow.
        </p>
        {onAbort && (
          <button className="btn" style={{ marginTop: 16 }} onClick={onAbort}>
            Use legacy signature
          </button>
        )}
      </div>
    );
  }

  // WAITING — main progress UI
  const pct = signing?.progressPct ?? 0;
  const current = signing?.currentFieldMarkerKey || null;
  const done = signing?.signedCount ?? 0;
  const total = signing?.totalRequired ?? 0;

  return (
    <div style={panel}>
      <div style={{ fontSize: 48 }}>👉</div>
      <h2 style={{ marginTop: 12 }}>Hand the terminal to the customer</h2>
      <p style={muted}>
        The customer is reading the agreement and signing each section on the Dejavoo P1.
        Do not press anything on the screen during this step.
      </p>

      {/* Progress bar */}
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          height: 12,
          background: '#e5e7eb',
          borderRadius: 999,
          overflow: 'hidden',
          marginTop: 24,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
            transition: 'width 400ms ease',
          }}
        />
      </div>
      <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600 }}>
        {done} / {total} fields signed ({pct}%)
      </div>
      {current && (
        <div style={{ marginTop: 4, ...muted, fontSize: 13 }}>
          Currently signing: <code>{current}</code>
        </div>
      )}

      <div style={{ marginTop: 24, display: 'flex', gap: 8 }}>
        <button className="btn ghost" onClick={handleAbort}>
          Cancel & abort terminal
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (kept here so the component is self-contained; the existing
// project mixes CSS modules / globals.css / Tailwind so this avoids a class
// inventory exercise).
// ---------------------------------------------------------------------------

const panel = {
  padding: 32,
  textAlign: 'center',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  minHeight: 360,
  justifyContent: 'center',
};

const muted = { color: '#6f668f', margin: 0, maxWidth: 480 };

function Spinner() {
  return (
    <div
      style={{
        width: 48,
        height: 48,
        borderRadius: '50%',
        border: '4px solid #e5e7eb',
        borderTopColor: '#6366f1',
        animation: 'spin 0.8s linear infinite',
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function KV({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: '0.75em', color: '#047857', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: '0.95em', color: '#065f46' }}>{children}</div>
    </div>
  );
}
