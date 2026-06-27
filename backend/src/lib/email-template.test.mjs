import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBrandedEmail, resolveEmailBrand, RFM_DEFAULT_BRAND } from './email-template.js';

test('renders html + text with brand color, CTA, and footer', () => {
  const { html, text } = renderBrandedEmail({
    brand: { companyName: 'Rent & Go', brandColor: '#0f6e56', address: 'Guaynabo, PR', phone: '787-555' },
    heading: 'You\'re booked',
    bodyHtml: 'Your reservation <b>RES-1</b> is confirmed.',
    cta: { label: 'Start pre-check-in', url: 'https://x/pre' },
    preheader: 'Finish pre-check-in',
  });
  assert.match(html, /#0f6e56/);
  assert.match(html, /Rent &amp; Go/);
  assert.match(html, /https:\/\/x\/pre/);
  assert.match(html, /Start pre-check-in/);
  assert.match(html, /Guaynabo, PR/);
  assert.match(text, /You're booked/);
  assert.match(text, /RES-1/, 'text strips html');
  assert.match(text, /Start pre-check-in: https:\/\/x\/pre/);
});

test('RFM default fallback when no brand given', () => {
  const { html } = renderBrandedEmail({ heading: 'Hi', bodyHtml: 'x' });
  assert.match(html, /#8752FE/i);
  assert.match(html, /Ride Fleet/, 'wordmark when no logo');
});

test('invalid brand color falls back to RFM purple', () => {
  const { html } = renderBrandedEmail({ brand: { brandColor: 'not-a-color' }, bodyHtml: 'x' });
  assert.match(html, /#8752FE/i);
});

test('logo img used when logoUrl present', () => {
  const { html } = renderBrandedEmail({ brand: { logoUrl: 'https://cdn/x.png', companyName: 'Acme' }, bodyHtml: 'x' });
  assert.match(html, /<img src="https:\/\/cdn\/x\.png"/);
});

test('es locale uses Spanish footer strings', () => {
  const { html } = renderBrandedEmail({ bodyHtml: 'x', locale: 'es' });
  assert.match(html, /Cancelar suscripción/);
});

test('resolveEmailBrand reads tenant settings, falls back on bad color', async () => {
  const fakeSettings = { getRentalAgreementConfig: async () => ({ companyName: 'T', companyLogoUrl: 'https://l', companyAddress: 'A', companyPhone: 'P', emailBrandColor: '#123456' }) };
  const b = await resolveEmailBrand({ tenantId: 't' }, { settingsService: fakeSettings });
  assert.equal(b.companyName, 'T');
  assert.equal(b.brandColor, '#123456');
  assert.equal(b.logoUrl, 'https://l');

  const badSettings = { getRentalAgreementConfig: async () => ({ companyName: 'T2', emailBrandColor: 'xxx' }) };
  const b2 = await resolveEmailBrand({}, { settingsService: badSettings });
  assert.equal(b2.brandColor, RFM_DEFAULT_BRAND.brandColor);
  assert.equal(b2.companyName, 'T2');
});
