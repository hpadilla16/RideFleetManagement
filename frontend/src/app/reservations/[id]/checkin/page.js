'use client';

// Retired 2026-06-26. Superseded by the unified checkout-session flow. This
// stub redirects any remaining inbound link (e.g. the legacy /inspection
// page's returnTo) to the current wizard so it never 404s, while removing
// the duplicate logic.
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function RetiredCheckinRedirect() {
  const { id } = useParams();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/reservations/${id}/checkin-wizard`);
  }, [id, router]);
  return <div style={{ padding: 24, color: '#6B7280' }}>Redirecting to check-in…</div>;
}
