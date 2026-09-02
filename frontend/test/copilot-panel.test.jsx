/**
 * Agent Copilot Phase 1 — the panel, the pre-flight gate, and the hand-off.
 * Pins, in order:
 *  (1) the launcher pill renders for a staff viewer, opens the panel, and an
 *      ES question resolves to a sourced answer with the honest CTA row
 *  (2) ASK_HERE — record-scoped teach with a reservation OPEN asks WHICH
 *      reservation before dispatching; "Sí, aquí" dispatches on the open
 *      record; "Es en otra reserva" navigates to the list FIRST and only
 *      dispatches after the route change (never arms on the wrong record)
 *  (3) NAVIGATE — teach from the wrong screen announces the move, then
 *      dispatches after the read beat (announced, never silent)
 *  (4) NEEDS_RECORD — record-scoped teach with nothing open asks for their
 *      case, then dispatches so the engine's parking bar owns the wait
 *  (5) a MISS answers honestly, logs to the ring buffer, and hands off to the
 *      pre-filled Ride University search
 *  (6) role gating — an AGENT asking an admin question gets "needs an admin",
 *      no tour button, no navigation
 *  (7) the chip: any tour start collapses the copilot to the chip; the done
 *      event for a copilot-launched module reopens with "¿Lo lograste?"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Mutable navigation double: tests move `pathname` and re-render.
const nav = { pathname: '/dashboard', push: vi.fn() };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// getFixedT-style i18n double: returns the English defaultValue with
// interpolation applied, so copy assertions pin the real fallbacks. A
// SINGLETON, like the real i18n instance — a fresh object per render would
// re-fire any effect that depends on it.
vi.mock('react-i18next', () => {
  const i18nDouble = {
    language: 'es',
    getFixedT: () => (key, opts) => {
      let out = typeof opts === 'string' ? opts : (opts?.defaultValue ?? key);
      for (const [k, v] of Object.entries(opts && typeof opts === 'object' ? opts : {})) {
        if (k !== 'defaultValue') out = out.replaceAll(`{{${k}}}`, String(v));
      }
      return out;
    },
  };
  const bundle = {
    t: (key, opts) => (typeof opts === 'string' ? opts : (opts?.defaultValue ?? key)),
    i18n: i18nDouble,
  };
  return { useTranslation: () => bundle };
});

import { Copilot } from '../src/components/copilot/Copilot';
import { TOUR_START_EVENT, TOUR_MODULE_DONE_EVENT } from '../src/components/training/TourHost';
import { MISS_LOG_KEY } from '../src/lib/training/intents.js';

const AGENT = { role: 'AGENT', isModuleEnabled: () => true };

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'How do I…?' }));
}

function ask(question) {
  const input = screen.getByPlaceholderText('Type your question…');
  fireEvent.change(input, { target: { value: question } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

/** Every ride-university:start dispatch, newest last. */
function captureTourStarts() {
  const starts = [];
  const listener = (e) => starts.push(e.detail);
  window.addEventListener(TOUR_START_EVENT, listener);
  return { starts, stop: () => window.removeEventListener(TOUR_START_EVENT, listener) };
}

