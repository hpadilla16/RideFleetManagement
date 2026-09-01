'use client';

// Check-in Audit — the T1 review queue (2026-09-03, approved mockup).
// Source of truth: design/mockups/checkin-audit-mockup.html (Mock 1 queue,
// Mock 2 detail) + checkin-audit-NOTES.md. THIS IS T1 ONLY — rules, no AI:
// - Lanes are saved filters over one findings table (tolls/notifications rail
//   pattern). The Possible-damage lane ships EMPTY with honest copy: photo AI
//   (T2) is not enabled. The KPI strip has NO AI-spend tile for the same
//   reason.
// - The detail view renders the Mock-2 mileage/fuel + entry-check cards from
//   the findings' own recorded numbers; the photo-pair pane is the T2
//   placeholder.
// - Dismissing offers the two verbs from the damage-baseline design: "Not an
//   issue" (any finding) and "Real but pre-existing" (DAMAGE findings only —
//   none exist in T1, so the verb renders disabled with the T2 note; the API
//   underneath is already generic).
// A check-in is never held by the audit — flags appear here after the close.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import {
  CHECKIN_AUDIT_LANE_GROUPS,
  CHECKIN_AUDIT_KPIS,
  LANE_QUERY,
  findingChip,
  groupRowsByReservation,
  mileageFuelAuditRows,
  entryAuditRows,
  canDismissPreexisting,
} from '../../lib/checkin-audit-lanes';

