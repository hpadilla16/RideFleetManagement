import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TourHost, TOUR_START_EVENT, TOUR_MODULE_DONE_EVENT } from '../src/components/training/TourHost';
import { findModule } from '../src/lib/training/curriculum.js';

// i18n: return the fallback so the English in the curriculum is what renders.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback, vars) => {
    const base = typeof fallback === 'string' ? fallback : (typeof fallback === 'object' && fallback !== null ? key : (fallback ?? key));
    const v = typeof fallback === 'object' && fallback !== null ? fallback : vars;
    return String(base).replace(/\{\{(\w+)\}\}/g, (_, k) => (v && v[k] != null ? String(v[k]) : `{{${k}}}`));
  } }),
}));

if (typeof globalThis.CSS === 'undefined') globalThis.CSS = { escape: (s) => s };

const start = (moduleKey) => act(() => {
  window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail: { track: 'MODULE', moduleKey } }));
});

/**
 * The kiosk course runs on screens the tour cannot reach (the guest's iPad,
 * the Valet console), so its steps are DRAWN and its modules close with a
 * CHECK. These pin the two new step kinds end to end: they show without any
 * element on the page, Next is locked until the right answer, and the module
 * is announced as walked only after that.
 */
describe('drawn and asked steps', () => {
  beforeEach(() => { window.localStorage.clear(); });

  it('a module made only of drawn steps starts with nothing on the page, and shows the figure', () => {
    render(<TourHost viewer={{ role: 'AGENT' }} />);
    start('kiosk-valet-help');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('tour-figure')).toBeInTheDocument();
    expect(screen.getByTestId('kiosk-figure')).toBeInTheDocument();
    // Callouts render numbered, from the curriculum.
    const first = findModule('kiosk-valet-help').steps[0];
    const list = screen.getByTestId('tour-callouts');
    expect(list.querySelectorAll('li').length).toBe(first.callouts.length);
    expect(list.textContent).toContain(first.callouts[0]);
  });

  it('a check locks Next until the right answer, explains a wrong one, and never costs the person the step', () => {
    render(<TourHost viewer={{ role: 'AGENT' }} />);
    start('kiosk-valet-help');
    const mod = findModule('kiosk-valet-help');
    const checkIndex = mod.steps.findIndex((s) => s.check);
    // Walk to the check.
    for (let i = 0; i < checkIndex; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('tour-check')).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();

    const wrong = mod.steps[checkIndex].check.options.find((o) => !o.correct);
    fireEvent.click(screen.getByTestId(`tour-check-option-${wrong.key}`));
    expect(screen.getByTestId('tour-check-why').textContent).toContain(wrong.why);
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();

    const right = mod.steps[checkIndex].check.options.find((o) => o.correct);
    fireEvent.click(screen.getByTestId(`tour-check-option-${right.key}`));
    expect(screen.getByTestId('tour-check-why').textContent).toContain(right.why);
    expect(screen.getByRole('button', { name: 'Done' })).not.toBeDisabled();
  });

  it('the module is announced as walked only after the check is passed', () => {
    const walked = vi.fn();
    window.addEventListener(TOUR_MODULE_DONE_EVENT, walked);
    render(<TourHost viewer={{ role: 'AGENT' }} />);
    start('kiosk-done-keys');
    const mod = findModule('kiosk-done-keys');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // Arrow-right must not sneak past a locked check.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(walked).not.toHaveBeenCalled();
    const right = mod.steps[1].check.options.find((o) => o.correct);
    fireEvent.click(screen.getByTestId(`tour-check-option-${right.key}`));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(walked).toHaveBeenCalledTimes(1);
    expect(walked.mock.calls[0][0].detail.moduleKey).toBe('kiosk-done-keys');
    window.removeEventListener(TOUR_MODULE_DONE_EVENT, walked);
  });

  it('the pick resets between steps — a wrong answer does not follow the person', () => {
    render(<TourHost viewer={{ role: 'AGENT' }} />);
    start('kiosk-done-keys');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByTestId('tour-check-option-A'));
    expect(screen.getByTestId('tour-check-why')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByTestId('tour-check-why')).toBeNull();
  });
});

describe('a parked tour never resumes on a drawn or asked step (Innovation, 2026-09-04)', () => {
  beforeEach(() => { window.localStorage.clear(); });

  it('kiosk-grant-valet launched with People closed parks — and stays parked, it does not jump to the quiz', () => {
    vi.useFakeTimers();
    try {
      render(<TourHost viewer={{ role: 'ADMIN' }} />);
      start('kiosk-grant-valet');
      // Nothing on the page carries data-tour="person-module-kiosk": parked.
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.queryByTestId('tour-check')).toBeNull();
      // The watcher polls every 700ms; the settle timer fires at 700ms too.
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.getByRole('status'), 'still parked').toBeInTheDocument();
      expect(screen.queryByTestId('tour-check'), 'the quiz must not be reachable without the real step').toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('…and resumes the moment the real element appears', () => {
    vi.useFakeTimers();
    try {
      render(<TourHost viewer={{ role: 'ADMIN' }} />);
      start('kiosk-grant-valet');
      expect(screen.getByRole('status')).toBeInTheDocument();
      const el = document.createElement('label');
      el.setAttribute('data-tour', 'person-module-kiosk');
      el.textContent = 'Kiosk';
      el.getBoundingClientRect = () => ({ width: 80, height: 20, top: 100, bottom: 120, left: 40, right: 120 });
      document.body.appendChild(el);
      act(() => { vi.advanceTimersByTime(1500); });
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByRole('dialog').textContent).toContain('Tick “Kiosk”');
      el.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
