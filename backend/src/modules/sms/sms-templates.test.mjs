import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTemplates, getTemplate, renderTemplate, renderCustom } from './sms-templates.js';

describe('SMS Templates', () => {
  it('getTemplates returns all templates', () => {
    const templates = getTemplates();
    assert.ok(Array.isArray(templates));
    assert.ok(templates.length >= 8);
    assert.ok(templates.every((t) => t.id && t.label));
  });

  it('getTemplate returns template by ID', () => {
    const t = getTemplate('BOOKING_CONFIRMATION');
    assert.ok(t);
    assert.equal(t.id, 'BOOKING_CONFIRMATION');
    assert.ok(t.body.includes('{{guestName}}'));
  });

  it('getTemplate returns null for unknown ID', () => {
    assert.equal(getTemplate('NONEXISTENT'), null);
  });

  it('renderTemplate interpolates variables', () => {
    const result = renderTemplate('BOOKING_CONFIRMATION', {
      guestName: 'Maria Rodriguez',
      reservationNumber: 'RES-001',
      pickupAt: 'Apr 15, 10:00 AM',
      pickupLocation: 'SJU Airport',
      vehicleLabel: '2023 Toyota Corolla',
      total: '$250.00',
      companyName: 'Ride Fleet'
    });
    assert.ok(result.includes('Maria Rodriguez'));
    assert.ok(result.includes('RES-001'));
    assert.ok(result.includes('SJU Airport'));
    assert.ok(result.includes('$250.00'));
    assert.ok(result.includes('Ride Fleet'));
    assert.ok(!result.includes('{{guestName}}'));
  });

  it('renderTemplate keeps unresolved variables', () => {
    const result = renderTemplate('PICKUP_REMINDER', { reservationNumber: 'RES-002' });
    assert.ok(result.includes('RES-002'));
    assert.ok(result.includes('{{pickupAt}}')); // unresolved
    assert.ok(result.includes('{{pickupLocation}}')); // unresolved
  });

  it('renderTemplate throws for unknown template', () => {
    assert.throws(() => renderTemplate('FAKE_TEMPLATE', {}), /not found/i);
  });

  it('renderCustom interpolates custom body', () => {
    const result = renderCustom('Hello {{guestName}}, your trip {{tripCode}} is ready!', {
      guestName: 'Carlos',
      tripCode: 'TRIP-123'
    });
    assert.equal(result, 'Hello Carlos, your trip TRIP-123 is ready!');
  });

  it('renderCustom handles empty variables', () => {
    const result = renderCustom('Hi {{guestName}}', {});
    assert.equal(result, 'Hi {{guestName}}');
  });

  it('all templates have required fields', () => {
    for (const t of getTemplates()) {
      assert.ok(t.id, `Template missing id`);
      assert.ok(t.label, `Template ${t.id} missing label`);
      if (t.id !== 'CUSTOM') {
        assert.ok(t.body.length > 10, `Template ${t.id} body too short`);
      }
    }
  });

  it('PICKUP_REMINDER contains reservation and location vars', () => {
    const t = getTemplate('PICKUP_REMINDER');
    assert.ok(t.body.includes('{{reservationNumber}}'));
    assert.ok(t.body.includes('{{pickupAt}}'));
    assert.ok(t.body.includes('{{pickupLocation}}'));
  });

  it('TRIP_CHAT_INVITE contains chatLink var', () => {
    const t = getTemplate('TRIP_CHAT_INVITE');
    assert.ok(t.body.includes('{{chatLink}}'));
    assert.ok(t.body.includes('{{hostName}}'));
  });
});
