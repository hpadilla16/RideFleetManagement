'use client';

// Check-in Audit — the review queue (T1 rules 2026-09-03; T2 photo AI
// 2026-09-02). Source of truth: design/mockups/checkin-audit-mockup.html
// (Mock 1 queue, Mock 2 pair viewer + verdict card) + checkin-audit-NOTES.md
// + damage-baseline-NOTES.md (the dismiss fork).
// - Lanes are saved filters over one findings table (tolls/notifications rail
//   pattern). Everything AI-shaped keys off the API's photoAiEnabled flag: a
//   T1-only tenant keeps the honest empty Possible-damage lane, the
//   placeholder Photo AI column, and NO AI-spend KPI tile.
// - With photo AI on, the Possible-damage lane fills from the T2 sweep, the
//   Photo AI column shows each close's verdict, the AI-spend tile appears,
//   and the detail's photo pane becomes the Mock-2 checkout↔check-in pair
//   viewer with the AI verdict card (suggestion-only — the disclaimer lives
//   inside the card).
// - Dismissing offers the two verbs from the damage-baseline design: "Not an
//   issue" (any finding) and "Real but pre-existing" (DAMAGE findings only —
//   T2's suspected-damage flags enable it; the backend derives the ledger
//   entry from the finding's own evidence).
// A check-in is never held by the audit — flags appear here after the close.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import {
  CHECKIN_AUDIT_LANE_GROUPS,
  LANE_QUERY,
  checkinAuditKpis,
  findingChip,
  photoAiCell,
  groupRowsByReservation,
  mileageFuelAuditRows,
  entryAuditRows,
  canDismissPreexisting,
  DAMAGE_SUSPECTED_PREFIX,
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

/** KPI strip — exported for component tests. The AI-spend tile renders ONLY
 *  when the tenant's photo AI is enabled (Mock 1's cost-transparency tile;
 *  at a permanent $0.00 on a T1-only tenant it would be a lie). */
