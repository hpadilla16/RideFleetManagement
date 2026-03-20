'use client';

import { API_BASE } from '../../../lib/client';
import { portalStyles } from './PortalFrame';

function formatWhen(value) {
  if (!value) return 'Pending';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Pending';
  return d.toLocaleString();
}

function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'completed') return { color: '#12633d', background: 'rgba(43, 174, 96, 0.14)' };
  if (value === 'active') return { color: '#10568b', background: 'rgba(48, 135, 214, 0.14)' };
  if (value === 'requested') return { color: '#7a4f08', background: 'rgba(255, 191, 71, 0.18)' };
  return { color: '#6f5b8f', background: 'rgba(111, 91, 143, 0.1)' };
}

export function PortalTimelineCard({ portal }) {
  if (!portal) return null;

  return (
    <div style={portalStyles.stack}>
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
        <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
          <div>
            <div style={portalStyles.statLabel}>Current Step</div>
            <div style={{ fontWeight: 700 }}>{portal.progress?.currentStep || 'Complete'}</div>
          </div>
          <div>
            <div style={portalStyles.statLabel}>Next Action</div>
            <div style={{ color: '#55456f', lineHeight: 1.5 }}>{portal.progress?.nextAction || 'Nothing pending.'}</div>
          </div>
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
        <h3 style={portalStyles.cardTitle}>Current Status</h3>
        <div style={portalStyles.statGrid}>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Reservation</div>
            <div style={portalStyles.statValue}>{portal.reservationStatus || '-'}</div>
          </div>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Agreement</div>
            <div style={portalStyles.statValue}>{portal.agreement?.agreementNumber || 'Pending'}</div>
          </div>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Paid</div>
            <div style={portalStyles.statValue}>${Number(portal.payment?.paidAmount || 0).toFixed(2)}</div>
          </div>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Balance Due</div>
            <div style={portalStyles.statValue}>${Number(portal.payment?.balanceDue || 0).toFixed(2)}</div>
          </div>
          <div style={portalStyles.statTile}>
            <div style={portalStyles.statLabel}>Payment Status</div>
            <div style={portalStyles.statValue}>{portal.payment?.statusLabel || '-'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
