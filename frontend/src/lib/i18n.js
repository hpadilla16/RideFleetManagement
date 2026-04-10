'use client';

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import es from '../locales/es.json';

const LANG_KEY = 'ridefleet_lang';

function readStoredLang() {
  if (typeof window === 'undefined') return 'en';
  try { return window.localStorage.getItem(LANG_KEY) || 'en'; } catch { return 'en'; }
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  lng: readStoredLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLanguage(lang) {
  i18n.changeLanguage(lang);
  try { window.localStorage.setItem(LANG_KEY, lang); } catch {}
  try { document.documentElement.lang = lang; } catch {}
}

export default i18n;
