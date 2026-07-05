'use client';

/**
 * /scan — the center action of the employee app shell (2026-07-05).
 *
 * Lookup-mode vehicle scanner: identify ANY fleet vehicle standing in front of
 * you (vehicle-profile QR, VIN Code-39 door sticker, or typed plate) and offer
 * the action that matches its state — check-in for an ON_RENT car, checkout
 * for an upcoming pickup, profile/damage otherwise. Approved mockups B2/B3:
 * doc/employee-mobile-app-mockups-2026-07-04.html.
 *
 * Scanning uses the same stack as inventory's VehicleScanner (BarcodeDetector
 * where available; iOS WKWebView lacks it — plate entry is the fallback until
 * the native ML Kit upgrade in Fase 3).
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

const CAMERA_CONSTRAINTS = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
};

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function extractVehicleId(raw) {
  const s = String(raw || '').trim();
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('vehicles');
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
    return parts[parts.length - 1] || s;
  } catch {
    const parts = s.split('/').filter(Boolean);
    return parts[parts.length - 1] || s;
  }
}

async function getDetector() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    const want = ['qr_code', 'code_39'].filter((f) => formats.includes(f));
    if (!want.length) return null;
    return new window.BarcodeDetector({ formats: want });
  } catch {
    return null;
  }
}

function ScanInner({ token, me, logout }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const scanningRef = useRef(false);
  const vehiclesRef = useRef([]);

  const [scanning, setScanning] = useState(false);
  const [scanSupported, setScanSupported] = useState(true);
  const [plate, setPlate] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [match, setMatch] = useState(null); // { vehicle, detail }

  useEffect(() => {
    api('/api/vehicles?limit=2000', {}, token)
      .then((out) => { vehiclesRef.current = Array.isArray(out) ? out : []; })
      .catch((e) => setError(e.message));
    getDetector().then((d) => setScanSupported(!!d));
    return () => stopCamera();
  }, [token]);

  const stopCamera = () => {
    scanningRef.current = false;
    setScanning(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  const resolveVehicle = async (vehicle) => {
    stopCamera();
    setStatus(`Found ${vehicle.plate || vehicle.vin || vehicle.id} — loading…`);
    try {
      const detail = await api(`/api/vehicles/${vehicle.id}`, {}, token);
      setMatch({ vehicle, detail });
      setStatus('');
    } catch (e) {
      // Detail failed (permissions, network) — still useful with list data.
      setMatch({ vehicle, detail: null });
      setStatus('');
      setError(e.message);
    }
  };

  const handleDetection = (rawValue, format) => {
    const fleet = vehiclesRef.current;
    if (format === 'qr_code') {
      const id = extractVehicleId(rawValue);
      const byId = fleet.find((v) => String(v.id) === String(id));
      if (byId) return resolveVehicle(byId);
      setStatus('QR read, but it does not match a vehicle in this fleet.');
      return null;
    }
    const value = norm(rawValue);
    if (!value) return null;
    const byVin = fleet.find((v) => norm(v.vin) === value || (value.length >= 8 && norm(v.vin).endsWith(value)));
    if (byVin) return resolveVehicle(byVin);
    setStatus(`Scanned ${rawValue} — no VIN match in this fleet.`);
    return null;
  };

  const startScan = async () => {
    setError('');
    setStatus('');
    setMatch(null);
    const detector = await getDetector();
    if (!detector) {
      setScanSupported(false);
      setError('Camera barcode scanning is not available on this device yet — use the plate lookup below.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      scanningRef.current = true;
      setScanning(true);
      setStatus('Point the camera at the vehicle QR or the VIN door sticker.');
      const tick = async () => {
        if (!scanningRef.current || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          for (const code of codes) {
            if (handleDetection(code.rawValue, code.format)) return;
          }
        } catch {}
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      setError(e?.name === 'NotAllowedError'
        ? 'Camera permission denied. Allow camera access, or use the plate lookup below.'
        : (e.message || 'Could not open the camera.'));
      stopCamera();
    }
  };

  const lookupPlate = (e) => {
    e.preventDefault();
    setError('');
    const q = norm(plate);
    if (!q) return;
    const fleet = vehiclesRef.current;
    const found = fleet.find((v) => norm(v.plate) === q)
      || fleet.find((v) => norm(v.internalNumber) === q)
      || fleet.find((v) => q.length >= 3 && norm(v.plate).includes(q));
    if (found) resolveVehicle(found);
    else setStatus(`No vehicle matches "${plate}" in this fleet.`);
  };

  const active = match?.detail?.activeReservation || null;
  const next = match?.detail?.nextReservation || null;
  const v = match?.detail?.vehicle || match?.detail || match?.vehicle || null;

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack" style={{ maxWidth: 560, margin: '0 auto' }}>
        <span className="eyebrow">Floor ops</span>
        <h2 className="page-title" style={{ margin: 0 }}>Scan vehicle</h2>
        <p className="ui-muted" style={{ marginTop: 0 }}>
          QR · VIN sticker · plate. The right action for the car you&apos;re standing next to.
        </p>

        {!match ? (
          <>
            <div style={{ position: 'relative', borderRadius: 18, overflow: 'hidden', background: '#1c1631', minHeight: scanning ? 320 : 0 }}>
              <video ref={videoRef} muted playsInline style={{ width: '100%', display: scanning ? 'block' : 'none' }} />
            </div>
            {scanSupported ? (
              scanning ? (
                <button type="button" className="button-subtle" style={{ minHeight: 48 }} onClick={stopCamera}>Stop camera</button>
              ) : (
                <button type="button" style={{ minHeight: 52 }} onClick={startScan}>📷 Start scanning</button>
              )
            ) : (
              <p className="ui-muted">Barcode scanning isn&apos;t available in this browser — use the plate lookup.</p>
            )}

            <form onSubmit={lookupPlate} className="stack" style={{ gap: 8 }}>
              <label className="ui-muted" htmlFor="scan-plate">Plate or unit #</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  id="scan-plate"
                  value={plate}
                  onChange={(e) => setPlate(e.target.value)}
                  placeholder="ABC-123"
                  style={{ flex: 1, minHeight: 48, textTransform: 'uppercase' }}
                  autoCapitalize="characters"
                  autoCorrect="off"
                />
                <button type="submit" style={{ minHeight: 48 }}>Find</button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="metric-card" style={{ padding: 16 }}>
              <div style={{ fontWeight: 800, fontSize: 18 }}>
                {[v?.year, v?.make, v?.model].filter(Boolean).join(' ') || 'Vehicle'}
              </div>
              <div className="ui-muted">
                {[v?.plate, v?.internalNumber ? `Unit ${v.internalNumber}` : null, v?.status].filter(Boolean).join(' · ')}
              </div>
              {active ? (
                <div style={{ marginTop: 8 }}>
                  <span className="status-chip warn">ON RENT · {active.reservationNumber || active.id}</span>
                </div>
              ) : next ? (
                <div style={{ marginTop: 8 }}>
                  <span className="status-chip neutral">UPCOMING · {next.reservationNumber || next.id}</span>
                </div>
              ) : null}
            </div>

            <div className="stack" style={{ gap: 10 }}>
              {active ? (
                <>
                  <Link href={`/reservations/${active.id}/checkin-wizard`}><button style={{ width: '100%', minHeight: 52 }}>▶ Start check-in (return)</button></Link>
                  <Link href={`/reservations/${active.id}`}><button className="button-subtle" style={{ width: '100%', minHeight: 48 }}>View reservation</button></Link>
                </>
              ) : null}
              {!active && next ? (
                <>
                  <Link href={`/reservations/${next.id}`}><button style={{ width: '100%', minHeight: 52 }}>▶ Open upcoming pickup</button></Link>
                </>
              ) : null}
              <Link href={`/vehicles/${match.vehicle.id}`}><button className="button-subtle" style={{ width: '100%', minHeight: 48 }}>Vehicle profile &amp; damage history</button></Link>
              <button type="button" className="button-subtle" style={{ minHeight: 48 }} onClick={() => { setMatch(null); setStatus(''); setError(''); }}>
                ↺ Scan another vehicle
              </button>
            </div>
          </>
        )}

        {status ? <p className="ui-muted" role="status">{status}</p> : null}
        {error ? <p style={{ color: '#b91c1c', fontWeight: 600 }} role="alert">{error}</p> : null}
      </section>
    </AppShell>
  );
}

export default function ScanPage() {
  return <AuthGate>{({ token, me, logout }) => <ScanInner token={token} me={me} logout={logout} />}</AuthGate>;
}
