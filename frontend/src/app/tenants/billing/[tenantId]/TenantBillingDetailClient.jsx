'use client';

/**
 * Tenant billing detail — `/tenants/billing/[tenantId]`. SUPER_ADMIN only.
 *
 * Backend: GET  /api/tenants/billing/:tenantId
 *          POST /api/tenants/billing/subscriptions/:id/cancel         { confirm, reason }
 *          POST /api/tenants/billing/subscriptions/:id/update-link    { email? }
 *          POST /api/tenants/billing/subscriptions/:id/revoke-invites
 *          POST /api/tenants/billing/subscriptions/:id/refresh
 *          POST /api/tenants/billing/:tenantId/suspend                { reason }
 *          POST /api/tenants/billing/:tenantId/restore
 *          POST /api/tenants/billing/:tenantId/apply-plan
 *
 * THE THREE THINGS THIS SCREEN MUST NOT GET WRONG
 * ---------------------------------------------------------------------------
 * 1. NO RETRY BUTTON, AND NO "ATTEMPT N OF M". Verified: a declined ARB payment
 *    suspends the subscription, and Authorize.Net retries nightly ONLY after the
 *    payment method is updated. There is no fixed retry count and no next-retry
 *    date to show. The approved mockup drew "Reintentar cobro ahora" and
 *    "Intento 2 de 3 · reintenta el 27 de agosto"; both would be fiction, so
 *    neither ships. What ships is the truth plus the one thing that fixes it:
 *    send a new-card link.
 *
 * 2. SUSPEND MUST NOT OVERSELL ITSELF. Today `Tenant.status` is enforced on the
 *    tenant's PUBLIC surfaces and their integration schedulers, but `requireAuth`
 *    does not read it — so suspending does NOT log their staff out yet. That
 *    gate is Phase 5. The dialog says exactly that. The mockup's "14 users lose
 *    access to the staff app the moment you confirm" would be a lie about a
 *    lever being pulled on a paying customer.
 *
 * 3. THE STORED CHARGE DESCRIPTION IS RENDERED VERBATIM. It was written once, at
 *    the moment of the charge, from the numbers actually used. It is the
 *    sentence somebody reads out on a dispute call — never recomputed here.
 *
 * English, hardcoded, matching /tenants.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../../lib/client';
import { billingDate, money, cycleLabel, STATUS_LABEL, STATUS_TONE } from '../BillingOverviewClient';

export const CANCEL_CONFIRMATION = 'CANCEL SUBSCRIPTION';

export function TenantBillingDetailClient({ token, tenantId }) {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [mintedLink, setMintedLink] = useState(null);
  const [showEvents, setShowEvents] = useState(false);

  const load = async () => {
    try {
      setData(await api(`/api/tenants/billing/${tenantId}`, { cacheTtlMs: 0 }, token));
      setMsg('');
    } catch (e) {
      setMsg(e.message);
    }
  };

  useEffect(() => { if (tenantId) load(); }, [tenantId, token]);

  const run = async (path, body, after) => {
    setBusy(true);
    try {
      const out = await api(path, { method: 'POST', body: JSON.stringify(body || {}) }, token);
      setDialog(null);
      if (after) after(out);
      await load();
      return out;
    } catch (e) {
      setMsg(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <section className="glass card-lg stack">
        {msg ? <div className="error">{msg}</div> : <p className="label">Loading…</p>}
      </section>
    );
  }

  const { tenant, subscription: sub, charges, events, invites, planDiverges } = data;
  const outstanding = (invites || []).filter((i) => !i.usedAt && !i.revokedAt);
  const subPath = sub ? `/api/tenants/billing/subscriptions/${sub.id}` : null;

  return (
    <section className="glass card-lg stack">
      <div className="row-between">
        <div>
          <p className="eyebrow">Ride Fleet · Admin · Tenant Billing</p>
          <h2 className="page-title">{tenant.name}</h2>
          <p className="label">{tenant.slug}</p>
        </div>
        <div className="inline-actions">
          <Link href="/tenants/billing" className="button-subtle">← Back</Link>
          <button type="button" className="button-subtle" onClick={load}>Refresh</button>
        </div>
      </div>

      {msg ? <div className="error">{msg}</div> : null}

      {mintedLink ? <MintedLink minted={mintedLink} onDismiss={() => setMintedLink(null)} /> : null}

      {tenant.status === 'SUSPENDED' ? (
        <div className="error">
          <strong>Access suspended{tenant.billingSuspendedAt ? ` on ${new Date(tenant.billingSuspendedAt).toISOString().slice(0, 10)}` : ''}.</strong>{' '}
          {tenant.billingSuspendedAt
            ? 'Their public booking site is dark and their integration syncs are stopped.'
            : 'This suspension was NOT set by billing — someone switched this tenant off by hand. '
              + 'Restore it from the Tenants screen once you know why.'}
        </div>
      ) : null}

      {/* PAST_DUE says what is true. No attempt count, no predicted retry date. */}
      {sub && sub.status === 'PAST_DUE' ? (
        <div className="error">
          <strong>Past due{sub.pastDueSince ? ` since ${new Date(sub.pastDueSince).toISOString().slice(0, 10)}` : ''}.</strong>{' '}
          The recurring charge was declined and the subscription is <strong>suspended at Authorize.Net</strong>.
          Authorize.Net resumes its own nightly retries <strong>only once the payment method is updated</strong> —
          it runs no fixed number of attempts, and waiting does not fix it. Staff access is unaffected while
          the status is Past due.
          <div className="inline-actions" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setDialog({ kind: 'updateLink' })}
            >
              Send new-card link
            </button>
            <button
              type="button"
              className="button-subtle"
              disabled={busy}
              onClick={() => run(`${subPath}/refresh`)}
            >
              Re-check at Authorize.Net
            </button>
          </div>
        </div>
      ) : null}

      {!sub ? (
        <div className="surface-note">
          <strong>{tenant.name} has no subscription.</strong> They are using Ride Fleet Manager and being billed
          nothing. Enrollment is minted from the <Link href="/tenants">Tenants</Link> page, which owns the plan,
          amount and start-date form the invite needs.
        </div>
      ) : (
        <>
          <div className="app-card-grid">
            <SubscriptionCard sub={sub} tenant={tenant} planDiverges={planDiverges} />
            <PaymentMethodCard
              sub={sub}
              outstanding={outstanding}
              busy={busy}
              onUpdateLink={() => setDialog({ kind: 'updateLink' })}
              onRevoke={() => run(`${subPath}/revoke-invites`)}
              onRefresh={() => run(`${subPath}/refresh`)}
            />
          </div>

          <ActionsCard
            sub={sub}
            tenant={tenant}
            planDiverges={planDiverges}
            busy={busy}
            setDialog={setDialog}
          />

          <ChargeHistory charges={charges} />

          <div className="row-between">
            <h3 className="section-title">
              <button type="button" className="button-subtle" onClick={() => setShowEvents((v) => !v)}>
                {showEvents ? '▾' : '▸'} Event log · TenantSubscriptionEvent
              </button>
            </h3>
            <span className="label">
              {events.length} event(s) · {events.filter((e) => !e.processedAt).length} unprocessed
            </span>
          </div>
          <p className="label">&quot;Did the webhook arrive?&quot; is answered here, not by an SSH to the droplet.</p>
          {showEvents ? <EventLog events={events} /> : null}
        </>
      )}

      {dialog ? (
        <ActionDialog
          dialog={dialog}
          tenant={tenant}
          sub={sub}
          busy={busy}
          // 'off' when the payload predates Phase 5 or the variable is unset —
          // the conservative reading, which is also the honest one: an unknown
          // enforcement state must not be described as a lockout.
          enforcement={data?.suspensionEnforcement || 'off'}
          onClose={() => setDialog(null)}
          onSubmit={(body) => {
            if (dialog.kind === 'updateLink') {
              return run(`${subPath}/update-link`, body, (out) => setMintedLink(out));
            }
            if (dialog.kind === 'cancel') return run(`${subPath}/cancel`, body);
            if (dialog.kind === 'suspend') return run(`/api/tenants/billing/${tenant.id}/suspend`, body);
            if (dialog.kind === 'restore') return run(`/api/tenants/billing/${tenant.id}/restore`, body);
            if (dialog.kind === 'applyPlan') return run(`/api/tenants/billing/${tenant.id}/apply-plan`, body);
            return null;
          }}
        />
      ) : null}
    </section>
  );
}