beforeEach(() => {
  nav.pathname = '/dashboard';
  nav.push = vi.fn();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('launcher and answers', () => {
  it('renders the pill, opens the panel, and answers the owner’s ES question with steps, source, and honest CTAs', () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('¿Cómo añado un conductor adicional?');

    // The curated playbook steps (Spanish content — the app language is es).
    expect(screen.getByText('Abre la reserva del cliente.')).toBeInTheDocument();
    expect(screen.getByText(/Dale al botón Additional Drivers/)).toBeInTheDocument();
    // The gotcha and its label.
    expect(screen.getByText('Where people trip')).toBeInTheDocument();
    expect(screen.getByText(/ANTES de entregar el vehículo/)).toBeInTheDocument();
    // The source chip — no source, no answer.
    expect(screen.getByText(/Playbook: Checkout, Inspection & Payment/)).toBeInTheDocument();
    // Phase 2: the micro-module exists, so the owner's example offers the
    // tour alongside navigation. The closers (2026-09-02) shipped the Ride
    // University article too, so the full CTA row is finally here.
    expect(screen.getByRole('button', { name: 'Show me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take me there' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View article' })).toBeInTheDocument();
    // The standing commitment is always visible.
    expect(screen.getByText('Explains and guides · never performs actions')).toBeInTheDocument();
  });

  it('a module-backed answer offers the tour and renders the curriculum’s own step titles', () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('how do I check out a vehicle');
    expect(screen.getByRole('button', { name: 'Show me' })).toBeInTheDocument();
    // Step titles come from the curriculum, not invented prose.
    expect(screen.getByText('Start the handover')).toBeInTheDocument();
    expect(screen.getByText('Terms, signed by the customer')).toBeInTheDocument();
    // The module gotcha rides along.
    expect(screen.getByText(/The photo step feels skippable/)).toBeInTheDocument();
  });
});

describe('pre-flight — ASK_HERE (the reservation-context question)', () => {
  it('teaching a record-scoped module with a reservation OPEN asks which one — and never dispatches blind', () => {
    nav.pathname = '/reservations/R-20841';
    const cap = captureTourStarts();
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('como hago un check-out');
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));

    // The QUESTION, with the open record named. Nothing dispatched yet.
    expect(screen.getByText('Want me to guide you right here on R-20841?')).toBeInTheDocument();
    expect(cap.starts).toHaveLength(0);

    // "Sí, aquí" → dispatch on the open record, panel yields to the chip.
    fireEvent.click(screen.getByRole('button', { name: 'Yes, here' }));
    expect(cap.starts).toEqual([{ track: 'MODULE', moduleKey: 'check-out' }]);
    expect(screen.getByText('Copilot · guide running')).toBeInTheDocument();
    cap.stop();
  });

  it('"Es en otra reserva" navigates to the list FIRST and only dispatches after the route change', () => {
    nav.pathname = '/reservations/R-20841';
    const cap = captureTourStarts();
    const view = render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('como hago un check-out');
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    fireEvent.click(screen.getByRole('button', { name: "It's a different reservation" }));

    // Navigated to the reservation list; NOT dispatched — dispatching from
    // R-20841 would arm the tour on the wrong record.
    expect(nav.push).toHaveBeenCalledWith('/reservations');
    expect(cap.starts).toHaveLength(0);

    // The route change lands → now the dispatch fires; the launch settle
    // parks (no record anchors on the list) and the engine's watcher follows
    // the agent into THEIR reservation.
    nav.pathname = '/reservations';
    view.rerender(<Copilot viewer={AGENT} />);
    expect(cap.starts).toEqual([{ track: 'MODULE', moduleKey: 'check-out' }]);
    cap.stop();
  });
});

describe('pre-flight — NAVIGATE and NEEDS_RECORD', () => {
  it('teaching from the wrong screen announces the move, then dispatches after the read beat', () => {
    vi.useFakeTimers();
    nav.pathname = '/';
    const cap = captureTourStarts();
    render(<Copilot viewer={{ role: 'OPS', isModuleEnabled: () => true }} />);
    openPanel();
    ask('how do I run the shuttle console');
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));

    // Announced, never silent — and not yet dispatched. (The screen name is
    // interpolated in the panel language — es under this mock.)
    expect(screen.getByText("I'll take you to la consola de Shuttles first — the guide starts there.")).toBeInTheDocument();
    expect(cap.starts).toHaveLength(0);

    act(() => { vi.advanceTimersByTime(1300); });
    expect(cap.starts).toEqual([{ track: 'MODULE', moduleKey: 'shuttle-dispatch' }]);
    cap.stop();
  });

  it('record-scoped with nothing open asks for THEIR case, then dispatches so the parking bar owns the wait', () => {
    vi.useFakeTimers();
    nav.pathname = '/knowledge-base';
    const cap = captureTourStarts();
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('how do I take a payment');
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));

    expect(screen.getByText("Which reservation is the problem on? Open it and I'll pick up there.")).toBeInTheDocument();
    const goBtn = screen.getByRole('button', { name: 'Take me to Reservations' });
    expect(cap.starts).toHaveLength(0);

    fireEvent.click(goBtn);
    expect(nav.push).toHaveBeenCalledWith('/reservations');

    act(() => { vi.advanceTimersByTime(1700); });
    expect(cap.starts).toEqual([{ track: 'MODULE', moduleKey: 'take-payment' }]);
    cap.stop();
  });
});

describe('the miss — honest, logged, handed off', () => {
  it('answers "no lo tengo", logs the ring-buffer entry, and pre-fills the Ride University search', () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('¿Cómo configuro el descuento de AAA?');

    expect(screen.getByText("I don't have that in the articles yet, and I'd rather not invent steps.")).toBeInTheDocument();
    expect(screen.getByText('NO SOURCE · NOT ANSWERED')).toBeInTheDocument();

    const logged = JSON.parse(window.localStorage.getItem(MISS_LOG_KEY));
    expect(logged).toHaveLength(1);
    expect(logged[0].q).toBe('¿Cómo configuro el descuento de AAA?');

    fireEvent.click(screen.getByRole('button', { name: 'Search Ride University' }));
    expect(nav.push).toHaveBeenCalledWith(
      `/knowledge-base?search=${encodeURIComponent('¿Cómo configuro el descuento de AAA?')}`,
    );
  });

  it('"Tell an admin" flags the logged miss and confirms in place', () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('something the map does not know');
    fireEvent.click(screen.getByRole('button', { name: 'Tell an admin' }));
    expect(screen.getByText('Noted — an admin will see it.')).toBeInTheDocument();
    const logged = JSON.parse(window.localStorage.getItem(MISS_LOG_KEY));
    expect(logged[0].flagged).toBe(true);
  });
});

describe('role gating (guardrail 4)', () => {
  it('an AGENT asking an admin question gets the honest answer — article kept, no tour, no navigation', () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('how do I add a user');
    expect(screen.getByText("That screen needs an admin — here's what they'll do.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show me' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take me there' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View article' })).toBeInTheDocument();
  });
});

describe('yielding to the tour', () => {
  it('any tour start collapses the copilot to the chip', () => {
    render(<Copilot viewer={AGENT} />);
    expect(screen.getByRole('button', { name: 'How do I…?' })).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail: { track: 'MODULE', moduleKey: 'find-reservation' } }));
    });
    expect(screen.getByText('Copilot · guide running')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'How do I…?' })).toBeNull();
  });

  it('the done event for a copilot-launched module reopens the panel with the completion question', () => {
    nav.pathname = '/reservations/R-1';
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('como hago un check-out');
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, here' }));
    expect(screen.getByText('Copilot · guide running')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent(TOUR_MODULE_DONE_EVENT, { detail: { moduleKey: 'check-out' } }));
    });
    expect(screen.getByText('Did you get it done?')).toBeInTheDocument();
    // check-out is OPPORTUNISTIC — the truth about completion rides along.
    expect(screen.getByText(/marks itself complete when the real record exists/)).toBeInTheDocument();
  });
});
