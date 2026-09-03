/**
 * Kiosk ↔ Valet bridge — F0 (G3) honest `flow_completed` refusal + v4
 * additive `kioskSessionId` (2026-09-03). Contract: KIOSK-EMBED.md v3/v4.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FLOW_COMPLETED_FALLBACK_REASON,
  ackKioskCommand,
  decideFlowCompletedAck,
  noteFirstRefusal,
  postKioskState,
  voziaPendingStepKey,
} from '../src/lib/voziaBridge.js';

const HOST = 'https://valet.example.test';
const IDENTITY = { conversationId: 'conv-1', secret: 's3cret' };

function lastBody() {
  const call = global.fetch.mock.calls.at(-1);
  return { url: call[0], body: JSON.parse(call[1].body), headers: call[1].headers };
}

describe('decideFlowCompletedAck (pure)', () => {
  it('success → plain ack (refused:false)', () => {
    expect(decideFlowCompletedAck({ ok: true })).toEqual({ refused: false });
  });

  it('server gate 409 CHECKOUT_NOT_CLOSED → refused with the server enum as reason', () => {
    expect(decideFlowCompletedAck({ ok: false, errorCode: 'CHECKOUT_NOT_CLOSED' }))
      .toEqual({ refused: true, reason: 'CHECKOUT_NOT_CLOSED' });
  });

  it('network / unpaired client codes pass through as enums', () => {
    expect(decideFlowCompletedAck({ ok: false, errorCode: 'NETWORK_UNAVAILABLE' }).reason).toBe('NETWORK_UNAVAILABLE');
    expect(decideFlowCompletedAck({ ok: false, errorCode: 'NO_SESSION' }).reason).toBe('NO_SESSION');
  });

  it('missing or non-enum error code → generic fallback (never free text / PII)', () => {
    expect(decideFlowCompletedAck({ ok: false }).reason).toBe(FLOW_COMPLETED_FALLBACK_REASON);
    expect(decideFlowCompletedAck({ ok: false, errorCode: null }).reason).toBe(FLOW_COMPLETED_FALLBACK_REASON);
    expect(decideFlowCompletedAck({ ok: false, errorCode: 'Request failed (500)' }).reason).toBe(FLOW_COMPLETED_FALLBACK_REASON);
    expect(decideFlowCompletedAck({ ok: false, errorCode: 'juan perez 787-555-0100' }).reason).toBe(FLOW_COMPLETED_FALLBACK_REASON);
    expect(decideFlowCompletedAck({ ok: false, errorCode: 'lowercase_code' }).reason).toBe(FLOW_COMPLETED_FALLBACK_REASON);
  });

  it('no args → refused (fail-closed)', () => {
    expect(decideFlowCompletedAck()).toEqual({ refused: true, reason: FLOW_COMPLETED_FALLBACK_REASON });
  });
});

describe('ackKioskCommand', () => {
  beforeEach(() => { global.fetch = vi.fn(() => Promise.resolve({ ok: true })); });
  afterEach(() => { delete global.fetch; });

  it('plain ack body is exactly { commandId } (unchanged v2 behavior)', async () => {
    await ackKioskCommand(HOST, IDENTITY, 12);
    const { url, body, headers } = lastBody();
    expect(url).toBe(`${HOST}/api/conversations/conv-1/kiosk-ack`);
    expect(body).toEqual({ commandId: 12 });
    expect(headers['x-conversation-secret']).toBe('s3cret');
  });

  it('refusal ack carries refused:true + sanitized enum reason (v3)', async () => {
    await ackKioskCommand(HOST, IDENTITY, 12, { refused: true, reason: 'CHECKOUT_NOT_CLOSED' });
    expect(lastBody().body).toEqual({ commandId: 12, refused: true, reason: 'CHECKOUT_NOT_CLOSED' });
  });

  it('refusal with free-text reason is coerced to the fallback enum', async () => {
    await ackKioskCommand(HOST, IDENTITY, 12, { refused: true, reason: 'guest said no thanks' });
    expect(lastBody().body).toEqual({ commandId: 12, refused: true, reason: FLOW_COMPLETED_FALLBACK_REASON });
  });

  it('refused:false / null refusal → plain ack', async () => {
    await ackKioskCommand(HOST, IDENTITY, 12, { refused: false });
    expect(lastBody().body).toEqual({ commandId: 12 });
    await ackKioskCommand(HOST, IDENTITY, 13, null);
    expect(lastBody().body).toEqual({ commandId: 13 });
  });

  it('no identity → no network call', async () => {
    await ackKioskCommand(HOST, { conversationId: null, secret: null }, 12, { refused: true, reason: 'X_Y' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('postKioskState — v4 additive kioskSessionId', () => {
  beforeEach(() => { global.fetch = vi.fn(() => Promise.resolve({ ok: true })); });
  afterEach(() => { delete global.fetch; });

  it('sends kioskSessionId alongside the enum-only payload', async () => {
    await postKioskState(HOST, IDENTITY, {
      step: 'payment', stepNumber: 4, totalSteps: 5, attempts: 1, kioskSessionId: 'ks_abc123',
    });
    const { url, body } = lastBody();
    expect(url).toBe(`${HOST}/api/conversations/conv-1/kiosk-state`);
    expect(body).toEqual({
      flow: 'checkin', step: 'payment', stepNumber: 4, totalSteps: 5, attempts: 1, kioskSessionId: 'ks_abc123',
    });
  });

  it('omits kioskSessionId when there is no session (WELCOME / pre-lookup)', async () => {
    await postKioskState(HOST, IDENTITY, { step: 'find_reservation', stepNumber: 1, totalSteps: 5, attempts: 1 });
    expect(lastBody().body).not.toHaveProperty('kioskSessionId');
  });

  it('still refuses to post a non-whitelisted step (no 400 storm)', async () => {
    await postKioskState(HOST, IDENTITY, { step: 'free text', stepNumber: 1, totalSteps: 5, kioskSessionId: 'ks_x' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('voziaPendingStepKey — actionable refusal toast (GD SHOULD 2)', () => {
  it('maps every wizard screen to the stepper label key it belongs to', () => {
    expect(voziaPendingStepKey('LOOKUP')).toBe('kiosk.stepReservation');
    expect(voziaPendingStepKey('SUMMARY')).toBe('kiosk.stepReservation');
    for (const s of ['ID', 'SELFIE', 'NAME_UPDATE', 'STAFF_ASSIST']) expect(voziaPendingStepKey(s)).toBe('kiosk.stepId');
    expect(voziaPendingStepKey('OFFERS')).toBe('kiosk.stepExtras');
    expect(voziaPendingStepKey('PAYMENT')).toBe('kiosk.stepPayment');
    expect(voziaPendingStepKey('SIGN')).toBe('kiosk.stepSign');
  });

  it('screens outside the stepper fall back to null (generic wording)', () => {
    for (const s of ['WELCOME', 'DONE', 'ESCALATED', 'PAIRING', 'OUT_OF_SERVICE', 'BOOT', undefined, null, '']) {
      expect(voziaPendingStepKey(s)).toBeNull();
    }
  });
});

describe('noteFirstRefusal — redelivery storm guard (Innovation SHOULD 5)', () => {
  it('first sighting of a conversation:command key → true, then false forever', () => {
    const seen = new Set();
    expect(noteFirstRefusal(seen, 'conv-1:12')).toBe(true);
    expect(noteFirstRefusal(seen, 'conv-1:12')).toBe(false);
    expect(noteFirstRefusal(seen, 'conv-1:12')).toBe(false);
    expect(seen.size).toBe(1);
  });

  it('same command id in another conversation is a fresh first time', () => {
    const seen = new Set();
    expect(noteFirstRefusal(seen, 'conv-1:12')).toBe(true);
    expect(noteFirstRefusal(seen, 'conv-2:12')).toBe(true);
    expect(noteFirstRefusal(seen, 'conv-1:13')).toBe(true);
    expect(seen.size).toBe(3);
  });

  it('never throws and never notifies on a bad set or key', () => {
    expect(noteFirstRefusal(null, 'x')).toBe(false);
    expect(noteFirstRefusal({}, 'x')).toBe(false);
    expect(noteFirstRefusal(new Set(), null)).toBe(false);
    expect(noteFirstRefusal(new Set(), undefined)).toBe(false);
  });

  it('simulates the storm: 500 redeliveries of one refused command → 1 notification', () => {
    const seen = new Set();
    let notified = 0;
    for (let i = 0; i < 500; i += 1) if (noteFirstRefusal(seen, 'conv-1:12')) notified += 1;
    expect(notified).toBe(1);
  });
});
