'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { api } from '../../../../lib/client';

function fmt(v) { return v ? new Date(v).toLocaleString() : '-'; }

function Photos({ title, data, selected, toggleSelect, openPhoto }) {
  const p = data?.photos || {};
  const keys = ['front', 'rear', 'left', 'right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk'];
  const rows = keys.filter((k) => !!p[k]);
  if (!rows.length) return <div className="muted">No photos saved</div>;
  return (
    <div className="photos-grid">
      {rows.map((k) => {
        const id = `${title}:${k}`;
        const on = selected.some((x) => x.id === id);
        return (
          <div key={k} className={`photo-card ${on ? 'selected' : ''}`}>
            <div className="photo-cap">{k}</div>
            <img src={p[k]} alt={k} onClick={() => openPhoto(p[k], `${title} · ${k}`)} style={{ cursor: 'zoom-in' }} />
            <div style={{ marginTop: 6 }}>
              <button type="button" onClick={() => toggleSelect({ id, src: p[k], label: `${title} · ${k}` })}>{on ? 'Selected' : 'Select'}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Block({ title, data, selected, toggleSelect, openPhoto }) {
  if (!data) return null;
  return (
    <section className="print-card">
      <h3>{title}</h3>
      <p><b>Time:</b> {fmt(data.at)}</p>
      <p><b>Exterior:</b> {data.exterior || '-'} | <b>Interior:</b> {data.interior || '-'} | <b>Tires:</b> {data.tires || '-'} | <b>Lights:</b> {data.lights || '-'} | <b>Windshield:</b> {data.windshield || '-'}</p>
      <p><b>Notes:</b> {data.notes || '-'}</p>
      <Photos title={title} data={data} selected={selected} toggleSelect={toggleSelect} openPhoto={openPhoto} />
    </section>
  );
}

export default function Page() {
  return <AuthGate>{({ token }) => <Inner token={token} />}</AuthGate>;
}

function Inner({ token }) {
  const { id } = useParams();
  const router = useRouter();
  const [report, setReport] = useState(null);
  const [msg, setMsg] = useState('');
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const agreement = await api(`/api/reservations/${id}/agreement`, {}, token);
        const inspectionReport = await api(`/api/rental-agreements/${agreement.id}/inspection-report`, {}, token);
        setReport(inspectionReport);
      } catch (e) {
        setMsg(e.message);
      }
    })();
  }, [id, token]);

  const toggleSelect = (item) => {
    setSelected((prev) => {
      const exists = prev.some((x) => x.id === item.id);
      if (exists) return prev.filter((x) => x.id !== item.id);
      if (prev.length >= 2) return [prev[1], item];
      return [...prev, item];
    });
  };

  const openPhoto = (src, label) => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>${label}</title><style>body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:96vw;max-height:96vh;object-fit:contain}</style></head><body><img src="${src}" alt="${label}"/></body></html>`);
    w.document.close();
  };

  const compare = () => {
    if (selected.length !== 2) return;
    const [a, b] = selected;
    const key = 'inspection_compare_' + Date.now();
    const payload = { a, b };
    try { localStorage.setItem(key, JSON.stringify(payload)); } catch {}
    const w = window.open('about:blank', '_blank');
    if (!w) return;
    try { w.name = JSON.stringify(payload); } catch {}
    w.location.href = `/reservations/${id}/inspection-compare?key=${encodeURIComponent(key)}`;
  };

  return (
    <main className="inspection-print-page">
      <style jsx>{`
        .inspection-print-page{font-family:Inter,Arial,sans-serif;background:#0f0d18;color:#f3efff;min-height:100vh;padding:20px}
        .print-head{background:#171327;border:1px solid #322652;border-radius:14px;padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:10px}
        .print-head h2{margin:0;color:#c8a8ff}
        .muted{color:#a89bc7;font-size:12px}
        .print-card{background:#171327;border:1px solid #322652;border-radius:14px;padding:14px;margin-top:10px}
        .print-card h3{margin:0 0 8px;color:#e8ddff}
        .print-card p{margin:6px 0;font-size:13px}
        .photos-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:10px}
        .photo-card{border:1px solid #3a2d5f;border-radius:10px;padding:8px;background:#120f21}
        .photo-card.selected{border-color:#9f79ff;box-shadow:0 0 0 2px rgba(159,121,255,.28)}
        .photo-card img{width:100%;height:110px;object-fit:cover;border-radius:8px;border:1px solid #43336b}
        .photo-cap{font-size:10px;text-transform:uppercase;color:#b9abd8;margin-bottom:6px}
        .actions{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap}
        @media print{ .actions{display:none !important} }
      `}</style>

      <div className="actions">
        <button onClick={() => router.push(`/reservations/${id}`)}>Back</button>
        <button onClick={() => window.print()}>Print</button>
        <button onClick={compare} disabled={selected.length !== 2}>Compare Selected ({selected.length}/2)</button>
      </div>

      <div className="print-head">
        <div>
          <h2>Inspection Report</h2>
          <div className="muted">Reservation: {report?.reservationNumber || id}</div>
        </div>
      </div>

      {msg ? <div className="print-card" style={{ color: '#b91c1c' }}>{msg}</div> : null}
      {!report?.checkoutInspection && !report?.checkinInspection ? <div className="print-card"><div className="muted">No inspection data found.</div></div> : null}
      <Block title="Checkout Inspection" data={report?.checkoutInspection} selected={selected} toggleSelect={toggleSelect} openPhoto={openPhoto} />
      <Block title="Check-in Inspection" data={report?.checkinInspection} selected={selected} toggleSelect={toggleSelect} openPhoto={openPhoto} />
    </main>
  );
}
