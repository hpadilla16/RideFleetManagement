'use client';

/**
 * Ride University — the modules, and where this person stands.
 *
 * Progress comes from the server (GET /api/training/progress), which settles
 * anything the domain records now prove before answering. So opening this page
 * is what completes a module someone finished during their shift: no
 * background sweep over every user, and the person is right there to see it.
 *
 * PERCENTAGE, NEVER RAW POINTS. An agent's whole curriculum is worth 105 and
 * an admin's 185, so a raw score would rank people by their job title. The
 * denominator is what is available to THAT viewer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';
import { COURSES, modulesFor, pointsAvailable } from '../../lib/training/curriculum.js';
import { moduleKey as mKey, trainingText } from '../../lib/training/i18n-keys.js';
import { TOUR_START_EVENT, TOUR_MODULE_DONE_EVENT } from './TourHost';

export function ModuleList({ token, me }) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState([]);
  const [justCompleted, setJustCompleted] = useState([]);
  const [busyKey, setBusyKey] = useState(null);

  const viewer = useMemo(() => ({
    role: me?.role,
    isModuleEnabled: (key) => me?.moduleAccess?.[key] !== false,
  }), [me]);

  const mine = useMemo(() => modulesFor(viewer), [viewer]);
  const available = useMemo(() => pointsAvailable(viewer), [viewer]);

  const load = useCallback(async () => {
    try {
      const out = await api('/api/training/progress', { bypassCache: true }, token);
      setProgress(Array.isArray(out?.progress) ? out.progress : []);
      setJustCompleted(Array.isArray(out?.justCompleted) ? out.justCompleted : []);
    } catch {
      // Training never blocks the page it lives on.
      setProgress([]);
    }
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

  // Walking a module's steps to the end completes it — but only when there is
  // nothing to prove. The server decides that from what was stamped at arming,
  // so a module whose point is doing the real work stays armed no matter how
  // many times someone walks the guide (2026-08-15).
  useEffect(() => {
    const onWalked = async (event) => {
      const moduleKey = event?.detail?.moduleKey;
      if (!moduleKey || !token) return;
      try {
        await api(`/api/training/progress/${encodeURIComponent(moduleKey)}/walkthrough-complete`, { method: 'POST' }, token);
        await load();
      } catch { /* the walk still happened; the page just won't tick over yet */ }
    };
    window.addEventListener(TOUR_MODULE_DONE_EVENT, onWalked);
    return () => window.removeEventListener(TOUR_MODULE_DONE_EVENT, onWalked);
  }, [token, load]);

  const byKey = useMemo(() => {
    const map = new Map();
    for (const row of progress) map.set(row.moduleKey, row);
    return map;
  }, [progress]);

  const earned = progress
    .filter((p) => p.status === 'COMPLETED')
    .reduce((sum, p) => sum + (Number(p.pointsAwarded) || 0), 0);
  const percent = available > 0 ? Math.min(100, Math.round((earned / available) * 100)) : 0;

  const startModule = async (module) => {
    setBusyKey(module.key);
    try {
      await api(`/api/training/progress/${encodeURIComponent(module.key)}/arm`, {
        method: 'POST',
        body: JSON.stringify({ verifyType: module.verify?.type || null, points: module.points || 0 }),
      }, token);
      await load();
    } catch { /* the guide still runs even if arming failed */ }
    setBusyKey(null);
    window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail: { track: 'MODULE', moduleKey: module.key } }));
  };

  if (!mine.length) return null;

  return (
    <section className="glass card-lg" style={{ marginBottom: 16 }}>
      <div className="row-between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>{t('training.yourTraining', 'Your training')}</h2>
        <span className="ui-muted" style={{ fontSize: 13 }}>
          {t('training.standing', `${percent}% complete · ${earned} of ${available} points`, { percent, earned, available })}
        </span>
      </div>

      <div style={{ height: 4, background: 'var(--surface-2, #f0edf9)', borderRadius: 2, overflow: 'hidden', margin: '10px 0 16px' }}>
        <i style={{ display: 'block', height: '100%', width: `${percent}%`, background: '#8752FE', borderRadius: 2 }} />
      </div>

      {justCompleted.length > 0 && (
        <div className="surface-note" style={{ marginBottom: 12 }}>
          {t('training.justCompleted', 'Completed since you were last here:')}{' '}
          <strong>{justCompleted.map((r) => r.moduleKey).join(', ')}</strong>
        </div>
      )}

      {COURSES.map((course) => {
        const modules = (course.modules || []).filter((m) => mine.some((x) => x.key === m.key));
        if (!modules.length) return null;
        return (
          <div key={course.key} style={{ marginBottom: 14 }}>
            <div className="label" style={{ marginBottom: 6 }}>{course.title}</div>
            <div className="stack" style={{ gap: 6 }}>
              {modules.map((m) => {
                const row = byKey.get(m.key);
                const done = row?.status === 'COMPLETED';
                const armed = row?.status === 'ARMED';
                return (
                  <div
                    key={m.key}
                    className="row-between"
                    style={{
                      alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      padding: '10px 12px', borderRadius: 10,
                      border: '1px solid var(--border-2, #e6e0f2)',
                      background: done ? 'rgba(31,138,95,0.06)' : 'var(--surface-1, #fff)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {trainingText(t, mKey(m, 'title'), m.title)}
                        {done && <span style={{ color: '#1f8a5f', marginLeft: 8, fontSize: 12 }}>✓</span>}
                      </div>
                      <div className="ui-muted" style={{ fontSize: 12.5 }}>
                        {trainingText(t, mKey(m, 'summary'), m.summary)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="ui-muted" style={{ fontSize: 12 }}>{m.points} pts</span>
                      {armed && m.verify && (
                        <span className="ui-muted" style={{ fontSize: 12 }}>
                          {t('training.waitingOnWork', 'Waiting on the real thing')}
                        </span>
                      )}
                      <button
                        type="button"
                        className={done ? 'button-subtle' : ''}
                        disabled={busyKey === m.key}
                        onClick={() => startModule(m)}
                      >
                        {done
                          ? t('training.review', 'Review')
                          : armed
                            ? t('training.showMeAgain', 'Show me again')
                            : t('training.start', 'Start')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
