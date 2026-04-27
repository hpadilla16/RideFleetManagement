import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from './review-email-template.js';

describe('review-email renderTemplate', () => {
  it('substitutes known variables', () => {
    const out = renderTemplate('Hi {{customerName}}, reservation {{reservationNumber}}', {
      customerName: 'Ana', reservationNumber: 'WEB-1234'
    });
    assert.equal(out, 'Hi Ana, reservation WEB-1234');
  });

  it('leaves unknown placeholders untouched', () => {
    const out = renderTemplate('Hello {{unknownKey}}', { customerName: 'Ana' });
    assert.equal(out, 'Hello {{unknownKey}}');
  });

  it('treats null/undefined values as empty', () => {
    assert.equal(renderTemplate('A={{a}},B={{b}}', { a: null, b: undefined }), 'A=,B=');
  });

  it('returns empty string for null/undefined templates', () => {
    assert.equal(renderTemplate(null, { x: '1' }), '');
    assert.equal(renderTemplate(undefined, { x: '1' }), '');
  });

  it('replaces ALL occurrences of the same variable', () => {
    const out = renderTemplate('{{n}} {{n}} {{n}}', { n: 'x' });
    assert.equal(out, 'x x x');
  });
});
