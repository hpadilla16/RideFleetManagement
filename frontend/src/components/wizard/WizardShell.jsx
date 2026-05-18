'use client';

/**
 * Pillar 2 — Wizard shell.
 *
 * Shared chrome for the checkout + checkin multi-step wizards. Renders:
 *   - Top bar with title + step counter
 *   - Animated step indicator (purple shimmer on current step)
 *   - Slot for the active step's body
 *   - Sticky bottom action bar with Back / Continue buttons
 *
 * Designed for both tablet (counter use) and phone (handheld) viewports.
 * Style heritage: matches design/mockups/pillar2-checkin-checkout/.
 */

import { useEffect } from 'react';

export function WizardShell({
  title,
  subtitle,
  stepIndex,            // 0-based
  totalSteps,
  stepTitle,
  onBack,
  onNext,
  backLabel = '← Back',
  nextLabel = 'Continue →',
  nextDisabled = false,
  nextVariant = 'primary',
  secondaryAction,      // { label, onClick, variant } | null
  ghostAction,          // { label, onClick } | null
  children,
  accent = 'purple'     // 'purple' | 'mint'
}) {
  useEffect(() => {
    // Scroll to top on each step change so the user doesn't land mid-page
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
  }, [stepIndex]);

  const accentGradient = accent === 'mint'
    ? 'linear-gradient(135deg, #1fc7aa, #16a589)'
    : 'linear-gradient(135deg, #8752FE, #6d3df2)';
  const accentShadow = accent === 'mint'
    ? '0 8px 20px rgba(31,199,170,.32)'
    : '0 8px 20px rgba(135,82,254,.32)';

  return (
    <div className="wizard-shell">
      {/* Stepper */}
      <div className="wiz-stepper">
        {Array.from({ length: totalSteps }, (_, i) => (
          <div
            key={i}
            className={
              i < stepIndex ? 'wiz-step done' :
              i === stepIndex ? 'wiz-step current' :
              'wiz-step'
            }
            style={i === stepIndex && accent === 'mint' ? { background: 'linear-gradient(90deg, #1fc7aa, #16a589)' } : null}
          />
        ))}
      </div>

      {/* Header */}
      <div className="wiz-header">
        <div className="wiz-stepnum">
          STEP {String(stepIndex + 1).padStart(2, '0')} OF {String(totalSteps).padStart(2, '0')}
        </div>
        <div className="wiz-title">{stepTitle}</div>
        {subtitle && <div className="wiz-subtitle">{subtitle}</div>}
      </div>

      {/* Body slot */}
      <div className="wiz-body">{children}</div>

      {/* Sticky bottom action */}
      <div className="wiz-actions">
        {onBack && (
          <button type="button" className="wiz-btn wiz-btn-secondary" onClick={onBack}>
            {backLabel}
          </button>
        )}
        {ghostAction && (
          <button type="button" className="wiz-btn wiz-btn-ghost" onClick={ghostAction.onClick}>
            {ghostAction.label}
          </button>
        )}
        {secondaryAction && (
          <button type="button" className="wiz-btn wiz-btn-secondary" onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </button>
        )}
        <button
          type="button"
          className="wiz-btn wiz-btn-primary"
          onClick={onNext}
          disabled={nextDisabled}
          style={{
            background: accentGradient,
            boxShadow: accentShadow,
            opacity: nextDisabled ? 0.5 : 1,
            cursor: nextDisabled ? 'not-allowed' : 'pointer'
          }}
        >
          {nextLabel}
        </button>
      </div>

      <style jsx>{`
        .wizard-shell {
          max-width: 1200px;
          margin: 0 auto;
          padding: 0 16px 96px;
          min-height: 100vh;
        }
        .wiz-stepper {
          display: flex;
          gap: 6px;
          padding: 16px 0;
        }
        .wiz-step {
          height: 4px;
          flex: 1;
          background: rgba(135,82,254,.14);
          border-radius: 4px;
          position: relative;
          overflow: hidden;
          transition: background .25s ease;
        }
        .wiz-step.done {
          background: #1fc7aa;
        }
        .wiz-step.current {
          background: linear-gradient(90deg, #8752FE, #6d3df2);
          box-shadow: 0 0 10px rgba(135,82,254,.4);
        }
        .wiz-step.current::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,.6), transparent);
          animation: shimmer 1.8s ease-in-out infinite;
        }
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .wiz-header {
          padding: 8px 4px 16px;
        }
        .wiz-stepnum {
          font-size: 11px;
          font-weight: 800;
          color: #6d3df2;
          letter-spacing: .12em;
        }
        .wiz-title {
          font-size: clamp(20px, 3vw, 26px);
          font-weight: 800;
          color: #211a38;
          letter-spacing: -.01em;
          margin-top: 4px;
        }
        .wiz-subtitle {
          font-size: 14px;
          color: #6f668f;
          margin-top: 4px;
        }
        .wiz-body {
          padding: 8px 0 24px;
        }
        .wiz-actions {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          padding: 14px 16px;
          background: rgba(255,255,255,.95);
          backdrop-filter: blur(20px);
          border-top: 1px solid rgba(135,82,254,.12);
          display: flex;
          gap: 10px;
          justify-content: flex-end;
          z-index: 50;
          box-shadow: 0 -8px 24px rgba(35,21,80,.06);
        }
        .wiz-btn {
          padding: 12px 22px;
          border-radius: 14px;
          font-size: 14px;
          font-weight: 800;
          letter-spacing: .02em;
          border: none;
          transition: all .15s ease;
          min-width: 100px;
        }
        .wiz-btn-primary {
          color: white;
        }
        .wiz-btn-primary:not(:disabled):hover {
          transform: translateY(-1px);
        }
        .wiz-btn-secondary {
          background: white;
          color: #6d3df2;
          border: 1px solid #d7cbff;
          box-shadow: 0 4px 10px rgba(35,21,80,.06);
        }
        .wiz-btn-secondary:hover {
          background: rgba(135,82,254,.06);
        }
        .wiz-btn-ghost {
          background: transparent;
          color: #6f668f;
          border: 1px solid rgba(135,82,254,.12);
          box-shadow: none;
        }
        .wiz-btn-ghost:hover {
          background: rgba(255,255,255,.5);
        }
        @media (max-width: 600px) {
          .wizard-shell { padding-bottom: 110px; }
          .wiz-actions { padding: 12px; }
          .wiz-btn { padding: 12px 16px; font-size: 13px; min-width: 0; flex: 1; }
        }
      `}</style>
    </div>
  );
}

