/**
 * Validation tests for the public website contact endpoint service
 * (publicBookingService.submitContactMessage). These cover the input-guard
 * branches that run BEFORE any DB/email access, so no DATABASE_URL is needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicBookingService } from './public-booking.service.js';

test('submitContactMessage requires name', async () => {
  await assert.rejects(() => publicBookingService.submitContactMessage({ email: 'a@b.com', message: 'hi', tenantId: 't1' }), /name is required/i);
});
test('submitContactMessage requires a valid email', async () => {
  await assert.rejects(() => publicBookingService.submitContactMessage({ name: 'Joe', email: 'nope', message: 'hi', tenantId: 't1' }), /valid email/i);
  await assert.rejects(() => publicBookingService.submitContactMessage({ name: 'Joe', message: 'hi', tenantId: 't1' }), /valid email/i);
});
test('submitContactMessage requires message', async () => {
  await assert.rejects(() => publicBookingService.submitContactMessage({ name: 'Joe', email: 'a@b.com', tenantId: 't1' }), /message is required/i);
});
test('submitContactMessage requires tenant', async () => {
  await assert.rejects(() => publicBookingService.submitContactMessage({ name: 'Joe', email: 'a@b.com', message: 'hi' }), /tenant is required/i);
});
