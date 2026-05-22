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

import { useEffect, useState } from 'react';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { CounterSigningProgress } from './CounterSigningProgress';
import { api } from '../../lib/client';

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
  // Round 25 (2026-05-22): pass agreement.tenantId so SUPER_ADMIN viewing
  // another tenant's reservation sees that tenant's flag state, not empty {}.
  const { flags, effectiveStates, loading } = useFeatureFlags(token, agreement?.tenantId || null);
  // Choice can be overridden by the agent — "Use legacy instead" link.
  const [forceLegacy, setForceLegacy] = useState(false);
  // Round 21 — preflight info + pre-auth override
  const [preflight, setPreflight] = useState(null);
  const [preflightError, setPreflightError] = useState('');
  const [overrideAmount, setOverrideAmount] = useState(null); // cents; null = use default
  const [overrideReason, setOverrideReason] = useState('');
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [terminalStarted, setTerminalStarted] = useState(false);

  // Fetch preflight when the new flow is active so we know the default
  // pre-auth amount + whether the customer has a saved card from a prior rental.
  useEffect(() => {
    if (loading || !flags.interactiveTC || !flags.dejavooCounter || forceLegacy) return;
    let cancelled = false;
    api(`/api/payment-gateway/counter/preflight?reservationId=${encodeURIComponent(reservationId)}`, {}, token)
      .then((out) => {
        if (!cancelled) setPreflight(out);
      })
      .catch((err) => {
        if (!cancelled) setPreflightError(err?.message || 'Preflight failed');
      });
    return () => { cancelled = true; };
  }, [loading, flags.interactiveTC, flags.dejavooCounter, forceLegacy, reservationId, token]);

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

  // Full new flow: terminal-driven. Show a confirm screen with the pre-auth
  // amount + agent override option BEFORE handing off to the terminal.
  if (!terminalStarted) {
    if (preflightError) {
      return (
        <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
          <div style={banner('warn')}>Preflight failed: {preflightError}</div>
          <button className="btn primary" onClick={() => setForceLegacy(true)}>
            Use legacy signature
          </button>
        </div>
      );
    }
    if (!preflight) {
      return (
        <div style={{ padding: 40, textAlign: 'center', color: '#6f668f' }}>
          Loading checkin preflight…
        </div>
      );
    }
    const defaultCents = preflight.defaultPreAuthAmountCents || 0;
    const effectiveCents = overrideAmount != null ? overrideAmount : defaultCents;
    const isOverride = overrideAmount != null && overrideAmount !== defaultCents;
    // Round 22 — split out: rental fee (charged via SALE) + deposit (held via AUTH).
    const rentalFeeCents = preflight.rentalFeeAmountCents || 0;
    const rentalAlreadyPaid = !!preflight.rentalFeeAlreadyCollected;
    return (
      <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
        <h3 style={{ marginTop: 0 }}>Counter checkin — payment + security deposit</h3>

        {/* Customer card-on-file warning if exists */}
        {preflight.customer?.existingDejavooCard && (
          <div style={banner('info')}>
            <strong>Note:</strong> {preflight.customer.name} has a saved card on file from a
            prior rental: <strong>{preflight.customer.existingDejavooCard.brand} ending in{' '}
            {preflight.customer.existingDejavooCard.last4}</strong>. The card the customer
            presents at the terminal now will REPLACE that saved card.
          </div>
        )}

        {/* Rental fee — charged at pickup via SALE (single swipe) */}
        <div style={{ background: '#f0fdf4', borderRadius: 10, padding: 16, marginTop: 16, border: '1px solid #bbf7d0' }}>
          <div style={{ fontSize: '0.85em', color: '#065f46', marginBottom: 6, fontWeight: 600 }}>
            Step 1 — Rental fee (charged now)
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 4, color: '#065f46' }}>
            ${(rentalFeeCents / 100).toFixed(2)}
          </div>
          <div style={{ fontSize: '0.85em', color: '#065f46' }}>
            {rentalAlreadyPaid
              ? `Already collected (${(preflight.rentalFeeAlreadyCollectedCents / 100).toFixed(2)} on file).`
              : 'Customer will swipe / tap / insert their card on the terminal. The card is saved on file for the deposit hold below and any future post-rental charges (tolls, late return, damage).'}
          </div>
        </div>

        {/* Pre-auth amount display + edit */}
        <div style={{ background: '#f9fafb', borderRadius: 10, padding: 16, marginTop: 16 }}>
          <div style={{ fontSize: '0.85em', color: '#6b7280', marginBottom: 6, fontWeight: 600 }}>
            Step 2 — Security deposit hold (card-on-file, no second swipe)
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>
            ${(effectiveCents / 100).toFixed(2)}
          </div>
          <div style={{ fontSize: '0.85em', color: '#6b7280', marginBottom: 12 }}>
            {isOverride ? (
              <>
                <strong>Override:</strong> default was ${(defaultCents / 100).toFixed(2)}
              </>
            ) : (
              <>Tenant default ({preflight.defaultSource === 'tenant_settings'
                ? 'from settings'
                : 'computed as 25% of estimated total'})</>
            )}
          </div>
          {!showOverrideForm && (
            <button className="btn ghost" onClick={() => setShowOverrideForm(true)}>
              {isOverride ? 'Adjust override' : 'Edit (requires manager approval)'}
            </button>
          )}
          {showOverrideForm && (
            <div style={{ marginTop: 12, padding: 12, background: 'white', borderRadius: 8 }}>
              <div style={{ fontSize: '0.85em', color: '#6b7280', marginBottom: 8 }}>
                Override the security deposit amount. Use only with manager authorization —
                this change is audit-logged.
              </div>
              <label style={{ display: 'block', marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>New amount (USD)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="input"
                  defaultValue={(effectiveCents / 100).toFixed(2)}
                  onChange={(e) => {
                    const dollars = parseFloat(e.target.value);
                    if (Number.isFinite(dollars) && dollars >= 0) {
                      setOverrideAmount(Math.round(dollars * 100));
                    }
                  }}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </label>
              <label style={{ display: 'block', marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Reason / manager who authorized</span>
                <textarea
                  className="input"
                  rows={2}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="e.g. Manager Juan Perez approved — corporate client, no deposit"
                  style={{ width: '100%', marginTop: 4 }}
                />
              </label>
              <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setShowOverrideForm(false);
                    setOverrideAmount(null);
                    setOverrideReason('');
                  }}
                >
                  Cancel override
                </button>
                <button
                  className="btn"
                  onClick={() => setShowOverrideForm(false)}
                  disabled={!overrideReason.trim()}
                >
                  Apply override
                </button>
              </div>
            </div>
          )}
        </div>

        <p style={{ color: '#6f668f', marginTop: 16 }}>
          When you click "Start", the Dejavoo P1 will display the T&C, prompt the customer to
          initial each required section + sign, then ask for their card ONCE to charge the
          ${(rentalFeeCents / 100).toFixed(2)} rental fee. The
          ${(effectiveCents / 100).toFixed(2)} deposit hold is then placed automatically
          against the same card — no second swipe needed.
        </p>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 24 }}>
          <button className="btn ghost" onClick={() => setForceLegacy(true)}>
            Use legacy signature instead
          </button>
          <button className="btn primary" onClick={() => setTerminalStarted(true)}>
            Hand terminal to customer →
          </button>
        </div>
      </div>
    );
  }

  return (
    <CounterSigningProgress
      reservationId={reservationId}
      token={token}
      preAuthAmountCents={overrideAmount}
      preAuthOverrideReason={overrideAmount != null ? overrideReason : null}
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
        setTerminalStarted(false);
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
