'use client';

// Generic slide-over shell for the planner side panels (Rules / Copilot /
// Recommendations). The panel components themselves are reused as-is inside.
export function PlannerSlideOver({ open, title, onClose, children, closeLabel = 'Close' }) {
  if (!open) return null;

  return (
    <div className="pl-slideover-root" role="dialog" aria-modal="true" aria-label={title}>
      <div className="pl-slideover-backdrop" onClick={onClose} />
      <aside className="pl-slideover">
        <div className="pl-slideover-head">
          <h3>{title}</h3>
          <button type="button" className="button-subtle" onClick={onClose}>{closeLabel}</button>
        </div>
        <div className="pl-slideover-body">
          {children}
        </div>
      </aside>
    </div>
  );
}
