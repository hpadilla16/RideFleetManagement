'use client';

import { useEffect, useState } from 'react';

export default function PrecheckinPage() {
  const [token, setToken] = useState('');
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setToken(p.get('token') || '');
  }, []);

  return (
    <main style={{ maxWidth: 760, margin: '24px auto', padding: 16 }}>
      <h1>Customer Pre-Check-in</h1>
      <p>Portal kickoff page. Token received: {token ? 'Yes' : 'No'}</p>
      <p>Next phase will validate token server-side and allow customer to complete profile, upload docs, and confirm details before arrival.</p>
    </main>
  );
}
