// PR 4 — Parallelize PUT /rental + GET /inspection-report on checkout.
// See docs/operations/checkout-perf-plan.md PR 4 and
// frontend/src/app/reservations/[id]/checkout/checkout-sync.js.

import { describe, it, expect, vi } from 'vitest';
import { syncRentalAndInspection } from '../src/app/reservations/[id]/checkout/checkout-sync.js';

const RENTAL_PAYLOAD = { vehicleId: 'veh-1', odometerOut: 12000, fuelOut: 1, cleanlinessOut: 5 };

describe('syncRentalAndInspection (PR 4)', () => {
  it('dispatches PUT /rental and GET /inspection-report synchronously — both in flight before either resolves', () => {
    // Each call returns an un-resolved promise so we can observe that *both*
    // were dispatched before we resolve anything. A sequential implementation
    // would only dispatch the second call after the first resolved — and with
    // these pending promises, it would never dispatch at all.
    const resolvers = [];
    const api = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));

    // Invoke without awaiting — we want to observe the sync side-effect.
    void syncRentalAndInspection('agr-1', RENTAL_PAYLOAD, { api, token: 'tok' });

    expect(api).toHaveBeenCalledTimes(2);

    const urls = api.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(
      expect.arrayContaining([
        '/api/rental-agreements/agr-1/rental',
        '/api/rental-agreements/agr-1/inspection-report'
      ])
    );

    // The PUT should carry method + body; the GET should not.
    const putCall = api.mock.calls.find((c) => c[0].endsWith('/rental'));
    const getCall = api.mock.calls.find((c) => c[0].endsWith('/inspection-report'));
    expect(putCall[1]).toMatchObject({ method: 'PUT' });
    expect(putCall[1].body).toBe(JSON.stringify(RENTAL_PAYLOAD));
    expect(getCall[1]).toEqual({});

    // Resolve in reverse order to prove there is no ordering dependency.
    resolvers[1]({ checkoutInspection: { at: '2026-04-19T18:00:00Z' } });
    resolvers[0]({ id: 'agr-1', status: 'DRAFT' });
  });

  it('returns the inspection-report when the checkout inspection is complete', async () => {
    const report = { checkoutInspection: { at: '2026-04-19T18:00:00Z' } };
    const api = vi.fn((url) =>
      url.endsWith('/rental') ? Promise.resolve({ id: 'agr-1' }) : Promise.resolve(report)
    );
    const result = await syncRentalAndInspection('agr-1', RENTAL_PAYLOAD, { api, token: 'tok' });
    expect(result).toBe(report);
  });

  it('throws with an actionable message if the checkout inspection is missing', async () => {
    const api = vi.fn((url) =>
      url.endsWith('/rental') ? Promise.resolve({ id: 'agr-1' }) : Promise.resolve({ checkoutInspection: null })
    );
    await expect(
      syncRentalAndInspection('agr-1', RENTAL_PAYLOAD, { api, token: 'tok' })
    ).rejects.toThrow(/Checkout inspection is required/);
  });

  it('propagates a PUT /rental failure without waiting for inspection-report', async () => {
    // Promise.all fail-fasts: if PUT rejects, the outer promise rejects even if
    // GET is still pending. The user sees the rental-persistence error and is
    // not blocked by a dangling inspection fetch.
    let inspectionResolver;
    const api = vi.fn((url) => {
      if (url.endsWith('/rental')) return Promise.reject(new Error('boom: 500'));
      return new Promise((r) => { inspectionResolver = r; });
    });
    await expect(
      syncRentalAndInspection('agr-1', RENTAL_PAYLOAD, { api, token: 'tok' })
    ).rejects.toThrow('boom: 500');
    // Still pending; the caller doesn't care. No leak because we didn't retain it.
    expect(typeof inspectionResolver).toBe('function');
  });
});
