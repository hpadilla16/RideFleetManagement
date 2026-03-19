'use client';

import { API_BASE } from '../../../lib/client';

function formatWhen(value) {
  if (!value) return 'Pending';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Pending';
  return d.toLocaleString();
}

export function PortalTimelineCard({ portal }) {
  if (!portal) return null;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Portal Timeline</h3>
        <div style={{ display: 'grid', gap: 10 }}>
          {(portal.timeline || []).map((item) => (
            <div key={item.key} style={{ borderBottom: '1px solid #eee', paddingBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>{item.label}</strong>
                <span style={{ textTransform: 'capitalize' }}>{item.status}</span>
              </div>
              <div style={{ fontSize: 13, color: '#555' }}>{item.description || '-'}</div>
              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>{formatWhen(item.at)}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Documents & Receipts</h3>
        <div style={{ display: 'grid', gap: 8 }}>
          {(portal.documents || []).map((doc) => (
            <div key={doc.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div><strong>{doc.label}</strong></div>
                <div style={{ fontSize: 12, color: '#666' }}>{doc.available ? 'Available' : 'Not available yet'}</div>
              </div>
              {doc.available ? (
                <a
                  href={`${API_BASE}${doc.downloadPath}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-block', padding: '8px 12px', border: '1px solid #ddd', borderRadius: 6, textDecoration: 'none' }}
                >
                  Download
                </a>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Current Status</h3>
        <div><strong>Reservation:</strong> {portal.reservationStatus || '-'}</div>
        <div><strong>Agreement:</strong> {portal.agreement?.agreementNumber ? `${portal.agreement.agreementNumber} (${portal.agreement.status})` : 'Pending'}</div>
        <div><strong>Payments Recorded:</strong> {Number(portal.payment?.paidAmount || 0).toFixed(2)}</div>
      </div>
    </div>
  );
}
