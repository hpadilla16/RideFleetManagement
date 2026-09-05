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
import { COURSES, modulesFor, pointsAvailable, courseReference } from '../../lib/training/curriculum.js';
import { courseKey as cKey, moduleKey as mKey, trainingText } from '../../lib/training/i18n-keys.js';
import { KIOSK_GLOSSARY, glossaryKey } from '../../lib/training/kiosk-glossary.js';
import { KioskButtonGlossary } from './KioskButtonGlossary';
import { enterPractice, inPracticeMode, practiceBlockedByImpersonation } from '../../lib/training/practice';
import { TOUR_START_EVENT, TOUR_MODULE_DONE_EVENT } from './TourHost';

export function ModuleList({ token, me }) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState([]);
  const [justCompleted, setJustCompleted] = useState([]);
  const [busyKey, setBusyKey] = useState(null);
  const [practiceError, setPracticeError] = useState('');
  // Reference material open (the kiosk button glossary). Not a module: no
  // progress row, no points — it is the thing you open when a guest is
  // standing there asking what a button does.
  const [glossaryOpen, setGlossaryOpen] = useState(false);

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

  // Reaching the end of a module's steps completes it (2026-08-17). The server
  // still decides — the row must have been armed and not already completed —
  // but a verify rule is no longer a gate on the guide: it is the other way
  // in, for someone who does the real work without walking anything.
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

  /** Take a module again — clears the record so it starts from zero. */
  const restartModule = async (module) => {
    setBusyKey(module.key);
    try {
      await api(`/api/training/progress/${encodeURIComponent(module.key)}/reset`, { method: 'POST' }, token);
      await load();
    } catch { /* leave the row as it was; the button can be pressed again */ }
    setBusyKey(null);
  };

  /**
   * The bridge into the demo tenant (2026-08-16). The hands-on modules run
   * against real inventory, which a trainee does not have — this swaps the
   * session for their own practice AGENT on the demo tenant so they can run
   * the same flows against data that is not. What they finish in there DOES
   * count: the token names them, so progress lands on their real record.
   * The PracticeBanner is the way back.
   */
  const practice = async () => {
    setPracticeError('');
    if (practiceBlockedByImpersonation()) {
      // A super admin mid-impersonation has a backup stack of their own;
      // nesting the two swaps tangles them (QA #9).
      setPracticeError(t('training.practiceImpersonation', 'Exit tenant view first, then start practice.'));
      return;
    }
    setBusyKey('__practice');
    try {
      const out = await api('/api/training/practice-session', { method: 'POST' }, token);
      if (!out?.token) throw new Error('no token');
      const meResp = await api('/api/auth/me', {}, out.token);
      const swapped = enterPractice({ token: out.token, user: meResp?.user || meResp });
      if (swapped) { window.location.href = '/'; return; }
      setBusyKey(null);
      setPracticeError(t('training.practiceError', 'Could not open practice mode — try again.'));
    } catch (err) {
      // 404 (no demo tenant) and 409 (account misconfigured) are both
      // admin-actionable — silence here just breeds "the button is broken".
      setBusyKey(null);
      setPracticeError(err?.message || t('training.practiceError', 'Could not open practice mode — try again.'));
    }
  };

  if (!mine.length) return null;

  return (
    <section className="glass card-lg" style={{ marginBottom: 16 }}>
      <div className="row-between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>{t('training.yourTraining', 'Your training')}</h2>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span className="ui-muted" style={{ fontSize: 13 }}>
            {t('training.standing', `${percent}% complete · ${earned} of ${available} points`, { percent, earned, available })}
          </span>
          {!inPracticeMode() && (
            <button
              type="button"
              className="button-subtle"
              disabled={busyKey === '__practice'}
              onClick={practice}
              title={t('training.practiceHint', 'Rehearse the hands-on modules on the demo tenant — no real data, and it counts toward your training')}
            >
              {busyKey === '__practice'
                ? t('training.practiceOpening', 'Opening practice…')
                : t('training.practiceCta', '🎓 Practice on the demo tenant')}
            </button>
          )}
        </div>
      </div>

      {practiceError && (
        <div className="surface-note" style={{ marginTop: 8, color: '#b3261e' }} role="alert">{practiceError}</div>
      )}

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
            <div className="label" style={{ marginBottom: 6 }}>{trainingText(t, cKey(course, 'title'), course.title)}</div>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {/* How this module is passed — from the curriculum, never
                          asserted by the row (approved mockup, 2026-09-04). */}
                      {m.verify ? (
                        <span className="ui-muted" data-testid="proof-pill" style={{ fontSize: 12 }}>{t('training.proof.byWork', 'Proved by doing the real thing')}</span>
                      ) : (m.steps || []).some((s) => s.check) ? (
                        <span className="ui-muted" data-testid="proof-pill" style={{ fontSize: 12 }}>{t('training.proof.readingCheck', 'Reading + check')}</span>
                      ) : null}
                      {Array.isArray(m.roles) && !m.roles.includes('AGENT') && !m.roles.includes('OPS') && (
                        <span className="ui-muted" data-testid="proof-pill" style={{ fontSize: 12 }}>{t('training.proof.adminOnly', 'Admin only')}</span>
                      )}
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
                      {(done || armed) && (
                        <button
                          type="button"
                          className="button-subtle"
                          disabled={busyKey === m.key}
                          onClick={() => restartModule(m)}
                          title={t('training.restartHint', 'Clear this module and take it from the beginning')}
                        >
                          {t('training.restart', 'Start over')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {courseReference(course) === KIOSK_GLOSSARY.key && (
                <div
                  className="row-between"
                  data-testid="course-reference-row"
                  style={{
                    alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    padding: '10px 12px', borderRadius: 10,
                    border: '1px dashed var(--border, #e6e0f2)',
                    background: 'var(--surface-2, #f7f5fd)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {trainingText(t, glossaryKey('title'), KIOSK_GLOSSARY.title)}
                    </div>
                    <div className="ui-muted" style={{ fontSize: 12.5 }}>
                      {trainingText(t, glossaryKey('summary'), KIOSK_GLOSSARY.summary)}
                    </div>
                  </div>
                  <button type="button" className="button-subtle" onClick={() => setGlossaryOpen(true)}>
                    {t('training.openReference', 'Open')}
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
      <KioskButtonGlossary open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </section>
  );
}
