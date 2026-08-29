'use client';

/**
 * Language for the two customer-facing autopay pages — enrollment
 * (AutopayClient) and the return leg (AutopayReturnClient).
 *
 * WHY NOT THE APP'S i18next INSTANCE
 * ------------------------------------------------------------------
 * Same reasoning SignClient sets out at length, and it applies here for the
 * same reason: src/lib/i18n.js resolves from localStorage['ridefleet_lang'],
 * which is written on the AGENT's device inside the authenticated app. These
 * two pages open from a link in an email, on the subscriber's own phone or
 * laptop, where that key has never been written. Reading it would give every
 * subscriber the app's default and nothing else. So the choice is page-local,
 * under its own key, exactly as the signing page does it.
 *
 * RESOLUTION ORDER: stored choice → browser language → 'en'.
 *
 * English is the default because most tenants are not in Puerto Rico; the
 * browser hint and the always-visible toggle are what keep Spanish reachable
 * for the ones that are. The first two only ever GUESS, which is why the
 * toggle is never hidden behind the guess being wrong.
 *
 * A separate key from the signing page's on purpose: the two pages have
 * different audiences (a renter at a counter vs. the tenant's owner reading
 * their email), and neither should silently set the other's language.
 */

import { useCallback, useEffect, useState } from 'react';

export const LANG_KEY = 'ride-autopay-lang';

/** Narrow anything to a language these pages actually ship strings for. */
export function toSupportedLang(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('es')) return 'es';
  if (s.startsWith('en')) return 'en';
  return null;
}

/**
 * The locale tag handed to Intl. 'es-PR' rather than plain 'es' because these
 * pages were written for Puerto Rico and that is the reference wording; the
 * month names are the same either way, the tag just keeps the intent visible.
 */
const INTL_LOCALE = { en: 'en-US', es: 'es-PR' };

/** How each language names the OTHER one, for the disclosure-language note. */
const LANGUAGE_NAMES = {
  en: { en: 'English', es: 'inglés' },
  es: { en: 'Spanish', es: 'español' },
};

export function languageName(code, inLang) {
  return LANGUAGE_NAMES[code]?.[inLang] || code;
}

/**
 * Render a 'YYYY-MM-DD' billing date in the reader's language.
 *
 * `startDate` is a CALENDAR date, not an instant — Authorize.Net bills on that
 * day in the merchant's own time, and the backend stores it as the string
 * 'YYYY-MM-DD' for exactly that reason.
 *
 * `timeZone: 'UTC'` is LOAD-BEARING and must match how the Date was built.
 * WITHOUT it, a reader west of UTC (es-PR is UTC-4) renders midnight UTC as
 * the PREVIOUS day, and the customer authorises a charge dated one day before
 * the one that actually runs. Do not "simplify" this option away. Only the
 * locale tag varies with the chosen language; the option does not.
 */
export function formatCalendarDate(iso, lang) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso || '';
  return new Intl.DateTimeFormat(INTL_LOCALE[lang] || INTL_LOCALE.en, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Money is rendered the same in both languages — en-US grouping, 2 decimals. */
export function formatMoney(value) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * `strings` is `{ en: {...}, es: {...} }`, owned by the page that renders it so
 * the translation sits next to the markup a reviewer is comparing it against.
 *
 * Returns `t` (with `{name}` interpolation), the resolved `lang`, `setLang`,
 * and `fmtDate` already bound to that language.
 */
export function useAutopayLang(strings) {
  const [lang, setLangState] = useState('en');

  useEffect(() => {
    const stored = (() => {
      try { return window.localStorage.getItem(LANG_KEY); } catch { return null; }
    })();
    const saved = toSupportedLang(stored);
    if (saved) { setLangState(saved); return; }
    // Only ever a guess, hence the toggle. Missing or unsupported leaves 'en'.
    const fromBrowser = toSupportedLang(typeof navigator !== 'undefined' ? navigator.language : null);
    if (fromBrowser) setLangState(fromBrowser);
  }, []);

  // Keep <html lang> honest: it drives screen-reader pronunciation and the
  // browser's own "translate this page?" prompt. The root layout server-renders
  // lang="en", which is also this page's default, so the first paint agrees.
  useEffect(() => {
    try { document.documentElement.lang = lang; } catch { /* non-DOM env */ }
  }, [lang]);

  const setLang = useCallback((next) => {
    setLangState(next);
    try { window.localStorage.setItem(LANG_KEY, next); } catch { /* private browsing */ }
  }, []);

  const t = useCallback((key, vars = {}) => {
    let s = strings[lang]?.[key] ?? strings.en?.[key] ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  }, [lang, strings]);

  const fmtDate = useCallback((iso) => formatCalendarDate(iso, lang), [lang]);

  return { t, lang, setLang, fmtDate };
}

/**
 * Always visible, on every state including the dead ends. A Spanish speaker who
 * lands on an expired link would otherwise be told, in English, to contact us.
 * Same call the signing page makes.
 */
export function LangToggle({ lang, setLang }) {
  return (
    <div style={TOGGLE.wrap}>
      {['en', 'es'].map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          style={{
            ...TOGGLE.btn,
            background: lang === code ? '#17141F' : '#FFFFFF',
            color: lang === code ? '#FFFFFF' : '#6B6478',
          }}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

const TOGGLE = {
  wrap: {
    display: 'flex',
    flexShrink: 0,
    border: '1px solid #E6E2EC',
    borderRadius: '999px',
    overflow: 'hidden',
  },
  btn: {
    padding: '.25rem .7rem',
    fontSize: '.78rem',
    fontWeight: 600,
    lineHeight: 1.6,
    cursor: 'pointer',
    border: 0,
  },
};