function fmtDateTime(d, lang) {
  try {
    return new Date(d).toLocaleString(lang === 'es' ? 'es-PR' : 'en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
}

function Chip({ finding }) {
  const { t } = useTranslation();
  const c = findingChip(finding);
  return (
    <span className={`chip chip--${c.tone}`} data-testid={`chip-${c.key}`}>
      <span className="led" />
      {t(c.labelKey, { ...c.params, defaultValue: c.defaultLabel || c.key })}
    </span>
  );
}

/** KPI strip — exported for component tests (must NOT contain the AI tile). */
export function KpiStrip({ kpis }) {
  const { t } = useTranslation();
  return (
    <div className="ca-kpis" data-testid="ca-kpis">
      {CHECKIN_AUDIT_KPIS.map((k) => (
        <div key={k.id} className={`ca-kpi${k.tone === 'flag' ? ' ca-kpi--flag' : ''}`} data-testid={`kpi-${k.id}`}>
          <div className="ca-kpi-lab">{t(`checkinAudit.kpis.${k.id}`, k.id)}</div>
          <div className="ca-kpi-val tnum">{Number(kpis?.[k.key]) || 0}</div>
        </div>
      ))}
    </div>
  );
}

/** Queue table (Mock 1) — one row per reservation, T1 chips per finding. */
export function AuditQueueTable({ rows, lane, onOpen }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const grouped = useMemo(() => groupRowsByReservation(rows), [rows]);
  if (!grouped.length) {
    return (
      <div className="ca-empty" data-testid="ca-empty">
        {lane === 'damage'
          ? t('checkinAudit.damageLaneEmpty', 'Photo AI is not enabled — this lane fills when the photo tier (T2) ships. Rules findings live in Entry errors and Mileage / fuel.')
          : t('checkinAudit.laneEmpty', 'Nothing in this lane.')}
      </div>
    );
  }
  return (
    <div className="ca-tbl-scroll">
      <table className="ca-tbl" data-testid="ca-table">
        <thead>
          <tr>
            <th>{t('checkinAudit.cols.reservation', 'Reservation')}</th>
            <th>{t('checkinAudit.cols.returned', 'Returned')}</th>
            <th>{t('checkinAudit.cols.rules', 'Rules audit · T1')}</th>
            <th>{t('checkinAudit.cols.photoAi', 'Photo AI · T2')}</th>
            <th>{t('checkinAudit.cols.closedBy', 'Checked in by')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {grouped.map((g) => (
            <tr key={g.reservationId}>
              <td>
                <span className="ca-res">{g.reservationNumber}</span>
                {g.vehicleLabel ? <span className="ca-veh">{g.vehicleLabel}</span> : null}
              </td>
              <td><time>{fmtDateTime(g.returnedAt, lang)}</time></td>
              <td>
                <span className="ca-chips">
                  {g.findings.map((f) => <Chip key={f.id} finding={f} />)}
                </span>
              </td>
              <td>
                <span className="chip chip--neutral" data-testid="t2-placeholder">
                  <span className="led" />
                  {t('checkinAudit.photoAiOff', 'Photo AI not enabled')}
                </span>
              </td>
              <td>{g.closedByName || '—'}</td>
              <td>
                <button type="button" className="ca-open" onClick={() => onOpen(g.reservationId)}>
                  {t('checkinAudit.review', 'Review')} →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Mock 2's right-column audit cards — exported for component tests. */
export function AuditDetailCards({ detail }) {
  const { t } = useTranslation();
  const findings = detail?.findings || [];
  const mf = mileageFuelAuditRows(findings);
  const entry = entryAuditRows(findings);
  const odo = mf.find((r) => r.id === 'odometer');
  const fuel = mf.find((r) => r.id === 'fuel');
  const entriesRow = entry.find((r) => r.id === 'entries');
  const missing = entriesRow?.finding?.details?.missingAngles || [];
  return (
    <div className="ca-cards">
      <section className="ca-card" data-testid="card-mileage-fuel">
        <header>
          <h4>{t('checkinAudit.cards.mileageFuel', 'Mileage & fuel audit')}</h4>
          <span className="ca-tier">T1 · {t('checkinAudit.rules', 'Rules')}</span>
          <span className={`chip chip--${odo.ok && fuel.ok ? 'ok' : 'warn'}`}>
            <span className="led" />
            {odo.ok && fuel.ok ? t('checkinAudit.pass', 'Pass') : t('checkinAudit.flagged', 'Flagged')}
          </span>
        </header>
        <div className={`ca-arow${odo.ok ? '' : ' is-warn'}`} data-testid="arow-odometer">
          <span className="lab">{t('checkinAudit.rows.odometer', 'Odometer')}</span>
          <span className="val tnum">{odo.out != null ? Number(odo.out).toLocaleString() : '—'}</span>
          <span className="arrow">→</span>
          <span className="val tnum">{odo.in != null ? Number(odo.in).toLocaleString() : '—'}</span>
          <span className="delta tnum">
            {odo.milesPerDay != null
              ? t('checkinAudit.rows.perDay', { n: odo.milesPerDay, defaultValue: `${odo.milesPerDay}/day` })
              : null}
            {odo.ok ? ' ✓' : null}
          </span>
        </div>
        <div className={`ca-arow${fuel.ok ? '' : ' is-warn'}`} data-testid="arow-fuel">
          <span className="lab">{t('checkinAudit.rows.fuel', 'Fuel')}</span>
          <span className="val tnum">{fuel.out != null ? `${Math.round(fuel.out * 100)}%` : '—'}</span>
          <span className="arrow">→</span>
          <span className="val tnum">{fuel.in != null ? `${Math.round(fuel.in * 100)}%` : '—'}</span>
          <span className="delta">
            {fuel.refillCharged === true ? t('checkinAudit.rows.refillBilled', 'refill fee billed ✓') : null}
            {fuel.refillCharged === false ? t('checkinAudit.rows.refillMissing', 'no refill fee billed') : null}
          </span>
        </div>
      </section>

      <section className="ca-card" data-testid="card-entry-checks">
        <header>
          <h4>{t('checkinAudit.cards.entries', 'Agent entry checks')}</h4>
          <span className="ca-tier">T1 · {t('checkinAudit.rules', 'Rules')}</span>
          <span className={`chip chip--${entry.every((r) => r.ok) ? 'ok' : 'warn'}`}>
            <span className="led" />
            {`${entry.filter((r) => r.ok).length} / ${entry.length}`}
          </span>
        </header>
        <div className={`ca-arow${entry[0].ok ? '' : ' is-warn'}`} data-testid="arow-impossible">
          <span className="lab">{t('checkinAudit.rows.impossible', 'Impossible')}</span>
          <span className="val">{t('checkinAudit.rows.impossibleRule', 'Odometer in ≥ out')}</span>
          <span className="delta">{entry[0].ok ? '✓' : t('checkinAudit.rows.impossibleFail', 'in < out — one entry is wrong')}</span>
        </div>
        <div className={`ca-arow${entriesRow.ok ? '' : ' is-warn'}`} data-testid="arow-entries">
          <span className="lab">{t('checkinAudit.rows.entries', 'Entries')}</span>
          <span className="val">
            {entriesRow.ok
              ? t('checkinAudit.rows.entriesComplete', 'Complete')
              : t('checkinAudit.rows.entriesMissing', { n: missing.length, defaultValue: `${missing.length} angle photos missing` })}
          </span>
          <span className="delta">
            {entriesRow.finding?.details?.hasSignature === false
              ? t('checkinAudit.rows.noSignature', 'no signature')
              : (entriesRow.ok ? '✓' : null)}
          </span>
        </div>
        <div className={`ca-arow${entry[2].ok ? '' : ' is-warn'}`} data-testid="arow-backdated">
          <span className="lab">{t('checkinAudit.rows.backdated', 'Return time')}</span>
          <span className="val">
            {entry[2].ok
              ? t('checkinAudit.rows.backdatedOk', 'Matches photo timestamps')
              : t('checkinAudit.rows.backdatedGap', { n: entry[2].finding?.details?.gapHours, defaultValue: `${entry[2].finding?.details?.gapHours}h from photo timestamps` })}
          </span>
          <span className="delta">{entry[2].ok ? '✓' : null}</span>
        </div>
      </section>

      <section className="ca-card ca-card--t2" data-testid="t2-photo-pane">
        <header>
          <h4>{t('checkinAudit.cards.photoPair', 'Photo comparison')}</h4>
          <span className="ca-tier ca-tier--t2">T2 · {t('checkinAudit.photoAi', 'Photo AI')}</span>
        </header>
        <p className="ca-t2-note">
          {t('checkinAudit.t2Placeholder', 'Photo AI is not enabled. When the photo tier ships (opt-in per tenant, tenant key), checkout and check-in photos of each angle are compared here and possible new damage lands in the queue — a person always confirms; nothing is ever charged automatically.')}
        </p>
      </section>
    </div>
  );
}

/** The dismiss fork (damage-baseline Mock 2) — exported for component tests. */
export function DismissDialog({ finding, onCancel, onDismiss }) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState('NOT_ISSUE');
  const preexistingAllowed = canDismissPreexisting(finding);
  return (
    <div className="modal-backdrop" role="dialog" aria-label={t('checkinAudit.dismiss.title', 'Dismiss this flag')} onClick={onCancel}>
      <div className="rent-modal glass ca-dismiss" data-testid="dismiss-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t('checkinAudit.dismiss.title', 'Dismiss this flag')}</h3>
        <p className="ca-dismiss-q">{t('checkinAudit.dismiss.q', 'What is it?')}</p>

        <label className={`ca-opt${choice === 'NOT_ISSUE' ? ' is-sel' : ''}`}>
          <input
            type="radio"
            name="dismiss-choice"
            checked={choice === 'NOT_ISSUE'}
            onChange={() => setChoice('NOT_ISSUE')}
          />
          <span>
            <b>{t('checkinAudit.dismiss.notIssue', 'Not an issue')}</b>
            <small>{t('checkinAudit.dismiss.notIssueSub', 'The check misread the situation. Logged as reviewed — nothing else happens.')}</small>
          </span>
        </label>

        <label className={`ca-opt${!preexistingAllowed ? ' is-off' : ''}${choice === 'PREEXISTING' ? ' is-sel' : ''}`}>
          <input
            type="radio"
            name="dismiss-choice"
            disabled={!preexistingAllowed}
            checked={choice === 'PREEXISTING'}
            onChange={() => setChoice('PREEXISTING')}
          />
          <span>
            <b>{t('checkinAudit.dismiss.preexisting', 'Real damage — but pre-existing')}</b>
            <small>
              {preexistingAllowed
                ? t('checkinAudit.dismiss.preexistingSub', "Adds it to this vehicle's damage baseline so it is never flagged again — and never charged to a customer.")
                : t('checkinAudit.dismiss.preexistingT2', 'Applies to photo-AI damage findings — awaits the photo tier (T2). Rules findings are numbers, not marks.')}
            </small>
          </span>
        </label>

        <div className="ca-dismiss-actions">
          <button type="button" className="button-primary" onClick={() => onDismiss(choice)} data-testid="dismiss-confirm">
            {t('checkinAudit.dismiss.confirm', 'Dismiss')}
          </button>
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckinAuditInner({ me, logout }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const [lane, setLane] = useState('entry');
  const [data, setData] = useState({ rows: [], counts: {}, kpis: {} });
  const [detail, setDetail] = useState(null);
  const [dismissing, setDismissing] = useState(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (l = lane) => {
    setLoading(true);
    setMsg('');
    try {
      const out = await api(`/api/checkin-audit?lane=${encodeURIComponent(LANE_QUERY[l] || 'entry')}`, { bypassCache: true });
      setData({ rows: out?.rows || [], counts: out?.counts || {}, kpis: out?.kpis || {} });
    } catch (e) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  };

  const openDetail = async (reservationId) => {
    try {
      setDetail(await api(`/api/checkin-audit/${reservationId}`, { bypassCache: true }));
    } catch (e) {
      setMsg(e.message);
    }
  };

  useEffect(() => { load(lane); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lane]);

  // Deep link from the notification center: /checkin-audit?reservationId=...
  // window.location instead of useSearchParams so the page needs no Suspense
  // boundary (the settings-page idiom). Mount-only on purpose.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const rid = new URLSearchParams(window.location.search).get('reservationId');
      if (rid) openDetail(rid);
    } catch { /* malformed query string — stay on the queue */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doDismiss = async (classification) => {
    const f = dismissing;
    setDismissing(null);
    if (!f) return;
    try {
      await api(`/api/checkin-audit/findings/${f.id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ classification }),
      });
      setMsg(t('checkinAudit.dismissed', 'Flag dismissed'));
      if (detail) await openDetail(detail.reservationId);
      await load(lane);
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <div className="nc-head">
        <div className="nc-title-row">
          <h2>{t('checkinAudit.title', 'Check-in Audit')}</h2>
          <span className="nc-sub">{t('checkinAudit.sub', 'Post-return review — rules audit on every close')}</span>
          <span className="chip chip--ok" style={{ marginLeft: 'auto' }}>
            <span className="led" />{t('checkinAudit.rulesOn', 'Rules audit · on')}
          </span>
          <span className="chip chip--neutral">
            <span className="led" />{t('checkinAudit.photoAiOff', 'Photo AI not enabled')}
          </span>
        </div>
      </div>

      {msg ? <div className="label">{msg}</div> : null}

      <KpiStrip kpis={data.kpis} />

      <div className="tq-body">
        <aside className="tq-rail" aria-label={t('checkinAudit.title', 'Check-in Audit')}>
          {CHECKIN_AUDIT_LANE_GROUPS.map((group) => (
            <Fragment key={group.id}>
              <div className={`tq-grp g-${group.tone}`}><i />{t(`checkinAudit.lanes.${group.id}`, group.id)}</div>
              {group.lanes.map((l) => {
                const n = Number(data.counts?.[l.count]) || 0;
                return (
                  <button
                    key={l.id}
                    type="button"
                    className={`tq-lane${lane === l.id ? ' is-on' : ''}`}
                    onClick={() => { setDetail(null); setLane(l.id); }}
                  >
                    {t(`checkinAudit.lanes.${l.id}`, l.id)}
                    <span className={`n${group.tone === 'warn' && n > 0 ? ' warm' : ''}`}>{n}</span>
                  </button>
                );
              })}
            </Fragment>
          ))}
          <div className="tq-rail-note">
            {t('checkinAudit.railNote', 'A check-in is never held by the audit. Flags appear here after the close.')}
          </div>
        </aside>

        <div className="ca-main">
          {detail ? (
            <div className="ca-detail" data-testid="ca-detail">
              <div className="ca-detail-head">
                <button type="button" className="btn-ghost" onClick={() => setDetail(null)}>
                  ← {t('checkinAudit.back', 'Back to queue')}
                </button>
                <h3>
                  {detail.reservationNumber || detail.reservationId}
                  {detail.vehicleLabel ? <span className="ca-veh-inline"> · {detail.vehicleLabel}</span> : null}
                </h3>
                <span className="ca-meta">
                  {detail.returnedAt ? `${t('checkinAudit.cols.returned', 'Returned')} ${fmtDateTime(detail.returnedAt, lang)}` : null}
                  {detail.closedByName ? ` · ${detail.closedByName}` : null}
                </span>
              </div>
              <div className="ca-detail-chips">
                {(detail.findings || []).map((f) => (
                  <span key={f.id} className="ca-detail-chip-row">
                    <Chip finding={f} />
                    {f.status === 'OPEN' ? (
                      <button type="button" className="ca-open" onClick={() => setDismissing(f)} data-testid={`dismiss-${f.checkKey}`}>
                        {t('checkinAudit.dismissAction', 'Dismiss…')}
                      </button>
                    ) : null}
                    {f.status === 'DISMISSED_NOT_ISSUE' ? (
                      <small className="ca-meta">
                        {t('checkinAudit.dismissedBy', { name: f.dismissedByName || '—', defaultValue: `Dismissed · ${f.dismissedByName || '—'}` })}
                      </small>
                    ) : null}
                  </span>
                ))}
              </div>
              <AuditDetailCards detail={detail} />
            </div>
          ) : (
            <AuditQueueTable rows={data.rows} lane={lane} onOpen={openDetail} />
          )}
          {loading ? <div className="surface-note">{t('common.loading', 'Loading…')}</div> : null}
        </div>
      </div>

      {dismissing ? (
        <DismissDialog
          finding={dismissing}
          onCancel={() => setDismissing(null)}
          onDismiss={doDismiss}
        />
      ) : null}
    </AppShell>
  );
}

export default function CheckinAuditPage() {
  return (
    <AuthGate>
      {({ me, logout }) => <CheckinAuditInner me={me} logout={logout} />}
    </AuthGate>
  );
}
