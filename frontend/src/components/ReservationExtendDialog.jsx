'use client';

import { useState } from 'react';
import { api } from '../lib/client';

export function ReservationExtendDialog({ reservation, token, onExtended, onCancel }) {
  const [newReturnAt, setNewReturnAt] = useState('');
  const [useCustomRate, setUseCustomRate] = useState(false);
  const [customRate, setCustomRate] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (!newReturnAt) {
        throw new Error('New return date is required');
      }

      const payload = {
        newReturnAt,
        extensionDailyRate: useCustomRate ? (customRate ? Number(customRate) : 0) : null,
        note: note.trim()
      };

      const result = await api(`/api/reservations/${reservation.id}/extend`, payload, token, 'POST');

      if (onExtended) {
        onExtended(result);
      }
    } catch (e) {
      setError(e.message || 'Failed to extend reservation');
    } finally {
      setLoading(false);
    }
  };

  const currentReturnAt = reservation?.returnAt ? new Date(reservation.returnAt).toISOString().slice(0, 16) : '';

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: '#fff',
        borderRadius: 16,
        padding: 24,
        maxWidth: 500,
        width: '90%',
        maxHeight: '90vh',
        overflowY: 'auto',
        boxShadow: '0 10px 40px rgba(0,0,0,0.2)'
      }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: 20, fontWeight: 600 }}>Extend Reservation</h2>
        <p style={{ margin: '0 0 20px 0', color: '#666', fontSize: 14 }}>
          Extend the return date for {reservation?.reservationNumber}. Original return: {currentReturnAt}
        </p>

        {error && (
          <div style={{
            backgroundColor: '#fee',
            color: '#c00',
            padding: 12,
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 14
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
              New Return Date & Time
            </label>
            <input
              type="datetime-local"
              value={newReturnAt}
              onChange={(e) => setNewReturnAt(e.target.value)}
              disabled={loading}
              style={{
                width: '100%',
                padding: '10px 8px',
                border: '1px solid #ddd',
                borderRadius: 8,
                fontSize: 14,
                fontFamily: 'inherit',
                boxSizing: 'border-box'
              }}
              required
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
              <input
                type="checkbox"
                checked={useCustomRate}
                onChange={(e) => setUseCustomRate(e.target.checked)}
                disabled={loading}
              />
              Apply custom daily rate (extension only)
            </label>
          </div>

          {useCustomRate && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
                Daily Rate ($)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={customRate}
                onChange={(e) => setCustomRate(e.target.value)}
                disabled={loading}
                placeholder="0.00"
                style={{
                  width: '100%',
                  padding: '10px 8px',
                  border: '1px solid #ddd',
                  borderRadius: 8,
                  fontSize: 14,
                  fontFamily: 'inherit',
                  boxSizing: 'border-box'
                }}
              />
              <p style={{ margin: '6px 0 0 0', color: '#666', fontSize: 12 }}>
                Leave empty or 0 for free extension. Current daily rate: ${Number(reservation?.dailyRate || 0).toFixed(2)}
              </p>
            </div>
          )}

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: 14 }}>
              Notes (optional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={loading}
              placeholder="e.g., Customer requested extension..."
              style={{
                width: '100%',
                padding: '10px 8px',
                border: '1px solid #ddd',
                borderRadius: 8,
                fontSize: 14,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                minHeight: 80,
                resize: 'vertical'
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onCancel}
              disabled={loading}
              style={{
                padding: '10px 20px',
                borderRadius: 8,
                border: '1px solid #ddd',
                backgroundColor: '#fff',
                color: '#333',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 500,
                opacity: loading ? 0.6 : 1
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{
                padding: '10px 20px',
                borderRadius: 8,
                border: 'none',
                backgroundColor: '#8752FE',
                color: '#fff',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 500,
                opacity: loading ? 0.6 : 1
              }}
            >
              {loading ? 'Extending...' : 'Extend'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
