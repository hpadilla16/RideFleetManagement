'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const sp = useSearchParams();
  const router = useRouter();
  const phase = String(sp.get('phase') || 'CHECKOUT').toUpperCase() === 'CHECKIN' ? 'CHECKIN' : 'CHECKOUT';
  const returnTo = String(sp.get('returnTo') || '').toLowerCase();

  const [row, setRow] = useState(null);
  const [msg, setMsg] = useState('');
  const [f, setF] = useState({ exterior: 'GOOD', interior: 'GOOD', tires: 'GOOD', lights: 'GOOD', windshield: 'GOOD', notes: '' });
  const [photos, setPhotos] = useState({ front: '', rear: '', left: '', right: '', frontSeat: '', rearSeat: '', dashboard: '', trunk: '' });

  useEffect(() => { (async () => { try { setRow(await api(`/api/reservations/${id}`, {}, token)); } catch (e) { setMsg(e.message); } })(); }, [id, token]);

  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  const onPickPhoto = async (key, file) => {
    try {
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      setPhotos((p) => ({ ...p, [key]: dataUrl }));
    } catch {
      setMsg('Could not read selected photo');
    }
  };

  const save = async () => {
    try {
      const tag = phase === 'CHECKIN' ? 'RES_INSPECTION_CHECKIN' : 'RES_INSPECTION_CHECKOUT';
      const payload = { ...f, phase, at: new Date().toISOString(), photos };
      const current = String(row?.notes || '');
      const clean = current.replace(new RegExp(`\\n?\\[${tag}\\]\\{[^\\n]*\\}`, 'g'), '').trim();
      const notes = `${clean}${clean ? '\n' : ''}[${tag}]${JSON.stringify(payload)}`;
      const updated = await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ notes }) }, token);
      setRow(updated);
      setMsg(`Inspection saved (${phase})`);
      if (returnTo === 'checkout') router.push(`/reservations/${id}/checkout`);
      else if (returnTo === 'checkin') router.push(`/reservations/${id}/checkin`);
      else router.push(`/reservations/${id}`);
    } catch (e) { setMsg(e.message); }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg">
        <div className="row-between"><h2>Reservation Inspection ({phase})</h2><button onClick={() => router.push(`/reservations/${id}`)}>Back</button></div>
        {msg ? <div className="label">{msg}</div> : null}
        <div className="grid3">
          {['exterior','interior','tires','lights','windshield'].map((k) => (
            <div className="stack" key={k}><label className="label">{k[0].toUpperCase() + k.slice(1)}</label><select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="GOOD">Good</option><option value="FAIR">Fair</option><option value="POOR">Poor</option></select></div>
          ))}
        </div>
        <div className="stack" style={{ marginTop: 8 }}><label className="label">Notes</label><textarea rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>

        <div className="glass card" style={{ marginTop: 10, padding: 10 }}>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Required Exterior Photos</h3>
            <a href="/inspection-car-reference.jpg" target="_blank" rel="noreferrer">View Reference Car</a>
          </div>
          <img src="/inspection-car-reference.jpg" alt="Inspection reference car" style={{ maxWidth: 320, width: '100%', borderRadius: 8, border: '1px solid var(--border)' }} />

          <div className="grid-2" style={{ marginTop: 10 }}>
            {[
              ['front', 'Front Photo'],
              ['rear', 'Rear Photo'],
              ['left', 'Left Photo'],
              ['right', 'Right Photo'],
              ['frontSeat', 'Front Seat Photo'],
              ['rearSeat', 'Rear Seats Photo'],
              ['dashboard', 'Dashboard Photo'],
              ['trunk', 'Trunk Photo']
            ].map(([k, label]) => (
              <div key={k} className="stack">
                <label className="label">{label}</label>
                <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>Take picture or upload file</div>
                <input type="file" accept="image/*" capture="environment" onChange={(e) => onPickPhoto(k, e.target.files?.[0])} />
                {photos[k] ? <img src={photos[k]} alt={`${k} preview`} style={{ maxWidth: 220, borderRadius: 8, border: '1px solid var(--border)' }} /> : null}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}><button className="ios-action-btn" onClick={save}>Save Inspection</button></div>
      </section>
    </AppShell>
  );
}
