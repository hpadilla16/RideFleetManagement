/**
 * Tests for counter-return.worker.js (2026-05-21).
 * Run: node --test backend/src/modules/payment-gateway/counter-return.worker.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterReturnHandler, QUEUE_NAME } from './counter-return.worker.js';

test('QUEUE_NAME is counter.return', () => {
  assert.equal(QUEUE_NAME, 'counter.return');
});

test('counterReturnHandler validates job data', async () => {
  await assert.rejects(
    () => counterReturnHandler({ data: {} }, { runOrchestrator: async () => ({}) }),
    /missing reservationId\/terminalId/
  );
  await assert.rejects(
    () =>
      counterReturnHandler(
        { data: { reservationId: 'r', terminalId: 't' } },
        { runOrchestrator: async () => ({}) }
      ),
    /missing userSnapshot.tenantId/
  );
});

test('counterReturnHandler passes finalAmountCents when present', async () => {
  let received = null;
  await counterReturnHandler(
    {
      data: {
        reservationId: 'r',
        terminalId: 't',
        userSnapshot: { sub: 'u', tenantId: 't1', role: 'AGENT' },
        finalAmountCents: 12345,
      },
    },
    {
      runOrchestrator: async (args) => {
        received = args;
        return { case: 'CAPTURE', capturedAmountCents: 12345, additionalSaleCents: 0 };
      },
    }
  );
  assert.equal(received.finalAmountCents, 12345);
  assert.equal(received.reservationId, 'r');
  assert.equal(received.user.tenantId, 't1');
});

test('counterReturnHandler omits finalAmountCents when null', async () => {
  let received = null;
  await counterReturnHandler(
    {
      data: {
        reservationId: 'r',
        terminalId: 't',
        userSnapshot: { sub: 'u', tenantId: 't1' },
        finalAmountCents: null,
      },
    },
    {
      runOrchestrator: async (args) => {
        received = args;
        return {};
      },
    }
  );
  // null becomes undefined so orchestrator can compute from charges
  assert.equal(received.finalAmountCents, undefined);
});

test('counterReturnHandler propagates errors', async () => {
  await assert.rejects(
    () =>
      counterReturnHandler(
        {
          data: {
            reservationId: 'r',
            terminalId: 't',
            userSnapshot: { sub: 'u', tenantId: 't1' },
          },
        },
        {
          runOrchestrator: async () => {
            throw new Error('boom');
          },
        }
      ),
    /boom/
  );
});
