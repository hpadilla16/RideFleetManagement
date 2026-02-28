'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

function parseKV(line = '') {
  const out = {};
  String(line).split(/\s+/).forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  });
  return out;
}

function findLine(notes = '', tag) {
  const re = new RegExp(`\\[${tag}[^\\]]*\\]\\s*([^\\n]*)`);
  const m = String(notes).match(re);
  return m ? parseKV(m[1]) : null;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const sp = useSearchParams();
  const [row, setRow] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    (async () => {
      try { setRow(await api(`/api/reservations/${id}`, {}, token)); }
      catch (e) { setMsg(e.message); }
    })();
  }, [id, token]);

  const checkout = useMemo(() => findLine(row?.notes, 'RES_CHECKOUT'), [row?.notes]);
  const checkin = useMemo(() => findLine(row?.notes, 'RES_CHECKIN'), [row?.notes]);
  const section = String(sp.get('section') || '').toLowerCase();

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between">
          <h2 className="page-title">Check-out / Check-in View</h2>
          <button onClick={() => router.push(`/reservations/${id}`)}>Back</button>
        </div>
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Reservation: {row?.reservationNumber || id}</div>
        {msg ? <div className="error">{msg}</div> : null}

        {(section !== 'checkin') && (
          <div className="glass card" style={{ padding: 12 }}>
            <h3 className="section-title">Check-out</h3>
            {checkout ? (
              <div className="grid2">
                <div><div className="label">Odometer Out</div><div>{checkout.odometerOut || '-'}</div></div>
                <div><div className="label">Fuel Out</div><div>{checkout.fuelOut || '-'}</div></div>
                <div><div className="label">Cleanliness Out</div><div>{checkout.cleanlinessOut || '-'}</div></div>
                <div><div className="label">Payment Method</div><div>{checkout.paymentMethod || '-'}</div></div>
              </div>
            ) : <div className="label">No check-out record found.</div>}
          </div>
        )}

        {(section !== 'checkout') && (
          <div className="glass card" style={{ padding: 12 }}>
            <h3 className="section-title">Check-in</h3>
            {checkin ? (
              <div className="grid2">
                <div><div className="label">Odometer In</div><div>{checkin.odometerIn || '-'}</div></div>
                <div><div className="label">Fuel In</div><div>{checkin.fuelIn || '-'}</div></div>
                <div><div className="label">Cleanliness In</div><div>{checkin.cleanlinessIn || '-'}</div></div>
                <div><div className="label">Notes</div><div>{checkin.notes || '-'}</div></div>
              </div>
            ) : <div className="label">No check-in record found.</div>}
          </div>
        )}
      </section>
    </AppShell>
  );
}
