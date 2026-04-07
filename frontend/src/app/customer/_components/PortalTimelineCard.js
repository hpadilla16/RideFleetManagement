'use client';

import { useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { portalStyles } from './PortalFrame';

function formatWhen(value) {
  if (!value) return 'Pending';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Pending';
  return d.toLocaleString();
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'completed') return { color: '#12633d', background: 'rgba(43, 174, 96, 0.14)' };
  if (value === 'active') return { color: '#10568b', background: 'rgba(48, 135, 214, 0.14)' };
  if (value === 'requested') return { color: '#7a4f08', background: 'rgba(255, 191, 71, 0.18)' };
  return { color: '#6f5b8f', background: 'rgba(111, 91, 143, 0.1)' };
}

function deriveEstimatedTotal({ reservation, breakdown, portal }) {
  if (typeof breakdown?.total === 'number') return Number(breakdown.total);
  if (typeof breakdown?.subtotal === 'number' || typeof breakdown?.tax === 'number' || typeof breakdown?.taxes === 'number') {
    return Number((Number(breakdown?.subtotal || 0) + Number(breakdown?.tax || breakdown?.taxes || 0)).toFixed(2));
  }
  if (typeof reservation?.estimatedTotal === 'number') return Number(reservation.estimatedTotal);
  const combined = Number(portal?.payment?.paidAmount || 0) + Number(portal?.payment?.balanceDue || 0);
  return combined > 0 ? Number(combined.toFixed(2)) : 0;
}

