'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API_BASE } from '../../../lib/client';

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return String(value);
  }
}

function ratingStars(rating) {
  const value = Math.max(0, Math.min(5, Math.round(Number(rating || 0))));
  return '★★★★★'.slice(0, value) + '☆☆☆☆☆'.slice(0, 5 - value);
}

export default function HostProfilePage() {
  const params = useParams();
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params?.id) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`${API_BASE}/api/public/booking/hosts/${encodeURIComponent(params.id)}`, {
          method: 'GET',
          cache: 'no-store'
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) throw new Error(json?.error || 'Unable to load host profile');
        if (!mounted) return;
        setPayload(json);
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
  }, [params?.id]);

  const host = payload?.host || null;

  return (
    <main style={{ minHeight: '100vh', padding: '24px clamp(16px, 3vw, 34px) 42px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'grid', gap: 18 }}>
        <section className="glass card-lg page-hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <span className="eyebrow">Host Profile</span>
              <h1 className="page-title" style={{ fontSize: 'clamp(28px, 4vw, 52px)', lineHeight: 1.04 }}>
                {host?.displayName || 'Host profile'}
              </h1>
              <p>
                Review the host’s rating history, recent guest feedback, and active public supply before booking.
              </p>
              {host ? (
                <div className="hero-meta">
                  <span className="hero-pill">{Number(host.averageRating || 0).toFixed(2)} rating</span>
                  <span className="hero-pill">{host.reviewCount || 0} review{host.reviewCount === 1 ? '' : 's'}</span>
                  <span className="hero-pill">{host.completedTrips || 0} completed trip{host.completedTrips === 1 ? '' : 's'}</span>
                </div>
              ) : null}
            </div>
            <div className="glass card section-card">
              <div className="section-title">Quick Snapshot</div>
              <div className="metric-grid">
                <div className="metric-card"><span className="label">Average</span><strong>{Number(host?.averageRating || 0).toFixed(2)}</strong></div>
                <div className="metric-card"><span className="label">Reviews</span><strong>{host?.reviewCount || 0}</strong></div>
                <div className="metric-card"><span className="label">Listings</span><strong>{host?.activeListings || 0}</strong></div>
                <div className="metric-card"><span className="label">Member Since</span><strong>{formatDateTime(host?.createdAt)}</strong></div>
              </div>
            </div>
          </div>
        </section>

        {error ? <div className="surface-note" style={{ color: '#991b1b' }}>{error}</div> : null}
        {loading ? <div className="surface-note">Loading host profile...</div> : null}

        {payload ? (
          <>
            <section className="split-panel">
              <section className="glass card-lg section-card">
                <div className="section-title">Recent Guest Reviews</div>
                <p className="ui-muted">These comments feed the host rating shown across the booking experience.</p>
                {payload.reviews?.length ? (
                  <div className="stack">
                    {payload.reviews.map((review) => (
                      <div key={review.id} className="doc-card">
                        <div className="row-between" style={{ gap: 12 }}>
                          <strong>{ratingStars(review.rating)} · {Number(review.rating || 0).toFixed(1)}</strong>
                          <span className="status-chip neutral">{formatDateTime(review.submittedAt)}</span>
                        </div>
                        <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                          {review.reviewerName || 'Guest'}
                        </div>
                        <div style={{ color: '#55456f', lineHeight: 1.6 }}>
                          {review.comments || 'The guest left a rating without additional comments.'}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="surface-note">No guest reviews have been published for this host yet.</div>
                )}
              </section>

              <section className="glass card-lg section-card">
                <div className="row-between">
                  <div>
                    <div className="section-title">Public Listings</div>
                    <p className="ui-muted">These are the listings currently visible to guests.</p>
                  </div>
                  <Link href="/book">
                    <button type="button" className="button-subtle">Back To Booking</button>
                  </Link>
                </div>
                {payload.listings?.length ? (
                  <div className="stack">
                    {payload.listings.map((listing) => (
                      <div key={listing.id} className="surface-note">
                        <strong>{listing.title}</strong>
                        <br />
                        {[listing.vehicle?.year, listing.vehicle?.make, listing.vehicle?.model].filter(Boolean).join(' ')}
                        {listing.location?.name ? ` · ${listing.location.name}` : ''}
                        <br />
                        From ${Number(listing.baseDailyRate || 0).toFixed(2)}/day
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="surface-note">No published listings are active for this host right now.</div>
                )}
              </section>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
