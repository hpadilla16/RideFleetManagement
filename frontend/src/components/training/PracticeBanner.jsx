'use client';

/**
 * The always-visible frame around practice mode.
 *
 * A trainee who forgets they are in the demo tenant is the whole risk of the
 * feature — they would "practice" on what they believe is a real customer, or
 * worse, do real work into the demo. So while the practice flag is set, this
 * banner sits fixed above EVERYTHING (the app's own z-indexes reach 9999) and
 * the one action on it is the way back.
 *
 * Mounted in app/layout.js beside TourMount, for the same reason TourMount
 * lives there: it must survive navigation. Costs nothing when not practicing.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inPracticeMode, exitPractice } from '../../lib/training/practice';

export function PracticeBanner() {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);

  useEffect(() => { setActive(inPracticeMode()); }, []);

  if (!active) return null;

  const leave = () => {
    exitPractice();
    // Full reload: every mounted component read the practice user at mount.
    window.location.href = '/';
  };

  return (
    <div
      role="status"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
        padding: '8px 14px', flexWrap: 'wrap',
        background: '#5b21b6', color: '#fff',
        fontSize: 13, fontWeight: 600,
        boxShadow: '0 2px 8px rgba(0,0,0,.25)',
      }}
    >
      <span aria-hidden="true">🎓</span>
      <span>
        {t('training.practiceBanner', 'PRACTICE MODE — demo tenant. Nothing here touches real data, and what you complete counts toward your training.')}
      </span>
      <button
        type="button"
        onClick={leave}
        style={{
          background: '#fff', color: '#5b21b6', border: 'none', borderRadius: 999,
          padding: '5px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}
      >
        {t('training.practiceExit', 'Back to my account')}
      </button>
    </div>
  );
}
