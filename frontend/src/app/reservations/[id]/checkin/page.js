'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const [row, setRow] = useState(null);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ odometerIn: '', fuelIn: '1.000', cleanlinessIn: '5', notes: '' });

  const load = async () => {
    const r = await api(`/api/reservations/${id}`, {}, token);
    setRow(r);
  };
  useEffect(() => { if (id) load(); }, [id, token]);

  const checkinAdvisory = useMemo(() => {
    const outFuel = Number(row?.rentalAgreement?.fuelOut ?? NaN);
    const outClean = Number(row?.rentalAgreement?.cleanlinessOut ?? NaN);
    const inFuel = Number(form.fuelIn || NaN);
    const inClean = Number(form.cleanlinessIn || NaN);

    const fuelMismatch = Number.isFinite(outFuel) && Number.isFinite(inFuel) && inFuel < outFuel;
    const cleanMismatch = Number.isFinite(outClean) && Number.isFinite(inClean) && inClean < outClean;

    return { fuelMismatch, cleanMismatch };
  }, [row?.rentalAgreement?.fuelOut, row?.rentalAgreement?.cleanlinessOut, form.fuelIn, form.cleanlinessIn]);
  const balanceSnapshot = Number(row?.rentalAgreement?.balance ?? row?.balance ?? row?.amountDue ?? 0);

  const ensureAgreementId = async () => {
    const out = await api(`/api/reservations/${id}/start-rental`, { method: 'POST', body: JSON.stringify({}) }, token);
    return out?.id;
  };

  const complete = async () => {
    try {
      if (!form.odometerIn) return setMsg('Odometer in is required');
      let nextNotes = String(row?.notes || '');
      if (checkinAdvisory.fuelMismatch || checkinAdvisory.cleanMismatch) {
        const reasons = [
          checkinAdvisory.fuelMismatch ? 'fuel lower than checkout' : null,
          checkinAdvisory.cleanMismatch ? 'cleanliness lower than checkout' : null
        ].filter(Boolean).join(' + ');
        nextNotes = `${nextNotes}${nextNotes.trim() ? '\n' : ''}[FEE_ADVISORY_OPEN ${new Date().toISOString()}] ${reasons}`;
      }

      const checkinLine = `[RES_CHECKIN ${new Date().toISOString()}] odometerIn=${Number(form.odometerIn || 0)} fuelIn=${Number(form.fuelIn || 0)} cleanlinessIn=${Number(form.cleanlinessIn || 5)} notes=${String(form.notes || '').replace(/\s+/g, ' ').trim()}`;
      nextNotes = `${nextNotes}${nextNotes.trim() ? '\n' : ''}${checkinLine}`;

      await api(`/api/reservations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'CHECKED_IN',
          notes: nextNotes
        })
      }, token);
      router.push(`/reservations/${id}`);
    } catch (e) { setMsg(e.message); }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Check-In Snapshot</span>
              <h3 style={{ margin: 0 }}>{row?.reservationNumber || `Reservation ${id}`}</h3>
              <p className="ui-muted">
                Review return condition, fee risk, and balance clarity before completing the close-out and returning the unit to fleet.
              </p>
            </div>
            <span className={`status-chip ${(checkinAdvisory.fuelMismatch || checkinAdvisory.cleanMismatch) ? 'warn' : 'good'}`}>
              {(checkinAdvisory.fuelMismatch || checkinAdvisory.cleanMismatch) ? 'Fee advisory open' : 'No fee advisory'}
            </span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Customer</span>
              <strong>{[row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' ') || row?.customer?.email || '-'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Vehicle</span>
              <strong>{[row?.vehicle?.year, row?.vehicle?.make, row?.vehicle?.model].filter(Boolean).join(' ') || row?.vehicle?.plate || '-'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Return</span>
              <strong>{row?.returnAt ? new Date(row.returnAt).toLocaleString() : '-'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Balance Snapshot</span>
              <strong>${balanceSnapshot.toFixed(2)}</strong>
            </div>
          </div>
        </div>

        <div className="row-between"><h2>Check-in Wizard</h2><button onClick={() => router.push(`/reservations/${id}`)}>Back</button></div>
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0, marginBottom: 8 }}>Reservation: {row?.reservationNumber || '-'}</div>
        {msg ? <div className="label" style={{ color: '#b91c1c' }}>{msg}</div> : null}

        <div className="grid2">
          <div className="stack"><label className="label">Odometer In</label><input type="number" min="0" value={form.odometerIn} onChange={(e) => setForm({ ...form, odometerIn: e.target.value })} /></div>
          <div className="stack"><label className="label">Fuel In</label><select value={form.fuelIn} onChange={(e) => setForm({ ...form, fuelIn: e.target.value })}>{['0.000','0.125','0.250','0.375','0.500','0.625','0.750','0.875','1.000'].map((v, i) => <option key={v} value={v}>{i}/8</option>)}</select></div>
          <div className="stack"><label className="label">Cleanliness In (1-5)</label><input type="number" min="1" max="5" value={form.cleanlinessIn} onChange={(e) => setForm({ ...form, cleanlinessIn: e.target.value })} /></div>
          <div className="stack"><label className="label">Notes</label><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>

        {(checkinAdvisory.fuelMismatch || checkinAdvisory.cleanMismatch) ? (
          <div className="glass card" style={{ padding: 10, marginTop: 8, borderColor: '#fed7aa', background: '#fff7ed' }}>
            <div style={{ fontWeight: 700, color: '#9a3412' }}>Potential Additional Fees</div>
            {checkinAdvisory.fuelMismatch ? <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Fuel level is lower than check-out. You may charge an additional fuel fee.</div> : null}
            {checkinAdvisory.cleanMismatch ? <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Cleanliness level is lower than check-out. You may charge an additional cleaning fee.</div> : null}
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
          <button onClick={() => router.push(`/reservations/${id}/inspection?phase=CHECKIN&returnTo=checkin`)}>Open Check-In Inspection</button>
          <button className="ios-action-btn" onClick={complete}>Complete Check-In</button>
        </div>
      </section>
    </AppShell>
  );
}
