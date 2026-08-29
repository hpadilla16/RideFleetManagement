'use client';

// Tolls — "Confidence triage lanes" (redesign A, approved 2026-08-28).
// Source of truth: design/mockups/tolls-redesign-A.html +
// design/mockups/tolls-redesign-NOTES.md. The six DB-counted queue views
// survive intact, regrouped under three confidence lanes; the raw matchReason
// token string is NEVER rendered (human chips instead — see lib/toll-triage);
// one primary action per row with Reset/Dispute/Waive in an overflow menu;
// provider/sync/import tooling lives on its own "Imports & sync" tab.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api, apiDownload } from '../../lib/client';
import {
  TOLL_QUEUE_VIEWS,
  TOLL_LANE_GROUPS,
  AUTO_CONFIRM_SCORE,
  laneForScore,
  confidenceForRow,
  inlineChipsForRow,
  rawReasonForRow,
  scoreLedgerForRow,
  filterByQueueView,
  isUsageOnly,
  isAutoMatched,
  isNeedsReview,
  isUnmatched,
  isReadyToPost,
  primaryActionForRow,
  overflowActionsForRow
} from '../../lib/toll-triage';

const EMPTY_IMPORT_FORM = {
  transactionAt: '',
  amount: '',
  location: '',
  lane: '',
  direction: '',
  plate: '',
  tag: '',
  sello: ''
};

const ISSUE_EDIT_ID_KEY = 'issues.editId';

