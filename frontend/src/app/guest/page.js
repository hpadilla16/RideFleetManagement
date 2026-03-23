'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { API_BASE, api } from '../../lib/client';

const RECENT_LOOKUPS_KEY = 'guest.recentLookups';

function fmtMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'completed') return { color: '#12633d', background: 'rgba(43, 174, 96, 0.14)' };
  if (value === 'active' || value === 'partial') return { color: '#10568b', background: 'rgba(48, 135, 214, 0.14)' };
  if (value === 'requested') return { color: '#7a4f08', background: 'rgba(255, 191, 71, 0.18)' };
  return { color: '#6f5b8f', background: 'rgba(111, 91, 143, 0.1)' };
}

function resolvePortalAction(confirmation, key) {
  const nextActions = confirmation?.nextActions;
  if (!nextActions) return null;
  if (nextActions[key]) return nextActions[key];
  if (key === 'customerInfo' && nextActions?.link) return nextActions;
  return null;
}

function tokenFromLink(link) {
  if (!link) return '';
  try {
    return new URL(link).searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function timelineStatus(portal, key) {
  return portal?.timeline?.find((item) => item.key === key) || null;
}

async function lookupBooking({ reference, email }) {
  return api('/api/public/booking/lookup', {
    method: 'POST',
    body: JSON.stringify({ reference, email })
  });
}

function StatusPill({ status }) {
  const tone = statusTone(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 28,
        padding: '0 10px',
        borderRadius: 999,
        background: tone.background,
        color: tone.color,
        fontSize: 12,
        fontWeight: 700,
        textTransform: 'capitalize'
      }}
    >
      {status}
    </span>
  );
}