export function PortalTimelineCard({
  portal,
  reservation,
  breakdown,
  currentStepKey,
  currentStepLabel,
  portalKind = '',
  token = '',
  onPortalUpdate
}) {
  const [selfServiceBusyStage, setSelfServiceBusyStage] = useState('');
  const [selfServiceError, setSelfServiceError] = useState('');
  const [selfServiceOk, setSelfServiceOk] = useState('');
  if (!portal) return null;

  const nextStep = portal.nextStep;
  const showNextLink = nextStep?.link && nextStep?.key && nextStep.key !== currentStepKey;
  const estimatedTotal = deriveEstimatedTotal({ reservation, breakdown, portal });
  const paidAmount = Number(portal.payment?.paidAmount || 0);
  const balanceDue = Number(portal.payment?.balanceDue || 0);
  const dueToday = balanceDue > 0 ? balanceDue : 0;
  const selfService = portal.selfService || null;
  const selfServiceTone = String(selfService?.status || '').toUpperCase() === 'READY'
    ? { color: '#12633d', background: 'rgba(43, 174, 96, 0.14)' }
    : String(selfService?.status || '').toUpperCase() === 'ATTENTION'
      ? { color: '#7a4f08', background: 'rgba(255, 191, 71, 0.18)' }
      : String(selfService?.status || '').toUpperCase() === 'BLOCKED'
        ? { color: '#991b1b', background: 'rgba(220, 38, 38, 0.12)' }
        : { color: '#6f5b8f', background: 'rgba(111, 91, 143, 0.1)' };
  const canConfirm = Boolean(portalKind && token);

  const confirmSelfServiceStage = async (stage) => {
    if (!canConfirm) {
      setSelfServiceError('This portal page cannot confirm self-service actions yet.');
      setSelfServiceOk('');
      return;
    }
    try {
      setSelfServiceBusyStage(stage);
      setSelfServiceError('');
      setSelfServiceOk('');
      const res = await fetch(`${API_BASE}/api/public/self-service/${encodeURIComponent(portalKind)}/${encodeURIComponent(token)}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Unable to confirm ${String(stage || '').toLowerCase()}.`);
      if (json?.portal) onPortalUpdate?.(json.portal);
      setSelfServiceOk(
        stage === 'PICKUP'
          ? 'Pickup confirmed successfully.'
          : 'Drop-off confirmed successfully.'
      );
    } catch (e) {
      setSelfServiceError(String(e.message || e));
    } finally {
      setSelfServiceBusyStage('');
    }
  };

  return (
    <div style={portalStyles.stack}>
      <div style={portalStyles.card}>
        <h3 style={portalStyles.cardTitle}>Action Center</h3>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={portalStyles.statGrid}>
            <div style={portalStyles.statTile}>
              <div style={portalStyles.statLabel}>Current Step</div>
              <div style={portalStyles.statValue}>{currentStepLabel || portal.progress?.currentStep || 'Complete'}</div>
            </div>
            <div style={portalStyles.statTile}>
              <div style={portalStyles.statLabel}>Next Action</div>
              <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.35 }}>{portal.progress?.nextAction || 'Nothing pending.'}</div>
            </div>
          </div>
          <div style={{ ...portalStyles.notice, background: 'rgba(79, 70, 229, 0.08)', color: '#4338ca' }}>
            Keep an eye on your email too. We send the next secure step there so you can finish everything before pickup.
          </div>
          {showNextLink ? (
            <a href={nextStep.link} target="_blank" rel="noreferrer" style={{ ...portalStyles.button, textDecoration: 'none' }}>
              Continue to {nextStep.label}
            </a>
          ) : null}
        </div>
      </div>

      <div style={portalStyles.card}>
        <h3 style={portalStyles.cardTitle}>Booking Snapshot</h3>
        <div style={portalStyles.statGrid}>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Reservation</div>
            <div style={portalStyles.statValue}>{reservation?.reservationNumber || '-'}</div>
          </div>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Vehicle</div>
            <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.35 }}>{reservation?.vehicle || '-'}</div>
          </div>
        </div>
        <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
          <div>
            <div style={portalStyles.statLabel}>Pickup</div>
            <div style={{ fontWeight: 700 }}>{formatWhen(reservation?.pickupAt)}</div>
            <div style={{ fontSize: 13, color: '#746294' }}>{reservation?.pickupLocation || '-'}</div>
          </div>
          <div>
            <div style={portalStyles.statLabel}>Return</div>
            <div style={{ fontWeight: 700 }}>{formatWhen(reservation?.returnAt)}</div>
            <div style={{ fontSize: 13, color: '#746294' }}>{reservation?.returnLocation || '-'}</div>
          </div>
        </div>
      </div>

      <div style={portalStyles.card}>
        <h3 style={portalStyles.cardTitle}>Payment Snapshot</h3>
        <div style={portalStyles.statGrid}>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Estimated Total</div>
            <div style={portalStyles.statValue}>{formatMoney(estimatedTotal)}</div>
          </div>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Paid So Far</div>
            <div style={portalStyles.statValue}>{formatMoney(paidAmount)}</div>
          </div>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Due Now</div>
            <div style={portalStyles.statValue}>{formatMoney(dueToday)}</div>
          </div>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Payment Status</div>
            <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.35 }}>{portal.payment?.statusLabel || '-'}</div>
          </div>
        </div>
        <div style={{ marginTop: 12, color: '#55456f', lineHeight: 1.55 }}>
          {dueToday > 0
            ? `The amount due right now is ${formatMoney(dueToday)}. Your full reservation estimate is ${formatMoney(estimatedTotal)}.`
            : `You're caught up right now. Your full reservation estimate is ${formatMoney(estimatedTotal)}.`}
        </div>
      </div>

      <div style={portalStyles.card}>
        <h3 style={portalStyles.cardTitle}>Completion Status</h3>
        <div style={portalStyles.statGrid}>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Progress</div>
            <div style={portalStyles.statValue}>{portal.progress?.completedSteps || 0}/{portal.progress?.totalSteps || 0}</div>
          </div>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Complete</div>
            <div style={portalStyles.statValue}>{portal.progress?.percent || 0}%</div>
          </div>
        </div>
      </div>

      {selfService ? (
        <div style={portalStyles.card}>
          <h3 style={portalStyles.cardTitle}>Self-Service Handoff</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>{selfService.keyExchangeLabel || 'Handoff'}</strong>
              <span style={{ ...portalStyles.secondaryButton, minHeight: 28, padding: '0 10px', border: 'none', background: selfServiceTone.background, color: selfServiceTone.color }}>
                {String(selfService.status || 'DISABLED').toLowerCase()}
              </span>
            </div>
            <div style={{ fontSize: 14, color: '#55456f', lineHeight: 1.55 }}>
              {selfService.readinessSummary || 'Self-service handoff summary unavailable.'}
            </div>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Pickup Ready</div>
                <div style={portalStyles.statValue}>{selfService.readyForPickup ? 'Yes' : 'No'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Drop-off Ready</div>
                <div style={portalStyles.statValue}>{selfService.readyForDropoff ? 'Yes' : 'No'}</div>
              </div>
            </div>
            <div style={{ fontSize: 13, color: '#746294', lineHeight: 1.6 }}>
              <div><strong>Pickup:</strong> {selfService.timestamps?.pickupLabel || 'Pending'} · {selfService.pickup?.operatingWindow || 'Hours unavailable'}</div>
              {selfService.pickup?.pointLabel ? <div><strong>Pickup Point:</strong> {selfService.pickup.pointLabel}</div> : null}
              {selfService.confirmations?.pickup?.confirmedAt ? <div><strong>Pickup Confirmed:</strong> {formatWhen(selfService.confirmations.pickup.confirmedAt)}</div> : null}
              <div><strong>Drop-off:</strong> {selfService.timestamps?.dropoffLabel || 'Pending'} · {selfService.dropoff?.operatingWindow || 'Hours unavailable'}</div>
              {selfService.dropoff?.pointLabel ? <div><strong>Drop-off Point:</strong> {selfService.dropoff.pointLabel}</div> : null}
              {selfService.confirmations?.dropoff?.confirmedAt ? <div><strong>Drop-off Confirmed:</strong> {formatWhen(selfService.confirmations.dropoff.confirmedAt)}</div> : null}
              {selfService.supportPhone ? <div><strong>Support:</strong> {selfService.supportPhone}</div> : null}
            </div>
            {!selfService.readyForPickup && (selfService.pickup?.blockers || []).length ? (
              <div style={{ ...portalStyles.notice, background: 'rgba(220, 38, 38, 0.08)', color: '#991b1b' }}>
                Pickup blockers: {(selfService.pickup?.blockers || []).join(' ')}
              </div>
            ) : null}
            {!selfService.readyForDropoff && (selfService.dropoff?.blockers || []).length ? (
              <div style={{ ...portalStyles.notice, background: 'rgba(245, 158, 11, 0.15)', color: '#92400e' }}>
                Drop-off blockers: {(selfService.dropoff?.blockers || []).join(' ')}
              </div>
            ) : null}
            {selfService.pickup?.instructions ? (
              <div style={{ ...portalStyles.notice, background: 'rgba(79, 70, 229, 0.08)', color: '#4338ca' }}>
                Pickup instructions: {selfService.pickup.instructions}
              </div>
            ) : null}
            {selfService.dropoff?.instructions ? (
              <div style={{ ...portalStyles.notice, background: 'rgba(16, 86, 139, 0.08)', color: '#10568b' }}>
                Drop-off instructions: {selfService.dropoff.instructions}
              </div>
            ) : null}
            {(selfService.canConfirmPickup || selfService.canConfirmDropoff) ? (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {selfService.canConfirmPickup ? (
                  <button
                    type="button"
                    onClick={() => confirmSelfServiceStage('PICKUP')}
                    disabled={selfServiceBusyStage === 'PICKUP' || !canConfirm}
                    style={portalStyles.button}
                  >
                    {selfServiceBusyStage === 'PICKUP' ? 'Confirming Pickup...' : 'Confirm Pickup Complete'}
                  </button>
                ) : null}
                {selfService.canConfirmDropoff ? (
                  <button
                    type="button"
                    onClick={() => confirmSelfServiceStage('DROPOFF')}
                    disabled={selfServiceBusyStage === 'DROPOFF' || !canConfirm}
                    style={portalStyles.secondaryButton}
                  >
                    {selfServiceBusyStage === 'DROPOFF' ? 'Confirming Drop-off...' : 'Confirm Drop-off Complete'}
                  </button>
                ) : null}
              </div>
            ) : null}
            {selfServiceError ? (
              <div style={{ ...portalStyles.notice, background: 'rgba(220, 38, 38, 0.12)', color: '#991b1b' }}>
                {selfServiceError}
              </div>
            ) : null}
            {selfServiceOk ? (
              <div style={{ ...portalStyles.notice, background: 'rgba(22, 163, 74, 0.12)', color: '#166534' }}>
                {selfServiceOk}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div style={portalStyles.card}>
        <h3 style={portalStyles.cardTitle}>Documents & Receipts</h3>
        <div style={{ display: 'grid', gap: 10 }}>
          {(portal.documents || []).map((doc) => (
            <div key={doc.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(105, 85, 171, 0.12)', flexWrap: 'wrap' }}>
              <div>
                <div><strong>{doc.label}</strong></div>
                <div style={{ fontSize: 12, color: '#746294' }}>{doc.available ? 'Available now' : 'Available after the step is completed'}</div>
              </div>
              {doc.available ? (
                <a
                  href={`${API_BASE}${doc.downloadPath}`}
                  target="_blank"
                  rel="noreferrer"
                  style={portalStyles.secondaryButton}
                >
                  Download
                </a>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div style={portalStyles.card}>
        <h3 style={portalStyles.cardTitle}>Portal Timeline</h3>
        <div style={{ display: 'grid', gap: 12 }}>
          {(portal.timeline || []).map((item) => {
            const tone = statusTone(item.status);
            return (
              <div key={item.key} style={{ display: 'grid', gap: 6, paddingBottom: 12, borderBottom: '1px solid rgba(105, 85, 171, 0.12)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong>{item.label}</strong>
                  <span style={{ ...portalStyles.secondaryButton, minHeight: 28, padding: '0 10px', border: 'none', background: tone.background, color: tone.color }}>
                    {item.status}
                  </span>
                </div>
                <div style={{ fontSize: 14, color: '#55456f', lineHeight: 1.5 }}>{item.description || '-'}</div>
                <div style={{ fontSize: 12, color: '#746294' }}>{formatWhen(item.at)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
