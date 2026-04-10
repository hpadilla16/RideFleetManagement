'use client';

import { useEffect } from 'react';
import '../lib/i18n';

export function I18nBoot() {
  useEffect(() => {
    try {
      const lang = window.localStorage.getItem('ridefleet_lang') || 'en';
      document.documentElement.lang = lang;
    } catch {}
  }, []);
  return null;
}
