import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rentalAgreementsService } from './rental-agreements.service.js';

// Wait for scheduled microtasks/timers to flush — setImmediate callbacks run
// on the check-phase of the event loop. A single `await setImmediate()` is
// insufficient because the chained `.then` inside the job itself schedules
// more microtasks. Loop a few ticks to drain them.
async function drainEventLoop(ticks = 5) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('scheduleEmailDelivery', () => {
  it('returns 202-shape response quickly when `to` is in payload', async () => {
    let emailCalled = false;
    const started = Date.now();
    const result = await rentalAgreementsService.scheduleEmailDelivery(
      'agr-1',
      { to: 'user@example.com' },
      'actor-1',
      'ten-1',
      {
        runEmail: async () => { emailCalled = true; return { ok: true, to: 'user@example.com' }; },
        findAgreement: async () => { throw new Error('should not look up agreement when `to` provided'); },
        writeAudit: async () => { throw new Error('audit should not fire on success'); },
        captureException: () => {},
        scheduler: setImmediate
      }
    );
    const elapsed = Date.now() - started;

    assert.deepEqual(result, { ok: true, queued: true, to: 'user@example.com' });
    assert.ok(elapsed < 50, `scheduleEmailDelivery should return in <50ms, took ${elapsed}ms`);
    assert.equal(emailCalled, false, 'email job should NOT have run synchronously');

    await drainEventLoop();
    assert.equal(emailCalled, true, 'email job must run after scheduler fires');
  });

  it('explicit payload.to takes precedence over agreement email', async () => {
    let emailRunWith = null;
    let findAgreementCalled = false;
    await rentalAgreementsService.scheduleEmailDelivery(
      'agr-precedence',
      { to: 'override@example.com' },
      'actor',
      'ten',
      {
        runEmail: async (id, p) => { emailRunWith = p?.to; return { ok: true }; },
        findAgreement: async () => { findAgreementCalled = true; return { customerEmail: 'original@example.com' }; },
        writeAudit: async () => {},
        captureException: () => {},
        scheduler: setImmediate
      }
    );
    await drainEventLoop();
    assert.equal(emailRunWith, 'override@example.com', 'runEmail must receive the override `to` from payload');
    assert.equal(findAgreementCalled, false, 'findAgreement must NOT be called when `to` is in payload');
  });

  it('looks up agreement email when payload has no `to`', async () => {
    let emailCalled = false;
    const result = await rentalAgreementsService.scheduleEmailDelivery(
      'agr-2',
      {},
      null,
      't1',
      {
        runEmail: async () => { emailCalled = true; return { ok: true }; },
        findAgreement: async () => ({ reservationId: 'r1', tenantId: 't1', customerEmail: 'fallback@example.com' }),
        writeAudit: async () => {},
        captureException: () => {},
        scheduler: setImmediate
      }
    );
    assert.equal(result.to, 'fallback@example.com');
    await drainEventLoop();
    assert.equal(emailCalled, true);
  });

  it('rejects with 400 when no email can be resolved', async () => {
    await assert.rejects(
      rentalAgreementsService.scheduleEmailDelivery(
        'agr-3',
        {},
        null,
        't1',
        {
          runEmail: async () => { throw new Error('should not be called'); },
          findAgreement: async () => ({ reservationId: 'r1', tenantId: 't1', customerEmail: null, reservation: { customer: { email: null } } }),
          writeAudit: async () => {},
          captureException: () => {},
          scheduler: setImmediate
        }
      ),
      (err) => err.statusCode === 400 && /email is required/i.test(err.message)
    );
  });

  it('writes an audit log entry when the async email job fails', async () => {
    let auditPayload = null;
    let capturedError = null;

    await rentalAgreementsService.scheduleEmailDelivery(
      'agr-4',
      { to: 'user@example.com' },
      'actor-4',
      'ten-4',
      {
        runEmail: async () => { throw new Error('SMTP exploded'); },
        findAgreement: async () => ({ reservationId: 'res-4', tenantId: 'ten-4' }),
        writeAudit: async (data) => { auditPayload = data; },
        captureException: (err, ctx) => { capturedError = { err, ctx }; },
        scheduler: setImmediate
      }
    );

    await drainEventLoop(10);

    assert.ok(capturedError, 'Sentry should have been notified');
    assert.equal(capturedError.ctx.context, 'emailAgreement async');
    assert.equal(capturedError.ctx.agreementId, 'agr-4');
    assert.equal(capturedError.ctx.tenantId, 'ten-4', 'tenantId must be tagged in Sentry context for routing');

    assert.ok(auditPayload, 'audit log must be written on failure');
    assert.equal(auditPayload.reservationId, 'res-4');
    assert.equal(auditPayload.tenantId, 'ten-4');
    assert.equal(auditPayload.actorUserId, 'actor-4');
    assert.equal(auditPayload.action, 'UPDATE');
    assert.match(auditPayload.reason, /email FAILED for user@example\.com/i);
    assert.match(auditPayload.reason, /SMTP exploded/);
  });

  it('does not throw if the audit write itself fails (best-effort)', async () => {
    let loggedAuditFailure = false;
    await rentalAgreementsService.scheduleEmailDelivery(
      'agr-5',
      { to: 'user@example.com' },
      null,
      null,
      {
        runEmail: async () => { throw new Error('primary failure'); },
        findAgreement: async () => ({ reservationId: 'res-5', tenantId: null }),
        writeAudit: async () => { throw new Error('audit write failed'); },
        captureException: () => {},
        scheduler: setImmediate,
        logger: { error: (msg) => { if (/audit write also failed/.test(msg)) loggedAuditFailure = true; } }
      }
    );
    // Draining the loop should not surface an unhandled rejection. If it
    // does, node:test reports it as an error on this test.
    await drainEventLoop(10);
    assert.equal(loggedAuditFailure, true, 'audit-write failure must be logged (no silent black hole)');
  });

  it('does not throw if captureException itself fails (defense-in-depth)', async () => {
    // If the Sentry SDK itself blows up during a job failure, we still want
    // the audit log path to fire and the process not to crash with an
    // unhandled rejection.
    let auditWritten = false;
    await rentalAgreementsService.scheduleEmailDelivery(
      'agr-6',
      { to: 'user@example.com' },
      null,
      'ten-6',
      {
        runEmail: async () => { throw new Error('primary failure'); },
        findAgreement: async () => ({ reservationId: 'res-6', tenantId: 'ten-6' }),
        writeAudit: async () => { auditWritten = true; },
        captureException: () => { throw new Error('Sentry SDK exploded'); },
        scheduler: setImmediate,
        logger: {}
      }
    );
    await drainEventLoop(10);
    assert.equal(auditWritten, true, 'audit log must still fire even if captureException throws');
  });

  it('passes tenantId to the default findAgreement so the async path is tenant-scoped', async () => {
    // Defense-in-depth contract: when payload has no `to`, the service must
    // look up the agreement via findAgreement(id, tenantId). If tenantId is
    // dropped or ignored, a request for an agreement of another tenant could
    // slip through if the route guard is ever removed.
    let receivedTenantId = '__not-called__';
    await rentalAgreementsService.scheduleEmailDelivery(
      'agr-7',
      {},
      'actor',
      'ten-expected',
      {
        runEmail: async () => ({ ok: true }),
        findAgreement: async (aid, tid) => {
          receivedTenantId = tid;
          return { reservationId: 'r7', tenantId: 'ten-expected', customerEmail: 'x@example.com' };
        },
        writeAudit: async () => {},
        captureException: () => {},
        scheduler: setImmediate
      }
    );
    await drainEventLoop();
    assert.equal(receivedTenantId, 'ten-expected', 'findAgreement must receive the tenantId for scoping');
  });

  it('null tenantId (super-admin) passes through to findAgreement without filter', async () => {
    let receivedTenantId = '__not-called__';
    await rentalAgreementsService.scheduleEmailDelivery(
      'agr-8',
      {},
      'sa-actor',
      null, // super-admin context
      {
        runEmail: async () => ({ ok: true }),
        findAgreement: async (aid, tid) => {
          receivedTenantId = tid;
          return { reservationId: 'r8', tenantId: 'whatever', customerEmail: 'sa@example.com' };
        },
        writeAudit: async () => {},
        captureException: () => {},
        scheduler: setImmediate
      }
    );
    await drainEventLoop();
    assert.equal(receivedTenantId, null, 'super-admin must pass null tenantId (matches crossTenantScopeFor)');
  });
});
