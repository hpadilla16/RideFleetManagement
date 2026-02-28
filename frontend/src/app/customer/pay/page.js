'use client';

import { useEffect, useState } from 'react';

export default function CustomerPayPage() {
  const [token, setToken] = useState('');
  const [success, setSuccess] = useState('');
  const [canceled, setCanceled] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [returnTransId, setReturnTransId] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [model, setModel] = useState(null);
  const [confirmAmount, setConfirmAmount] = useState('');
  const [confirmRef, setConfirmRef] = useState('MANUAL');

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setToken(p.get('token') || '');
    setSuccess(p.get('success') || '');
    setCanceled(p.get('canceled') || '');
    setSessionId(p.get('session_id') || '');
    setReturnTransId(p.get('transId') || p.get('x_trans_id') || p.get('transaction_id') || '');
  }, []);

  useEffect(() => {
    const run = async () => {
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`http://localhost:4000/api/public/payment/${encodeURIComponent(token)}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || 'Unable to load payment page');
        setModel(j);
        setConfirmAmount(String(j.amountDue || ''));
        setLoading(false);
      } catch (e) {
        setError(String(e.message || e));
        setLoading(false);
      }
    };
    run();
  }, [token]);

  useEffect(() => {
    const autoConfirmReturn = async () => {
      if (!token || !success || !model) return;
      try {
        if (model.gateway === 'stripe') {
          if (!sessionId) return;
          const res = await fetch(`http://localhost:4000/api/public/payment/${encodeURIComponent(token)}/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j?.error || 'Stripe confirmation failed');
          setOk(`Payment recorded successfully: $${Number(j.paidAmount || 0).toFixed(2)}` + (j?.savedCardOnFile ? ' Card on file saved.' : ''));
          return;
        }

        const paidAmount = Number(model.amountDue || confirmAmount || 0);
        if (!Number.isFinite(paidAmount) || paidAmount <= 0) return;
        const reference = returnTransId ? `AUTHNET:${returnTransId}` : (confirmRef || 'AUTHNET:MANUAL');
        const res = await fetch(`http://localhost:4000/api/public/payment/${encodeURIComponent(token)}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paidAmount, reference })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || 'Payment confirmation failed');
        setOk(`Payment recorded successfully: $${Number(j.paidAmount || 0).toFixed(2)}` + (j?.savedCardOnFile ? ' Card on file saved.' : ''));
        setError('');
      } catch (e) {
        setError(String(e.message || e));
      }
    };
    autoConfirmReturn();
  }, [token, success, sessionId, model, returnTransId, confirmAmount, confirmRef]);

  const startCheckout = async () => {
    try {
      setError('');
      const res = await fetch(`http://localhost:4000/api/public/payment/${encodeURIComponent(token)}/create-session`, { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Unable to start checkout');
      if (!j.checkoutUrl) throw new Error('Checkout URL missing');
      window.location.href = j.checkoutUrl;
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const confirmPayment = async () => {
    try {
      const paidAmount = Number(confirmAmount || 0);
      if (!Number.isFinite(paidAmount) || paidAmount <= 0) throw new Error('Enter valid paid amount');
      const res = await fetch(`http://localhost:4000/api/public/payment/${encodeURIComponent(token)}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paidAmount, reference: confirmRef || 'AUTHNET:MANUAL' })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Payment confirmation failed');
      setOk(`Payment recorded successfully: $${Number(j.paidAmount || 0).toFixed(2)}` + (j?.savedCardOnFile ? ' Card on file saved.' : ''));
      setError('');
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: '24px auto', padding: 16 }}>
      <h1>Customer Payment</h1>
      {loading ? <p>Loading...</p> : null}
      {error ? <p style={{ color: '#b91c1c' }}>{error}</p> : null}
      {ok ? <p style={{ color: '#065f46' }}>{ok}</p> : null}
      {canceled ? <p style={{ color: '#92400e' }}>Payment was canceled. You can try again.</p> : null}

      {!loading && model ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
            <div><strong>Reservation:</strong> {model.reservation?.reservationNumber}</div>
            <div><strong>Customer:</strong> {model.reservation?.customerName || '-'}</div>
            <div><strong>Amount Due:</strong> ${Number(model.amountDue || 0).toFixed(2)}</div>
            <div><strong>Gateway:</strong> {String(model.gateway || '').toUpperCase()}</div>
          </div>

          {model.breakdown ? (
            <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
              <strong>Payment Breakdown</strong>
              <table style={{ width: '100%', minWidth: 0, marginTop: 8 }}>
                <thead><tr><th style={{ textAlign: 'left' }}>Charge</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
                <tbody>
                  {(model.breakdown.lines || []).map((l, i) => (
                    <tr key={i}>
                      <td>{l.name}</td>
                      <td style={{ textAlign: 'right' }}>{l.qty ?? '-'}</td>
                      <td style={{ textAlign: 'right' }}>{typeof l.rate === 'number' ? `$${Number(l.rate).toFixed(2)}` : String(l.rate ?? '-')}</td>
                      <td style={{ textAlign: 'right' }}>{Number(l.total || 0) < 0 ? `-$${Math.abs(Number(l.total || 0)).toFixed(2)}` : `$${Number(l.total || 0).toFixed(2)}`}</td>
                    </tr>
                  ))}
                  <tr><td colSpan={3}><strong>Subtotal</strong></td><td style={{ textAlign: 'right' }}><strong>${Number(model.breakdown.subtotal || 0).toFixed(2)}</strong></td></tr>
                  <tr><td colSpan={3}>Tax</td><td style={{ textAlign: 'right' }}>${Number(model.breakdown.tax || 0).toFixed(2)}</td></tr>
                  <tr><td colSpan={3}><strong>Total</strong></td><td style={{ textAlign: 'right' }}><strong>${Number(model.breakdown.total || 0).toFixed(2)}</strong></td></tr>
                </tbody>
              </table>
            </div>
          ) : null}

          {!success ? (
            <button onClick={startCheckout} disabled={!model.gatewayReady}>Pay Now</button>
          ) : model.gateway === 'stripe' ? (
            <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
              <strong>Payment return detected.</strong>
              <div>Finalizing Stripe confirmation...</div>
            </div>
          ) : (
            <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
              <strong>Payment return detected.</strong>
              <div>Please confirm payment amount/reference to finalize posting.</div>
              <input placeholder="Paid Amount" value={confirmAmount} onChange={(e) => setConfirmAmount(e.target.value)} />
              <input placeholder="Reference (Auth/Trans ID)" value={confirmRef} onChange={(e) => setConfirmRef(e.target.value)} />
              <button onClick={confirmPayment}>Confirm Payment</button>
            </div>
          )}

          {!model.gatewayReady ? <p style={{ color: '#92400e' }}>Gateway not configured for {String(model.gateway || '').toUpperCase()}. Set the required backend env credentials.</p> : null}
        </div>
      ) : null}
    </main>
  );
}
