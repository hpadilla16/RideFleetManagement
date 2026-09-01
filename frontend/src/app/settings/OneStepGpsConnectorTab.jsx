'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';

/**
 * OneStepGpsConnectorTab — the OneStepGPS telematics connector panel inside
 * Settings → Telematics (2026-08-24, approved mockups screens 1/2/4).
 *
 * Factored out of the 7.6k-line settings page the same way LoanerRatesTab is.
 * Talks ONLY to the connector admin endpoints on
 * `/api/admin/integrations/onestepgps` (see
 * backend/src/modules/integrations/onestepgps/onestepgps.routes.js):
 *
 *   GET    /status                 booleans + timestamps — never the key
 *   POST   /credentials {apiKey}   set/rotate (write-only: input clears after save)
 *   DELETE /credentials            disconnect — mappings are KEPT (approved)
 *   POST   /test-connection        { ok, deviceCount | error }
 *   GET    /devices                live list + mappedVehicleId per device
 *   GET    /device-mappings        rows (need ids to deactivate)
 *   POST   /device-mappings        upsert one mapping
 *   DELETE /device-mappings/:id    deactivate (isActive=false, events keep FK)
 *
 * Approved decisions honored here:
 *  - Mapping table lives in Settings (this panel), not the shuttle admin page.
 *  - Plate auto-match is a SUGGESTION: pre-selected + green badge, persisted
 *    only on explicit "Save mappings".
 *  - Disconnect keeps mappings (backend never wipes them on key delete).
 *  - Bilingual EN-primary with ES hints; full strings in locales/{en,es}.json
 *    under the `onestepgps` namespace.
 *
 * The API key is write-only end to end: type=password, state cleared after
 * save, and nothing from the server ever contains it (status is booleans).
 */