export function KpiStrip({ kpis, photoAiEnabled = false }) {
  const { t } = useTranslation();
  return (
    <div className="ca-kpis" data-testid="ca-kpis">
      {checkinAuditKpis(photoAiEnabled).map((k) => (
        <div key={k.id} className={`ca-kpi${k.tone === 'flag' ? ' ca-kpi--flag' : ''}${k.tone === 'money' ? ' ca-kpi--money' : ''}`} data-testid={`kpi-${k.id}`}>
          <div className="ca-kpi-lab">{t(`checkinAudit.kpis.${k.id}`, k.id)}</div>
          {k.tone === 'money' ? (
            <div className="ca-kpi-val tnum">
              ${(Number(kpis?.aiSpendTodayUsd) || 0).toFixed(2)}
              <em className="ca-kpi-sub">
                {t('checkinAudit.kpis.aiSpendSub', {
                  n: Number(kpis?.aiAnalyzedToday) || 0,
                  s: Number(kpis?.aiSkippedBudgetToday) || 0,
                  defaultValue: `${Number(kpis?.aiAnalyzedToday) || 0} analyzed · ${Number(kpis?.aiSkippedBudgetToday) || 0} over budget`,
                })}
              </em>
            </div>
          ) : (
            <div className="ca-kpi-val tnum">{Number(kpis?.[k.key]) || 0}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Queue table (Mock 1) — one row per reservation, T1 chips per finding,
 *  Photo AI column from the API's per-reservation T2 summary. */
export function AuditQueueTable({ rows, lane, onOpen, t2 = {}, photoAiEnabled = false }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const grouped = useMemo(() => groupRowsByReservation(rows), [rows]);
  if (!grouped.length) {
    return (
      <div className="ca-empty" data-testid="ca-empty">
        {lane === 'damage'
          ? (photoAiEnabled
            ? t('checkinAudit.damageLaneClear', 'No possible-damage flags right now — the photo sweep runs a few minutes after each close.')
            : t('checkinAudit.damageLaneEmpty', 'Photo AI is not enabled — this lane fills when the photo tier (T2) ships. Rules findings live in Entry errors and Mileage / fuel.'))
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
                {(() => {
                  const c = photoAiCell(t2?.[g.reservationId], photoAiEnabled);
                  return (
                    <span className={`chip chip--${c.tone}`} data-testid={photoAiEnabled ? `t2-cell-${c.key}` : 't2-placeholder'}>
                      <span className="led" />
                      {t(c.labelKey, { ...c.params, defaultValue: c.defaultLabel })}
                    </span>
                  );
                })()}
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

      {(detail?.photoAiEnabled || detail?.t2Scan || (detail?.findings || []).some((f) => String(f.checkKey || '').startsWith(DAMAGE_SUSPECTED_PREFIX)))
        ? <PhotoPairPane detail={detail} />
        : (
          <section className="ca-card ca-card--t2" data-testid="t2-photo-pane">
            <header>
              <h4>{t('checkinAudit.cards.photoPair', 'Photo comparison')}</h4>
              <span className="ca-tier ca-tier--t2">T2 · {t('checkinAudit.photoAi', 'Photo AI')}</span>
            </header>
            <p className="ca-t2-note">
              {t('checkinAudit.t2Placeholder', 'Photo AI is not enabled. When the photo tier ships (opt-in per tenant, tenant key), checkout and check-in photos of each angle are compared here and possible new damage lands in the queue — a person always confirms; nothing is ever charged automatically.')}
            </p>
          </section>
        )}
    </div>
  );
}

const ANGLE_ORDER = ['front', 'rear', 'left', 'right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk'];

/** Mock 2's checkout↔check-in pair viewer + AI verdict card — exported for
 *  component tests. Angle strip (warm dot on flagged angles, check on clean
 *  ones), the two photos with the suspected-region overlay, and the
 *  suggestion-only verdict card with its disclaimer inside. */
export function PhotoPairPane({ detail }) {
  const { t } = useTranslation();
  const pairs = detail?.photoPairs || {};
  const suspects = useMemo(() => {
    const map = {};
    for (const f of detail?.findings || []) {
      if (String(f.checkKey || '').startsWith(DAMAGE_SUSPECTED_PREFIX)) {
        map[f.details?.angle || f.checkKey.slice(DAMAGE_SUSPECTED_PREFIX.length)] = f;
      }
    }
    return map;
  }, [detail]);
  const angles = useMemo(() => {
    const present = new Set([...Object.keys(pairs), ...Object.keys(suspects)]);
    return ANGLE_ORDER.filter((a) => present.has(a));
  }, [pairs, suspects]);
  const [angle, setAngle] = useState(() => angles.find((a) => suspects[a]) || angles[0] || null);
  const active = angle && angles.includes(angle) ? angle : (angles.find((a) => suspects[a]) || angles[0] || null);
  const pair = active ? pairs[active] : null;
  const suspect = active ? suspects[active] : null;
  const region = suspect?.details?.region || null;
  const scan = detail?.t2Scan || null;

  return (
    <section className="ca-card ca-card--t2 ca-card--pair" data-testid="t2-pair-viewer">
      <header>
        <h4>{t('checkinAudit.cards.photoPair', 'Photo comparison')}</h4>
        <span className="ca-tier ca-tier--t2">T2 · {t('checkinAudit.photoAi', 'Photo AI')}</span>
        {scan?.resolution === 'ANALYZED' ? (
          <span className="chip chip--ok"><span className="led" />{t('checkinAudit.t2Analyzed', 'Analyzed')}</span>
        ) : null}
      </header>

      {!angles.length ? (
        <p className="ca-t2-note" data-testid="t2-pane-note">
          {scan?.resolution === 'SKIPPED_BUDGET'
            ? t('checkinAudit.t2SkippedBudget', 'Skipped — the daily photo-AI budget was reached before this close.')
            : scan?.resolution === 'SKIPPED_NO_PHOTOS'
              ? t('checkinAudit.t2SkippedNoPhotos', 'Skipped — no angle has a photo on both the checkout and check-in side.')
              : scan?.resolution === 'FAILED'
                ? t('checkinAudit.t2Failed', 'The photo analysis failed — the check-in itself is unaffected.')
                : t('checkinAudit.t2Pending', 'Queued for the photo sweep — it runs a few minutes after each close.')}
        </p>
      ) : (
        <div className="ca-pair-body">
          <div className="ca-angle-strip" role="tablist" aria-label={t('checkinAudit.pair.angles', 'Inspection angles')}>
            {angles.map((a) => (
              <button
                key={a}
                type="button"
                role="tab"
                aria-selected={a === active}
                className={`ca-angle${a === active ? ' is-on' : ''}${suspects[a] ? ' is-flagged' : ''}`}
                data-testid={`angle-${a}`}
                onClick={() => setAngle(a)}
              >
                <span className={suspects[a] ? 'dot' : 'tick'}>{suspects[a] ? '' : '✓'}</span>
                {t(`checkinAudit.angles.${a}`, a)}
              </button>
            ))}
          </div>

          <div className="ca-pair" data-testid={`pair-${active}`}>
            <figure className="ca-shot">
              <figcaption>
                <span className="ca-tag ca-tag--out">{t('checkinAudit.pair.checkout', 'Checkout')}</span>
                {t('checkinAudit.pair.baseline', 'baseline')}
              </figcaption>
              {pair?.checkout
                ? <img src={pair.checkout} alt={t('checkinAudit.pair.checkoutAlt', { angle: active, defaultValue: `Checkout photo · ${active}` })} />
                : <div className="ca-shot-missing">{t('checkinAudit.pair.missing', 'No photo for this angle')}</div>}
            </figure>
            <figure className="ca-shot">
              <figcaption>
                <span className="ca-tag ca-tag--in">{t('checkinAudit.pair.checkin', 'Check-in')}</span>
                {t('checkinAudit.pair.returned', 'returned')}
              </figcaption>
              {pair?.checkin ? (
                <div className="ca-shot-img">
                  <img src={pair.checkin} alt={t('checkinAudit.pair.checkinAlt', { angle: active, defaultValue: `Check-in photo · ${active}` })} />
                  {region ? (
                    <span
                      className="ca-region"
                      data-testid="suspect-region"
                      style={{
                        left: `${Math.round((region.x || 0) * 1000) / 10}%`,
                        top: `${Math.round((region.y || 0) * 1000) / 10}%`,
                        width: `${Math.round((region.w || 0) * 1000) / 10}%`,
                        height: `${Math.round((region.h || 0) * 1000) / 10}%`,
                      }}
                    >
                      <span className="ca-region-label">
                        {t('checkinAudit.pair.suspected', 'Suspected')}{suspect?.details?.kind ? ` · ${suspect.details.kind}` : ''}
                      </span>
                    </span>
                  ) : null}
                </div>
              ) : <div className="ca-shot-missing">{t('checkinAudit.pair.missing', 'No photo for this angle')}</div>}
            </figure>
          </div>

          {suspect ? (
            <div className="ca-verdict" data-testid="ai-verdict-card">
              <div className="ca-verdict-top">
                <span className="ca-tier ca-tier--t2">{t('checkinAudit.verdict.source', 'AI vision · T2')}</span>
                <span className={`chip chip--${suspect.severity === 'ERROR' ? 'danger' : 'warn'}`}>
                  <span className="led" />{t('checkinAudit.verdict.title', 'Possible new damage')}
                </span>
                <span className="ca-conf-bar" title={`${suspect.details?.confidence ?? '—'}%`}>
                  <i style={{ width: `${Number(suspect.details?.confidence) || 0}%` }} />
                </span>
                <span className="ca-conf tnum">{suspect.details?.confidence ?? '—'}%</span>
              </div>
              {suspect.details?.description ? <p className="ca-verdict-desc">“{suspect.details.description}”</p> : null}
              {(suspect.details?.knownDamageMatched || []).length ? (
                <p className="ca-verdict-known" data-testid="known-damage-note">
                  {t('checkinAudit.verdict.knownMatched', 'The model also matched documented baseline damage in this view — shown for context, never hidden.')}
                </p>
              ) : null}
              <p className="ca-verdict-foot">
                {t('checkinAudit.verdict.disclaimer', 'AI suggestion — a staff member confirms. The highlighted box is a pointer, not a measurement, and nothing is ever charged automatically.')}
              </p>
            </div>
          ) : (
            <p className="ca-t2-note" data-testid="t2-angle-clean">
              {t('checkinAudit.pair.clean', 'No new marks suspected on this angle.')}
            </p>
          )}
        </div>
      )}
    </section>
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
  const [data, setData] = useState({ rows: [], counts: {}, kpis: {}, t2: {}, photoAiEnabled: false });
  const [detail, setDetail] = useState(null);
  const [dismissing, setDismissing] = useState(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (l = lane) => {
    setLoading(true);
    setMsg('');
    try {
      const out = await api(`/api/checkin-audit?lane=${encodeURIComponent(LANE_QUERY[l] || 'entry')}`, { bypassCache: true });
      setData({
        rows: out?.rows || [],
        counts: out?.counts || {},
        kpis: out?.kpis || {},
        t2: out?.t2 || {},
        photoAiEnabled: out?.photoAiEnabled === true,
      });
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
          {data.photoAiEnabled ? (
            <span className="chip chip--ok" data-testid="photo-ai-on">
              <span className="led" />{t('checkinAudit.photoAiOn', 'Photo AI · tenant key')}
            </span>
          ) : (
            <span className="chip chip--neutral">
              <span className="led" />{t('checkinAudit.photoAiOff', 'Photo AI not enabled')}
            </span>
          )}
        </div>
      </div>

      {msg ? <div className="label">{msg}</div> : null}

      <KpiStrip kpis={data.kpis} photoAiEnabled={data.photoAiEnabled} />

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
            <AuditQueueTable rows={data.rows} lane={lane} onOpen={openDetail} t2={data.t2} photoAiEnabled={data.photoAiEnabled} />
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
