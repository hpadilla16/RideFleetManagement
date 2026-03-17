'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

function normalizePaymentRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((p) => ({
    id: p.id,
    paidAt: p.paidAt,
    method: p.method,
    amount: Number(p.amount || 0),
    reference: p.reference || '',
    source: 'db'
  }));
}

function deriveTotalFromReservationRow(row) {
  const direct = [
    row?.total,
    row?.totalAmount,
    row?.amountDue,
    row?.grandTotal,
    row?.chargesTotal,
  ].map((v) => Number(v || 0)).find((v) => v > 0);
  if (direct) return Number(direct.toFixed(2));

  const pickup = row?.pickupAt ? new Date(row.pickupAt) : null;
  const ret = row?.returnAt ? new Date(row.returnAt) : null;
  const hasDates = pickup instanceof Date && !Number.isNaN(pickup?.getTime?.()) && ret instanceof Date && !Number.isNaN(ret?.getTime?.());
  const days = hasDates ? Math.max(1, Math.ceil((ret - pickup) / (1000 * 60 * 60 * 24))) : 1;
  const daily = Number(row?.dailyRate || 0);
  const fee = Number(row?.serviceFee || 0);
  const taxRate = Number(row?.taxRate || 0) / 100;
  const base = daily * days;
  const tax = Number(((base + fee) * taxRate).toFixed(2));
  const computed = Number((base + fee + tax).toFixed(2));
  return computed > 0 ? computed : 0;
}
export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [row, setRow] = useState(null);
  const [paymentRows, setPaymentRows] = useState([]);
  const [pricing, setPricing] = useState(null);
  const [msg, setMsg] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [r, payments, pricingOut] = await Promise.all([
      api(`/api/reservations/${id}`, {}, token),
      api(`/api/reservations/${id}/payments`, {}, token).catch(() => []),
      api(`/api/reservations/${id}/pricing`, {}, token).catch(() => null)
    ]);
    setRow(r);
    setPaymentRows(normalizePaymentRows(payments));
    setPricing(pricingOut);
  };

  useEffect(() => { if (id) load(); }, [id]);

  const payments = useMemo(() => paymentRows, [paymentRows]);
  const totalFromQuery = useMemo(() => Number(searchParams?.get('total') || 0), [searchParams]);
  const total = useMemo(() => {
    const fromPricing = Number(pricing?.totals?.total || 0);
    const fromRow = Number(deriveTotalFromReservationRow(row).toFixed(2));
    return Number(Math.max(totalFromQuery, fromPricing, fromRow).toFixed(2));
  }, [row, pricing?.totals?.total, totalFromQuery]);
  const paid = useMemo(() => Number(payments.reduce((s, p) => s + Number(p.amount || 0), 0).toFixed(2)), [payments]);
  const unpaid = useMemo(() => Math.max(0, Number((total - paid).toFixed(2))), [total, paid]);

  const addPayment = async () => {
    try {
      const v = Number(amount || 0);
      if (!(v > 0)) return setMsg('Enter a valid amount');
      if (v - unpaid > 0.009) return setMsg(`Amount exceeds unpaid balance ($${unpaid.toFixed(2)})`);
      setSaving(true);
      await api(`/api/reservations/${id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: v,
          method,
          reference: String(reference || `OTC-${Date.now()}`),
          origin: 'OTC'
        })
      }, token);
      await load();
      setAmount('');
      setReference('');
      setMsg('Payment recorded');
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg">
        <div className="row-between">
          <h2>Reservation Payments</h2>
          <button onClick={() => router.push(`/reservations/${id}`)}>Back</button>
        </div>
        {msg ? <div className="label" style={{ marginBottom: 8 }}>{msg}</div> : null}
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Total: ${total.toFixed(2)}</div>
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Total Payments: ${paid.toFixed(2)}</div>
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0, marginBottom: 10 }}>Unpaid Balance: ${unpaid.toFixed(2)}</div>

        <div className="grid3" style={{ marginBottom: 10 }}>
          <div className="stack"><label className="label">Amount</label><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="stack"><label className="label">Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="ZELLE">Zelle</option>
              <option value="ATH_MOVIL">ATH Movil</option>
              <option value="BANK_TRANSFER">Bank Transfer</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div className="stack"><label className="label">Reference</label><input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        </div>
        <button onClick={addPayment} disabled={saving}>{saving ? 'Saving...' : 'Record OTC Payment'}</button>

        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Date</th><th>Method</th><th>Amount</th><th>Reference</th></tr></thead>
          <tbody>
            {payments.length ? payments.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.paidAt).toLocaleString()}</td>
                <td>{p.method}</td>
                <td>${Number(p.amount || 0).toFixed(2)}</td>
                <td>{p.reference}</td>
              </tr>
            )) : <tr><td colSpan={4}>No payments yet</td></tr>}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
