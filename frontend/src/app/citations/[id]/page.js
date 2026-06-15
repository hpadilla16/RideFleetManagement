'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

const SOURCE_LABELS = {
  CITATION_PROCESSING_CENTER: 'CPC', T2: 'T2', OCSO_COMPTROLLER: 'OCSO',
  VIOLATIONINFO: 'Verra', MANUAL: 'Manual', MAIL_OCR: 'Mailed (OCR)',
};
const PAY_FALLBACK = [
  [/metropolis/i, 'https://payments.metropolis.io'],
  [/professional parking|paymyviolations|oxygen/i, 'https://paymyviolations.com'],
  [/vanguard|payparkingnotice/i, 'https://payparkingnotice.com'],
  [/citation processing|(^|\W)cpc(\W|$)/i, 'https://www.citationprocessingcenter.com'],
  [/violationinfo|red light|red traffic|automated enforcement|stops|camera|speed/i, 'https://www.violationinfo.com'],
];
function payUrlFor(c) {
  if (c?.externalUrl && /^https?:\/\//i.test(c.externalUrl)) return c.externalUrl;
  const hay = `${c?.agency || ''} ${c?.violationType || ''}`;
  for (const [re, url] of PAY_FALLBACK) { if (re.test(hay)) return url; }
  return null;
}
function money(v) { return `$${Number(Number(v || 0).toFixed(2)).toFixed(2)}`; }
function dateLabel(v) { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function dateTimeLabel(v) { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }

const CSS = `
.cd-root{--bg:#faf9f5;--surface:#f1efe8;--card:#ffffff;--text:#2c2c2a;--muted:#5f5e5a;--hint:#888780;
 --bt:rgba(0,0,0,0.12);--bs:rgba(0,0,0,0.22);
 --ok-bg:#eaf3de;--ok:#3b6d11;--ok-bd:#97c459;--warn-bg:#faeeda;--warn:#854f0b;--warn-bd:#e0b46a;
 --danger-bg:#fcebeb;--danger:#a32d2d;--danger-bd:#f09595;--brand-bg:#efe9f8;--brand:#6d4ea8;--brand-bd:#b9a3df;
 --info:#185fa5;--radmd:8px;--radlg:12px;
 color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55;}
.cd-root .cd-back{font-size:13px;background:transparent;border:0.5px solid var(--bs);border-radius:var(--radmd);padding:7px 12px;color:var(--text);cursor:pointer;margin-bottom:14px;}
.cd-root .cd-back:hover{background:var(--surface);}
.cd-root .cd-hd{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px;}
.cd-root .cd-no{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums;}
.cd-root .cd-sub{font-size:13px;color:var(--hint);margin:0 0 16px;}
.cd-root .cd-chip{font-size:11px;padding:3px 10px;border-radius:999px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;}
.cd-root .cd-src{font-size:11px;padding:3px 9px;border-radius:6px;background:var(--surface);color:var(--muted);white-space:nowrap;}
.cd-root .cd-grid{display:grid;grid-template-columns:1.55fr 1fr;gap:16px;}
@media(max-width:900px){.cd-root .cd-grid{grid-template-columns:1fr;}}
.cd-root .cd-panel{border:0.5px solid var(--bt);border-radius:var(--radlg);background:var(--card);margin-bottom:16px;}
.cd-root .cd-ph{padding:13px 15px;border-bottom:0.5px solid var(--bt);font-weight:500;font-size:14px;}
.cd-root .cd-pb{padding:6px 15px 12px;}
.cd-root .cd-facts{display:grid;grid-template-columns:1fr 1fr;gap:0 22px;}
.cd-root .cd-fact{padding:10px 0;border-bottom:0.5px solid var(--bt);}
.cd-root .cd-fact .k{font-size:11px;color:var(--hint);text-transform:uppercase;letter-spacing:.4px;}
.cd-root .cd-fact .vv{font-size:14px;margin-top:2px;}
.cd-root .mono{font-variant-numeric:tabular-nums;}
.cd-root .cd-ic{width:40px;height:40px;border-radius:9px;background:var(--surface);display:flex;align-items:center;justify-content:center;flex:none;font-size:18px;}
.cd-root .cd-tl{font-size:12px;color:var(--muted);padding:8px 0;border-bottom:0.5px solid var(--bt);display:flex;gap:9px;align-items:flex-start;}
.cd-root .cd-tl:last-child{border-bottom:0;}
.cd-root .cd-dot{width:9px;height:9px;border-radius:999px;background:var(--ok);margin-top:4px;flex:none;}
.cd-root .cd-confbar{width:90px;height:6px;border-radius:999px;background:var(--surface);overflow:hidden;display:inline-block;vertical-align:middle;}
.cd-root .cd-confbar>span{display:block;height:100%;background:var(--warn);}
.cd-root .cd-lnk{color:var(--info);text-decoration:none;font-size:13px;cursor:pointer;}
.cd-root .cd-lnk:hover{text-decoration:underline;}
.cd-root .cd-bigpay{justify-content:center;background:var(--ok-bg);color:var(--ok);border:0.5px solid var(--ok-bd);font-weight:600;font-size:14px;padding:11px;text-decoration:none;border-radius:var(--radmd);display:flex;align-items:center;gap:7px;}
.cd-root .cd-bigpay:hover{filter:brightness(.97);}
.cd-root .cd-ghost{width:100%;justify-content:center;font-size:13px;background:transparent;border:0.5px solid var(--bs);border-radius:var(--radmd);padding:9px;color:var(--text);cursor:pointer;display:flex;align-items:center;gap:6px;}
.cd-root .cd-ghost:hover{background:var(--surface);}
.cd-root textarea{font-family:inherit;font-size:13px;border:0.5px solid var(--bs);border-radius:var(--radmd);padding:7px 9px;background:var(--card);color:var(--text);width:100%;resize:vertical;}
.cd-root .cd-act{font-size:12px;padding:8px;border-radius:var(--radmd);border:0.5px solid var(--bs);background:transparent;cursor:pointer;flex:1;display:flex;align-items:center;justify-content:center;gap:5px;}
.cd-root .b-conf{background:var(--ok-bg);color:var(--ok);border-color:var(--ok-bd);}
.cd-root .b-disp{background:var(--warn-bg);color:var(--warn);border-color:var(--warn-bd);}
.cd-root .b-void{color:var(--danger);border-color:var(--danger-bd);}
.cd-root .fl{font-size:11px;color:var(--hint);display:block;margin-bottom:3px;}
`;

const TONE = {
  NEEDS_REVIEW: ['var(--warn)', 'var(--warn-bg)'], MATCHED: ['var(--ok)', 'var(--ok-bg)'],
  DISPUTED: ['var(--danger)', 'var(--danger-bg)'], VOID: ['var(--muted)', 'var(--surface)'],
  BILLED: ['var(--ok)', 'var(--ok-bg)'], PAID: ['var(--ok)', 'var(--ok-bg)'], IMPORTED: ['var(--muted)', 'var(--surface)'],
};

export default function CitationDetailPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const params = useParams();
  const router = useRouter();
  const id = params?.id;
  const [c, setC] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const load = async () => {
    try { setC(await api(`/api/citations/${id}`, {}, token)); setMsg(''); }
    catch (e) { setMsg(e?.message || 'Failed to load citation'); }
  };
  useEffect(() => { if (id) load(); /* eslint-disable-next-line */ }, [id, token]);

  const viewScan = async () => {
    try {
      const out = await api(`/api/citations/${id}/document`, {}, token);
      if (out?.url) window.open(out.url, '_blank', 'noopener'); else setMsg('No scanned notice on file.');
    } catch (e) { setMsg(e?.message || 'Could not open scan'); }
  };
  const review = async (decision) => {
    try {
      setBusy(decision);
      await api(`/api/citations/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, note }) }, token);
      await load(); setMsg(`Citation → ${decision}`);
    } catch (e) { setMsg(e?.message || 'Review failed'); }
    finally { setBusy(''); }
  };

  if (!c) {
    return (
      <AppShell me={me} logout={logout}>
        <section className="glass card-lg stack">
          <button type="button" className="button-subtle" onClick={() => router.push('/citations')}>← Back to Citations</button>
          <div className="label">{msg || 'Loading citation…'}</div>
        </section>
      </AppShell>
    );
  }

  const status = String(c.status || '').toUpperCase();
  const [fg, bg] = TONE[status] || ['var(--muted)', 'var(--surface)'];
  const payUrl = payUrlFor(c);
  const total = Number(c.amount || 0) + Number(c.fee || 0);
  const conf = c.matchConfidence != null ? Number(c.matchConfidence) : null;
  const renter = c.reservation?.customer ? `${c.reservation.customer.firstName || ''} ${c.reservation.customer.lastName || ''}`.trim() : null;
  const vehLine = c.vehicle ? [c.vehicle.year, c.vehicle.make, c.vehicle.model].filter(Boolean).join(' ') : '';
  const Fact = ({ k, children, last }) => (
    <div className="cd-fact" style={last ? { borderBottom: 0 } : undefined}><div className="k">{k}</div><div className="vv">{children}</div></div>
  );

  return (
    <AppShell me={me} logout={logout}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="cd-root" style={{ background: 'var(--bg)', padding: 18, borderRadius: 16 }}>
        <button type="button" className="cd-back" onClick={() => router.push('/citations')}>← Back to citations</button>

        <div className="cd-hd">
          <div className="cd-no">{c.citationNo}</div>
          <span className="cd-chip" style={{ color: fg, background: bg }}>{status.replace('_', ' ')}</span>
          {c.agency ? <span className="cd-src">{c.agency}</span> : null}
          {c.violationType ? <span className="cd-src">{c.violationType}</span> : null}
        </div>
        <p className="cd-sub">
          {SOURCE_LABELS[c.source] || c.source} · imported {dateLabel(c.createdAt)}
          {c.vehicle ? ` · matched to ${c.vehicle.plate}` : ''}
          {c.reservation ? ` · tied to ${c.reservation.reservationNumber}` : ''}
        </p>

        {msg ? <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>{msg}</div> : null}

        <div className="cd-grid">
          {/* LEFT */}
          <div>
            <div className="cd-panel">
              <div className="cd-ph">Key facts</div>
              <div className="cd-pb">
                <div className="cd-facts">
                  <Fact k="Issued date">{dateLabel(c.issuedAt)}</Fact>
                  <Fact k="Due date">{dateLabel(c.dueAt)}</Fact>
                  <Fact k="Uploaded">{dateLabel(c.createdAt)}</Fact>
                  <Fact k="Violation type">{c.violationType || '—'}</Fact>
                  <Fact k="Amount"><span className="mono">{money(c.amount)}</span></Fact>
                  <Fact k="Processing fee"><span className="mono">{money(c.fee)}</span></Fact>
                  <Fact k="Total due"><span className="mono" style={{ fontWeight: 600 }}>{money(total)}</span></Fact>
                  <Fact k="Location">{c.location || '—'}</Fact>
                  <Fact k="Plate / State"><span className="mono">{(c.plateNormalized || c.vehicle?.plate || '—')}{c.plateState ? ` · ${c.plateState}` : ''}</span></Fact>
                  <Fact k="Source"><span className="cd-src">{SOURCE_LABELS[c.source] || c.source}</span></Fact>
                  <Fact k="Agency">{c.agency || '—'}</Fact>
                  <Fact k="OCR confidence" last>
                    {conf != null ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span className="cd-confbar"><span style={{ width: `${Math.max(0, Math.min(100, conf))}%` }} /></span>
                        <span style={{ color: 'var(--warn)', fontSize: 13 }}>{conf}%</span>
                      </span>
                    ) : '—'}
                  </Fact>
                </div>
              </div>
            </div>

            <div className="cd-panel">
              <div className="cd-ph">Activity</div>
              <div style={{ padding: '8px 15px 10px' }}>
                <div className="cd-tl"><span className="cd-dot" /><div><b>Uploaded / imported</b><div style={{ color: 'var(--hint)' }}>{dateTimeLabel(c.createdAt)}</div></div></div>
                <div className="cd-tl"><span className="cd-dot" /><div><b>OCR extracted</b>{conf != null ? ` — ${conf}% confidence` : ''}</div></div>
                <div className="cd-tl"><span className="cd-dot" style={c.vehicle ? undefined : { background: 'var(--bs)' }} /><div style={c.vehicle ? undefined : { color: 'var(--hint)' }}>{c.vehicle ? <><b>Matched to vehicle</b> — {c.vehicle.plate}</> : 'Plate not matched to fleet'}</div></div>
                <div className="cd-tl"><span className="cd-dot" style={c.reservation ? undefined : { background: 'var(--bs)' }} /><div style={c.reservation ? undefined : { color: 'var(--hint)' }}>{c.reservation ? <><b>Matched to reservation</b> — {c.reservation.reservationNumber}</> : 'No rental matched the citation date'}</div></div>
                <div className="cd-tl"><span className="cd-dot" style={{ background: 'var(--bs)' }} /><div style={{ color: 'var(--hint)' }}><b>Status</b> — {status.replace('_', ' ')}</div></div>
              </div>
            </div>
          </div>

          {/* RIGHT */}
          <div>
            <div className="cd-panel">
              <div className="cd-ph">Pay &amp; documents</div>
              <div style={{ padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                {payUrl ? (
                  <>
                    <a className="cd-bigpay" href={payUrl} target="_blank" rel="noreferrer">Pay now — {money(total)} ↗</a>
                    <div style={{ fontSize: 11, color: 'var(--hint)', textAlign: 'center', marginTop: -2 }}>Opens agency portal · {payUrl.replace(/^https?:\/\//, '').split('/')[0]}</div>
                  </>
                ) : <div style={{ fontSize: 12, color: 'var(--hint)', textAlign: 'center' }}>No payment link captured.</div>}
                <button type="button" className="cd-ghost" onClick={viewScan}>View scanned notice</button>
              </div>
            </div>

            <div className="cd-panel">
              <div className="cd-ph">Vehicle</div>
              <div style={{ padding: '13px 15px', display: 'flex', alignItems: 'center', gap: 11 }}>
                <div className="cd-ic">🚗</div>
                {c.vehicle ? (
                  <>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500, fontSize: 14 }} className="mono">{c.vehicle.plate}</div>
                      <div style={{ fontSize: 12, color: 'var(--hint)' }}>{vehLine || '—'}</div>
                    </div>
                    <a className="cd-lnk" href={`/vehicles?focus=${c.vehicle.id}`}>Profile ›</a>
                  </>
                ) : (
                  <div style={{ flex: 1, fontSize: 13, color: 'var(--hint)' }}>Not matched to a vehicle{c.plateNormalized ? ` (${c.plateNormalized} not in fleet)` : ''}.</div>
                )}
              </div>
            </div>

            <div className="cd-panel">
              <div className="cd-ph">Reservation</div>
              <div style={{ padding: '13px 15px' }}>
                {c.reservation ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 9 }}>
                      <div className="cd-ic">👤</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500, fontSize: 14 }}><a className="cd-lnk" href={`/reservations/${c.reservation.id}`}>{c.reservation.reservationNumber}</a></div>
                        {renter ? <div style={{ fontSize: 12, color: 'var(--hint)' }}>{renter}</div> : null}
                      </div>
                      <span className="cd-chip" style={{ color: 'var(--brand)', background: 'var(--brand-bg)' }}>Matched</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{dateLabel(c.reservation.pickupAt)} → {dateLabel(c.reservation.returnAt)}</div>
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--hint)' }}>Not matched to a rental{c.issuedAt ? ' (no reservation covered the citation date)' : ' (no citation date to match)'}.</div>
                )}
              </div>
            </div>

            <div className="cd-panel">
              <div className="cd-ph">Review</div>
              <div style={{ padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div>
                  <label className="fl">Notes (saved with the decision)</label>
                  <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g., verified plate & date against contract." />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="cd-act b-conf" disabled={busy === 'CONFIRM'} onClick={() => review('CONFIRM')}>Confirm</button>
                  <button type="button" className="cd-act b-disp" disabled={busy === 'DISPUTE'} onClick={() => review('DISPUTE')}>Dispute</button>
                  <button type="button" className="cd-act b-void" disabled={busy === 'VOID'} onClick={() => review('VOID')}>Void</button>
                  {status !== 'NEEDS_REVIEW' ? (
                    <button type="button" className="cd-act" disabled={busy === 'REJECT'} onClick={() => review('REJECT')} title="Undo — back to Needs Review">Undo</button>
                  ) : null}
                </div>
                <p style={{ fontSize: 11, color: 'var(--hint)', margin: '2px 0 0' }}>Confirm accepts the match. Billing the renter moves money → separate, approval-gated action.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
