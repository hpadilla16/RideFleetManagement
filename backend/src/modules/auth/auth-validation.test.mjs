import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Inline the validation logic (same as auth.routes.js) to unit test it
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{12,}$/;

function validatePassword(password) {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (!PASSWORD_REGEX.test(password)) {
    return 'Password must include uppercase, lowercase, a number, and a special character';
  }
  return null;
}

describe('Password Validation', () => {
  it('accepts a strong password', () => {
    assert.equal(validatePassword('SecurePass123!'), null);
  });

  it('accepts complex password with special chars', () => {
    assert.equal(validatePassword('My$tr0ng_P@ss!'), null);
  });

  it('rejects too short password', () => {
    const err = validatePassword('Short1!');
    assert.ok(err);
    assert.ok(err.includes('12'));
  });

  it('rejects password without uppercase', () => {
    const err = validatePassword('alllowercase1!');
    assert.ok(err);
    assert.ok(err.includes('uppercase'));
  });

  it('rejects password without lowercase', () => {
    const err = validatePassword('ALLUPPERCASE1!');
    assert.ok(err);
    assert.ok(err.includes('uppercase'));
  });

  it('rejects password without number', () => {
    const err = validatePassword('NoNumbersHere!');
    assert.ok(err);
  });

  it('rejects password without special character', () => {
    const err = validatePassword('NoSpecialChar1A');
    assert.ok(err);
    assert.ok(err.includes('special'));
  });

  it('rejects empty password', () => {
    assert.ok(validatePassword(''));
    assert.ok(validatePassword(null));
    assert.ok(validatePassword(undefined));
  });

  it('accepts exactly 12 characters', () => {
    assert.equal(validatePassword('Abcdefgh1!23'), null);
  });

  it('rejects 11 characters', () => {
    assert.ok(validatePassword('Abcdefgh1!2'));
  });
});
