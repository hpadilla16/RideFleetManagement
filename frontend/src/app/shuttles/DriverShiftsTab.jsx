'use client';

/**
 * Driver-shift management panel — the third tab on /shuttles (Phase 3 STAFF
 * UI, 2026-08-25; pairs with the Driver Mode backend, Screens 12–15).
 *
 * Mint: POST /api/shuttle-monitor/driver-shifts {vehicleId, driverName,
 * hours, locationId} → 201 carries the tokenized link ONCE. The result modal
 * is the only place the link ever appears — the list endpoint deliberately
 * never re-shows tokens (lost link = revoke + re-mint), and this component
 * drops the minted payload from state the moment the modal closes.
 *
 * List/revoke/notify: GET /driver-shifts, DELETE /:id, POST /:id/notify
 * {message}. Notify only works on an ACTIVE shift (backend 409s otherwise).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';
import { shiftVehicleOptions, driverShiftLink } from '../../lib/shuttle-staff';

const dtShort = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export function MintResultModal({ shift, onClose }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const link = driverShiftLink(shift?.linkPath, origin);
  const shareText = t('shuttleMonitor.shiftShareText', {
    defaultValue: 'Shuttle driver link for {{driver}} (expires {{expires}}): {{link}}',
    driver: shift?.driverName || '',
    expires: dtShort(shift?.expiresAt),
    link,
  });

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* stays copyable by hand */ }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,12,40,.42)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div onClick={(e) => e.stopPropagation()} className="glass card-lg" style={{ width: 'min(500px, 94vw)', padding: 18 }} data-testid="mint-modal">
        <h3 style={{ marginTop: 0 }}>{t('shuttleMonitor.shiftLinkTitle', 'Driver link created')}</h3>
        <p className="ui-muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          {[shift?.driverName, shift?.vehicleLabel].filter(Boolean).join(' · ')}
          {shift?.expiresAt ? ` · ${t('shuttleMonitor.shiftExpires', { defaultValue: 'expires {{when}}', when: dtShort(shift.expiresAt) })}` : ''}
        </p>
        <div
          className="surface-note"
          data-testid="mint-link"
          style={{ wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace', fontSize: 12.5, userSelect: 'all' }}
        >
          {link}
        </div>
        <p className="surface-note warn" style={{ fontSize: 12.5, marginTop: 10 }}>
          {t('shuttleMonitor.shiftLinkOnce', 'This link is shown only ONCE — it is never listed again. If it gets lost, revoke this shift and mint a new one.')}
        </p>
        <p className="ui-muted" style={{ fontSize: 12 }}>
          {t('shuttleMonitor.shiftShareHint', 'Send it to the driver over WhatsApp or SMS — anyone with the link can open the driver view until it expires or is revoked.')}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
          <button type="button" onClick={copy}>
            {copied ? t('shuttleMonitor.shiftCopied', 'Copied ✓') : t('shuttleMonitor.shiftCopy', 'Copy link')}
          </button>
          <a
            className="button-subtle"
            style={{ fontSize: 13, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', padding: '6px 12px' }}
            href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
            target="_blank"
            rel="noreferrer"
          >
            {t('shuttleMonitor.shiftWhatsApp', 'Share via WhatsApp')}
          </a>
          <button type="button" className="button-subtle" onClick={onClose}>{t('common.close', 'Close')}</button>
        </div>
      </div>
    </div>
  );
}

export function DriverShiftsTab({ token, shuttles = [] }) {
  const { t } = useTranslation();
  const [shifts, setShifts] = useState(null);
  const [err, setErr] = useState('');
  const [minted, setMinted] = useState(null); // 201 payload — modal-only, dropped on close
  const [form, setForm] = useState({ key: '', driverName: '', hours: '12' });
  const [busy, setBusy] = useState(false);
  const [notifyFor, setNotifyFor] = useState(null); // shift id with the composer open
  const [message, setMessage] = useState('');
  const [notifyState, setNotifyState] = useState(null); // {id, ok} | {id, error}

  const load = useCallback(async () => {
    try {
      const out = await api('/api/shuttle-monitor/driver-shifts', { bypassCache: true }, token);
      setShifts(Array.isArray(out?.shifts) ? out.shifts : []);
    } catch (e) {
      setErr(e?.message || 'Could not load driver shifts');
      setShifts([]);
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const options = shiftVehicleOptions(shuttles);

  const mint = async (e) => {
    e?.preventDefault?.();
    const opt = options.find((o) => o.key === form.key);
    if (!opt || !form.driverName.trim()) {
      setErr(t('shuttleMonitor.shiftFormIncomplete', 'Pick a shuttle and enter the driver’s name.'));
      return;
    }
    setBusy(true); setErr('');
    try {
      const out = await api('/api/shuttle-monitor/driver-shifts', {
        method: 'POST',
        body: {
          vehicleId: opt.vehicleId,
          locationId: opt.locationId,
          driverName: form.driverName.trim(),
          hours: form.hours === '' ? null : Number(form.hours),
        },
      }, token);
      setMinted({ ...out, vehicleLabel: opt.label });
      setForm({ key: '', driverName: '', hours: '12' });
      load();
    } catch (e2) {
      setErr(e2?.message || 'Could not create the driver link');
    } finally { setBusy(false); }
  };

  const revoke = async (s) => {
    const sure = typeof window === 'undefined' || window.confirm(
      t('shuttleMonitor.shiftRevokeConfirm', {
        defaultValue: 'Revoke the driver link for {{driver}}? The link stops working immediately.',
        driver: s.driverName,
      }),
    );
    if (!sure) return;
    try {
      await api(`/api/shuttle-monitor/driver-shifts/${s.id}`, { method: 'DELETE' }, token);
      setErr('');
    } catch (e) { setErr(e?.message || 'Could not revoke'); }
    load();
  };

  const sendNotify = async (s) => {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api(`/api/shuttle-monitor/driver-shifts/${s.id}/notify`, { method: 'POST', body: { message: text } }, token);
      setNotifyState({ id: s.id, ok: true });
      setMessage('');
      setNotifyFor(null);
    } catch (e) {
      // 409 = the shift died between poll and send — say so, don't pretend.
      setNotifyState({ id: s.id, error: e?.message || 'Could not send' });
    } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 14 }} data-testid="driver-shifts-tab">
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* mint form */}
        <form onSubmit={mint} className="glass card" style={{ flex: '0 1 340px', minWidth: 280, padding: 14 }}>
          <span className="label">{t('shuttleMonitor.shiftMintTitle', 'New driver link')}</span>
          <p className="ui-muted" style={{ fontSize: 12, marginTop: 4 }}>
            {t('shuttleMonitor.shiftMintBody', 'A per-shift link opens the driver view for one shuttle — no account, no password. It expires on its own.')}
          </p>
          <div className="stack" style={{ gap: 10, marginTop: 10 }}>
            <div className="stack">
              <label className="label" htmlFor="shift-vehicle">{t('shuttleMonitor.shiftVehicle', 'Shuttle')}</label>
              <select
                id="shift-vehicle"
                value={form.key}
                disabled={busy}
                onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              >
                <option value="">{t('shuttleMonitor.shiftVehiclePick', 'Pick a shuttle…')}</option>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {[o.label, o.locationName].filter(Boolean).join(' — ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="stack">
              <label className="label" htmlFor="shift-driver">{t('shuttleMonitor.shiftDriverName', 'Driver name')}</label>
              <input
                id="shift-driver"
                value={form.driverName}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setForm((f) => ({ ...f, driverName: e.target.value }))}
                placeholder={t('shuttleMonitor.shiftDriverPlaceholder', 'Luis M.')}
              />
            </div>
            <div className="stack">
              <label className="label" htmlFor="shift-hours">{t('shuttleMonitor.shiftHours', 'Valid for (hours)')}</label>
              <input
                id="shift-hours"
                type="number"
                min="1"
                max="24"
                value={form.hours}
                disabled={busy}
                onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
                style={{ width: 110 }}
              />
            </div>
          </div>
          {err ? <p className="surface-note warn" style={{ marginTop: 10, fontSize: 12.5 }}>{err}</p> : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="submit" disabled={busy}>{t('shuttleMonitor.shiftMint', 'Create driver link')}</button>
          </div>
        </form>

        {/* active shifts */}
        <div style={{ flex: '1 1 380px', minWidth: 300 }}>
          <span className="label">
            {t('shuttleMonitor.shiftListTitle', { defaultValue: 'Active shifts · {{count}}', count: shifts?.length ?? 0 })}
          </span>
          {shifts == null ? (
            <p className="ui-muted" style={{ marginTop: 8 }}>{t('shuttleMonitor.loading', 'Loading shuttles…')}</p>
          ) : shifts.length === 0 ? (
            <p className="ui-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              {t('shuttleMonitor.shiftListEmpty', 'No active driver links. Mint one to put a driver on shift.')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {shifts.map((s) => (
                <div key={s.id} className="glass card" style={{ padding: 12 }} data-testid="shift-row">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13.5 }}>{s.driverName}</strong>
                    <span className="ui-muted" style={{ fontSize: 12 }}>
                      {[s.vehicleLabel, s.plate, s.locationName].filter(Boolean).join(' · ')}
                    </span>
                    <span className="status-chip" style={{ marginLeft: 'auto' }}>
                      {t('shuttleMonitor.shiftExpires', { defaultValue: 'expires {{when}}', when: dtShort(s.expiresAt) })}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      style={{ fontSize: 12 }}
                      onClick={() => {
                        setNotifyState(null);
                        setMessage('');
                        setNotifyFor(notifyFor === s.id ? null : s.id);
                      }}
                    >
                      {t('shuttleMonitor.shiftMessage', 'Message driver')}
                    </button>
                    <button type="button" className="button-subtle" style={{ fontSize: 12 }} onClick={() => revoke(s)}>
                      {t('shuttleMonitor.shiftRevoke', 'Revoke link')}
                    </button>
                  </div>
                  {notifyFor === s.id ? (
                    <div style={{ display: 'flex', gap: 6, marginTop: 9, alignItems: 'flex-start' }}>
                      <textarea
                        rows={2}
                        maxLength={280}
                        value={message}
                        disabled={busy}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder={t('shuttleMonitor.shiftMessagePlaceholder', 'Pick up at Lot B first — 2 customers waiting')}
                        style={{ flex: 1, fontSize: 12.5 }}
                        aria-label={t('shuttleMonitor.shiftMessage', 'Message driver')}
                      />
                      <button type="button" disabled={busy || !message.trim()} onClick={() => sendNotify(s)} style={{ fontSize: 12 }}>
                        {t('shuttleMonitor.shiftSend', 'Send')}
                      </button>
                    </div>
                  ) : null}
                  {notifyState?.id === s.id ? (
                    notifyState.ok ? (
                      <p className="surface-note" style={{ marginTop: 8, fontSize: 12 }} data-testid="notify-ok">
                        {t('shuttleMonitor.shiftMessageSent', 'Message sent — it shows on the driver’s screen.')}
                      </p>
                    ) : (
                      <p className="surface-note warn" style={{ marginTop: 8, fontSize: 12 }}>{notifyState.error}</p>
                    )
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <p className="ui-muted" style={{ fontSize: 11, lineHeight: 1.55, marginTop: 10 }}>
            {t('shuttleMonitor.shiftListNote', 'Links are never re-shown after minting. A lost link means revoke + mint a new one.')}
          </p>
        </div>
      </div>

      {minted ? <MintResultModal shift={minted} onClose={() => setMinted(null)} /> : null}
    </div>
  );
}
