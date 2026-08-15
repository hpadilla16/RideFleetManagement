'use client';

/**
 * Ride University — who on the team is trained.
 *
 * The question this answers is not "how many badges does María have". It is
 * "is María ready to work the counter alone on Saturday?" — so the row leads
 * with a percentage and what is still outstanding, and there is no ranking,
 * no leaderboard and no sorting by score.
 *
 * PERCENTAGE, NEVER RAW POINTS. An agent's whole curriculum is worth 105 and
 * an admin's 185, so a raw score would sort people by their job title. Each
 * person's denominator is computed from THEIR role, which is why the available
 * totals are sent up with the request: the curriculum lives on the client, and
 * the server has no idea what a given role is expected to know.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';
import { modulesFor, pointsAvailable } from '../../lib/training/curriculum.js';

export function TeamTraining({ token, people = [], scopedQuery = '' }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [denied, setDenied] = useState(false);

  // Only people who can actually sign in have training to do.
  const staff = useMemo(
    () => (people || []).filter((p) => p?.userId && p?.hasLogin !== false && p?.accessRole),
    [people]
  );

  // What each person's role is expected to know — their denominator.
  const availableByUser = useMemo(() => {
    const out = {};
    for (const p of staff) out[p.userId] = pointsAvailable({ role: p.accessRole });
    return out;
  }, [staff]);

  const load = useCallback(async () => {
    if (!token || !staff.length) return;
    try {
      const qs = new URLSearchParams({ available: JSON.stringify(availableByUser) });
      const sep = scopedQuery ? '&' : '?';
      const out = await api(`/api/training/team${scopedQuery}${sep}${qs.toString()}`, { bypassCache: true }, token);
      setRows(Array.isArray(out?.team) ? out.team : []);
      setDenied(false);
    } catch (err) {
      // A role without permission gets nothing rather than a broken page.
      if (/403|forbidden/i.test(String(err?.message || ''))) setDenied(true);
      setRows([]);
    } finally {
      setLoaded(true);
    }
  }, [token, staff.length, availableByUser, scopedQuery]);

  useEffect(() => { load(); }, [load]);

  const byUser = useMemo(() => {
    const map = new Map();
    for (const r of rows) map.set(r.userId, r);
    return map;
  }, [rows]);

  if (denied || !staff.length) return null;

  return (
    <section className="glass card-lg" style={{ marginBottom: 16 }}>
      <div className="row-between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t('training.teamHeading', 'Team training')}</h3>
        <span className="ui-muted" style={{ fontSize: 12.5 }}>
          {t('training.teamNote', 'Progress against what each role is expected to know')}
        </span>
      </div>

      <div className="stack" style={{ gap: 6, marginTop: 12 }}>
        {staff.map((p) => {
          const standing = byUser.get(p.userId);
          const percent = standing?.percent ?? 0;
          const done = standing?.completedCount ?? 0;
          const armed = standing?.armedCount ?? 0;
          const total = modulesFor({ role: p.accessRole }).length;
          // Nothing at all vs genuinely 0% are different facts. Someone who has
          // never opened Ride University should not read as "failing".
          const untouched = !standing || (done === 0 && armed === 0);

          return (
            <div
              key={p.userId}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) 64px',
                gap: 12, alignItems: 'center',
                padding: '9px 12px', borderRadius: 10,
                border: '1px solid var(--border-2, #e6e0f2)',
                background: 'var(--surface-1, #fff)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.displayName || p.fullName || p.email}
                </div>
                <div className="ui-muted" style={{ fontSize: 12 }}>
                  {p.accessRole} · {untouched
                    ? t('training.notStarted', 'Has not started')
                    : t('training.doneOf', `${done} of ${total} modules`, { done, total })}
                  {armed > 0 ? ` · ${t('training.inProgress', `${armed} in progress`, { armed })}` : ''}
                </div>
              </div>

              <div
                style={{ height: 6, background: 'var(--surface-2, #f0edf9)', borderRadius: 3, overflow: 'hidden' }}
                role="img"
                aria-label={`${percent}%`}
              >
                <i style={{
                  display: 'block', height: '100%', width: `${percent}%`, borderRadius: 3,
                  background: percent >= 100 ? '#1f8a5f' : '#8752FE',
                }} />
              </div>

              <div style={{
                textAlign: 'right', fontSize: 13, fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                color: untouched ? 'var(--text-3, #736a8b)' : 'var(--text-1, #1e1a2b)',
              }}>
                {untouched ? '—' : `${percent}%`}
              </div>
            </div>
          );
        })}
      </div>

      {loaded && rows.length === 0 && (
        <p className="ui-muted" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
          {t('training.nobodyStarted', 'Nobody has opened Ride University yet.')}
        </p>
      )}
    </section>
  );
}