/**
 * Card primitive used by all step bodies. Matches the mockup style:
 * white surface, light purple border, subtle shadow.
 */
export function WizCard({ children, accent, padding = 18, style = {}, className = '' }) {
  const baseStyle = {
    background: 'white',
    border: '1px solid #e6dfff',
    borderRadius: 16,
    padding: typeof padding === 'number' ? padding : 16,
    boxShadow: '0 8px 22px rgba(35,21,80,.08)',
    ...style
  };
  if (accent === 'warn') {
    baseStyle.background = 'linear-gradient(135deg, rgba(245,158,11,.08), rgba(245,158,11,.02))';
    baseStyle.borderColor = 'rgba(245,158,11,.24)';
  } else if (accent === 'mint') {
    baseStyle.background = 'linear-gradient(135deg, rgba(31,199,170,.06), rgba(31,199,170,.02))';
    baseStyle.borderColor = 'rgba(31,199,170,.22)';
  } else if (accent === 'ink') {
    baseStyle.background = 'linear-gradient(135deg, #211a38, #2c1e54)';
    baseStyle.borderColor = 'transparent';
    baseStyle.color = 'white';
  }
  return <div className={className} style={baseStyle}>{children}</div>;
}

/**
 * Two-column responsive grid used inside step bodies.
 */
export function WizGrid({ cols = 2, gap = 14, children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gap
    }}>
      {children}
      <style jsx>{`
        @media (max-width: 720px) {
          div { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