const normalizePlate = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function OneStepGpsConnectorTab({ token, scopedSettingsPath, onPageMsg }) {
  const { t } = useTranslation();
  const connectorCardRef = useRef(null);

  // ── Connector credential state ────────────────────────────────────────────
  const [status, setStatus] = useState(null); // { hasApiKey, rotatedAt, lastTestedAt, lastTestStatus, mappedDevices }
  const [statusLoading, setStatusLoading] = useState(true);
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, deviceCount } | { ok:false, error }

  // ── Devices + mappings state ──────────────────────────────────────────────
  const [devices, setDevices] = useState(null); // null = not loaded yet
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState('');
  const [mappingRows, setMappingRows] = useState([]); // GET /device-mappings (ids for deactivate)
  const [vehicles, setVehicles] = useState([]);
  // selections: externalDeviceId -> { vehicleId: string, source: 'saved'|'auto'|'manual' }
  const [selections, setSelections] = useState({});
  const [savingMappings, setSavingMappings] = useState(false);
  const [mappingsSavedCount, setMappingsSavedCount] = useState(null);

  const basePath = '/api/admin/integrations/onestepgps';

  const loadStatus = useCallback(async () => {
    try {
      const out = await api(scopedSettingsPath(`${basePath}/status`), { bypassCache: true }, token);
      setStatus(out || { hasApiKey: false });
    } catch (e) {
      onPageMsg?.(`OneStepGPS status failed: ${e.message || e}`);
      setStatus({ hasApiKey: false });
    } finally {
      setStatusLoading(false);
    }
  }, [scopedSettingsPath, token, onPageMsg]);

  const loadVehicles = useCallback(async () => {
    try {
      const d = await api(scopedSettingsPath('/api/vehicles'), {}, token);
      const list = Array.isArray(d) ? d : (d?.vehicles || []);
      setVehicles(list.map((v) => ({
        id: v.id, plate: v.plate || '', make: v.make || '', model: v.model || '', year: v.year || '',
      })));
    } catch { /* picker just stays empty; the table still renders */ }
  }, [scopedSettingsPath, token]);

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true);
    setDevicesError('');
    try {
      const [devOut, mapOut] = await Promise.all([
        api(scopedSettingsPath(`${basePath}/devices`), { bypassCache: true }, token),
        api(scopedSettingsPath(`${basePath}/device-mappings`), { bypassCache: true }, token),
      ]);
      const list = Array.isArray(devOut?.devices) ? devOut.devices : [];
      setDevices(list);
      setMappingRows(Array.isArray(mapOut?.mappings) ? mapOut.mappings : []);
    } catch (e) {
      setDevices([]);
      setDevicesError(String(e.message || e));
    } finally {
      setDevicesLoading(false);
    }
  }, [scopedSettingsPath, token]);

  useEffect(() => {
    setStatusLoading(true);
    setTestResult(null);
    setMappingsSavedCount(null);
    setDevices(null);
    setSelections({});
    loadStatus();
    loadVehicles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedSettingsPath]);

  useEffect(() => {
    if (status?.hasApiKey && devices === null && !devicesLoading) loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.hasApiKey]);

  // Seed selections when devices/vehicles land: saved mapping wins; otherwise
  // an exact-plate match is PRE-SELECTED as a suggestion (source 'auto') and
  // only persisted on explicit Save (approved decision #3).
  useEffect(() => {
    if (!Array.isArray(devices)) return;
    const plateToVehicle = new Map();
    for (const v of vehicles) {
      const p = normalizePlate(v.plate);
      if (!p) continue;
      // Ambiguous plates (two vehicles, same plate) get NO suggestion.
      plateToVehicle.set(p, plateToVehicle.has(p) ? null : v.id);
    }
    setSelections(() => {
      const next = {};
      for (const d of devices) {
        if (d.mappedVehicleId) {
          next[d.externalDeviceId] = { vehicleId: d.mappedVehicleId, source: 'saved' };
          continue;
        }
        const match = plateToVehicle.get(normalizePlate(d.licensePlate));
        next[d.externalDeviceId] = match
          ? { vehicleId: match, source: 'auto' }
          : { vehicleId: '', source: 'saved' };
      }
      return next;
    });
  }, [devices, vehicles]);

  // ── Derived table info ────────────────────────────────────────────────────
  const vehicleById = useMemo(() => new Map(vehicles.map((v) => [v.id, v])), [vehicles]);
  const vehicleLabel = (v) => [v.plate || '—', [v.make, v.model, v.year].filter(Boolean).join(' ')].filter(Boolean).join(' · ');

  const rows = useMemo(() => (Array.isArray(devices) ? devices.map((d) => {
    const sel = selections[d.externalDeviceId] || { vehicleId: '', source: 'saved' };
    const baseline = d.mappedVehicleId || '';
    const dirty = sel.vehicleId !== baseline;
    return { device: d, sel, baseline, dirty };
  }) : []), [devices, selections]);

  const dirtyCount = rows.filter((r) => r.dirty).length;
  const mappedCount = rows.filter((r) => r.sel.vehicleId).length;
  const activeMappingByExternalId = useMemo(() => {
    const m = new Map();
    for (const row of mappingRows) if (row.isActive) m.set(row.externalDeviceId, row);
    return m;
  }, [mappingRows]);

  const vehiclesWithoutDevice = useMemo(() => {
    const used = new Set(rows.map((r) => r.sel.vehicleId).filter(Boolean));
    return vehicles.filter((v) => !used.has(v.id));
  }, [rows, vehicles]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const saveKey = async () => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    setSavingKey(true);
    try {
      await api(scopedSettingsPath(`${basePath}/credentials`), { method: 'POST', body: JSON.stringify({ apiKey }) }, token);
      setKeyInput(''); // write-only: never keep the key around after save
      setTestResult(null);
      onPageMsg?.(t('onestepgps.keySaved'));
      await loadStatus();
      setDevices(null); // force a device reload with the new key
    } catch (e) {
      onPageMsg?.(`${t('onestepgps.keySaveFailed')}: ${e.message || e}`);
    } finally {
      setSavingKey(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const out = await api(scopedSettingsPath(`${basePath}/test-connection`), { method: 'POST' }, token);
      setTestResult(out || { ok: false, error: 'empty response' });
      loadStatus();
    } catch (e) {
      setTestResult({ ok: false, error: String(e.message || e) });
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    if (typeof window !== 'undefined' && !window.confirm(t('onestepgps.disconnectConfirm'))) return;
    setDisconnecting(true);
    try {
      await api(scopedSettingsPath(`${basePath}/credentials`), { method: 'DELETE' }, token);
      setTestResult(null);
      setDevices(null);
      setSelections({});
      onPageMsg?.(t('onestepgps.keyCleared'));
      await loadStatus();
    } catch (e) {
      onPageMsg?.(`${t('onestepgps.disconnectFailed')}: ${e.message || e}`);
    } finally {
      setDisconnecting(false);
    }
  };

  const setRowVehicle = (externalDeviceId, vehicleId) => {
    setMappingsSavedCount(null);
    setSelections((prev) => ({ ...prev, [externalDeviceId]: { vehicleId, source: 'manual' } }));
  };

  const saveMappings = async () => {
    const dirtyRows = rows.filter((r) => r.dirty);
    if (!dirtyRows.length) return;
    setSavingMappings(true);
    try {
      let failures = 0;
      for (const row of dirtyRows) {
        const { device, sel, baseline } = row;
        try {
          if (sel.vehicleId) {
            await api(scopedSettingsPath(`${basePath}/device-mappings`), {
              method: 'POST',
              body: JSON.stringify({
                vehicleId: sel.vehicleId,
                externalDeviceId: device.externalDeviceId,
                label: device.displayName || undefined,
              }),
            }, token);
          } else if (baseline) {
            // Cleared picker on a saved row → deactivate (approved: inactive, not wiped).
            const mapping = activeMappingByExternalId.get(device.externalDeviceId);
            if (mapping) {
              await api(scopedSettingsPath(`${basePath}/device-mappings/${encodeURIComponent(mapping.id)}`), { method: 'DELETE' }, token);
            }
          }
        } catch (e) {
          failures += 1;
          onPageMsg?.(`${t('onestepgps.mappingSaveFailed', { device: device.displayName || device.externalDeviceId })}: ${e.message || e}`);
        }
      }
      await loadDevices();
      await loadStatus();
      if (!failures) setMappingsSavedCount(mappedCount);
    } finally {
      setSavingMappings(false);
    }
  };

  // ── Render helpers ────────────────────────────────────────────────────────
  const fmtTime = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
  };

  const hasKey = !!status?.hasApiKey;
  const chip = !hasKey
    ? { cls: 'neutral', label: t('onestepgps.chipNotConnected') }
    : (testResult && !testResult.ok) || (!testResult && status?.lastTestStatus === 'ERROR')
      ? { cls: 'warn', label: t('onestepgps.chipError') }
      : { cls: 'good', label: t('onestepgps.chipConnected') };

  const scrollToConnector = () => {
    connectorCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <>
      {/* ═══════════ Screen 1 — connector card ═══════════ */}
      <section className="glass card section-card" ref={connectorCardRef}>
        <div className="row-between" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 0 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div className="osg-provider-mark" aria-hidden>1S</div>
            <div className="stack" style={{ gap: 4 }}>
              <h3 style={{ margin: 0 }}>{t('onestepgps.title')}</h3>
              <div className="ui-muted">
                {t('onestepgps.subtitle')}{' '}
                <span className="osg-hint-es">{t('onestepgps.subtitleHint')}</span>
              </div>
            </div>
          </div>
          <span className={`status-chip ${chip.cls}`}>{chip.label}</span>
        </div>

        {statusLoading ? (
          <p className="ui-muted">{t('onestepgps.loading')}</p>
        ) : (
          <>
            <div className="form-grid-2">
              <div className="stack" style={{ gap: 6 }}>
                <label className="label" htmlFor="osg-api-key">
                  {t('onestepgps.apiKeyLabel')}{' '}
                  <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{t('onestepgps.apiKeyLabelHint')}</span>
                </label>
                {hasKey && (
                  <div className="osg-key-state">
                    <span style={{ color: 'var(--ok-tx)', fontWeight: 800 }}>✓</span>
                    <span>{t('onestepgps.keyConfigured')}&nbsp;••••••••••••••••</span>
                  </div>
                )}
                {hasKey && <div className="ui-muted">{t('onestepgps.rotateHint')}</div>}
                <input
                  id="osg-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder={hasKey ? t('onestepgps.apiKeyRotatePlaceholder') : t('onestepgps.apiKeyPlaceholder')}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
                {!hasKey && (
                  <div className="ui-muted">
                    {t('onestepgps.apiKeyStored')}{' '}
                    <span className="osg-hint-es">{t('onestepgps.apiKeyStoredHint')}</span>
                  </div>
                )}
              </div>
              {hasKey ? (
                <div className="stack" style={{ gap: 8 }}>
                  <span className="label">{t('onestepgps.connectionLabel')}</span>
                  {testResult?.ok && (
                    <div className="osg-banner ok">
                      <span className="osg-banner-ic">✓</span>
                      <div>
                        <strong>{t('onestepgps.testOk', { count: testResult.deviceCount ?? 0 })}</strong><br />
                        <span style={{ fontWeight: 400 }}>
                          {t('onestepgps.testOkDetail', { count: testResult.deviceCount ?? 0 })}
                          {status?.lastTestedAt ? ` ${t('onestepgps.lastTested', { time: fmtTime(status.lastTestedAt) })}` : ''}
                        </span>
                      </div>
                    </div>
                  )}
                  {testResult && !testResult.ok && (
                    <div className="osg-banner err">
                      <span className="osg-banner-ic">✕</span>
                      <div>
                        <strong>{t('onestepgps.testFail', { error: testResult.error || 'unknown error' })}</strong><br />
                        <span style={{ fontWeight: 400 }}>{t('onestepgps.testFailDetail')}</span>
                      </div>
                    </div>
                  )}
                  {!testResult && (
                    <div className="surface-note">
                      {status?.lastTestedAt
                        ? `${status.lastTestStatus === 'OK' ? t('onestepgps.lastTestOkNote') : t('onestepgps.lastTestErrorNote')} ${t('onestepgps.lastTested', { time: fmtTime(status.lastTestedAt) })}`
                        : t('onestepgps.neverTestedNote')}
                    </div>
                  )}
                </div>
              ) : (
                <div className="surface-note">{t('onestepgps.apiKeyHelp')}</div>
              )}
            </div>

            <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
              <button type="button" onClick={saveKey} disabled={savingKey || !keyInput.trim()}>
                {savingKey ? t('onestepgps.savingKey') : (hasKey ? t('onestepgps.saveNewKey') : t('onestepgps.saveKey'))}
              </button>
              <button type="button" className="button-subtle" onClick={runTest} disabled={!hasKey || testing}>
                {testing ? t('onestepgps.testing') : (testResult && !testResult.ok ? t('onestepgps.testAgain') : t('onestepgps.testConnection'))}
              </button>
              {hasKey && (
                <>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="button-danger" onClick={disconnect} disabled={disconnecting}>
                    {disconnecting ? t('onestepgps.disconnecting') : t('onestepgps.disconnect')}
                  </button>
                </>
              )}
            </div>

            {hasKey && (
              <div className="surface-note">
                <strong>{t('onestepgps.disconnectNoteLead')}</strong> {t('onestepgps.disconnectNote')}{' '}
                <span className="osg-hint-es">{t('onestepgps.disconnectNoteHint')}</span>
              </div>
            )}
          </>
        )}
      </section>

      {/* ═══════════ Screen 2 / Screen 4 — mapping table or empty state ═══════════ */}
      {!statusLoading && !hasKey && (
        <div className="osg-empty">
          <div className="osg-empty-glyph" aria-hidden>📡</div>
          <h3 style={{ margin: 0 }}>{t('onestepgps.emptyTitle')}</h3>
          <div className="ui-muted" style={{ maxWidth: 420 }}>
            {t('onestepgps.emptyBody')}<br />
            <span className="osg-hint-es">{t('onestepgps.emptyBodyHint')}</span>
          </div>
          <button type="button" onClick={scrollToConnector}>{t('onestepgps.emptyCta')}</button>
        </div>
      )}

      {hasKey && (
        <section className="glass card section-card">
          <div className="row-between" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 0 }}>
            <div className="stack" style={{ gap: 4 }}>
              <h3 style={{ margin: 0 }}>
                {t('onestepgps.mappingTitle')}{' '}
                <span className="osg-hint-es" style={{ fontWeight: 400 }}>{t('onestepgps.mappingTitleHint')}</span>
              </h3>
              <div className="ui-muted">
                {t('onestepgps.mappingSummary', {
                  total: rows.length,
                  mapped: mappedCount,
                  unmapped: rows.length - mappedCount,
                })}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {dirtyCount > 0 && (
                <span className="status-chip warn">{t('onestepgps.unsavedChanges', { count: dirtyCount })}</span>
              )}
              <button type="button" className="button-subtle" onClick={loadDevices} disabled={devicesLoading}>
                {t('onestepgps.refreshDevices')}
              </button>
              <button type="button" onClick={saveMappings} disabled={savingMappings || devicesLoading || dirtyCount === 0}>
                {savingMappings ? t('onestepgps.savingMappings') : t('onestepgps.saveMappings')}
              </button>
            </div>
          </div>

          {mappingsSavedCount !== null && (
            <div className="osg-banner ok">
              <span className="osg-banner-ic">✓</span>
              <div>
                <strong>{t('onestepgps.mappingsSaved', { count: mappingsSavedCount })}</strong>{' '}
                <span style={{ fontWeight: 400 }}>{t('onestepgps.mappingsSavedDetail')}</span>
              </div>
            </div>
          )}

          {devicesLoading && <p className="ui-muted">{t('onestepgps.loadingDevices')}</p>}
          {!devicesLoading && devicesError && (
            <div className="osg-banner err">
              <span className="osg-banner-ic">✕</span>
              <div>
                <strong>{t('onestepgps.devicesError')}</strong>{' '}
                <span style={{ fontWeight: 400 }}>{devicesError}</span>
              </div>
            </div>
          )}
          {!devicesLoading && !devicesError && rows.length === 0 && (
            <p className="ui-muted">{t('onestepgps.noDevices')}</p>
          )}

          {!devicesLoading && !devicesError && rows.length > 0 && (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>{t('onestepgps.colDevice')}</th>
                    <th>{t('onestepgps.colPlate')}</th>
                    <th>{t('onestepgps.colVehicle')}</th>
                    <th>{t('onestepgps.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ device, sel, dirty }) => {
                    const selVehicle = sel.vehicleId ? vehicleById.get(sel.vehicleId) : null;
                    const devicePlate = normalizePlate(device.licensePlate);
                    const manualMismatch = !!selVehicle && sel.source !== 'auto'
                      && (!devicePlate || normalizePlate(selVehicle.plate) !== devicePlate);
                    const plateHasNoVehicle = !sel.vehicleId && devicePlate
                      && !vehicles.some((v) => normalizePlate(v.plate) === devicePlate);
                    return (
                      <tr key={device.externalDeviceId} className={dirty ? 'osg-dirty' : ''}>
                        <td>
                          <strong>{device.displayName || device.externalDeviceId}</strong><br />
                          <span className="ui-muted" style={{ fontFamily: 'var(--font-mono, ui-monospace, Consolas, monospace)', fontSize: 12 }}>
                            {device.externalDeviceId}
                          </span>
                        </td>
                        <td>{device.licensePlate || <span className="ui-muted">{t('onestepgps.noPlate')}</span>}</td>
                        <td>
                          <select
                            value={sel.vehicleId}
                            onChange={(e) => setRowVehicle(device.externalDeviceId, e.target.value)}
                            style={{ maxWidth: 280, minHeight: 36 }}
                            aria-label={t('onestepgps.colVehicle')}
                          >
                            <option value="">{t('onestepgps.choosePlaceholder')}</option>
                            {vehicles.map((v) => (
                              <option key={v.id} value={v.id}>{vehicleLabel(v)}</option>
                            ))}
                          </select>
                          {sel.source === 'auto' && sel.vehicleId && (
                            <div style={{ marginTop: 5 }}>
                              <span className="badge osg-badge-auto">{t('onestepgps.autoMatched')}</span>
                            </div>
                          )}
                          {manualMismatch && (
                            <div style={{ marginTop: 5 }}>
                              <span className="badge">{t('onestepgps.mappedManually')}</span>
                            </div>
                          )}
                          {plateHasNoVehicle && (
                            <div className="ui-muted" style={{ marginTop: 5, whiteSpace: 'normal' }}>
                              {t('onestepgps.noPlateMatch', { plate: device.licensePlate })}
                            </div>
                          )}
                        </td>
                        <td>
                          {sel.vehicleId
                            ? <span className="status-chip good">{t('onestepgps.chipMapped')}</span>
                            : <span className="status-chip neutral">{t('onestepgps.chipUnmapped')}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!devicesLoading && !devicesError && vehiclesWithoutDevice.length > 0 && (
            <div className="surface-note">
              <strong>{t('onestepgps.vehiclesWithoutDevice', { count: vehiclesWithoutDevice.length })}</strong>{' '}
              <span className="osg-hint-es">{t('onestepgps.vehiclesWithoutDeviceHint')}</span>{' '}
              {vehiclesWithoutDevice.slice(0, 8).map((v) => vehicleLabel(v)).join('  ·  ')}
              {vehiclesWithoutDevice.length > 8 ? ` … +${vehiclesWithoutDevice.length - 8}` : ''}.{' '}
              {t('onestepgps.vehiclesWithoutDeviceNote')}
            </div>
          )}
        </section>
      )}
    </>
  );
}
