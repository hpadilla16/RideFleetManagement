'use client';

/**
 * Reservation lifecycle rail (Innovation #1 from design/INNOVATION-REVIEW.md,
 * approved mockups 2026-07-26).
 *
 * One persistent strip: Booked → Pre-check-in → Signed → On rent → Return →
 * Closed, with Balance + Deposit hold ALWAYS visible on the right. This
 * branch exists because the balance was displayed wrong once — the rail makes
 * it impossible to lose.
 *
 * DISPLAY ONLY. Balance reads RentalAgreement.balance (the server-side source
 * of truth, recomputed on every pricing mutation) via the agreement row the
 * host page already fetches; nothing here computes money.
 *
 * Stage derivation is deliberately conservative: a stage lights up only on
 * hard evidence (timestamps / statuses), UNKNOWN renders as not-done.
 */

const STAGES = ['Booked', 'Pre-check-in', 'Signed', 'On rent', 'Return', 'Closed'];

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function deriveLifecycle(reservation, agreement) {
  const status = String(reservation?.status || '').toUpperCase();
  const dead = status === 'CANCELLED' || status === 'NO_SHOW';
  const agreementClosed = String(agreement?.status || '').toUpperCase() === 'CLOSED' || !!agreement?.closedAt;
  const returned = status === 'CHECKED_IN' || status === 'CHECKED_IN_UNPAID' || agreementClosed;
  const onRent = status === 'CHECKED_OUT';
  const signed = !!(agreement?.tcSignedAt || reservation?.signatureSignedAt || agreement?.finalizedAt || onRent || returned);
  const precheckin = !!(reservation?.customerInfoCompletedAt || signed);

  const done = [true, precheckin, signed, onRent || returned, returned, agreementClosed];
  // Current = first not-done stage; when everything is done, Closed is current.
  let current = done.findIndex((d) => !d);
  if (current === -1) current = STAGES.length - 1;
  // "On rent" reads as the ACTIVE stage while checked out, not a pending one.
  if (onRent && !returned) current = 3;
  return { dead, deadLabel: status === 'NO_SHOW' ? 'No-show' : 'Cancelled', done, current };
}

export function LifecycleRail({ reservation, agreement }) {
  if (!reservation) return null;
  const { dead, deadLabel, done, current } = deriveLifecycle(reservation, agreement);

  const balance = agreement?.balance;
  const depositHold = agreement?.depositHoldAmount ?? agreement?.securityDepositAmount;
  const balanceNum = Number(balance || 0);

  return (
    <div
      className="glass card"
      style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 0, overflowX: 'auto', opacity: dead ? 0.75 : 1 }}
    >
      {dead ? (
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 7, padding: '3px 10px',
            fontSize: 12.5, fontWeight: 700, background: 'var(--danger-bg, #fdecea)', color: 'var(--danger-tx, #b3261e)',
            marginRight: 14, whiteSpace: 'nowrap'
          }}
        >
          {deadLabel}
        </span>
      ) : null}

      {STAGES.map((label, i) => {
        const isDone = !dead && done[i] && i !== current;
        const isNow = !dead && i === current;
        return (
          <span key={label} style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto' }}>
            {i > 0 ? (
              <span style={{ width: 26, height: 2, margin: '0 7px', background: isDone || (done[i - 1] && !dead) ? 'var(--ok-tx, #0f766e)' : 'var(--border-2, #d9d2ea)', opacity: dead ? 0.4 : 1 }} />
            ) : null}
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap',
                color: isDone ? 'var(--ok-tx, #0f766e)' : isNow ? 'var(--brand-tx, var(--brand-purple, #6a35e0))' : 'var(--text-3, #736a8b)'
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 16, height: 16, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700, background: isDone ? 'var(--ok-tx, #0f766e)' : 'var(--surface-1, #fff)',
                  color: isDone ? '#fff' : 'inherit',
                  border: isDone ? '2px solid var(--ok-tx, #0f766e)' : isNow ? '2px solid var(--brand-purple, #6a35e0)' : '2px solid var(--border-2, #d9d2ea)',
                  boxShadow: isNow ? '0 0 0 3px var(--brand-soft, rgba(135,82,254,0.18))' : 'none'
                }}
              >
                {isDone ? '✓' : ''}
              </span>
              {label}
            </span>
          </span>
        );
      })}

      <span
        style={{
          marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'center', flex: '0 0 auto',
          background: 'var(--surface-2, #f7f5fd)', border: '1px solid var(--border-2, #e9e4f4)', borderRadius: 8, padding: '6px 14px'
        }}
      >
        <span>
          <span className="label" style={{ display: 'block', fontSize: 10.5 }}>Balance</span>
          <strong style={{ fontVariantNumeric: 'tabular-nums', fontSize: 14.5, color: balanceNum > 0 ? 'var(--danger-tx, #b3261e)' : 'var(--ok-tx, #0f766e)' }}>
            {balance == null ? '—' : money(balance)}
          </strong>
        </span>
        <span>
          <span className="label" style={{ display: 'block', fontSize: 10.5 }}>Deposit hold</span>
          <strong style={{ fontVariantNumeric: 'tabular-nums', fontSize: 14.5 }}>
            {depositHold == null ? '—' : money(depositHold)}
          </strong>
        </span>
      </span>
    </div>
  );
}
