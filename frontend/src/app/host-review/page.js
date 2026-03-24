'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../../lib/client';

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function stars(rating) {
  const value = Math.max(0, Math.min(5, Number(rating || 0)));
  return '★★★★★'.slice(0, value) + '☆☆☆☆☆'.slice(0, 5 - value);
}

export default function HostReviewPage() {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState(null);
  const [form, setForm] = useState({ rating: 5, comments: '' });

  useEffect(() => {
    try {
      const params = new URL(window.location.href).searchParams;
      setToken(params.get('token') || '');
    } catch {
      setToken('');
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`${API_BASE}/api/public/booking/host-reviews/${encodeURIComponent(token)}`, {
          method: 'GET',
          cache: 'no-store'
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) throw new Error(json?.error || 'Unable to load host review');
        if (!mounted) return;
        setPayload(json);
        if (json?.review?.status === 'SUBMITTED') {
          setForm({
            rating: Number(json.review.rating || 5),
            comments: json.review.comments || ''
          });
        }
      } catch (err) {
        if (!mounted) return;
        setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [token]);

  const alreadySubmitted = payload?.review?.status === 'SUBMITTED';
  const host = payload?.host || null;
  const trip = payload?.trip || null;
  const hostTrustState = Number(host?.averageRating || 0) >= 4.5 ? 'Strong trust signal' : Number(host?.reviewCount || 0) ? 'Growing review history' : 'First reviews coming in';

  const summary = useMemo(() => {
    if (!host) return null;
    return `${Number(host.averageRating || 0).toFixed(2)} average across ${Number(host.reviewCount || 0)} review${Number(host.reviewCount || 0) === 1 ? '' : 's'}`;
  }, [host]);

  async function submit() {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/public/booking/host-reviews/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(json?.error || 'Unable to submit host review');
      setPayload((current) => ({
        ...(current || {}),
        review: json.review,
        host: json.host || current?.host || null
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', padding: '24px clamp(16px, 3vw, 34px) 42px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', display: 'grid', gap: 18 }}>
        <section className="glass card-lg page-hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <span className="eyebrow">Host Rating</span>
              <h1 className="page-title" style={{ fontSize: 'clamp(28px, 4vw, 52px)', lineHeight: 1.04 }}>
                Rate your host after the trip and help future guests book with confidence.
              </h1>
              <p>
                Share a simple rating and an optional comment. This rating becomes part of the host profile shown during future car sharing bookings.
              </p>
            </div>
            <div className="glass card section-card">
              <div className="section-title">Trip Snapshot</div>
              <div className="stack">
                <div className="surface-note">{trip?.tripCode || 'Trip review'}</div>
                <div className="surface-note">{trip?.listingTitle || 'Host trip'}</div>
                <div className="surface-note">{trip?.vehicleLabel || 'Vehicle'}{trip?.locationName ? ` · ${trip.locationName}` : ''}</div>
              </div>
            </div>
          </div>
        </section>

        {error ? <div className="surface-note" style={{ color: '#991b1b' }}>{error}</div> : null}

        {loading ? (
          <section className="glass card-lg section-card">
            <div className="surface-note">Loading host review...</div>
          </section>
        ) : payload ? (
          <>
          <section className="app-banner">
            <div className="row-between" style={{ marginBottom: 0 }}>
              <div className="stack" style={{ gap: 6 }}>
                <span className="eyebrow">Review Snapshot</span>
                <h3 style={{ margin: 0 }}>{alreadySubmitted ? 'Thanks for rating this host' : 'Your feedback helps the marketplace'}</h3>
                <p className="ui-muted">
                  Show future guests what the host experience felt like while giving the host a clear trust signal on future bookings.
                </p>
              </div>
              <span className={`status-chip ${alreadySubmitted ? 'good' : 'neutral'}`}>
                {alreadySubmitted ? 'Review submitted' : 'Review pending'}
              </span>
            </div>
            <div className="app-card-grid compact">
              <div className="info-tile">
                <span className="label">Host</span>
                <strong>{host?.displayName || '-'}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Current Rating</span>
                <strong>{Number(host?.averageRating || 0).toFixed(2)}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Review Count</span>
                <strong>{host?.reviewCount || 0}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Trust Signal</span>
                <strong>{hostTrustState}</strong>
              </div>
            </div>
          </section>
          <section className="split-panel">
            <section className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Host Profile</div>
                  <p className="ui-muted">This is the host your rating will support.</p>
                </div>
                {host?.id ? (
                  <Link href={`/host-profile/${host.id}`}>
                    <button type="button" className="button-subtle">View Host Profile</button>
                  </Link>
                ) : null}
              </div>
              <div className="info-grid-tight">
                <div className="info-tile"><span className="label">Host</span><strong>{host?.displayName || '-'}</strong></div>
                <div className="info-tile"><span className="label">Average Rating</span><strong>{Number(host?.averageRating || 0).toFixed(2)}</strong></div>
                <div className="info-tile"><span className="label">Review Count</span><strong>{host?.reviewCount || 0}</strong></div>
                <div className="info-tile"><span className="label">Scheduled Return</span><strong>{formatDateTime(trip?.scheduledReturnAt)}</strong></div>
              </div>
              {summary ? <div className="surface-note">{summary}</div> : null}
            </section>

            <section className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Your Review</div>
                  <p className="ui-muted">A quick score and optional comment are enough.</p>
                </div>
                {alreadySubmitted ? <span className="status-chip good">Submitted</span> : <span className="status-chip neutral">Pending</span>}
              </div>

              {alreadySubmitted ? (
                <div className="stack">
                  <div className="surface-note">
                    <strong>{stars(payload.review?.rating)}</strong>
                    <br />
                    Submitted {formatDateTime(payload.review?.submittedAt)}
                  </div>
                  <div className="surface-note">{payload.review?.comments || 'No comment was left with this rating.'}</div>
                </div>
              ) : (
                <div className="stack">
                  <div className="section-title" style={{ fontSize: 16 }}>How would you rate this host?</div>
                  <div className="inline-actions">
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={form.rating === value ? '' : 'button-subtle'}
                        onClick={() => setForm((current) => ({ ...current, rating: value }))}
                      >
                        {value} Star{value === 1 ? '' : 's'}
                      </button>
                    ))}
                  </div>
                  <div className="surface-note">{stars(form.rating)}</div>
                  <div className="stack">
                    <label className="label">Comments</label>
                    <textarea
                      rows={5}
                      value={form.comments}
                      onChange={(event) => setForm((current) => ({ ...current, comments: event.target.value }))}
                      placeholder="Tell future guests what went well, what stood out, or anything the host should improve."
                    />
                  </div>
                  <div className="inline-actions">
                    <button type="button" disabled={saving} onClick={submit}>
                      {saving ? 'Submitting...' : 'Submit Host Review'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