export default function GuestAppPage() {
  const [lookupState, setLookupState] = useState({ reference: '', email: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [portalStatus, setPortalStatus] = useState(null);
  const [recentLookups, setRecentLookups] = useState([]);
  const [issueForm, setIssueForm] = useState({ type: 'OTHER', title: '', description: '', amountClaimed: '' });
  const [issueMsg, setIssueMsg] = useState('');

  const customerInfoAction = resolvePortalAction(result, 'customerInfo');
  const signatureAction = resolvePortalAction(result, 'signature');
  const paymentAction = resolvePortalAction(result, 'payment');
  const customerInfoLive = timelineStatus(portalStatus, 'customerInfo');
  const signatureLive = timelineStatus(portalStatus, 'signature');
  const paymentLive = timelineStatus(portalStatus, 'payment');
  const documents = portalStatus?.documents || [];
  const timeline = portalStatus?.timeline || [];

  const primaryAction = useMemo(() => {
    if (portalStatus?.nextStep?.link) return { label: portalStatus.nextStep.label, link: portalStatus.nextStep.link };
    if (customerInfoAction?.link) return { label: 'Continue to Pre-check-in', link: customerInfoAction.link };
    if (signatureAction?.link) return { label: 'Continue to Signature', link: signatureAction.link };
    if (paymentAction?.link) return { label: 'Continue to Payment', link: paymentAction.link };
    return null;
  }, [customerInfoAction?.link, paymentAction?.link, portalStatus?.nextStep?.label, portalStatus?.nextStep?.link, signatureAction?.link]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(RECENT_LOOKUPS_KEY) || '[]');
      setRecentLookups(Array.isArray(stored) ? stored : []);
    } catch {
      setRecentLookups([]);
    }
  }, []);

  function persistRecentLookup(confirmation, fallbackEmail = '') {
    const entry = {
      reference: confirmation?.trip?.tripCode || confirmation?.reservation?.reservationNumber || '',
      email: confirmation?.customer?.email || fallbackEmail,
      customerName: `${confirmation?.customer?.firstName || ''} ${confirmation?.customer?.lastName || ''}`.trim() || 'Guest',
      bookingType: confirmation?.bookingType || 'RENTAL',
      updatedAt: new Date().toISOString()
    };
    if (!entry.reference || !entry.email) return;
    try {
      const next = [entry, ...recentLookups.filter((row) => !(row.reference === entry.reference && row.email === entry.email))].slice(0, 5);
      localStorage.setItem(RECENT_LOOKUPS_KEY, JSON.stringify(next));
      setRecentLookups(next);
    } catch {}
  }

  async function loadPortalStatus(confirmation) {
    const token = tokenFromLink(resolvePortalAction(confirmation, 'customerInfo')?.link);
    if (!token) {
      setPortalStatus(null);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/public/customer-info/${encodeURIComponent(token)}`, {
        method: 'GET',
        cache: 'no-store'
      });
      if (!res.ok) {
        setPortalStatus(null);
        return;
      }
      const json = await res.json();
      setPortalStatus(json?.portal || null);
    } catch {
      setPortalStatus(null);
    }
  }

  async function resolveLookup(reference, email) {
    setLoading(true);
    setError('');
    try {
      const payload = await lookupBooking({ reference, email });
      setResult(payload);
      persistRecentLookup(payload, email);
      await loadPortalStatus(payload);
    } catch (err) {
      setResult(null);
      setPortalStatus(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function runLookup() {
    await resolveLookup(lookupState.reference, lookupState.email);
  }

  async function useRecentLookup(row) {
    const next = { reference: row.reference, email: row.email };
    setLookupState(next);
    await resolveLookup(next.reference, next.email);
  }

  async function submitIssue(event) {
    event.preventDefault();
    try {
      const created = await api('/api/public/booking/issues', {
        method: 'POST',
        body: JSON.stringify({
          reference: result?.trip?.tripCode || result?.reservation?.reservationNumber || lookupState.reference,
          email: result?.customer?.email || lookupState.email,
          type: issueForm.type,
          title: issueForm.title,
          description: issueForm.description,
          amountClaimed: issueForm.amountClaimed === '' ? null : Number(issueForm.amountClaimed)
        })
      });
      setIssueMsg('Issue submitted. Customer service can now review it in the Issue Center.');
      setIssueForm({ type: 'OTHER', title: '', description: '', amountClaimed: '' });
      setResult((current) => current ? {
        ...current,
        trip: {
          ...current.trip,
          incidents: [created, ...(current.trip?.incidents || [])]
        }
      } : current);
    } catch (err) {
      setIssueMsg(err.message);
    }
  }

  return (
    <main style={{ minHeight: '100vh', padding: '22px clamp(16px, 3vw, 34px) 42px' }}>
      <div style={{ maxWidth: 1160, margin: '0 auto', display: 'grid', gap: 18 }}>
        <section className="glass card-lg page-hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <span className="eyebrow">Guest App Foundation</span>
              <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 54px)', lineHeight: 1.02 }}>
                Manage your booking, complete your steps, and reopen your documents from one guest surface.
              </h1>
              <p>
                Guests can find a rental reservation or car sharing trip, check live progress, download documents and receipts,
                and jump directly into pre-check-in, signature, or payment without calling the counter.
              </p>
              <div className="hero-meta">
                <span className="hero-pill">Guest resume flow</span>
                <span className="hero-pill">Live step status</span>
                <span className="hero-pill">Documents and receipts</span>
              </div>
            </div>
            <div className="glass card section-card">
              <div className="section-title">What Guests Can Do</div>
              <div className="stack">
                <div className="surface-note">Look up a booking using the reservation or trip reference plus email.</div>
                <div className="surface-note">See the next required step in real time.</div>
                <div className="surface-note">Download signed paperwork and receipts when they are ready.</div>
              </div>
            </div>
          </div>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Find Your Booking</div>
              <p className="ui-muted">Use the same email that was used during booking. Works for rental and car sharing.</p>
            </div>
            <span className="status-chip neutral">Guest Access</span>
          </div>
          <div className="form-grid-2">
            <div>
              <div className="label">Reference</div>
              <input
                value={lookupState.reference}
                onChange={(event) => setLookupState((current) => ({ ...current, reference: event.target.value }))}
                placeholder="Reservation number or trip code"
              />
            </div>
            <div>
              <div className="label">Email</div>
              <input
                type="email"
                value={lookupState.email}
                onChange={(event) => setLookupState((current) => ({ ...current, email: event.target.value }))}
                placeholder="guest@email.com"
              />
            </div>
          </div>
          <div className="inline-actions">
            <button type="button" disabled={loading} onClick={runLookup}>
              {loading ? 'Finding Booking...' : 'Open Guest Booking'}
            </button>
            <Link href="/book">
              <button type="button" className="button-subtle">Create New Booking</button>
            </Link>
          </div>
          {error ? <div className="surface-note" style={{ color: '#991b1b' }}>{error}</div> : null}
        </section>

        {recentLookups.length ? (
          <section className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Recent Guest Lookups</div>
                <p className="ui-muted">Helpful when a guest returns later from the same device.</p>
              </div>
              <button
                type="button"
                className="button-subtle"
                onClick={() => {
                  try { localStorage.removeItem(RECENT_LOOKUPS_KEY); } catch {}
                  setRecentLookups([]);
                }}
              >
                Clear
              </button>
            </div>
            <div className="app-card-grid compact">
              {recentLookups.map((row) => (
                <div key={`${row.reference}:${row.email}`} className="glass card section-card" style={{ padding: 14 }}>
                  <div style={{ fontWeight: 700 }}>{row.reference}</div>
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                    {row.customerName} - {row.bookingType === 'CAR_SHARING' ? 'Car Sharing' : 'Rental'}
                  </div>
                  <div className="ui-muted" style={{ fontSize: 13 }}>{row.email}</div>
                  <div className="inline-actions">
                    <button type="button" onClick={() => useRecentLookup(row)}>Resume Now</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {result ? (
          <section className="split-panel">
            <div className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Guest Booking Summary</div>
                  <p className="ui-muted">A clean snapshot of the booking, guest, and next action.</p>
                </div>
                <span className="status-chip neutral">{result.bookingType === 'CAR_SHARING' ? 'Car Sharing' : 'Rental'}</span>
              </div>
              <div className="info-grid-tight">
                <div className="info-tile"><span className="label">Reference</span><strong>{result.trip?.tripCode || result.reservation?.reservationNumber || '-'}</strong></div>
                <div className="info-tile"><span className="label">Customer</span><strong>{`${result.customer?.firstName || ''} ${result.customer?.lastName || ''}`.trim() || 'Guest'}</strong></div>
                <div className="info-tile"><span className="label">Tenant</span><strong>{result.tenant?.name || '-'}</strong></div>
                <div className="info-tile"><span className="label">Current Step</span><strong>{portalStatus?.progress?.currentStep || 'Guest Flow'}</strong></div>
                <div className="info-tile"><span className="label">Pickup</span><strong>{formatDateTime(result.reservation?.pickupAt)}</strong></div>
                <div className="info-tile"><span className="label">Return</span><strong>{formatDateTime(result.reservation?.returnAt)}</strong></div>
              </div>
              <div className="app-banner">
                <div className="section-title">Booking Snapshot</div>
                <div className="app-banner-list">
                  {result.bookingType === 'CAR_SHARING' ? (
                    <>
                      <span className="app-banner-pill">Trip total {fmtMoney(result.trip?.quotedTotal)}</span>
                      <span className="app-banner-pill">Host earnings {fmtMoney(result.trip?.hostEarnings)}</span>
                      <span className="app-banner-pill">Platform fee {fmtMoney(result.trip?.platformFee)}</span>
                    </>
                  ) : (
                    <>
                      <span className="app-banner-pill">Reservation estimate {fmtMoney(result.reservation?.estimatedTotal)}</span>
                      <span className="app-banner-pill">Status {result.reservation?.status || '-'}</span>
                      <span className="app-banner-pill">Payment {portalStatus?.paymentStatusLabel || 'Pending'}</span>
                    </>
                  )}
                </div>
              </div>
              {primaryAction?.link ? (
                <div className="inline-actions">
                  <a href={primaryAction.link} target="_blank" rel="noreferrer">
                    <button type="button">{primaryAction.label}</button>
                  </a>
                </div>
              ) : null}
            </div>

            <div className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Live Guest Status</div>
                  <p className="ui-muted">Real-time visibility into progress and the next required step.</p>
                </div>
                <span className="status-chip neutral">{portalStatus?.progress?.percent || 0}% complete</span>
              </div>
              {portalStatus ? (
                <div className="stack">
                  <div className="surface-note" style={{ display: 'grid', gap: 10 }}>
                    <div style={{ height: 10, borderRadius: 999, background: 'rgba(146, 118, 255, 0.14)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${portalStatus.progress?.percent || 0}%`,
                          height: '100%',
                          borderRadius: 999,
                          background: 'linear-gradient(90deg, #7c3aed 0%, #38bdf8 100%)'
                        }}
                      />
                    </div>
                    <div style={{ color: '#55456f', lineHeight: 1.5 }}>
                      Progress <strong>{portalStatus.progress?.completedSteps || 0}/{portalStatus.progress?.totalSteps || 0}</strong>.
                      {' '}Next action: <strong>{portalStatus.progress?.nextAction || 'Continue your guest workflow.'}</strong>
                    </div>
                  </div>
                  <div className="app-card-grid compact">
                    {[customerInfoLive, signatureLive, paymentLive].filter(Boolean).map((item) => (
                      <div key={item.key} className="doc-card">
                        <div className="row-between" style={{ gap: 10, alignItems: 'center' }}>
                          <strong>{item.label}</strong>
                          <StatusPill status={item.status} />
                        </div>
                        <div className="doc-meta">{item.description || '-'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="surface-note">Live portal status will appear here as soon as the guest flow is available.</div>
              )}
              <div className="inline-actions">
                {customerInfoAction?.link ? (
                  <a href={customerInfoAction.link} target="_blank" rel="noreferrer">
                    <button type="button" className="button-subtle">Pre-check-in</button>
                  </a>
                ) : null}
                {signatureAction?.link ? (
                  <a href={signatureAction.link} target="_blank" rel="noreferrer">
                    <button type="button" className="button-subtle">Signature</button>
                  </a>
                ) : null}
                {paymentAction?.link ? (
                  <a href={paymentAction.link} target="_blank" rel="noreferrer">
                    <button type="button" className="button-subtle">Payment</button>
                  </a>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {result ? (
          <section className="split-panel">
            <div className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Documents And Receipts</div>
                  <p className="ui-muted">Guests can reopen signed paperwork and payment proof without calling the counter.</p>
                </div>
                <span className="status-chip neutral">{documents.filter((item) => item.available).length} available</span>
              </div>
              {documents.length ? (
                <div className="doc-grid">
                  {documents.map((doc) => (
                    <div key={doc.key} className="doc-card">
                      <div className="row-between" style={{ gap: 12 }}>
                        <div>
                          <strong>{doc.label}</strong>
                          <div className="doc-meta">{doc.available ? 'Ready to download' : 'Not available yet'}</div>
                        </div>
                        <span className={doc.available ? 'status-chip good' : 'status-chip neutral'}>
                          {doc.available ? 'Available' : 'Pending'}
                        </span>
                      </div>
                      {doc.available ? (
                        <div className="inline-actions">
                          <a href={`${API_BASE}${doc.downloadPath}`} target="_blank" rel="noreferrer">
                            <button type="button">Download</button>
                          </a>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="surface-note">Documents will appear here as the booking progresses.</div>
              )}
            </div>

            <div className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Booking Timeline</div>
                  <p className="ui-muted">A guest-friendly view of what has already happened and what still remains.</p>
                </div>
                <span className="status-chip neutral">{timeline.length} events</span>
              </div>
              {timeline.length ? (
                <div className="timeline-list">
                  {timeline.map((item) => (
                    <div key={item.key} className="timeline-item">
                      <div className="row-between" style={{ gap: 10 }}>
                        <strong>{item.label}</strong>
                        <StatusPill status={item.status} />
                      </div>
                      <div className="ui-muted" style={{ fontSize: 13 }}>{formatDateTime(item.at)}</div>
                      <div style={{ color: '#55456f', lineHeight: 1.5 }}>{item.description || '-'}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="surface-note">Timeline entries will appear here as the booking moves forward.</div>
              )}
            </div>
          </section>
        ) : null}

        {result?.bookingType === 'CAR_SHARING' && result?.trip ? (
          <section className="split-panel">
            <div className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Report An Issue Or Dispute</div>
                  <p className="ui-muted">Guests can report damage, cleaning, toll, late return, or other trip disputes from here.</p>
                </div>
                <span className="status-chip warn">{(result.trip?.incidents || []).length} cases</span>
              </div>
              {issueMsg ? <div className="surface-note" style={{ color: /submitted/i.test(issueMsg) ? '#166534' : '#991b1b' }}>{issueMsg}</div> : null}
              <form className="stack" onSubmit={submitIssue}>
                <div className="form-grid-2">
                  <div>
                    <div className="label">Issue Type</div>
                    <select value={issueForm.type} onChange={(e) => setIssueForm((current) => ({ ...current, type: e.target.value }))}>
                      <option value="DAMAGE">Damage</option>
                      <option value="TOLL">Toll</option>
                      <option value="CLEANING">Cleaning</option>
                      <option value="LATE_RETURN">Late Return</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                  <div>
                    <div className="label">Amount Claimed</div>
                    <input type="number" min="0" step="0.01" value={issueForm.amountClaimed} onChange={(e) => setIssueForm((current) => ({ ...current, amountClaimed: e.target.value }))} placeholder="Optional" />
                  </div>
                </div>
                <div>
                  <div className="label">Title</div>
                  <input value={issueForm.title} onChange={(e) => setIssueForm((current) => ({ ...current, title: e.target.value }))} placeholder="Short summary of the issue" />
                </div>
                <div>
                  <div className="label">Details</div>
                  <textarea rows={4} value={issueForm.description} onChange={(e) => setIssueForm((current) => ({ ...current, description: e.target.value }))} placeholder="Describe what happened and what support is needed" />
                </div>
                <div className="inline-actions">
                  <button type="submit">Submit Issue</button>
                </div>
              </form>
            </div>

            <div className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Existing Cases</div>
                  <p className="ui-muted">A quick status view of issues already raised for this trip.</p>
                </div>
              </div>
              {(result.trip?.incidents || []).length ? (
                <div className="timeline-list">
                  {result.trip.incidents.map((incident) => (
                    <div key={incident.id} className="timeline-item">
                      <div className="row-between" style={{ gap: 10 }}>
                        <strong>{incident.title}</strong>
                        <StatusPill status={incident.status} />
                      </div>
                      <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                        {[incident.type, incident.amountClaimed ? fmtMoney(incident.amountClaimed) : 'No amount claimed'].join(' - ')}
                      </div>
                      <div className="ui-muted" style={{ fontSize: 13 }}>{formatDateTime(incident.createdAt)}</div>
                      <div style={{ color: '#55456f', lineHeight: 1.5 }}>{incident.description || 'No details provided.'}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="surface-note">No guest issues have been raised for this trip yet.</div>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
