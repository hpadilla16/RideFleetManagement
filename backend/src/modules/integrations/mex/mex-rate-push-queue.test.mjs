/**
 * The rate push runs on the SAME queue as the reservation sync, on purpose.
 *
 * Both drive one single-window TSD account; two concurrent sessions kick each
 * other's login (measured 2026-08-06: the first push dry-run collided with the
 * 15-min sync and every screen bounced to login). mex.sync has concurrency 1,
 * so sharing it is the serialization.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';
process.env.INTEGRATION_ENC_KEY = process.env.INTEGRATION_ENC_KEY
  || Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

const worker = await import('./mex.worker.js');
const pushSvc = await import('./mex-rate-push.service.js');

describe('rate-push job dispatch', () => {
  it('a kind:rate-push job routes to the push, not the sync', async () => {
    // The sync path would throw on the missing configs/session; the push path
    // hits runMexRatePush which returns mode_off under the default env gate.
    const prev = process.env.MEX_RATE_PUSH_MODE;
    delete process.env.MEX_RATE_PUSH_MODE;
    try {
      const out = await worker.mexSyncHandler({ data: { kind: 'rate-push', tenantId: 't1' } });
      assert.deepEqual(out, { skipped: 'mode_off', mode: 'OFF' },
        'the push env gate answered — proof the job reached runMexRatePush');
    } finally {
      if (prev === undefined) delete process.env.MEX_RATE_PUSH_MODE;
      else process.env.MEX_RATE_PUSH_MODE = prev;
    }
  });

  it('a rate-push job without a tenant fails loudly', async () => {
    await assert.rejects(
      () => worker.mexSyncHandler({ data: { kind: 'rate-push' } }),
      /tenantId is required/,
    );
  });
});

describe('enqueueRatePushForEnabledTenants', () => {
  it('does not enqueue anything unless the env gate is LIVE', async () => {
    const prev = process.env.MEX_RATE_PUSH_MODE;
    try {
      process.env.MEX_RATE_PUSH_MODE = 'DRY_RUN';
      const out = await worker.enqueueRatePushForEnabledTenants({});
      assert.deepEqual(out, { skipped: 'mode_dry_run', queued: 0 },
        'a schedule must never push prices the operator has not switched on');
    } finally {
      if (prev === undefined) delete process.env.MEX_RATE_PUSH_MODE;
      else process.env.MEX_RATE_PUSH_MODE = prev;
    }
  });
});
