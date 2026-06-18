'use client';

/**
 * Printed per-vehicle QR resolver (Fase D, 2026-06-18).
 * The static QR placed inside the car encodes /inspect/v/<vehicleId>.<sig>.
 * Scanning it lands here; we resolve the vehicle's ACTIVE rental to a CHECK-IN
 * inspection token and forward to the normal /inspect/<token> flow.
 * NO auth — the signed payload + the active-rental check are the gate.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../../lib/client';

export default function Page() {
  const params = useParams();
  const router = useRouter();
  const payload = params?.payload;
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!payload) return;
    let on = true;
    (async () => {
      try {
        const out = await api(`/api/customer-inspection/v/${encodeURIComponent(payload)}`, { bypassCache: true });
        if (!on) return;
        if (out?.token) router.replace(`/inspect/${out.token}`);
        else setError('No active rental on this vehicle right now.');
      } catch (err) {
        if (on) setError(err?.message || 'This code is no longer valid.');
      }
    })();
    return () => { on = false; };
  }, [payload, router]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f6f4fd', padding: 24, fontFamily: 'Arial, Helvetica, sans-serif' }}>
      <div style={{ maxWidth: 380, textAlign: 'center', color: '#1d1d2c' }}>
        {error ? (
          <>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🚗</div>
            <h2 style={{ color: '#5b3df5', margin: '0 0 8px' }}>Can’t start the inspection</h2>
            <p style={{ color: '#555' }}>{error}</p>
            <p style={{ color: '#888', fontSize: 13 }}>If you’re returning the car, please see the rental office.</p>
          </>
        ) : (
          <>
            <div style={{ fontSize: 40, marginBottom: 8 }}>📷</div>
            <h2 style={{ color: '#5b3df5', margin: '0 0 8px' }}>Starting your inspection…</h2>
            <p style={{ color: '#555' }}>One moment — finding your rental.</p>
          </>
        )}
      </div>
    </div>
  );
}
