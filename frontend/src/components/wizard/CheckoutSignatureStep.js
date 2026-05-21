'use client';

/**
 * CheckoutSignatureStep — smart wizard step that picks the right signing
 * surface for the current tenant + user (2026-05-21).
 *
 * Decision matrix:
 *   - interactiveTC=ON + dejavooCounter=ON + terminal available →
 *       CounterSigningProgress (Dejavoo terminal)
 *   - interactiveTC=ON + no terminal →
 *       Tablet UX (Phase P5 deferred) → falls back to legacy + banner
 *   - interactiveTC=OFF →
 *       LegacySignature (the existing Step5Signature with signerName + pad)
 *
 * Wraps the legacy Step5Signature inline so the existing wizard's
 * canAdvance / submit logic keeps working with no other changes.
 *
 * Props:
 *   reservationId
 *   token
 *   agreement                       — passthrough to legacy renderer
 *   signerName / onSignerName       — legacy renderer state
 *   signatureDataUrl / onSignature  — legacy renderer state
 *   error                           — legacy submit error
 *   onTerminalCompleted({ signing }) — called when DEJAVOO flow finishes;
 *                                       parent should mark the step ready to advance
 *   LegacySignature                 — the existing Step5Signature component
 *                                       (passed in to avoid a circular import)
 */

import { useState } from 'react';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { CounterSigningProgress } from './CounterSigningProgress';

export function CheckoutSignatureStep({
  reservationId,
  token,
  agreement,
  signerName,
  onSignerName,
  signatureDataUrl,
  onSignature,
  error,
  onTerminalCompleted,
  LegacySignature,
}) {
  const { flags, effectiveStates, loading } = useFeatureFlags(token);
  // Choice can be overridden by the agent — "Use legacy instead" link.
  const [forceLegacy, setForceLegacy] = useState(false);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#6f668f' }}>
        Resolving signing surface…
      </div>
    );
  }

  const tcOn = !!flags.interactiveTC;
  const djOn = !!flags.dejavooCounter;

  // If the agent explicitly forced legacy OR Interactive T&C is OFF, render
  // the legacy single-sig flow. Surface=TABLET also degrades here for now
  // because the tablet UX is Phase P5 (deferred).
  if (forceLegacy || !tcOn) {
    return (
      <LegacySignature
        agreement={agreement}
        signerName={signerName}
        onSignerName={onSignerName}
        signatureDataUrl={signatureDataUrl}
        onSignature={onSignature}
        error={error}
      />
    );
  }

  // Interactive T&C is ON. If Dejavoo counter is also ON, attempt the
  // terminal flow. Otherwise show a banner + legacy fallback.
  if (!djOn) {
    return (
      <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
        <div style={banner('info')}>
          Interactive T&C is enabled, but no Dejavoo terminal is configured
          for this tenant. The tablet signing UX is scheduled for a later
          release. For now, please collect the customer signature on this
          screen.
        </div>
        <LegacySignature
          agreement={agreement}
          signerName={signerName}
          onSignerName={onSignerName}
          signatureDataUrl={signatureDataUrl}
          onSignature={onSignature}
          error={error}
        />
      </div>
    );
  }

  // Full new flow: terminal-driven
  return (
    <CounterSigningProgress
      reservationId={reservationId}
      token={token}
      onComplete={(signing) => {
        if (onTerminalCompleted) onTerminalCompleted({ signing });
      }}
      onSurfaceResolved={(surface) => {
        // If backend says LEGACY (e.g. flags flipped between flag-cache and
        // request), fall back to the legacy pad without forcing reload.
        if (surface === 'LEGACY') setForceLegacy(true);
      }}
      onAbort={() => {
        // Agent cancelled — give them the legacy fallback so the customer
        // can still sign.
        setForceLegacy(true);
      }}
    />
  );
}

function banner(kind) {
  const palette = {
    info: { bg: '#eff6ff', border: '#bfdbfe', text: '#1e3a8a' },
    warn: { bg: '#fffbeb', border: '#fde68a', text: '#92400e' },
  };
  const p = palette[kind] || palette.info;
  return {
    padding: 14,
    border: `1px solid ${p.border}`,
    background: p.bg,
    color: p.text,
    borderRadius: 10,
    marginBottom: 16,
    fontSize: 14,
    lineHeight: 1.5,
  };
}
