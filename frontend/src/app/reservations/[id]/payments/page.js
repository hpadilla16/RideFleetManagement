'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

function parsePayments(notes) {
  const txt = String(notes || '');
  const re = /^\[PAYMENT\s+([^\]]+)\]\s+([^\s]+)\s+paid\s+([0-9]+(?:\.[0-9]+)?)\s+ref=(.+)$/gim;
  const out = [];
  let m;
  while ((m = re.exec(txt)) !== null) {
    out.push({ id: `note-${m[1]}-${m[4]}`, paidAt: m[1], method: m[2], amount: Number(m[3] || 0), reference: m[4] });
  }
  return out;
}

function extractJsonAfterMarker(notes, marker) {
  const txt = String(notes || '');
  const start = txt.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = txt.indexOf('{', start + marker.length);
  if (jsonStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = jsonStart; i < txt.length; i += 1) {
    const ch = txt[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return txt.slice(jsonStart, i + 1);
    }
  }
  return null;
}

function parseChargesTotalFromMeta(notes) {
  const json = extractJsonAfterMarker(notes, '[RES_CHARGES_META]');
  if (!json) return 0;
  try {
    const meta = JSON.parse(json);
    const rows = Array.isArray(meta?.chargeRows) ? meta.chargeRows : [];
    return Number(rows
      .filter((r) => {
        const n = String(r?.name || '').toLowerCase();
        return !n.includes('deposit') && !n.includes('security deposit');
      })
      .reduce((s, r) => s + Number(r?.total || 0), 0)
      .toFixed(2));
  } catch { return 0; }
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
  const [msg, setMsg] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const r = await api(`/api/reservations/${id}`, {}, token);
    setRow(r);
  };

  useEffect(() => { if (id) load(); }, [id]);

  const payments = useMemo(() => parsePayments(row?.notes), [row?.notes]);
  const totalFromQuery = useMemo(() => Number(searchParams?.get('total') || 0), [searchParams]);
  const total = useMemo(() => {
    const fromMeta = Number(parseChargesTotalFromMeta(row?.notes).toFixed(2));
    const fromRow = Number(deriveTotalFromReservationRow(row).toFixed(2));
    return Number(Math.max(totalFromQuery, fromMeta, fromRow).toFixed(2));
  }, [row, row?.notes, totalFromQuery]);
  const paid = useMemo(() => Number(payments.reduce((s, p) => s + Number(p.amount || 0), 0).toFixed(2)), [payments]);
  const unpaid = useMemo(() => Math.max(0, Number((total - paid).toFixed(2))), [total, paid]);

  const addPayment = async () => {
    try {
      const v = Number(amount || 0);
      if (!(v > 0)) return setMsg('Enter a valid amount');
      if (v - unpaid > 0.009) return setMsg(`Amount exceeds unpaid balance ($${unpaid.toFixed(2)})`);
      setSaving(true);
      const now = new Date().toISOString();
      const line = `[PAYMENT ${now}] ${String(method || 'CASH').toUpperCase()} paid ${v.toFixed(2)} ref=${String(reference || `OTC-${Date.now()}`)}`;
      const clean = String(row?.notes || '').trim();
      const next = `${clean}${clean ? '\n' : ''}${line}`;
      const updated = await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ notes: next }) }, token);
      setRow(updated);
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
