'use client';

/**
 * "Qué preguntan los agentes" — the copilot's authoring backlog, for admins.
 *
 * Phase 2 of the Agent Copilot logs every question the panel could not answer
 * (CopilotMiss, grouped by normalized query). This card renders that backlog
 * where admins already look for training signals: the People page, right
 * beside Team training — "who on the team is trained" next to "what the whole
 * team cannot find". One glance answers both halves of the same question:
 * is the team ready, and where is the curriculum thin.
 *
 * Reads GET /api/copilot/misses/top (ADMIN-gated at the route). The gating
 * idiom is TeamTraining's, verbatim: fetch, and render NOTHING on 403 — the
 * server owns the role decision, the card never re-implements it.
 *
 * SEVEN DAYS, because the empty state says "this week" and must be telling
 * the truth. A backlog that quietly queried 30 days under a weekly headline
 * would be the copilot's own sin: an answer with the wrong source.
 *
 * Each row deep-links "Buscar en KB" into the knowledge-base search prefill
 * the copilot already built (?search= on /knowledge-base) — the admin lands
 * one click from either finding the article that exists or writing the one
 * that does not.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';
import { relativeTime } from '../../lib/notification-lanes';

export const MISSES_DAYS = 7;
export const MISSES_LIMIT = 10;

export function CopilotMisses({ token }) {
  const { t } = useTranslation();
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const out = await api(
        `/api/copilot/misses/top?days=${MISSES_DAYS}&limit=${MISSES_LIMIT}`,
        { bypassCache: true },
        token
      );
      setItems(Array.isArray(out?.items) ? out.items : []);
      setHidden(false);
    } catch {
      // A role without permission gets nothing rather than a broken card —
      // the endpoint is ADMIN-gated and the server's decision is final. Any
      // other failure hides the card too: the empty state below claims
      // "no unanswered questions", and a fetch error is not that fact.
      setHidden(true);
      setItems([]);
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (hidden || !loaded) return null;

  return (
    <section className="glass card-lg" style={{ marginBottom: 16 }} data-testid="copilot-misses">
      <div className="row-between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t('copilot.misses.heading', 'What agents are asking')}</h3>
        <span className="ui-muted" style={{ fontSize: 12.5 }}>
          {t('copilot.misses.note', 'Questions the copilot could not answer, last {{days}} days', { days: MISSES_DAYS })}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="ui-muted" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
          {t('copilot.misses.empty', 'No unanswered questions this week.')}
        </p>
      ) : (
        <div className="stack" style={{ gap: 6, marginTop: 12 }}>
          {items.map((row) => (
            <div
              key={row.normalizedQuery}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: 12, alignItems: 'center',
                padding: '9px 12px', borderRadius: 10,
                border: '1px solid var(--border-2, #e6e0f2)',
                background: 'var(--surface-1, #fff)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.query}
                  {row.flagged && (
                    <span
                      style={{
                        marginLeft: 8, padding: '1px 8px', borderRadius: 6,
                        background: 'rgba(214, 69, 69, .08)', color: '#c03636',
                        fontSize: 11, fontWeight: 700, verticalAlign: 'middle',
                      }}
                    >
                      {t('copilot.misses.flagged', 'Flagged')}
                    </span>
                  )}
                </div>
                <div className="ui-muted" style={{ fontSize: 12 }}>
                  {/* `times`, not i18next's plural-magic `count` */}
                  {t('copilot.misses.askedCount', 'Asked {{times}}×', { times: row.count })}
                  {row.lastAt ? ` · ${t('copilot.misses.lastAsked', 'last {{ago}} ago', { ago: relativeTime(row.lastAt) })}` : ''}
                </div>
              </div>

              <Link
                href={`/knowledge-base?search=${encodeURIComponent(row.query)}`}
                className="button-subtle"
                style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}
              >
                {t('copilot.misses.searchKb', 'Search the KB')}
              </Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
