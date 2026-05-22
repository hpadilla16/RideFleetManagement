'use client';

/**
 * CounterReturnProgress — full-screen progress UI for the Dejavoo P1
 * terminal RETURN flow (2026-05-21).
 *
 * Different from CounterSigningProgress (checkout) because at return we
 * already have a prior AUTH; the backend orchestrator picks one of:
 *   - CAPTURE          (final <= preAuth + > 0)
 *   - CAPTURE_PLUS_SALE (final > preAuth)
 *   - VOID             (final == 0)
 *
 * Flow:
 *   1. On mount, POST /api/payment-gateway/counter/start-return with
 *      reservationId + finalAmountCents (computed from feePreview).
 *   2. Backend returns { jobId, terminalId } and the worker starts.
 *   3. Poll GET /api/payment-gateway/transactions?reservationId= every 2s,
 *      looking for the newest CAPTURE/SALE/VOID transaction with a
 *      completedAt timestamp.
 *   4. When approved + completed → done.
 *
 * Props:
 *   reservationId
 *   token
 *   finalAmountCents — final amount to settle (in cents)
 *   onComplete(result) — { case, capturedAmountCents, additionalSaleCents, ... }
 *   onSurfaceResolved(surface, info)
 *   onAbort()
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/client';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;

export function CounterReturnProgress({
  reservationId,
  token,
  finalAmountCents,
  onComplete,
  onSurfaceResolved,
  onAbort,
}) {
  const [phase, setPhase] = useState('STARTING'); // STARTING | WAITING | COMPLETED | ERROR
  const [terminalId, setTerminalId] = useState(null);
  const [latestTx, setLatestTx] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [pollCount, setPollCount] = useState(0);
  // Track the timestamp when we started polling so we ignore older transactions
  // from prior checkin (e.g. the original AUTH).
  const [startedAt, setStartedAt] = useState(null);
  const pollTimer = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        const body = JSON.stringify({
          reservationId,
          ...(typeof finalAmountCents === 'number'
            ? { finalAmountCents: Math.max(0, Math.round(finalAmountCents)) }
            : {}),
        });
        const out = await api(
          '/api/payment-gateway/counter/start-return',
          { method: 'POST', body },
          token
        );
        setTerminalId(out?.terminalId || null);
        setStartedAt(Date.now());
        if (onSurfaceResolved) onSurfaceResolved(out?.surface, out);
        setPhase('WAITING');
      } catch (err) {
        setPhase('ERROR');
        setErrorMsg(err?.message || 'Failed to start counter return');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== 'WAITING') return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const out = await api(
          `/api/payment-gateway/transactions?reservationId=${encodeURIComponent(reservationId)}&limit=20`,
          {},
          token
        );
        if (cancelled) return;
        // Find the newest CAPTURE / SALE / VOID after our startedAt.
        const candidate = (out?.transactions || [])
          .filter((t) => ['CAPTURE', 'SALE', 'VOID'].includes(t.type))
          .filter((t) => {
            const startedTs = startedAt || 0;
            const txStarted = t.startedAt ? Date.parse(t.startedAt) : 0;
            return txStarted >= startedTs - 5000; // 5s clock-skew tolerance
          })
          .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0))[0];
        if (candidate) {
          setLatestTx(candidate);
          if (candidate.completedAt) {
            if (candidate.approved) {
              setPhase('COMPLETED');
              if (onComplete) onComplete(candidate);
              return;
            } else {
              setPhase('ERROR');
              setErrorMsg(
                candidate.errorMessage ||
                  candidate.statusCode ||
                  'Transaction was not approved'
              );
              return;
            }
          }
        }
        setPollCount((c) => c + 1);
      } catch (err) {
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
  }, [phase, startedAt]);

  const handleAbort = async () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    try {
      if (terminalId) {
        await api(
          '/api/payment-gateway/counter/abort',
          { method: 'POST', body: JSON.stringify({ terminalId }) },
          token
        );
      }
    } catch {}
    if (onAbort) onAbort();
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (phase === 'STARTING') {
    return (
      <div style={panel}>
        <Spinner />
        <h2 style={{ marginTop: 16 }}>Starting return on terminal…</h2>
        <p style={muted}>Resolving prior pre-auth + final amount…</p>
      </div>
    );
  }

  if (phase === 'ERROR') {
    return (
      <div style={panel}>
        <div style={{ fontSize: 48 }}>⚠️</div>
        <h2 style={{ marginTop: 12 }}>Return failed</h2>
        <p style={{ ...muted, color: '#b91c1c' }}>{errorMsg}</p>
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => window.location.reload()}>
            Try again
          </button>
          {onAbort && (
            <button className="btn ghost" onClick={onAbort}>
              Use legacy signature
            </button>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'COMPLETED') {
    const cents = latestTx?.amountCents || 0;
    const dollars = (cents / 100).toFixed(2);
    return (
      <div style={panel}>
        <div style={{ fontSize: 56 }}>✅</div>
        <h2 style={{ marginTop: 12 }}>
          {latestTx?.type === 'VOID' ? 'Pre-auth released' : 'Payment captured'}
        </h2>
        <p style={muted}>
          {latestTx?.type === 'VOID'
            ? 'No additional amount owed. Hold released.'
            : `Captured \$${dollars} on the terminal.`}
          {latestTx?.cardLast4 && (
            <> Card ending in <strong>{latestTx.cardLast4}</strong>.</>
          )}
        </p>
      </div>
    );
  }

  // WAITING
  const dollars = finalAmountCents != null ? (finalAmountCents / 100).toFixed(2) : null;
  return (
    <div style={panel}>
      <div style={{ fontSize: 48 }}>💳</div>
      <h2 style={{ marginTop: 12 }}>Hand the terminal to the customer</h2>
      <p style={muted}>
        {dollars != null
          ? `Customer is reviewing the \$${dollars} settlement on the Dejavoo P1 and signing the receipt.`
          : 'Customer is reviewing the settlement on the Dejavoo P1 and signing the receipt.'}
        {' '}Do not press anything on the terminal during this step.
      </p>

      <div style={{ marginTop: 24, ...muted, fontSize: 13 }}>
        {latestTx ? (
          <>
            Type: <code>{latestTx.type}</code> · Status: <code>{latestTx.statusCode || 'pending…'}</code>
          </>
        ) : (
          <>Waiting for terminal response…</>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <button className="btn ghost" onClick={handleAbort}>
          Cancel & abort terminal
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
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
        borderTopColor: '#10b981',
        animation: 'spin 0.8s linear infinite',
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
