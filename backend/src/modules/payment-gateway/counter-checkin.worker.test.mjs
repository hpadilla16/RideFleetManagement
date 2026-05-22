/**
 * Tests for counter-checkin.worker.js (2026-05-21).
 * Run: node --test backend/src/modules/payment-gateway/counter-checkin.worker.test.mjs
 *
 * Exercises the handler with a mocked orchestrator. Enqueue/registration
 * paths (BullMQ) are covered by integration smoke tests during deploy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterCheckinHandler, QUEUE_NAME } from './counter-checkin.worker.js';

test('QUEUE_NAME is counter.checkin', () => {
  assert.equal(QUEUE_NAME, 'counter.checkin');
});

test('counterCheckinHandler validates required job data', async () => {
  await assert.rejects(
    () => counterCheckinHandler({ data: {} }, { runOrchestrator: async () => ({}) }),
    /missing reservationId\/terminalId/
  );
  await assert.rejects(
    () =>
      counterCheckinHandler(
        { data: { reservationId: 'r1', terminalId: 't1' } },
        { runOrchestrator: async () => ({}) }
      ),
    /missing userSnapshot.tenantId/
  );
});

test('counterCheckinHandler calls runOrchestrator with the expected shape', async () => {
  let receivedArgs = null;
  const result = await counterCheckinHandler(
    {
      data: {
        reservationId: 'r1',
        terminalId: 'term1',
        userSnapshot: { sub: 'u_alice', tenantId: 't1', role: 'AGENT' },
        ipAddress: '10.0.0.1',
        userAgent: 'TestAgent/1.0',
      },
    },
    {
      runOrchestrator: async (args) => {
        receivedArgs = args;
        return {
          signingId: 'sgn1',
          authReferenceId: 'AUTH-1',
          authAmountCents: 25000,
          completed: true,
        };
      },
    }
  );
  assert.equal(receivedArgs.reservationId, 'r1');
  assert.equal(receivedArgs.terminalId, 'term1');
  assert.equal(receivedArgs.user.tenantId, 't1');
  assert.equal(receivedArgs.user.sub, 'u_alice');
  assert.equal(receivedArgs.deps.ipAddress, '10.0.0.1');
  assert.equal(receivedArgs.deps.userAgent, 'TestAgent/1.0');
  assert.equal(result.signingId, 'sgn1');
  assert.equal(result.authAmountCents, 25000);
});

test('counterCheckinHandler propagates orchestrator errors', async () => {
  await assert.rejects(
    () =>
      counterCheckinHandler(
        {
          data: {
            reservationId: 'r1',
            terminalId: 'term1',
            userSnapshot: { sub: 'u', tenantId: 't1', role: 'AGENT' },
          },
        },
        {
          runOrchestrator: async () => {
            const err = new Error('AUTH declined');
            err.code = 'AUTH_DECLINED';
            throw err;
          },
        }
      ),
    /AUTH declined/
  );
});
