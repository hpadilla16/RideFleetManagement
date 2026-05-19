// 16g — Tests for the canonical Terms & Conditions version metadata.
//
// Run: `node --test src/lib/terms/version.test.mjs` from backend/. No
// Prisma client / DB required.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TC_VERSION, TC_EFFECTIVE_DATE, TC_HTML_FILENAME } from './version.js';
import { getCanonicalTermsHtml, getCanonicalTermsPlainText, INITIALS_KEYS } from './index.js';

describe('TC_VERSION constants', () => {
  it('is a YYYY-MM-DD string', () => {
    assert.match(TC_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the html filename suffix', () => {
    assert.equal(TC_HTML_FILENAME, `tc-${TC_VERSION}.html`);
  });

  it('TC_EFFECTIVE_DATE parses to the same calendar day as TC_VERSION', () => {
    assert.ok(TC_EFFECTIVE_DATE instanceof Date);
    assert.equal(TC_EFFECTIVE_DATE.toISOString().slice(0, 10), TC_VERSION);
  });
});

describe('getCanonicalTermsHtml', () => {
  const html = getCanonicalTermsHtml();

  it('returns non-empty HTML with the data-tc-version marker', () => {
    assert.ok(html.length > 1000, 'expected a substantial document');
    assert.ok(html.includes(`data-tc-version="${TC_VERSION}"`));
  });

  it('renders blank underscores for every INITIALS_KEY when none supplied', () => {
    for (const key of INITIALS_KEYS) {
      assert.ok(!html.includes(`{{${key}}}`), `marker ${key} should be substituted`);
    }
    // The DEFAULT_BLANK is three underscores.
    assert.ok(html.includes('___'));
  });

  it('substitutes supplied initials into the markers', () => {
    const stamped = getCanonicalTermsHtml({
      initials: {
        INITIALS_S4_DECLINE: 'HP',
        INITIALS_S11_CARD_ON_FILE: 'HP',
        INITIALS_S11_CNP: 'HP',
        INITIALS_S11_NO_CHARGEBACK: 'HP',
        INITIALS_S13_POST_RENTAL: 'HP'
      }
    });
    for (const key of INITIALS_KEYS) {
      assert.ok(!stamped.includes(`{{${key}}}`));
    }
    // Substituted initials should appear at least five times.
    const matches = stamped.match(/\bHP\b/g) || [];
    assert.ok(matches.length >= 5, `expected at least 5 HP occurrences, got ${matches.length}`);
  });

  it('html-escapes supplied initials to prevent injection', () => {
    const stamped = getCanonicalTermsHtml({
      initials: { INITIALS_S4_DECLINE: '<script>x</script>' }
    });
    assert.ok(!stamped.includes('<script>x</script>'));
    assert.ok(stamped.includes('&lt;script&gt;'));
  });

  it('contains the new card-on-file and post-rental disclosures', () => {
    // Sanity check that the canonical sections that justify the
    // autocharge unblock are actually present in the rendered output.
    assert.ok(/CARD-ON-FILE PRE-AUTHORIZATION/i.test(html));
    assert.ok(/DELAYED CHARGES/i.test(html));
    assert.ok(/PRIVACY, DATA RETENTION/i.test(html));
  });
});

describe('getCanonicalTermsPlainText', () => {
  const txt = getCanonicalTermsPlainText();

  it('strips all HTML tags', () => {
    assert.ok(!/[<>]/.test(txt), 'plain text should not contain angle brackets');
  });

  it('preserves bilingual content markers', () => {
    assert.ok(txt.includes('AUTHORIZED USE'));
    assert.ok(txt.includes('USO AUTORIZADO'));
  });
});
