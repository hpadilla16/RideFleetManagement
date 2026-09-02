'use client';

/**
 * QR self-return — per-location settings card (Settings → Locations editor,
 * 2026-09-02; mounted right beside ShuttleTrackerSettings).
 *
 * The tenant enables the QR here, prints the poster, and tapes it up in the
 * return area. Customers scan it, type reservation number + last name, and
 * the system records the moment the car was handed back — check-in close
 * caps the late fee at that hour when the counter is slow.
 *
 * Self-contained on purpose (settings/page.js is 7,600 lines): owns its own
 * load/save against /api/self-return. Same `scopedSettingsPath` contract as
 * ShuttleTrackerSettings — a SUPER_ADMIN who picked a tenant at the top of
 * Settings reads and writes THAT tenant's QR (the 2026-08-26 lesson).
 *
 * SHIP-INERT: no QR exists until someone clicks Enable; disabling revokes
 * the token, and re-enabling mints a NEW one, so old posters die.
 *
 * QR rendering uses the repo's existing `qrcode` dependency, dynamically
 * imported (the vehicles-page idiom) so the encoder never rides the
 * settings bundle for tenants who never open this card.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, readStoredToken } from '../../lib/client';

export function SelfReturnQrSettings({ locationId, scopedSettingsPath }) {
  const [state, setState] = useState(null);      // { enabled, linkPath }
  const [status, setStatus] = useState('loading'); // loading | ready | saving | error
  const [message, setMessage] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');

  const scoped = useCallback(
    (path) => (typeof scopedSettingsPath === 'function' ? scopedSettingsPath(path) : path),
    [scopedSettingsPath],
  );

  const load = useCallback(async () => {
    if (!locationId) return;
    setStatus('loading');
    setMessage('');
    try {
      const out = await api(scoped(`/api/self-return/locations/${encodeURIComponent(locationId)}/qr`), {}, readStoredToken());
      setState(out);
      setStatus('ready');
    } catch (err) {
      setMessage(err?.message || 'Could not load the return QR settings');
      setStatus('error');
    }
  }, [locationId, scoped]);

  useEffect(() => { load(); }, [load]);

  // The full public URL the poster carries (and the QR encodes).
  const link = state?.enabled && state?.linkPath && typeof window !== 'undefined'
    ? `${window.location.origin}${state.linkPath}`
    : '';

  useEffect(() => {
    if (!link) { setQrDataUrl(''); return; }
    let alive = true;
    import('qrcode')
      .then((QRCode) => (QRCode.toDataURL || QRCode.default?.toDataURL)?.(link, { width: 320, margin: 1 }))
      .then((url) => { if (alive && url) setQrDataUrl(url); })
      .catch(() => { /* the link line still renders; the QR is a convenience */ });
    return () => { alive = false; };
  }, [link]);

  const toggle = async (enable) => {
    setStatus('saving');
    setMessage('');
    try {
      await api(
        scoped(`/api/self-return/locations/${encodeURIComponent(locationId)}/qr`),
        { method: enable ? 'POST' : 'DELETE', ...(enable ? { body: '{}' } : {}) },
        readStoredToken(),
      );
      await load();
    } catch (err) {
      setMessage(err?.message || 'Could not save');
      setStatus('ready');
    }
  };

  const printPoster = () => {
    if (!link || !qrDataUrl) return;
    const w = window.open('', '_blank', 'width=480,height=680');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>Return QR</title></head>
      <body style="font-family:system-ui,sans-serif;text-align:center;padding:40px 24px">
        <h1 style="font-size:28px;margin:0">¿Devolviste el carro?</h1>
        <p style="font-size:18px;margin:6px 0 22px">Marca aquí la devolución · Returned the car? Mark it here</p>
        <img src="${qrDataUrl}" alt="QR" style="width:320px;height:320px" />
        <p style="font-size:13px;color:#555;word-break:break-all">${link}</p>
        <script>window.onload=function(){window.print()}</` + `script>
      </body></html>`);
    w.document.close();
  };

  if (!locationId) return null;

  return (
    <div className="glass card" style={{ padding: 14, marginTop: 12 }} data-testid="self-return-qr-settings">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13.5 }}>Return QR — customer marks the car returned</strong>
        {status === 'ready' && state ? (
          <span className={`status-chip ${state.enabled ? 'good' : ''}`}>{state.enabled ? 'on' : 'off'}</span>
        ) : null}
      </div>
      <p className="ui-muted" style={{ fontSize: 12.5, margin: '6px 0 10px', lineHeight: 1.5 }}>
        Print the QR and tape it up in the return area. The customer scans it, enters their
        reservation number + last name, and the exact hand-back time is recorded — check-in
        close computes the late fee up to that hour instead of when staff run the wizard.
        Disabling revokes the code; re-enabling prints a new one.
      </p>
      {status === 'loading' ? <p className="ui-muted" style={{ fontSize: 12.5 }}>Loading…</p> : null}
      {message ? <p className="surface-note warn" style={{ fontSize: 12.5 }}>{message}</p> : null}
      {status !== 'loading' && state ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {state.enabled ? (
              <>
                <button type="button" disabled={status === 'saving' || !qrDataUrl} onClick={printPoster} data-testid="qr-print">
                  Print the poster
                </button>
                <button type="button" className="button-subtle" disabled={status === 'saving'} onClick={() => toggle(false)} data-testid="qr-disable">
                  Disable (revokes the code)
                </button>
              </>
            ) : (
              <button type="button" disabled={status === 'saving'} onClick={() => toggle(true)} data-testid="qr-enable">
                Enable return QR
              </button>
            )}
          </div>
          {state.enabled && qrDataUrl ? (
            <div style={{ textAlign: 'center' }}>
              <img src={qrDataUrl} alt="Return QR" style={{ width: 132, height: 132, borderRadius: 8, border: '1px solid var(--border-2, #d9d2ea)' }} data-testid="qr-image" />
              <div className="ui-muted" style={{ fontSize: 11, maxWidth: 220, wordBreak: 'break-all', marginTop: 4 }}>{link}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
