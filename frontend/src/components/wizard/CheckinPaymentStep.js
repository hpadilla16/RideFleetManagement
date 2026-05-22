'use client';

/**
 * CheckinPaymentStep — smart wizard step for the checkin (RETURN) flow's
 * payment + signature stage (2026-05-21).
 *
 * Decision matrix (mirrors CheckoutSignatureStep but for the return flow):
 *   - dejavooCounter=ON → CounterReturnProgress (terminal capture/void/sale)
 *   - dejavooCounter=OFF → legacy Step5Signature (existing single-sig pad)
 *
 * Note: unlike checkout (where interactiveTC is needed for the T&C signing
 * flow), at return we ONLY need dejavooCounter. The customer already signed
 * the agreement at pickup; here we just settle the bill on the terminal.
 *
 * Props:
 *   reservationId
 *   token
 *   finalAmountCents — computed by caller from feePreview.total etc.
 *   feePreview, signerName, onSignerName, signatureDataUrl, onSignature,
 *   paymentMode, cardLast4, cardBrand, error — passthrough to legacy renderer
 *   onTerminalCompleted({ result })
 *   LegacySignature — Step5Signature passed in to avoid circular import
 */

import { useState } from 'react';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { CounterReturnProgress } from './CounterReturnProgress';

export function CheckinPaymentStep({
  reservationId,
  token,
  finalAmountCents,
  feePreview,
  signerName,
  onSignerName,
  signatureDataUrl,
  onSignature,
  paymentMode,
  cardLast4,
  cardBrand,
  error,
  onTerminalCompleted,
  LegacySignature,
  tenantId, // Round 25 (2026-05-22): SUPER_ADMIN tenant scoping for feature flags
}) {
  // Round 25: pass tenantId so SUPER_ADMIN viewing another tenant's reservation
  // sees that tenant's flag state, not empty {}.
  const { flags, loading } = useFeatureFlags(token, tenantId || null);
  const [forceLegacy, setForceLegacy] = useState(false);
  const [terminalStarted, setTerminalStarted] = useState(false);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#6f668f' }}>
        Resolving payment surface…
      </div>
    );
  }

  const djOn = !!flags.dejavooCounter;

  // If Dejavoo counter is OFF or the agent forced legacy, render the
  // existing single-sig flow.
  if (forceLegacy || !djOn) {
    return (
      <LegacySignature
        feePreview={feePreview}
        signerName={signerName}
        onSignerName={onSignerName}
        signatureDataUrl={signatureDataUrl}
        onSignature={onSignature}
        paymentMode={paymentMode}
        cardLast4={cardLast4}
        cardBrand={cardBrand}
        error={error}
      />
    );
  }

  // Dejavoo flow ON. If agent hasn't started yet, show a confirm screen
  // so they can review the amount before handing over the terminal.
  if (!terminalStarted) {
    const dollars =
      finalAmountCents != null ? (finalAmountCents / 100).toFixed(2) : null;
    return (
      <div style={{ padding: 32, maxWidth: 720, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 48 }}>💳</div>
        <h2 style={{ marginTop: 12 }}>Ready to process return on terminal</h2>
        <div
          style={{
            margin: '24px 0',
            padding: 20,
            borderRadius: 12,
            background: '#f3f4f6',
            display: 'inline-block',
          }}
        >
          <div style={{ fontSize: '0.85em', color: '#6b7280', marginBottom: 4 }}>
            Final settlement
          </div>
          <div style={{ fontSize: 36, fontWeight: 700 }}>
            {dollars != null ? `$${dollars}` : '—'}
          </div>
        </div>
        <p style={{ color: '#6f668f', maxWidth: 480, margin: '12px auto' }}>
          When you click "Start", the Dejavoo P1 will display the line items
          and the customer will sign the receipt. The terminal will{' '}
          {finalAmountCents > 0
            ? 'capture from the pre-auth (or charge additional if needed)'
            : 'void the pre-auth (nothing owed)'}
          .
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 24 }}>
          <button className="btn ghost" onClick={() => setForceLegacy(true)}>
            Use legacy signature
          </button>
          <button className="btn primary" onClick={() => setTerminalStarted(true)}>
            Start on terminal →
          </button>
        </div>
      </div>
    );
  }

  return (
    <CounterReturnProgress
      reservationId={reservationId}
      token={token}
      finalAmountCents={finalAmountCents}
      onComplete={(result) => {
        if (onTerminalCompleted) onTerminalCompleted({ result });
      }}
      onSurfaceResolved={(surface) => {
        if (surface === 'LEGACY') setForceLegacy(true);
      }}
      onAbort={() => {
        setTerminalStarted(false);
        setForceLegacy(true);
      }}
    />
  );
}