export default function TollsPage() {
  return <AuthGate>{({ token, me, logout }) => <TollsInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function money(value) {
  return `$${Number(Number(value || 0).toFixed(2)).toFixed(2)}`;
}

function shortDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function importRunDiagnostics(run, t) {
  const autoSync = run?.metadata?.autoSync || {};
  const scrapedCount = Number(autoSync.scrapedCount || run?.metadata?.scrapedCount || 0);
  const duplicateExistingCount = Number(autoSync.duplicateExistingCount || run?.metadata?.duplicateExistingCount || 0);
  const dedupedInRunCount = Number(autoSync.dedupedInRunCount || run?.metadata?.dedupedInRunCount || 0);
  if (!scrapedCount && !duplicateExistingCount && !dedupedInRunCount) return '';
  return t('tolls.imports.runsDiag', 'Scraped {{scraped}} | Existing duplicates {{dup}} | Deduped in run {{deduped}}', {
    scraped: scrapedCount, dup: duplicateExistingCount, deduped: dedupedInRunCount
  });
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseBulkImportRows(text) {
  const rawLines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!rawLines.length) return [];

  const delimiter = rawLines[0].includes('\t') ? '\t' : ',';
  const splitLine = (line) => line.split(delimiter).map((part) => part.trim());
  const header = splitLine(rawLines[0]).map(normalizeHeader);
  const hasHeader = header.some((cell) => ['transactionat', 'datetime', 'date', 'timestamp', 'amount', 'plate', 'tag', 'sello', 'sticker'].includes(cell));
  const rows = (hasHeader ? rawLines.slice(1) : rawLines).map((line) => splitLine(line)).filter((parts) => parts.some(Boolean));
  const columnIndex = (aliases, fallback) => {
    const idx = header.findIndex((cell) => aliases.includes(cell));
    return idx >= 0 ? idx : fallback;
  };

  const dateIdx = columnIndex(['transactionat', 'datetime', 'date', 'timestamp'], 0);
  const amountIdx = columnIndex(['amount', 'tollamount', 'charge'], 1);
  const locationIdx = columnIndex(['location', 'plaza'], 2);
  const laneIdx = columnIndex(['lane', 'directionlane'], 3);
  const directionIdx = columnIndex(['direction'], 4);
  const plateIdx = columnIndex(['plate', 'licenseplate', 'tablilla'], 5);
  const tagIdx = columnIndex(['tag', 'tolltag', 'tagnumber'], 6);
  const selloIdx = columnIndex(['sello', 'sticker', 'tollsticker', 'stickernumber'], 7);

  return rows.map((parts) => ({
    transactionAt: parts[dateIdx] || '',
    amount: Number(parts[amountIdx] || 0),
    location: parts[locationIdx] || '',
    lane: parts[laneIdx] || '',
    direction: parts[directionIdx] || '',
    plate: parts[plateIdx] || '',
    tag: parts[tagIdx] || '',
    sello: parts[selloIdx] || ''
  })).filter((row) => row.transactionAt && Number.isFinite(row.amount) && row.amount > 0);
}

/* Per-action dialog copy (replaces window.prompt — NOTES finding #8). */
const ACTION_DIALOGS = {
  MARK_DISPUTED: { title: ['tolls.dialog.disputeTitle', 'Dispute toll'], body: ['tolls.dialog.disputeBody', 'Marks the toll disputed and opens an Issue Center case.'], note: ['tolls.dialog.disputeNote', 'Optional dispute note'], danger: false },
  MARK_NOT_BILLABLE: { title: ['tolls.dialog.waiveTitle', 'Waive toll — not billable'], body: ['tolls.dialog.waiveBody', 'The toll stays on record but will not be billed to anyone.'], note: ['tolls.dialog.waiveNote', 'Optional waiver note'], danger: true },
  RESET_MATCH: { title: ['tolls.dialog.resetTitle', 'Reset match'], body: ['tolls.dialog.resetBody', 'Clears the suggestion and returns the toll to the unmatched queue for the next sweep.'], note: ['tolls.dialog.resetNote', 'Optional reset note'], danger: false },
  CONFIRM_DISPATCHED: { title: ['tolls.dialog.dispatchTitle', 'Confirm dispatch'], body: ['tolls.dialog.dispatchBody', 'Confirms the vehicle was actually dispatched to this customer before formal checkout.'], note: ['tolls.dialog.dispatchNote', 'Optional dispatch confirmation note'], danger: false },
  MARK_NOT_DISPATCHED: { title: ['tolls.dialog.notDispatchedTitle', 'Not dispatched'], body: ['tolls.dialog.notDispatchedBody', 'Removes the pre-checkout suggestion — the vehicle was not with this customer.'], note: ['tolls.dialog.notDispatchedNote', 'Optional note for why this vehicle was not dispatched'], danger: true }
};

/** Themed note dialog — the app's modal-backdrop pattern, not window.prompt. */
function TollNoteDialog({ dialog, busy, onCancel, onApply }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const cfg = ACTION_DIALOGS[dialog.action] || {};
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="tq-dialog" role="dialog" aria-modal="true">
        <h3>{t(...(cfg.title || ['tolls.dialog.apply', 'Apply']))}</h3>
        <p>{cfg.body ? t(...cfg.body) : null}</p>
        <label className="label">{cfg.note ? t(...cfg.note) : t('tolls.dialog.noteLabel', 'Note (optional)')}</label>
        <textarea rows={3} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
        <div className="row">
          <button type="button" className="button-subtle" onClick={onCancel} disabled={busy}>{t('tolls.dialog.cancel', 'Cancel')}</button>
          <button type="button" className={cfg.danger ? 'button-subtle' : ''} style={cfg.danger ? { color: 'var(--danger-tx)', borderColor: 'var(--danger-bd)' } : undefined} onClick={() => onApply(note)} disabled={busy}>
            {busy ? t('tolls.dialog.working', 'Working…') : t('tolls.dialog.apply', 'Apply')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Themed bulk-confirm dialog (replaces window.confirm — NOTES finding #8). */
function TollBulkConfirmDialog({ rows, busy, onCancel, onConfirm }) {
  const { t } = useTranslation();
  const shown = rows.slice(0, 5);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="tq-dialog" role="dialog" aria-modal="true">
        <h3>{t('tolls.dialog.bulkTitle', 'Confirm {{count}} tolls now?', { count: rows.length })}</h3>
        <p>{t('tolls.dialog.bulkBody', 'This will assign each toll to its suggested reservation (or confirm dispatch where required) and post charges.')}</p>
        <ul>
          {shown.map((row) => (
            <li key={row.id}>
              #{row.latestAssignment?.reservation?.reservationNumber || row.reservation?.reservationNumber || row.id}
              {' · '}{money(row.amount)}
            </li>
          ))}
          {rows.length > shown.length ? <li>{t('tolls.dialog.bulkMore', '+{{count}} more', { count: rows.length - shown.length })}</li> : null}
        </ul>
        <div className="row">
          <button type="button" className="button-subtle" onClick={onCancel} disabled={busy}>{t('tolls.dialog.cancel', 'Cancel')}</button>
          <button type="button" onClick={onConfirm} disabled={busy}>
            {busy ? t('tolls.toolbar.confirming', 'Confirming…') : t('tolls.dialog.bulkConfirm', 'Confirm all')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Themed waive-selected dialog: one note applied to every selected toll. */
function TollWaiveSelectedDialog({ rows, busy, onCancel, onApply }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="tq-dialog" role="dialog" aria-modal="true">
        <h3>{t('tolls.dialog.waiveSelectedTitle', 'Waive {{count}} selected tolls — not billable', { count: rows.length })}</h3>
        <p>{t('tolls.dialog.waiveSelectedBody', 'Each selected toll will be marked not billable with your note.')} ({money(total)})</p>
        <label className="label">{t('tolls.dialog.waiveNote', 'Optional waiver note')}</label>
        <textarea rows={3} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
        <div className="row">
          <button type="button" className="button-subtle" onClick={onCancel} disabled={busy}>{t('tolls.dialog.cancel', 'Cancel')}</button>
          <button type="button" className="button-subtle" style={{ color: 'var(--danger-tx)', borderColor: 'var(--danger-bd)' }} onClick={() => onApply(note)} disabled={busy}>
            {busy ? t('tolls.dialog.working', 'Working…') : t('tolls.foot.waiveSelected', 'Waive selected')}
          </button>
        </div>
      </div>
    </div>
  );
}

const TONE_CLASS = { ok: 'w-ok', warn: 'w-warn', bad: 'w-bad', info: 'w-info' };

function ConfidenceCell({ row, t, onMore, overflow }) {
  const score = confidenceForRow(row);
  const lane = laneForScore(score);
  const { chips } = inlineChipsForRow(row);
  const laneClass = lane === 'high' ? '' : lane === 'mid' ? ' mid' : lane === 'low' ? ' low' : ' none';
  return (
    <>
      {/* the raw token string survives ONLY as a hover title for support calls */}
      <span className={`tq-conf${laneClass}`} title={rawReasonForRow(row)}>
        {score == null ? (
          <b>{t('tolls.row.noMatch', 'no match')}</b>
        ) : (
          <>
            <span className="bar"><i style={{ width: `${Math.max(0, Math.min(100, Number(score)))}%` }} /></span>
            <b>{Number(score)}</b>
          </>
        )}
      </span>
      <div className="tq-why">
        {chips.map((chip) => (
          <span key={chip.token} className={TONE_CLASS[chip.tone] || ''}>{t(chip.key)}</span>
        ))}
        {overflow > 0 ? (
          <button type="button" className="more" onClick={onMore}>{t('tolls.row.moreChips', '+{{count}} more', { count: overflow })}</button>
        ) : null}
      </div>
    </>
  );
}

function EvidenceDrawer({ row, t }) {
  const score = confidenceForRow(row);
  const ledger = scoreLedgerForRow(row);
  const reservation = row.latestAssignment?.reservation || row.reservation || null;
  const pickupAt = reservation?.pickupAt ? new Date(reservation.pickupAt) : null;
  const returnAt = reservation?.returnAt ? new Date(reservation.returnAt) : null;
  const tollAt = row.transactionAt ? new Date(row.transactionAt) : null;
  let tickPct = null;
  let winStyle = null;
  if (pickupAt && returnAt && tollAt && returnAt > pickupAt) {
    // Plot the rental window on a track padded 12% each side so a toll just
    // outside the window still lands on the drawing.
    const span = returnAt.getTime() - pickupAt.getTime();
    const t0 = pickupAt.getTime() - span * 0.12;
    const t1 = returnAt.getTime() + span * 0.12;
    const pct = (ms) => Math.max(0, Math.min(100, ((ms - t0) / (t1 - t0)) * 100));
    winStyle = { left: `${pct(pickupAt.getTime())}%`, right: `${100 - pct(returnAt.getTime())}%` };
    tickPct = pct(tollAt.getTime());
  }
  const idRows = [
    { label: t('tolls.evidence.plate', 'Plate'), toll: row.plateRaw, vehicle: row.vehicle?.plate },
    { label: t('tolls.evidence.tag', 'Tag'), toll: row.tagRaw, vehicle: row.vehicle?.tollTagNumber },
    { label: t('tolls.evidence.sello', 'Sello'), toll: row.selloRaw, vehicle: row.vehicle?.tollStickerNumber }
  ];
  const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (
    <tr className="evidence">
      <td colSpan={7}>
        <div className="tq-evi">
          <div>
            <h5>{t('tolls.evidence.ledger', 'Score ledger — why {{score}}', { score: score == null ? '—' : score })}</h5>
            {ledger.length ? (
              <table className="tq-ledger">
                <tbody>
                  {ledger.map((entry) => (
                    <tr key={entry.token}>
                      <td>{t(entry.key)}</td>
                      <td className={`pts${entry.negative ? ' neg' : ''}`}>{entry.pts}</td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>
                      {score != null && Number(score) < AUTO_CONFIRM_SCORE
                        ? t('tolls.evidence.belowAuto', 'Suggested — below auto-confirm ({{threshold}})', { threshold: AUTO_CONFIRM_SCORE })
                        : t('tolls.evidence.atAuto', 'At or above auto-confirm ({{threshold}})', { threshold: AUTO_CONFIRM_SCORE })}
                    </td>
                    <td className="pts">{score == null ? '—' : Number(score)}</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('tolls.evidence.noLedger', 'The matcher recorded no scoring tokens for this toll.')}</p>
            )}
          </div>
          <div>
            <h5>{t('tolls.evidence.identifiers', 'Identifiers · toll vs vehicle')}</h5>
            <div className="tq-idgrid">
              {idRows.map((idRow) => {
                const hit = idRow.toll && idRow.vehicle && norm(idRow.toll) === norm(idRow.vehicle);
                return (
                  <span key={idRow.label} style={{ display: 'contents' }}>
                    <span className="h">{idRow.label}</span>
                    <span className={`v ${idRow.toll ? (hit ? 'hit' : '') : 'miss'}`}>{idRow.toll || '—'}</span>
                    <span className={`v ${hit ? 'hit' : idRow.vehicle ? '' : 'miss'}`}>{idRow.vehicle ? `${idRow.vehicle}${hit ? ' ✓' : ''}` : '—'}</span>
                  </span>
                );
              })}
            </div>
            <div className="tq-evi-raw">{t('tolls.evidence.raw', 'Matcher tokens (support)')}: {rawReasonForRow(row) || '—'}</div>
          </div>
          <div>
            <h5>{t('tolls.evidence.window', 'Toll vs rental window')}</h5>
            {winStyle ? (
              <div className="tq-tline">
                <div className="track">
                  <span className="win" style={winStyle} />
                  {tickPct != null ? <span className="tick" style={{ left: `${tickPct}%` }} /> : null}
                </div>
                <div className="lbls">
                  <span>{t('tolls.evidence.pickup', 'Pickup')} {shortDateTime(reservation.pickupAt)}</span>
                  <span>{t('tolls.evidence.return', 'Return')} {shortDateTime(reservation.returnAt)}</span>
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 10, lineHeight: 1.55 }}>
                  {t('tolls.evidence.tollAt', 'Toll {{when}}', { when: shortDateTime(row.transactionAt) })}
                </p>
              </div>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--text-3)' }}>—</p>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function TollsInner({ token, me, logout }) {
  const { t } = useTranslation();
  const role = String(me?.role || '').toUpperCase();
  const isSuper = role === 'SUPER_ADMIN';
  const [msg, setMsg] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [tenantRows, setTenantRows] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [providerForm, setProviderForm] = useState({
    provider: 'AUTOEXPRESO',
    username: '',
    password: '',
    loginUrl: '',
    notes: '',
    isActive: true
  });
  const [statusFilter, setStatusFilter] = useState('');
  const [reviewOnly, setReviewOnly] = useState(true);
  // ?view=NEEDS_REVIEW lets the dashboard tile land on the queue it counts.
  // A tile that opens the module on "All" makes the reader hunt for the rows
  // it just promised them (Hector, 2026-08-07: "le dan y no aparece nada").
  const [queueView, setQueueView] = useState(() => {
    if (typeof window === 'undefined') return 'ALL';
    const v = new URLSearchParams(window.location.search).get('view');
    return v && TOLL_QUEUE_VIEWS.includes(v) ? v : 'ALL';
  });
  const [activeTab, setActiveTab] = useState('QUEUE');
  const [query, setQuery] = useState('');
  const [bulkImportText, setBulkImportText] = useState('');
  const [importForm, setImportForm] = useState(() => ({
    ...EMPTY_IMPORT_FORM,
    transactionAt: new Date().toISOString().slice(0, 16)
  }));
  const [reservationDrafts, setReservationDrafts] = useState({});
  const [busyId, setBusyId] = useState('');
  // Bandeja "peajes por cobrar" (TollBridge point 9): unacked tolls attached
  // to contracts, closed contracts first. Rendered as the alerts tray above
  // the queue (its UI had been lost — NOTES finding #11).
  const [alerts, setAlerts] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [evidenceId, setEvidenceId] = useState('');
  // Themed dialogs replace window.prompt/window.confirm (NOTES finding #8):
  // { kind: 'note', row, action } | { kind: 'bulk-confirm' } | { kind: 'waive-selected' }
  const [dialog, setDialog] = useState(null);

  const scopedTollsPath = (path) => {
    if (!isSuper || !activeTenantId) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}tenantId=${encodeURIComponent(activeTenantId)}`;
  };

  const loadTenants = async () => {
    if (!isSuper) return;
    try {
      const rows = await api('/api/tenants', {}, token);
      const list = Array.isArray(rows) ? rows : [];
      setTenantRows(list);
      if (!activeTenantId && list[0]?.id) setActiveTenantId(list[0].id);
    } catch (error) {
      setMsg(error.message);
    }
  };

  const load = async () => {
    try {
      if (isSuper && !activeTenantId) {
        setDashboard(null);
        return;
      }
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (statusFilter) params.set('status', statusFilter);
      if (reviewOnly) params.set('needsReview', 'true');
      const out = await api(scopedTollsPath(`/api/tolls/dashboard${params.toString() ? `?${params.toString()}` : ''}`), {}, token);
      setDashboard(out);
      try {
        const alertsOut = await api(scopedTollsPath('/api/tolls/alerts'), { bypassCache: true }, token);
        setAlerts(Array.isArray(alertsOut?.alerts) ? alertsOut.alerts : []);
      } catch { setAlerts([]); }
      const provider = out?.providerAccount || null;
      setProviderForm((current) => ({
        provider: provider?.provider || 'AUTOEXPRESO',
        username: provider?.username || '',
        password: '',
        loginUrl: provider?.settings?.loginUrl || '',
        notes: provider?.settings?.notes || '',
        isActive: provider?.isActive !== false
      }));
      setSelectedIds(new Set());
      setMsg('');
    } catch (error) {
      setMsg(error.message);
    }
  };

  useEffect(() => {
    loadTenants();
  }, [token, isSuper]);

  useEffect(() => {
    load();
  }, [token, statusFilter, reviewOnly, activeTenantId, isSuper]);

  const transactions = useMemo(() => Array.isArray(dashboard?.transactions) ? dashboard.transactions : [], [dashboard]);
  // The counts come from the DATABASE (dashboard.queueCounts). Counting the
  // loaded page is what made the queue climb from 19 to 21 after staff
  // confirmed 19 rows: the list is capped at 200 over a queue thousands deep,
  // so confirming rows pulled unseen ones into the window. The client-side
  // numbers survive only as a fallback for an older payload.
  const queueCounts = useMemo(() => dashboard?.queueCounts || ({
    ALL: transactions.length,
    AUTO_MATCHED: transactions.filter(isAutoMatched).length,
    NEEDS_REVIEW: transactions.filter(isNeedsReview).length,
    UNMATCHED: transactions.filter(isUnmatched).length,
    DISPATCH_REVIEW: transactions.filter((row) => row.dispatchConfirmationRequired).length,
    USAGE_ONLY: transactions.filter(isUsageOnly).length,
    READY_TO_POST: transactions.filter(isReadyToPost).length
  }), [dashboard, transactions]);
  // What this payload actually holds, versus what matches. Saying so beats
  // implying the page is the whole queue.
  const shownOf = useMemo(() => {
    const total = Number(dashboard?.totalCount ?? transactions.length);
    const returned = Number(dashboard?.returnedCount ?? transactions.length);
    return returned < total ? { returned, total } : null;
  }, [dashboard, transactions]);
  const visibleTransactions = useMemo(() => filterByQueueView(queueView, transactions), [queueView, transactions]);

  // "Pending to post" in dollars — the number an owner actually asks for.
  // Computed over the LOADED ready-to-post rows; prefixed ≥ when the window
  // is truncated so it never overstates certainty.
  const pendingToPost = useMemo(() => {
    const rows = transactions.filter(isReadyToPost);
    const sum = rows.reduce((acc, row) => acc + Number(row.amount || 0), 0);
    const truncated = !!shownOf && Number(queueCounts.READY_TO_POST || 0) > rows.length;
    return { sum, truncated };
  }, [transactions, shownOf, queueCounts]);

  const acknowledgeAlert = async (id) => {
    try {
      await api(scopedTollsPath(`/api/tolls/transactions/${id}/acknowledge`), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setAlerts((prev) => prev.filter((row) => row.id !== id));
    } catch (error) {
      setMsg(error.message);
    }
  };

  const saveManualImport = async (event) => {
    event.preventDefault();
    try {
      setBusyId('manual-import');
      await api(scopedTollsPath('/api/tolls/transactions/manual-import'), {
        method: 'POST',
        body: JSON.stringify({
          rows: [{
            transactionAt: importForm.transactionAt,
            amount: Number(importForm.amount || 0),
            location: importForm.location,
            lane: importForm.lane,
            direction: importForm.direction,
            plate: importForm.plate,
            tag: importForm.tag,
            sello: importForm.sello
          }]
        })
      }, token);
      setImportForm({
        ...EMPTY_IMPORT_FORM,
        transactionAt: new Date().toISOString().slice(0, 16)
      });
      setMsg(t('tolls.msg.tollImported', 'Toll transaction imported'));
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const saveBulkImport = async () => {
    const rows = parseBulkImportRows(bulkImportText);
    if (!rows.length) {
      setMsg(t('tolls.msg.pasteCsv', 'Paste CSV rows with transactionAt, amount, location, lane, direction, plate, tag, sello'));
      return;
    }
    try {
      setBusyId('bulk-import');
      await api(scopedTollsPath('/api/tolls/transactions/manual-import'), {
        method: 'POST',
        body: JSON.stringify({ rows })
      }, token);
      setBulkImportText('');
      setMsg(t('tolls.msg.bulkImported', '{{count}} toll transactions imported', { count: rows.length }));
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const confirmMatch = async (row) => {
    const reservationId = row?.latestAssignment?.reservation?.id || '';
    const reservationNumber = reservationDrafts[row.id] || '';
    if (!reservationId && !reservationNumber.trim()) {
      setMsg(t('tolls.msg.addReservationFirst', 'Add a reservation number or use a suggested reservation first'));
      return;
    }
    try {
      setBusyId(`confirm-${row.id}`);
      await api(scopedTollsPath(`/api/tolls/transactions/${row.id}/confirm-match`), {
        method: 'POST',
        body: JSON.stringify({
          reservationId: reservationId || undefined,
          reservationNumber: reservationId ? undefined : reservationNumber.trim()
        })
      }, token);
      setMsg(t('tolls.msg.matchedTo', 'Toll matched to reservation {{number}}', { number: row?.latestAssignment?.reservation?.reservationNumber || reservationNumber.trim() }));
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const postToReservation = async (row) => {
    try {
      setBusyId(`post-${row.id}`);
      await api(scopedTollsPath(`/api/tolls/transactions/${row.id}/post-to-reservation`), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg(t('tolls.msg.posted', 'Toll posted to reservation charges'));
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  // The note now arrives from the themed dialog, not window.prompt.
  const runReviewAction = async (row, action, note = '') => {
    try {
      setBusyId(`${action}-${row.id}`);
      const out = await api(scopedTollsPath(`/api/tolls/transactions/${row.id}/review-action`), {
        method: 'POST',
        body: JSON.stringify({ action, note })
      }, token);
      const issueMessage = action === 'MARK_DISPUTED' && out?.issueIncident?.id
        ? t('tolls.msg.issueCase', ' | Issue Center case {{id}}', { id: `${out.issueIncident.id}${out?.issueIncident?.title ? ` (${out.issueIncident.title})` : ''}` })
        : '';
      setMsg(`${t('tolls.msg.updated', 'Toll {{label}}', { label: out?.actionLabel || 'updated' })}${issueMessage}`);
      setDialog(null);
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const openIssueCase = (incidentId) => {
    if (!incidentId) return;
    try {
      localStorage.setItem(ISSUE_EDIT_ID_KEY, incidentId);
    } catch {}
    window.location.href = '/issues';
  };

  const saveProviderAccount = async () => {
    try {
      setBusyId('provider-save');
      await api(scopedTollsPath('/api/tolls/provider-account'), {
        method: 'PUT',
        body: JSON.stringify(providerForm)
      }, token);
      setMsg(t('tolls.msg.providerSaved', 'Toll provider setup saved'));
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const runProviderHealthCheck = async () => {
    try {
      setBusyId('provider-health');
      const out = await api(scopedTollsPath('/api/tolls/provider-account/health-check'), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg(out?.ready
        ? t('tolls.msg.healthPassed', 'Provider health check passed')
        : t('tolls.msg.healthMissing', 'Provider is missing: {{missing}}', { missing: (out?.missing || []).join(', ') }));
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const runMockSync = async () => {
    try {
      setBusyId('provider-sync');
      await api(scopedTollsPath('/api/tolls/provider-account/mock-sync'), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg(t('tolls.msg.mockDone', 'Mock sync completed and import history updated'));
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const runLiveSync = async () => {
    try {
      setBusyId('provider-live-sync');
      const out = await api(scopedTollsPath('/api/tolls/provider-account/live-sync'), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg(t('tolls.msg.liveDone', 'AutoExpreso sync completed with {{count}} imported rows', { count: Number(out?.createdCount || 0) }));
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const bulkConfirmCandidates = useMemo(() => {
    return visibleTransactions.filter((row) => {
      if (isUsageOnly(row)) return false;
      if (!row.needsReview) return false;
      if (row.dispatchConfirmationRequired && row.reservation?.id) return true;
      if (row.latestAssignment?.reservation?.id) return true;
      return false;
    });
  }, [visibleTransactions]);

  const runBulkConfirm = async (ids) => {
    try {
      setBusyId('bulk-confirm');
      const out = await api(scopedTollsPath('/api/tolls/transactions/bulk-confirm'), {
        method: 'POST',
        body: JSON.stringify({ ids, note: 'Bulk confirm from review queue' })
      }, token);
      const matched = Number(out?.confirmed || 0);
      const dispatched = Number(out?.dispatchConfirmed || 0);
      const skipped = Number(out?.skipped || 0);
      const failed = Number(out?.failed || 0);
      const parts = [
        matched ? t('tolls.msg.bulkMatched', '{{count}} matched', { count: matched }) : '',
        dispatched ? t('tolls.msg.bulkDispatched', '{{count}} dispatch-confirmed', { count: dispatched }) : '',
        skipped ? t('tolls.msg.bulkSkipped', '{{count}} skipped', { count: skipped }) : '',
        failed ? t('tolls.msg.bulkFailed', '{{count}} failed', { count: failed }) : ''
      ].filter(Boolean);
      setMsg(t('tolls.msg.bulkConfirmDone', 'Bulk confirm complete: {{parts}}', { parts: parts.join(', ') || t('tolls.msg.bulkNoChanges', 'no changes') }));
      setDialog(null);
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const openBulkConfirm = () => {
    if (!bulkConfirmCandidates.length) {
      setMsg(t('tolls.msg.noEligibleConfirm', 'No tolls eligible for Confirm All in the current view (need a suggested reservation or dispatch confirmation pending).'));
      return;
    }
    setDialog({ kind: 'bulk-confirm', rows: bulkConfirmCandidates });
  };

  const runBulkAutoMatch = async () => {
    try {
      setBusyId('bulk-auto-match');
      const out = await api(scopedTollsPath('/api/tolls/transactions/bulk-auto-match'), {
        method: 'POST',
        body: JSON.stringify({ limit: 500 })
      }, token);
      setMsg(t('tolls.msg.bulkMatchDone', 'Bulk match complete: {{confirmed}} auto-confirmed, {{suggested}} suggested, {{reviewed}} reviewed', {
        confirmed: Number(out?.autoConfirmed || 0),
        suggested: Number(out?.suggested || 0),
        reviewed: Number(out?.reviewed || 0)
      }));
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  // Export CSV — wires the ACTIVE filters + queue view into the (new) export
  // endpoint so the spreadsheet always matches the screen.
  const runExportCsv = async () => {
    try {
      setBusyId('export-csv');
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (statusFilter) params.set('status', statusFilter);
      if (reviewOnly) params.set('needsReview', 'true');
      if (queueView && queueView !== 'ALL') params.set('view', queueView);
      const res = await apiDownload(scopedTollsPath(`/api/tolls/transactions/export.csv${params.toString() ? `?${params.toString()}` : ''}`), { cache: 'no-store' }, token);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${t('tolls.msg.exportFailed', 'CSV export failed')} (${res.status})`);
      }
      const disposition = String(res.headers.get('Content-Disposition') || '');
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || `tolls-${queueView.toLowerCase()}.csv`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg(t('tolls.msg.exported', 'Exported {{filename}}', { filename }));
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const selectedRows = useMemo(() => visibleTransactions.filter((row) => selectedIds.has(row.id)), [visibleTransactions, selectedIds]);
  const selectedTotal = useMemo(() => selectedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0), [selectedRows]);
  const selectableRows = useMemo(() => visibleTransactions.filter((row) => !isUsageOnly(row)), [visibleTransactions]);

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePageSelection = () => {
    setSelectedIds((prev) => {
      if (prev.size >= selectableRows.length && selectableRows.length) return new Set();
      return new Set(selectableRows.map((row) => row.id));
    });
  };

  const runWaiveSelected = async (note) => {
    const rows = selectedRows;
    let done = 0;
    setBusyId('waive-selected');
    try {
      for (const row of rows) {
        // review-action is per-toll; sequential keeps the audit trail readable.
        await api(scopedTollsPath(`/api/tolls/transactions/${row.id}/review-action`), {
          method: 'POST',
          body: JSON.stringify({ action: 'MARK_NOT_BILLABLE', note })
        }, token);
        done += 1;
      }
      setMsg(t('tolls.msg.waivedSelected', '{{done}} of {{total}} selected tolls waived', { done, total: rows.length }));
    } catch (error) {
      setMsg(`${t('tolls.msg.waivedSelected', '{{done}} of {{total}} selected tolls waived', { done, total: rows.length })} — ${error.message}`);
    } finally {
      setDialog(null);
      setBusyId('');
      await load();
    }
  };

  /* ---------- row action dispatch ---------- */
  const openNoteDialog = (row, action) => setDialog({ kind: 'note', row, action });

  const primaryButtonFor = (row) => {
    const hasDraft = !!(reservationDrafts[row.id] || '').trim();
    const primary = primaryActionForRow(row, { hasDraft });
    switch (primary) {
      case 'USAGE':
        return <span className="status-chip good">{t('tolls.row.usageOnlyChip', 'Usage only — no charge')}</span>;
      case 'DISPATCHED':
        return (
          <button type="button" className="tq-mini-btn tq-btn-primary" onClick={() => openNoteDialog(row, 'CONFIRM_DISPATCHED')} disabled={busyId === `CONFIRM_DISPATCHED-${row.id}`}>
            {t('tolls.actions.dispatched', 'Dispatched ✓')}
          </button>
        );
      case 'CONFIRM':
        return (
          <button type="button" className="tq-mini-btn tq-btn-primary" onClick={() => confirmMatch(row)} disabled={busyId === `confirm-${row.id}`}>
            {t('tolls.actions.confirm', 'Confirm')}
          </button>
        );
      case 'POST':
        return (
          <button type="button" className="tq-mini-btn tq-btn-primary" onClick={() => postToReservation(row)} disabled={busyId === `post-${row.id}`}>
            {t('tolls.actions.post', 'Post')}
          </button>
        );
      case 'ASSIGN':
        return (
          <button type="button" className="tq-mini-btn button-subtle" disabled title={t('tolls.msg.addReservationFirst', 'Add a reservation number or use a suggested reservation first')}>
            {t('tolls.actions.assign', 'Assign')}
          </button>
        );
      default:
        return (
          <button type="button" className="tq-mini-btn button-subtle" onClick={() => setEvidenceId((prev) => prev === row.id ? '' : row.id)}>
            {t('tolls.actions.review', 'Review')} ▾
          </button>
        );
    }
  };

  const OVERFLOW_RENDER = {
    CONFIRM_DISPATCHED: (row) => ({ label: t('tolls.actions.dispatched', 'Dispatched ✓'), onClick: () => openNoteDialog(row, 'CONFIRM_DISPATCHED') }),
    MARK_NOT_DISPATCHED: (row) => ({ label: t('tolls.actions.notDispatched', 'Not dispatched — remove'), desc: t('tolls.actions.notDispatchedDesc', 'The vehicle was not dispatched to this customer'), onClick: () => openNoteDialog(row, 'MARK_NOT_DISPATCHED') }),
    CONFIRM_MATCH: (row) => ({ label: t('tolls.actions.confirm', 'Confirm'), onClick: () => confirmMatch(row) }),
    POST: (row) => ({ label: t('tolls.actions.post', 'Post'), onClick: () => postToReservation(row) }),
    RESET_MATCH: (row) => ({ label: t('tolls.actions.reset', 'Reset match'), desc: t('tolls.actions.resetDesc', 'Clear suggestion, back to unmatched'), onClick: () => openNoteDialog(row, 'RESET_MATCH') }),
    MARK_DISPUTED: (row) => ({ label: t('tolls.actions.dispute', 'Dispute…'), desc: t('tolls.actions.disputeDesc', 'Opens an Issue Center case'), onClick: () => openNoteDialog(row, 'MARK_DISPUTED') }),
    MARK_NOT_BILLABLE: (row) => ({ label: t('tolls.actions.waive', 'Waive — not billable…'), desc: t('tolls.actions.waiveDesc', 'Requires a note'), danger: true, onClick: () => openNoteDialog(row, 'MARK_NOT_BILLABLE') })
  };

  const rowMenu = (row) => {
    const hasDraft = !!(reservationDrafts[row.id] || '').trim();
    const items = overflowActionsForRow(row, { hasDraft });
    if (!items.length) return null;
    return (
      <details className="tq-menu">
        <summary title={t('tolls.row.moreActions', 'More actions')}>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
        </summary>
        <div className="tq-menu-pop">
          {items.map((item, index) => {
            const cfg = OVERFLOW_RENDER[item]?.(row);
            if (!cfg) return null;
            const dangerSep = cfg.danger && index > 0 ? <div className="sep" /> : null;
            return (
              <Fragment key={item}>
                {dangerSep}
                <button
                  type="button"
                  className={cfg.danger ? 'danger' : ''}
                  disabled={busyId === `${item}-${row.id}`}
                  onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); cfg.onClick(); }}
                >
                  {cfg.label}
                  {cfg.desc ? <small>{cfg.desc}</small> : null}
                </button>
              </Fragment>
            );
          })}
        </div>
      </details>
    );
  };

  /* ---------- render ---------- */
  const autoSyncOn = !!dashboard?.autoSync?.enabled;
  const providerName = providerForm.provider === 'SUNPASS' ? 'SunPass' : 'AutoExpreso';
  const laneLabel = (view) => t(`tolls.views.${view}`, view);

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">{t('tolls.eyebrow', 'Toll Operations')}</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>{t('tolls.title', 'Tolls')}</h2>
              <p className="ui-muted">{t('tolls.subtitle', 'Match tolls against the tenant fleet and reservation windows')}</p>
            </div>
            <span className={`tq-sync-led${autoSyncOn ? '' : ' off'}`}>
              <i />
              {autoSyncOn
                ? t('tolls.syncOn', 'Auto-sync on · last sweep {{when}}', { when: shortDateTime(dashboard?.autoSync?.lastAutomaticRunAt) })
                : t('tolls.syncOff', 'Auto-sync off')}
            </span>
          </div>

          {isSuper ? (
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <label className="label" style={{ minWidth: 160 }}>{t('tolls.tenantScopeLabel', 'Toll Tenant Scope')}</label>
              <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
                <option value="">{t('tolls.tenantSelect', 'Select tenant')}</option>
                {tenantRows.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                ))}
              </select>
              <span className="ui-muted">
                {activeTenantId
                  ? t('tolls.tenantActive', '{{name}} active', { name: tenantRows.find((tenant) => tenant.id === activeTenantId)?.name || '' })
                  : t('tolls.tenantChoose', 'Choose a tenant before importing or reviewing tolls')}
              </span>
            </div>
          ) : null}

          <nav className="tq-tabs" aria-label="Tolls sections">
            <button type="button" className={activeTab === 'QUEUE' ? 'is-on' : ''} onClick={() => setActiveTab('QUEUE')}>
              {t('tolls.tabQueue', 'Review queue')}
            </button>
            <button type="button" className={activeTab === 'IMPORTS' ? 'is-on' : ''} onClick={() => setActiveTab('IMPORTS')}>
              {t('tolls.tabImports', 'Imports & sync')}
            </button>
          </nav>

          <div className="app-card-grid compact" style={{ marginTop: 12 }}>
            <div className="info-tile">
              <span className="label">{t('tolls.kpi.importedToday', 'Imported today')}</span>
              <strong>{dashboard?.metrics?.importedToday || 0}</strong>
            </div>
            <div className="info-tile">
              <span className="label">{t('tolls.kpi.autoMatched', 'Auto-matched')}</span>
              <strong>{dashboard?.metrics?.matched || 0}</strong>
            </div>
            <div className="info-tile">
              <span className="label">{t('tolls.kpi.needsReview', 'Needs review')}</span>
              <strong>{dashboard?.metrics?.needsReviewActionable ?? dashboard?.metrics?.needsReview ?? 0}</strong>
              {Number(dashboard?.metrics?.needsReviewNoSuggestion || 0) > 0 ? (
                <span className="label" style={{ display: 'block', marginTop: 2 }}>
                  {t('tolls.kpi.noCandidate', '+ {{count}} with no match candidate', { count: dashboard.metrics.needsReviewNoSuggestion })}
                </span>
              ) : null}
            </div>
            <div className="info-tile" title={t('tolls.kpi.pendingLoadedHint', 'Dollar total of the loaded ready-to-post rows')}>
              <span className="label">{t('tolls.kpi.pendingToPost', 'Pending to post')}</span>
              <strong style={{ color: 'var(--brand-tx)' }}>{pendingToPost.truncated ? '≥ ' : ''}{money(pendingToPost.sum)}</strong>
            </div>
            <div className="info-tile">
              <span className="label">{t('tolls.kpi.postedToBilling', 'Posted to billing')}</span>
              <strong>{dashboard?.metrics?.postedToBilling || 0}</strong>
            </div>
          </div>
        </div>

        {msg ? <div className="label">{msg}</div> : null}

        {dashboard && dashboard.tollsEnabled === false ? (
          <div className="glass card section-card">
            <div className="section-title">{t('tolls.disabled.title', 'Tolls Module Disabled')}</div>
            <div className="surface-note">{t('tolls.disabled.body', 'Enable Tolls for this tenant in the tenant/module controls before using AutoExpreso sync, imports, or review queue.')}</div>
          </div>
        ) : null}

        {activeTab === 'QUEUE' ? (
          <>
            {/* toolbar: every existing control, one row */}
            <div className="inline-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
              <input
                placeholder={t('tolls.toolbar.searchPlaceholder', 'Search plate, tag, location, reservation')}
                style={{ minWidth: 220, flex: '0 1 280px' }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
              />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t('tolls.toolbar.allStatuses', 'All statuses')}>
                <option value="">{t('tolls.toolbar.allStatuses', 'All statuses')}</option>
                <option value="IMPORTED">{t('tolls.toolbar.statusImported', 'Imported')}</option>
                <option value="MATCHED">{t('tolls.toolbar.statusMatched', 'Matched')}</option>
                <option value="NEEDS_REVIEW">{t('tolls.toolbar.statusNeedsReview', 'Needs Review')}</option>
                <option value="BILLED">{t('tolls.toolbar.statusBilled', 'Billed')}</option>
                <option value="DISPUTED">{t('tolls.toolbar.statusDisputed', 'Disputed')}</option>
                <option value="VOID">{t('tolls.toolbar.statusVoid', 'Void / Not Billable')}</option>
              </select>
              <label className="label"><input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} /> {t('tolls.toolbar.reviewOnly', 'Review only')}</label>
              <button type="button" className="button-subtle" onClick={load}>{t('tolls.toolbar.refresh', 'Refresh')}</button>
              <button type="button" className="button-subtle" onClick={runExportCsv} disabled={busyId === 'export-csv' || (isSuper && !activeTenantId)}>
                {busyId === 'export-csv' ? t('tolls.toolbar.exporting', 'Exporting…') : t('tolls.toolbar.exportCsv', 'Export CSV')}
              </button>
              <span style={{ marginLeft: 'auto' }} />
              <button type="button" className="button-subtle" onClick={runBulkAutoMatch} disabled={busyId === 'bulk-auto-match' || (isSuper && !activeTenantId)}>
                {busyId === 'bulk-auto-match' ? t('tolls.toolbar.matching', 'Matching…') : t('tolls.toolbar.autoMatchAll', 'Auto-match all')}
              </button>
              <button
                type="button"
                className="tq-btn-primary"
                onClick={openBulkConfirm}
                disabled={busyId === 'bulk-confirm' || (isSuper && !activeTenantId) || !bulkConfirmCandidates.length}
                title={bulkConfirmCandidates.length
                  ? t('tolls.toolbar.eligibleCount', '{{count}} tolls ready to confirm', { count: bulkConfirmCandidates.length })
                  : t('tolls.toolbar.noEligible', 'No eligible tolls in this view')}
              >
                {busyId === 'bulk-confirm' ? t('tolls.toolbar.confirming', 'Confirming…') : t('tolls.toolbar.confirmAll', 'Confirm all')}
                {bulkConfirmCandidates.length ? <span className="tq-btn-count">{bulkConfirmCandidates.length}</span> : null}
              </button>
            </div>

            <div className="tq-body">
              {/* lane rail: the 6 existing views, regrouped by confidence */}
              <aside className="tq-rail" aria-label={t('tolls.tabQueue', 'Review queue')}>
                {TOLL_LANE_GROUPS.map((group) => (
                  <Fragment key={group.id}>
                    <div className={`tq-grp g-${group.tone}`}><i />{t(`tolls.lanes.${group.id}`, group.id)}</div>
                    {group.views.map((view) => (
                      <button
                        key={view}
                        type="button"
                        className={`tq-lane${queueView === view ? ' is-on' : ''}`}
                        onClick={() => { setQueueView(view); setEvidenceId(''); }}
                      >
                        {laneLabel(view)}
                        <span className={`n${view === 'NEEDS_REVIEW' && Number(queueCounts.NEEDS_REVIEW || 0) > 0 ? ' hot' : ''}`}>
                          {queueCounts[view] ?? 0}
                        </span>
                      </button>
                    ))}
                  </Fragment>
                ))}
                <div className="tq-rail-note">{t('tolls.railNote', 'Counts come from the database, not the loaded page. Lanes group the same six queues the module has always had — nothing was removed.')}</div>
              </aside>

              <div className="tq-main">
                {/* Bandeja "peajes por cobrar" — restored TollBridge alerts tray */}
                {alerts.length ? (
                  <details className="tq-alerts">
                    <summary>{t('tolls.alerts.open', '{{count}} toll alerts', { count: alerts.length })} — {t('tolls.alerts.desc', 'Unacknowledged tolls attached to contracts — closed contracts first.')}</summary>
                    <ul>
                      {alerts.slice(0, 8).map((alert) => (
                        <li key={alert.id}>
                          <b>{money(alert.amount)}</b>
                          <span>{shortDateTime(alert.transactionAt)}{alert.location ? ` · ${alert.location}` : ''}</span>
                          <span>{alert.reservationNumber ? `${t('tolls.alerts.reservation', 'Reservation')} ${alert.reservationNumber}` : ''}{alert.customerName ? ` · ${alert.customerName}` : ''}</span>
                          <button type="button" className="button-subtle" style={{ minHeight: 28, padding: '2px 10px', fontSize: 11.5 }} onClick={() => acknowledgeAlert(alert.id)}>
                            {t('tolls.alerts.ack', 'Acknowledge')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {/* honest truncation notice, compressed to one line */}
                {shownOf && visibleTransactions.length < Number(queueCounts[queueView] || 0) ? (
                  <div className="tq-ctx">
                    <span>
                      <b>{t('tolls.truncation', '{{shown}} of {{dbCount}} loaded — DB counts, list caps at the {{returned}} most recent of {{total}} tolls.', {
                        shown: visibleTransactions.length,
                        dbCount: queueCounts[queueView],
                        returned: shownOf.returned,
                        total: shownOf.total
                      })}</b>
                    </span>
                    <span className="next">{t('tolls.truncationNext', 'Narrow with filters to reach the rest →')}</span>
                  </div>
                ) : null}

                {t(`tolls.viewHints.${queueView}`, '') ? (
                  <div className="tq-hint">{t(`tolls.viewHints.${queueView}`)}</div>
                ) : null}

                <div className="tq-scroll">
                  <table className="tq-table">
                    <thead>
                      <tr>
                        <th style={{ width: 30 }}>
                          <input
                            type="checkbox"
                            aria-label={t('tolls.table.selectAll', 'Select page')}
                            checked={!!selectableRows.length && selectedIds.size >= selectableRows.length}
                            onChange={togglePageSelection}
                          />
                        </th>
                        <th style={{ width: '15%' }}>{t('tolls.table.toll', 'Toll')}</th>
                        <th className="right" style={{ width: '8%' }}>{t('tolls.table.amount', 'Amount')}</th>
                        <th style={{ width: '13%' }}>{t('tolls.table.vehicle', 'Vehicle')}</th>
                        <th style={{ width: '17%' }}>{t('tolls.table.reservation', 'Reservation')}</th>
                        <th style={{ width: '27%' }}>{t('tolls.table.match', 'Match confidence · why')}</th>
                        <th className="right" style={{ width: '20%' }}>{t('tolls.table.action', 'Action')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTransactions.map((row) => {
                        const assignmentStatus = String(row.latestAssignment?.status || '').toUpperCase();
                        const stateLabel = assignmentStatus === 'AUTO_CONFIRMED'
                          ? t('tolls.row.autoPaired', 'Auto-paired')
                          : assignmentStatus === 'CONFIRMED' || assignmentStatus === 'MATCHED'
                            ? t('tolls.row.confirmed', 'Confirmed')
                            : t('tolls.row.suggested', 'Suggested');
                        const { overflow } = inlineChipsForRow(row);
                        const selectable = !isUsageOnly(row);
                        return (
                          <Fragment key={row.id}>
                            <tr className={selectedIds.has(row.id) ? 'is-sel' : ''}>
                              <td>
                                <input
                                  type="checkbox"
                                  disabled={!selectable}
                                  checked={selectedIds.has(row.id)}
                                  onChange={() => toggleSelected(row.id)}
                                  aria-label={row.id}
                                />
                              </td>
                              <td className="tq-when">
                                <b>{shortDateTime(row.transactionAt)}</b>
                                <small>{row.location || '-'}{row.lane ? ` · ${row.lane}` : ''}{row.direction ? ` ${row.direction}` : ''}</small>
                              </td>
                              <td className="right"><span className="tq-money">{money(row.amount)}</span></td>
                              <td className="tq-cell">
                                {row.vehicle ? (
                                  <>
                                    <b>{row.vehicle.internalNumber}</b>
                                    {row.vehicle.plate ? <span className="tq-plate">{row.vehicle.plate}</span> : null}
                                  </>
                                ) : (
                                  <>
                                    <span className="status-chip danger" style={{ fontSize: 11 }}>{t('tolls.row.notInFleet', 'Not in fleet')}</span>
                                    {row.plateRaw || row.tagRaw || row.selloRaw ? (
                                      <small style={{ display: 'block', marginTop: 3 }}>
                                        {t('tolls.row.read', 'read: {{value}}', { value: row.plateRaw || row.tagRaw || row.selloRaw })}
                                      </small>
                                    ) : null}
                                  </>
                                )}
                              </td>
                              <td className="tq-cell">
                                {row.latestAssignment?.reservation ? (
                                  <>
                                    <b>{row.latestAssignment.reservation.reservationNumber}</b>
                                    <small>
                                      {stateLabel}
                                      {row.reservation?.customer ? ` · ${[row.reservation.customer.firstName, row.reservation.customer.lastName].filter(Boolean).join(' ')}` : ''}
                                    </small>
                                  </>
                                ) : row.reservation ? (
                                  <>
                                    <b>{row.reservation.reservationNumber}</b>
                                    {row.reservation.customer ? (
                                      <small>{[row.reservation.customer.firstName, row.reservation.customer.lastName].filter(Boolean).join(' ')}</small>
                                    ) : null}
                                  </>
                                ) : (
                                  <input
                                    className="tq-res-input"
                                    placeholder={t('tolls.row.assignPlaceholder', 'Assign reservation #…')}
                                    value={reservationDrafts[row.id] || ''}
                                    onChange={(e) => setReservationDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && (reservationDrafts[row.id] || '').trim()) confirmMatch(row); }}
                                  />
                                )}
                                {row.issueIncident?.id ? (
                                  <small style={{ display: 'block' }}>
                                    <button type="button" className="tq-foot-issue" onClick={() => openIssueCase(row.issueIncident.id)} style={{ background: 'none', border: 0, padding: 0, minHeight: 0, boxShadow: 'none', fontSize: 11, color: 'var(--brand-tx)', cursor: 'pointer' }}>
                                      {t('tolls.row.issueLink', 'Issue {{id}} — {{status}}', { id: row.issueIncident.id, status: row.issueIncident.status || 'OPEN' })} ↗
                                    </button>
                                  </small>
                                ) : null}
                              </td>
                              <td>
                                {row.billingStatus === 'DISPUTED' ? (
                                  <span className="status-chip warn" style={{ marginBottom: 3 }}>{t('tolls.toolbar.statusDisputed', 'Disputed')}</span>
                                ) : row.billingStatus === 'WAIVED' ? (
                                  <span className="status-chip neutral" style={{ marginBottom: 3 }}>{t('tolls.toolbar.statusVoid', 'Void / Not Billable')}</span>
                                ) : null}
                                <ConfidenceCell
                                  row={row}
                                  t={t}
                                  overflow={overflow}
                                  onMore={() => setEvidenceId((prev) => prev === row.id ? '' : row.id)}
                                />
                              </td>
                              <td>
                                <div className="tq-act">
                                  {primaryButtonFor(row)}
                                  {row.reservation?.id ? (
                                    <a className="go-res" href={`/reservations/${row.reservation.id}`} title={t('tolls.row.viewReservation', 'View reservation')}>
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
                                    </a>
                                  ) : null}
                                  {rowMenu(row)}
                                </div>
                              </td>
                            </tr>
                            {evidenceId === row.id ? <EvidenceDrawer row={row} t={t} /> : null}
                          </Fragment>
                        );
                      })}
                      {!visibleTransactions.length ? (
                        <tr>
                          <td colSpan={7} className="label">{t('tolls.table.empty', 'No toll transactions matched this queue view yet.')}</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                <div className="tq-foot">
                  {selectedRows.length ? (
                    <>
                      <span>{t('tolls.foot.selected', '{{count}} selected', { count: selectedRows.length })} · <b style={{ color: 'var(--text-1)' }}>{money(selectedTotal)}</b></span>
                      <button type="button" className="lnk" disabled={busyId === 'bulk-confirm'} onClick={() => setDialog({ kind: 'bulk-confirm', rows: selectedRows, fromSelection: true })}>
                        {t('tolls.foot.confirmSelected', 'Confirm selected')}
                      </button>
                      <button type="button" className="lnk quiet" disabled={busyId === 'waive-selected'} onClick={() => setDialog({ kind: 'waive-selected' })}>
                        {t('tolls.foot.waiveSelected', 'Waive selected')}
                      </button>
                      <button type="button" className="lnk quiet" onClick={() => setSelectedIds(new Set())}>{t('tolls.foot.clear', 'Clear')}</button>
                    </>
                  ) : null}
                  <span className="r">{t('tolls.foot.rows', '{{count}} rows · sorted newest', { count: visibleTransactions.length })}</span>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* ============ Imports & sync tab — everything that used to sit above the queue ============ */}
            <div className="glass card section-card">
              <div className="row-between">
                <div className="section-title">{t('tolls.imports.autoSyncTitle', 'Automatic AutoExpreso Sync')}</div>
                <span className={`status-chip ${autoSyncOn ? 'good' : 'neutral'}`}>
                  {autoSyncOn ? t('tolls.imports.autoSyncEnabled', 'Auto Sync Enabled') : t('tolls.imports.autoSyncDisabled', 'Auto Sync Disabled')}
                </span>
              </div>
              <div className="tq-mini-grid">
                <div className="tq-mini"><span className="klab">{t('tolls.imports.interval', 'Interval')}</span><b>{t('tolls.imports.minutes', '{{count}} min', { count: Number(dashboard?.autoSync?.intervalMinutes || 0) })}</b></div>
                <div className="tq-mini"><span className="klab">{t('tolls.imports.lastRun', 'Last automatic run')}</span><b>{dashboard?.autoSync?.lastAutomaticRunAt ? shortDateTime(dashboard.autoSync.lastAutomaticRunAt) : t('tolls.imports.notScheduled', 'Not scheduled yet')}</b></div>
                <div className="tq-mini"><span className="klab">{t('tolls.imports.nextRun', 'Next scheduled run')}</span><b>{dashboard?.autoSync?.nextRunAt ? shortDateTime(dashboard.autoSync.nextRunAt) : t('tolls.imports.notScheduled', 'Not scheduled yet')}</b></div>
                {dashboard?.autoSync?.lastSweep ? (
                  <>
                    <div className="tq-mini"><span className="klab">{t('tolls.imports.lastImported', 'Last sweep imported')}</span><b>{Number(dashboard.autoSync.lastSweep.importedCount || 0)}</b></div>
                    <div className="tq-mini"><span className="klab">{t('tolls.imports.lastAutoMatched', 'Last sweep auto-matched')}</span><b>{Number(dashboard.autoSync.lastSweep.autoMatchedCount || 0)}</b></div>
                    <div className="tq-mini"><span className="klab">{t('tolls.imports.lastSuggested', 'Last sweep suggested')}</span><b>{Number(dashboard.autoSync.lastSweep.suggestedCount || 0)}</b></div>
                    <div className="tq-mini"><span className="klab">{t('tolls.imports.pendingReview', 'Pending review now')}</span><b>{Number(dashboard.autoSync.lastSweep.pendingReviewCount || 0)}</b></div>
                  </>
                ) : null}
              </div>
              <div className="surface-note" style={{ marginTop: 10 }}>{t('tolls.imports.autoSyncNote', 'The backend runs AutoExpreso sync sweeps automatically for active tenants with tolls enabled, then re-checks pending tolls against the assigned vehicle, swap-aware responsibility window, and dispatch state.')}</div>
            </div>

            <div className="glass card section-card">
              <div className="row-between">
                <div className="section-title">{t('tolls.imports.providerTitle', 'Toll Provider Setup')}</div>
                <span className={`status-chip ${dashboard?.providerAccount?.isActive ? 'good' : 'neutral'}`}>
                  {dashboard?.providerAccount?.isActive ? t('tolls.imports.providerReady', 'Provider Ready') : t('tolls.imports.providerNotConfigured', 'Not configured')}
                </span>
              </div>
              <div className="surface-note" style={{ marginBottom: 10 }}>{t('tolls.imports.providerDesc', 'Select your toll provider and configure login credentials. The system will scrape toll transactions from the provider portal and match them to your fleet.')}</div>
              <div className="grid2">
                <div className="stack">
                  <label className="label">{t('tolls.imports.providerLabel', 'Toll Provider')}</label>
                  <select value={providerForm.provider} onChange={(e) => setProviderForm((prev) => ({ ...prev, provider: e.target.value }))}>
                    <option value="AUTOEXPRESO">AutoExpreso (Puerto Rico)</option>
                    <option value="SUNPASS">SunPass (Florida)</option>
                  </select>
                </div>
                <input placeholder={t('tolls.imports.usernamePlaceholder', '{{provider}} username', { provider: providerName })} value={providerForm.username} onChange={(e) => setProviderForm((prev) => ({ ...prev, username: e.target.value }))} />
                <input
                  placeholder={dashboard?.providerAccount?.hasPassword
                    ? t('tolls.imports.passwordKeep', 'Leave blank to keep current password')
                    : t('tolls.imports.passwordPlaceholder', '{{provider}} password', { provider: providerName })}
                  type="password"
                  value={providerForm.password}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, password: e.target.value }))}
                />
                <input placeholder={t('tolls.imports.loginUrl', 'Login URL (optional override)')} value={providerForm.loginUrl} onChange={(e) => setProviderForm((prev) => ({ ...prev, loginUrl: e.target.value }))} />
              </div>
              <textarea rows={3} placeholder={t('tolls.imports.notesPlaceholder', 'Provider notes or login behavior notes')} value={providerForm.notes} onChange={(e) => setProviderForm((prev) => ({ ...prev, notes: e.target.value }))} />
              <div className="inline-actions" style={{ marginTop: 10 }}>
                <label className="label"><input type="checkbox" checked={providerForm.isActive} onChange={(e) => setProviderForm((prev) => ({ ...prev, isActive: e.target.checked }))} /> {t('tolls.imports.active', 'Active provider account')}</label>
                <button type="button" disabled={busyId === 'provider-save' || (isSuper && !activeTenantId)} onClick={saveProviderAccount}>
                  {busyId === 'provider-save' ? t('tolls.imports.saving', 'Saving…') : t('tolls.imports.save', 'Save Provider Setup')}
                </button>
                <button type="button" className="button-subtle" disabled={busyId === 'provider-health' || (isSuper && !activeTenantId)} onClick={runProviderHealthCheck}>
                  {busyId === 'provider-health' ? t('tolls.imports.checking', 'Checking…') : t('tolls.imports.health', 'Run Health Check')}
                </button>
                <button type="button" className="button-subtle" disabled={busyId === 'provider-sync' || (isSuper && !activeTenantId)} onClick={runMockSync}>
                  {busyId === 'provider-sync' ? t('tolls.imports.running', 'Running…') : t('tolls.imports.mockSync', 'Run Mock Sync')}
                </button>
                <button type="button" className="button-subtle" disabled={busyId === 'provider-live-sync' || (isSuper && !activeTenantId)} onClick={runLiveSync}>
                  {busyId === 'provider-live-sync' ? t('tolls.imports.syncing', 'Syncing…') : t('tolls.imports.liveSync', 'Run {{provider}} Sync', { provider: providerName })}
                </button>
              </div>
              {dashboard?.providerAccount?.lastSyncStatus || dashboard?.providerAccount?.lastSyncMessage ? (
                <div className="surface-note" style={{ marginTop: 10 }}>
                  {t('tolls.imports.lastStatus', 'Last sync status: {{status}}', { status: `${dashboard?.providerAccount?.lastSyncStatus || 'N/A'}${dashboard?.providerAccount?.lastSyncMessage ? ` | ${dashboard.providerAccount.lastSyncMessage}` : ''}` })}
                </div>
              ) : null}
            </div>

            <div className="glass card section-card">
              <div className="section-title">{t('tolls.imports.manualTitle', 'Manual Toll Import')}</div>
              {isSuper && !activeTenantId ? (
                <div className="surface-note" style={{ marginBottom: 10 }}>{t('tolls.imports.manualChooseTenant', "Choose the tenant above first so the toll import uses that tenant's fleet, toll tags, toll stickers, and reservation windows.")}</div>
              ) : null}
              <form className="stack" onSubmit={saveManualImport}>
                <div className="grid2">
                  <input type="datetime-local" required value={importForm.transactionAt} onChange={(e) => setImportForm((prev) => ({ ...prev, transactionAt: e.target.value }))} />
                  <input type="number" step="0.01" min="0.01" required placeholder={t('tolls.imports.amount', 'Toll amount')} value={importForm.amount} onChange={(e) => setImportForm((prev) => ({ ...prev, amount: e.target.value }))} />
                </div>
                <div className="grid2">
                  <input placeholder={t('tolls.imports.location', 'Location / Plaza')} value={importForm.location} onChange={(e) => setImportForm((prev) => ({ ...prev, location: e.target.value }))} />
                  <input placeholder={t('tolls.imports.lane', 'Lane / Direction')} value={importForm.lane} onChange={(e) => setImportForm((prev) => ({ ...prev, lane: e.target.value }))} />
                </div>
                <div className="grid3">
                  <input placeholder={t('tolls.imports.plate', 'Plate')} value={importForm.plate} onChange={(e) => setImportForm((prev) => ({ ...prev, plate: e.target.value }))} />
                  <input placeholder={t('tolls.imports.tag', 'Toll Tag Number')} value={importForm.tag} onChange={(e) => setImportForm((prev) => ({ ...prev, tag: e.target.value }))} />
                  <input placeholder={t('tolls.imports.sello', 'Toll Sticker Number')} value={importForm.sello} onChange={(e) => setImportForm((prev) => ({ ...prev, sello: e.target.value }))} />
                </div>
                <div className="inline-actions">
                  <button type="submit" disabled={busyId === 'manual-import' || (isSuper && !activeTenantId)}>
                    {busyId === 'manual-import' ? t('tolls.imports.importing', 'Importing…') : t('tolls.imports.import', 'Import Toll')}
                  </button>
                </div>
              </form>
            </div>

            <div className="glass card section-card">
              <div className="section-title">{t('tolls.imports.bulkTitle', 'Bulk CSV Import')}</div>
              <div className="surface-note" style={{ marginBottom: 10 }}>
                {t('tolls.imports.bulkDesc', 'Paste CSV or tab-separated rows in this order:')}
                <br />
                <code>transactionAt, amount, location, lane, direction, plate, tag, sello</code>
              </div>
              <textarea
                rows={7}
                placeholder={'transactionAt,amount,location,lane,direction,plate,tag,sello\n2026-03-26T00:41,5.00,Plaza Norte,Lane 1,North,BBTB1,0202,0202'}
                value={bulkImportText}
                onChange={(e) => setBulkImportText(e.target.value)}
              />
              <div className="inline-actions" style={{ marginTop: 10 }}>
                <button type="button" disabled={busyId === 'bulk-import' || (isSuper && !activeTenantId)} onClick={saveBulkImport}>
                  {busyId === 'bulk-import' ? t('tolls.imports.importing', 'Importing…') : t('tolls.imports.bulkImport', 'Import CSV Rows')}
                </button>
                <button type="button" className="button-subtle" onClick={runExportCsv} disabled={busyId === 'export-csv' || (isSuper && !activeTenantId)}>
                  {busyId === 'export-csv' ? t('tolls.toolbar.exporting', 'Exporting…') : t('tolls.toolbar.exportCsv', 'Export CSV')}
                </button>
              </div>
            </div>

            <div className="glass card section-card">
              <div className="section-title">{t('tolls.imports.runsTitle', 'Recent Import Runs')}</div>
              {Array.isArray(dashboard?.importRuns) && dashboard.importRuns.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>{t('tolls.imports.runsStarted', 'Started')}</th>
                      <th>{t('tolls.imports.runsSource', 'Source')}</th>
                      <th>{t('tolls.imports.runsStatus', 'Status')}</th>
                      <th>{t('tolls.imports.runsImported', 'Imported')}</th>
                      <th>{t('tolls.imports.runsMatched', 'Matched')}</th>
                      <th>{t('tolls.imports.runsReview', 'Review')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.importRuns.map((run) => (
                      <tr key={run.id}>
                        <td>{new Date(run.startedAt).toLocaleString()}</td>
                        <td>{run.sourceType || '-'}</td>
                        <td>
                          <div>{run.status || '-'}</div>
                          {importRunDiagnostics(run, t) ? (
                            <div className="label" style={{ marginTop: '0.25rem' }}>{importRunDiagnostics(run, t)}</div>
                          ) : null}
                        </td>
                        <td>{run.importedCount}</td>
                        <td>{run.matchedCount}</td>
                        <td>{run.reviewCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="surface-note">{t('tolls.imports.runsEmpty', 'Import run history will appear here once provider sync or bulk imports start logging runs.')}</div>
              )}
            </div>
          </>
        )}
      </section>

      {dialog?.kind === 'note' ? (
        <TollNoteDialog
          dialog={dialog}
          busy={busyId === `${dialog.action}-${dialog.row.id}`}
          onCancel={() => setDialog(null)}
          onApply={(note) => runReviewAction(dialog.row, dialog.action, note)}
        />
      ) : null}
      {dialog?.kind === 'bulk-confirm' ? (
        <TollBulkConfirmDialog
          rows={dialog.rows || []}
          busy={busyId === 'bulk-confirm'}
          onCancel={() => setDialog(null)}
          onConfirm={() => runBulkConfirm((dialog.rows || []).map((row) => row.id))}
        />
      ) : null}
      {dialog?.kind === 'waive-selected' ? (
        <TollWaiveSelectedDialog
          rows={selectedRows}
          busy={busyId === 'waive-selected'}
          onCancel={() => setDialog(null)}
          onApply={runWaiveSelected}
        />
      ) : null}
    </AppShell>
  );
}