function SubscriptionCard({ sub, tenant, planDiverges }) {
  const [showConsent, setShowConsent] = useState(false);
  return (
    <div className="glass card stack">
      <div className="row-between">
        <h3 className="section-title">Subscription</h3>
        <span className={`chip ${STATUS_TONE[sub.status] || 'chip--neutral'}`}>
          <span className="led" />{STATUS_LABEL[sub.status] || sub.status}
        </span>
      </div>
      <Kv k="Plan (billing)" v={<>{sub.planName} <span className="chip chip--neutral">{sub.planCode}</span></>} />
      <Kv
        k="Plan (entitlement)"
        v={planDiverges
          ? <span className="chip chip--warn">{tenant.plan} — differs</span>
          : <span className="chip chip--ok">{tenant.plan} — matches</span>}
      />
      <Kv k="Amount" v={money(sub.amount, sub.currency)} />
      <Kv k="Cycle" v={cycleLabel(sub.intervalUnit, sub.intervalLength)} />
      <Kv k="Started" v={billingDate(sub.startDate)} />
      <Kv
        k="Current period"
        v={sub.currentPeriodStart ? `${billingDate(sub.currentPeriodStart)} → ${billingDate(sub.currentPeriodEnd)}` : '—'}
      />
      <Kv
        k={sub.startDate === sub.nextChargeDate ? 'First charge' : 'Next charge'}
        v={sub.nextChargeDate ? billingDate(sub.nextChargeDate) : '—'}
      />
      {/* Only a GENUINE trial puts a date here. A deferred first charge is not a
          trial and must not be labelled as one. */}
      <Kv k="Trial" v={sub.trialEndsAt ? `ends ${billingDate(sub.trialEndsAt)}` : 'none'} />
      <Kv k="arbSubscriptionId" v={<Copyable value={sub.arbSubscriptionId} />} />
      <Kv k="customerProfileId" v={<Copyable value={sub.customerProfileId} />} />
      {sub.arbStatusSnapshot ? (
        <Kv k="Authorize.Net reports" v={<>{sub.arbStatusSnapshot}{sub.lastReconciledAt ? ` · checked ${new Date(sub.lastReconciledAt).toISOString().slice(0, 10)}` : ''}</>} />
      ) : null}

      {sub.authorizedAt ? (
        <div className="surface-note">
          <strong>Consent archived</strong> {new Date(sub.authorizedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC
          {sub.authorizedIp ? ` · from ${sub.authorizedIp}` : ''}
          {sub.authorizedEmail ? ` · ${sub.authorizedEmail}` : ''}
          {sub.authorizedDisclosureHash ? <> · <code>sha256 {String(sub.authorizedDisclosureHash).slice(0, 8)}…</code></> : null}
          {sub.authorizedDisclosureText ? (
            <>
              {' '}
              <button type="button" className="button-subtle" onClick={() => setShowConsent((v) => !v)}>
                {showConsent ? 'Hide' : 'Show'} the exact text they agreed to
              </button>
              {showConsent ? <blockquote className="label">{sub.authorizedDisclosureText}</blockquote> : null}
            </>
          ) : null}
        </div>
      ) : (
        <p className="label">No card has been authorised yet.</p>
      )}
    </div>
  );
}

function PaymentMethodCard({ sub, outstanding, busy, onUpdateLink, onRevoke, onRefresh }) {
  return (
    <div className="glass card stack">
      <div className="row-between">
        <h3 className="section-title">Payment method</h3>
        {sub.status === 'PAST_DUE' ? <span className="chip chip--danger"><span className="led" />Declining</span> : null}
      </div>
      {sub.cardLast4 ? (
        <>
          <div><strong>{sub.cardBrand || 'Card'} •••• {sub.cardLast4}</strong></div>
          <div className="label">
            {sub.cardExpMonth && sub.cardExpYear
              ? `Expires ${String(sub.cardExpMonth).padStart(2, '0')}/${String(sub.cardExpYear).slice(-2)}`
              : 'Expiry unknown'}
            {sub.cardExpiry ? (sub.cardExpiry.expired ? ' — EXPIRED' : ' — expiring soon') : ''}
          </div>
        </>
      ) : <p className="label">No card on file.</p>}

      <p className="label">
        The full number never touched a Ride server. We store only the Authorize.Net identifier, the brand,
        the last four and the expiry.
      </p>

      <div className="inline-actions">
        <button type="button" className="button-subtle" disabled={busy} onClick={onUpdateLink}>
          Send new-card link
        </button>
        <button type="button" className="button-subtle" disabled={busy || !outstanding.length} onClick={onRevoke}>
          Revoke outstanding links ({outstanding.length})
        </button>
        <button type="button" className="button-subtle" disabled={busy} onClick={onRefresh}>
          Re-check at Authorize.Net
        </button>
      </div>

      <p className="label">
        A link sent by email, never a card form inside the panel. There is exactly one card-capture route in
        the system and it is the public tokenised page on Authorize.Net&apos;s own origin. That is what keeps
        the SAQ C scope intact.
      </p>

      {outstanding.length ? (
        <div className="label">
          Outstanding: {outstanding.map((i) => (
            <span key={i.id}>
              {i.mode} → {i.email} · prefix <code>{i.tokenPrefix}</code> · expires{' '}
              {new Date(i.expiresAt).toISOString().slice(0, 10)} · {i.openedAt ? 'opened' : 'unopened'}{' '}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActionsCard({ sub, tenant, planDiverges, busy, setDialog }) {
  return (
    <div className="glass card stack">
      <h3 className="section-title">Actions</h3>
      <div className="inline-actions">
        {planDiverges ? (
          <button type="button" className="button-subtle" disabled={busy} onClick={() => setDialog({ kind: 'applyPlan' })}>
            Apply billing plan to entitlements
          </button>
        ) : null}
        {tenant.status === 'SUSPENDED' ? (
          <button type="button" className="button-subtle" disabled={busy} onClick={() => setDialog({ kind: 'restore' })}>
            Restore access
          </button>
        ) : (
          <button type="button" className="button-danger" disabled={busy} onClick={() => setDialog({ kind: 'suspend' })}>
            Suspend access
          </button>
        )}
        <button type="button" className="button-danger" disabled={busy} onClick={() => setDialog({ kind: 'cancel' })}>
          Cancel subscription
        </button>
      </div>
      <p className="label">
        Plan and cycle changes are not here: they compute a prorated amount nobody has agreed to in advance,
        and they ship in a later phase with a preview of the exact number and the exact sentence that will be
        stored. Refunds are readable in the history below and issuable in the Authorize.Net portal.
      </p>
    </div>
  );
}

function ChargeHistory({ charges }) {
  return (
    <>
      <div className="row-between">
        <h3 className="section-title">Payment history</h3>
        <span className="label">This is the surface that answers a dispute. It reads aloud as written.</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Type</th><th>Description — what the customer is told</th>
              <th>Amount</th><th>Status</th><th>transId</th>
            </tr>
          </thead>
          <tbody>
            {charges.map((c) => (
              <tr key={c.id}>
                <td className="nowrap">{billingDate(c.chargeDate)}</td>
                <td><span className="chip chip--neutral">{c.kind}</span></td>
                <td>
                  {/* VERBATIM. Written once at charge time from the numbers
                      actually used; never recomputed from a catalog that may
                      since have been edited. */}
                  <div>{c.description}</div>
                  {c.status === 'DECLINED' ? (
                    <div className="label">
                      Declined{c.responseCode ? ` — response ${c.responseCode}` : ''}
                      {c.responseReasonText ? `: ${c.responseReasonText}` : ''}.
                      {' '}The subscription is suspended at Authorize.Net until the card is replaced.
                    </div>
                  ) : null}
                  {c.periodStart ? (
                    <div className="label">Covers {billingDate(c.periodStart)} → {billingDate(c.periodEnd)}</div>
                  ) : null}
                </td>
                <td className="nowrap">{money(c.amount, c.currency)}</td>
                <td><span className={`chip ${c.status === 'SETTLED' ? 'chip--ok' : c.status === 'DECLINED' || c.status === 'ERROR' ? 'chip--danger' : 'chip--neutral'}`}>{c.status}</span></td>
                <td className="nowrap"><code>{c.transId || '—'}</code></td>
              </tr>
            ))}
            {!charges.length ? (
              <tr><td colSpan={6} className="label">No charges recorded yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EventLog({ events }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr><th>Received</th><th>Type</th><th>Processed</th><th>Attempts</th><th>notificationId</th></tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="nowrap">{new Date(e.receivedAt).toISOString().replace('T', ' ').slice(0, 19)}</td>
              <td><code>{e.eventType}</code></td>
              <td>
                {e.processedAt
                  ? <span className="chip chip--ok">{new Date(e.processedAt).toISOString().slice(11, 19)}</span>
                  : <span className="chip chip--warn">unprocessed</span>}
                {e.processingError ? <div className="label">{e.processingError}</div> : null}
              </td>
              <td>{e.attempts}</td>
              <td className="nowrap"><code>{String(e.notificationId).slice(0, 8)}…</code></td>
            </tr>
          ))}
          {!events.length ? <tr><td colSpan={5} className="label">No events yet.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The one-time link. Shown once and never again: only the sha256 is stored, so
 * there is no "show me that link again" — if it is lost, revoke and mint a new
 * one. Same bargain the driver-shift links already make.
 */
function MintedLink({ minted, onDismiss }) {
  return (
    <div className="app-banner">
      <strong>Link created — this is the only time it is shown.</strong>
      <div><code>{minted.url}</code></div>
      <p className="label">
        Sent to {minted.email}. Single-use, expires{' '}
        {minted.expiresAt ? new Date(minted.expiresAt).toISOString().slice(0, 10) : ''}. Anyone holding it can
        attach a card to this tenant until it is used, expires or is revoked — send it only to the person who
        pays. For support: prefix <code>{minted.tokenPrefix}</code>.
      </p>
      <div className="inline-actions">
        <button
          type="button"
          className="button-subtle"
          onClick={() => navigator?.clipboard?.writeText(minted.url)}
        >
          Copy link
        </button>
        <button type="button" className="button-subtle" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

/**
 * Render a raw Tenant.status for prose. Tenant.status is FREE TEXT (schema:
 * `status String`, and tenants.service.js updateTenant only uppercases whatever
 * it is given), so there is no label map to look it up in the way STATUS_LABEL
 * covers the subscription's fixed vocabulary. Title-cased to sit beside
 * "Active" and "Past due" in the same sentence rather than shouting DEMO at the
 * reader.
 */
function titleCaseStatus(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
}

const DIALOGS = {
  updateLink: {
    title: 'Send a new-card link',
    submit: 'Generate link',
    danger: false,
    body: (
      <>
        <p>
          Emails the billing contact a tokenised link on Authorize.Net&apos;s own origin where they replace the
          card. The plan, the amount and the schedule do not change.
        </p>
        <p className="label">
          This is the documented remedy for a decline: Authorize.Net resumes billing a suspended subscription
          only once the payment method has been updated.
        </p>
      </>
    ),
    fields: [{ name: 'email', label: 'Send to (blank = the address that authorised the card)', required: false }],
  },
  suspend: {
    title: 'Suspend access',
    submit: 'Suspend this tenant',
    danger: true,
    // A FUNCTION, not a node — this is the one dialog whose true consequences
    // depend on a deploy variable. See the comment inside.
    body: ({ enforcement }) => (
      <>
        <p><strong>What stops working immediately:</strong></p>
        <ul>
          <li>Their public booking website goes dark</li>
          <li>The booking engine — search, availability, quotes, listings</li>
          <li>Their integration syncs: Economy, NU, booking-source</li>
        </ul>
        {/* THE HONEST LIMIT, AND IT NOW DEPENDS ON A DEPLOY VARIABLE.
            The staff lockout shipped in Phase 5 but is gated on
            TENANT_SUSPENSION_ENFORCEMENT, which the browser cannot see — so the
            backend tells us (`suspensionEnforcement` on the detail payload) and
            this paragraph says what is TRUE ON THIS DEPLOY. Hard-coding either
            answer would be a lie about a lever being pulled on a paying
            customer, which is the thing this dialog was written to avoid. */}
        {enforcement === 'enforce' ? (
          <p><strong>Their staff are locked out of the app immediately.</strong> Signed-in sessions stop
            working on the next request — no waiting for a token to expire. They keep exactly three things:
            the billing page where they pay us, the ability to close out rentals that are already on the
            street, and their own customers&apos; in-flight surfaces (shuttle tracker, signing,
            pre-check-in), which are never gated.</p>
        ) : (
          <p><strong>What does NOT stop:</strong> their staff can still sign in and use the app. The
            request-time lock exists in this build but is switched OFF on this deploy
            (<code>TENANT_SUSPENSION_ENFORCEMENT</code>{enforcement === 'log' ? ' is in log-only mode' : ' is not set'}),
            so today this is a commercial lever over their public surfaces, not a freeze.</p>
        )}
        <p className="label">
          The Authorize.Net subscription is left alone — it keeps its schedule so a fixed card resumes
          instantly. Nothing here cancels it.
        </p>
      </>
    ),
    fields: [{ name: 'reason', label: 'Reason (goes in the audit log with your user)', required: true, textarea: true }],
  },
  restore: {
    title: 'Restore access',
    submit: 'Restore this tenant',
    danger: false,
    // A FUNCTION, like suspend's, and for the same reason: only the server knows
    // what this tenant goes back to. Tenant.status is free text and 'ACTIVE' is
    // load-bearing — the public booking token resolver, the booking-engine tenant
    // resolution and the car-sharing marketplace list all match it exactly — so
    // "restore" does NOT mean "put on the public site" for every tenant.
    //
    // READS `restoresToStatus`, WHICH THE SERVER RESOLVED. It does NOT re-derive
    // the rule from `billingPreviousStatus`: that rule has edge cases (a
    // recorded SUSPENDED falls back to ACTIVE) and a second copy of it here
    // would drift into a dialog promising one outcome while the write performs
    // another. resolveRestoredTenantStatus() in billing-admin.service.js owns it.
    body: ({ tenant }) => {
      const back = String(tenant?.restoresToStatus || 'ACTIVE').trim();
      const returnsToActive = back.toUpperCase() === 'ACTIVE';
      return (
        <>
          <p>
            Returns this tenant to <strong>{titleCaseStatus(back)}</strong>{' '}
            {tenant?.billingPreviousStatus
              ? '— the status it held before billing suspended it.'
              : '— no earlier status was recorded for this suspension, so it falls back to Active.'}{' '}
            {returnsToActive
              ? 'Their public booking site and integration syncs come back on.'
              : 'That is NOT Active, so their public booking site stays dark and they stay out of the '
                + 'car-sharing marketplace — exactly as before the suspension.'}
          </p>
          <p className="label">
            The subscription carries its own status: a delinquent one comes back <strong>Past due</strong>.
            Restoring access is not evidence that money moved, and only a settled charge clears a delinquency.
          </p>
        </>
      );
    },
    fields: [{ name: 'reason', label: 'Reason (optional)', required: false }],
  },
  applyPlan: {
    title: 'Apply the billing plan to entitlements',
    submit: 'Apply to entitlements',
    danger: false,
    body: (
      <>
        <p>
          Moves <code>Tenant.plan</code> — the entitlement key that drives user and vehicle caps — to match the
          plan this tenant is billed for. This is the only way the two ever get reconciled, and it is always a
          deliberate click.
        </p>
        <p className="label">
          It changes entitlements only. It does not change the amount, does not re-price anything, and does not
          touch Authorize.Net. If this is a downgrade the tenant may end up over the new caps; existing records
          are untouched and the next create is what gets refused.
        </p>
      </>
    ),
    fields: [],
  },
  cancel: {
    title: 'Cancel subscription',
    submit: 'Cancel at Authorize.Net',
    danger: true,
    body: (
      <>
        <p>
          <strong>This calls Authorize.Net first</strong> and marks the subscription cancelled here only if that
          succeeds. If Authorize.Net refuses or times out, nothing changes on this screen — because a row marked
          cancelled whose subscription is still live over there would keep charging a card belonging to somebody
          who believes they cancelled.
        </p>
        <p>It cannot be undone. Resuming means a new enrollment and the customer typing a card again.</p>
        <p className="label">The agreed cancellation policy is 30 days&apos; notice.</p>
      </>
    ),
    fields: [
      { name: 'reason', label: 'Reason (required)', required: true, textarea: true },
      { name: 'confirm', label: `Type ${CANCEL_CONFIRMATION} to confirm`, required: true, placeholder: CANCEL_CONFIRMATION },
    ],
  },
};

function ActionDialog({ dialog, tenant, sub, busy, enforcement, onClose, onSubmit }) {
  const spec = DIALOGS[dialog.kind];
  const [form, setForm] = useState({});
  if (!spec) return null;

  // A spec body may be a node (most of them) or a function of the live deploy
  // context (suspend, whose consequences differ by environment variable) or of
  // the tenant itself (restore, whose outcome differs by recorded status).
  const bodyNode = typeof spec.body === 'function' ? spec.body({ enforcement, tenant }) : spec.body;

  const missing = spec.fields.some((f) => f.required && !String(form[f.name] || '').trim());

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rent-modal glass" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h3 className="section-title">{spec.title}</h3>
          {spec.danger ? <span className="chip chip--danger"><span className="led" />Destructive</span> : null}
        </div>
        <p className="label">{tenant.name}{sub ? ` · ${sub.planName} · ${money(sub.amount, sub.currency)}` : ''}</p>

        <div className={spec.danger ? 'error' : 'surface-note'}>{bodyNode}</div>

        {spec.fields.map((f) => (
          <div key={f.name} className="stack">
            <label htmlFor={`dlg-${f.name}`}>{f.label}</label>
            {f.textarea ? (
              <textarea
                id={`dlg-${f.name}`}
                value={form[f.name] || ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.name]: e.target.value }))}
              />
            ) : (
              <input
                id={`dlg-${f.name}`}
                type="text"
                placeholder={f.placeholder || ''}
                value={form[f.name] || ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.name]: e.target.value }))}
              />
            )}
          </div>
        ))}

        <div className="inline-actions">
          <button type="button" className="button-subtle" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={spec.danger ? 'button-danger' : 'button'}
            disabled={busy || missing}
            onClick={() => onSubmit(form)}
          >
            {spec.submit}
          </button>
        </div>
      </div>
    </div>
  );
}

function Kv({ k, v }) {
  return (
    <div className="row-between">
      <span className="label">{k}</span>
      <span>{v ?? '—'}</span>
    </div>
  );
}

function Copyable({ value }) {
  if (!value) return <span className="label">—</span>;
  return (
    <>
      <code>{value}</code>{' '}
      <button
        type="button"
        className="button-subtle"
        aria-label={`Copy ${value}`}
        onClick={() => navigator?.clipboard?.writeText(value)}
      >
        ⧉
      </button>
    </>
  );
}
