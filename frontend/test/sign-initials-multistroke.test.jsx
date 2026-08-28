import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

/**
 * The initials pad froze half-way through the customer's own initials.
 *
 * An initial is not a signature: "H.P." is four separate strokes with a
 * finger-lift between each one. The pad committed on the FIRST lift, POSTed
 * it, got `signed: true` back, passed that down as `disabled` — and the
 * canvas went inert with a single upright stroke on it, a green ✓ claiming
 * success, and no Clear button (it only rendered while `!disabled`). The
 * renter's only remaining move was to hand the phone to the agent.
 *
 * These tests drive the canvas the way a finger does, so they are the only
 * place the freeze is actually reproducible.
 */

const apiMock = vi.fn();
vi.mock('../src/lib/client', () => ({
  API_BASE: 'http://localhost:4000',
  api: (...args) => apiMock(...args),
}));

/** Long enough to clear the `length < 200` guard on both sides of the wire. */
const INK = `data:image/png;base64,${'R'.repeat(300)}`;

/**
 * jsdom has no 2D canvas backend — getContext returns null and the pad's
 * setup effect throws. Stub exactly the calls the pad makes. (Same shape as
 * sign-tenant-identity.test.jsx; kept local so neither file's stub can drift
 * out from under the other.)
 */
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => ({
    scale: () => {}, fillRect: () => {}, beginPath: () => {}, moveTo: () => {},
    lineTo: () => {}, stroke: () => {}, fillStyle: '', strokeStyle: '',
    lineWidth: 0, lineCap: '',
  });
  HTMLCanvasElement.prototype.toDataURL = () => INK;
});

const { SignClient } = await import('../src/app/(public)/sign/[token]/SignClient.jsx');

const SECTIONS = [
  { key: 'rental_period', label: 'Rental period', body: 'Return the vehicle on time.', signed: false },
  { key: 'fuel_policy', label: 'Fuel policy', body: 'Return it full.', signed: false },
];

function payload(overrides = {}) {
  return {
    reservationNumber: 'RES-1',
    agreementNumber: 'RA-1',
    brand: { companyName: 'Autos del Valle' },
    signerLocale: 'en',
    sections: SECTIONS.map((s) => ({ ...s })),
    ...overrides,
  };
}

/**
 * Timers are faked, so testing-library's own waitFor cannot be used to settle
 * the mount fetch — it would poll against a clock nothing is advancing. Two
 * awaited acts is enough: one for the api() promise, one for the setState it
 * schedules.
 */
async function flush() {
  await act(async () => {});
  await act(async () => {});
}

/** One stroke: press, drag, lift. The lift is the event that used to commit. */
function stroke(canvas, from = 5, to = 30) {
  fireEvent.mouseDown(canvas, { clientX: from, clientY: from });
  fireEvent.mouseMove(canvas, { clientX: to, clientY: to });
  fireEvent.mouseUp(canvas);
}

async function tick(ms) {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await act(async () => {});
}

/** Every POST to /initials, oldest first, as { sectionKey, initialDataUrl }. */
function initialPosts() {
  return apiMock.mock.calls
    .filter(([path]) => String(path).endsWith('/initials'))
    .map(([, opts]) => JSON.parse(opts.body));
}

function pads() {
  // Two initial pads in section order, then the full signature pad last.
  return Array.from(document.querySelectorAll('canvas'));
}

async function mount() {
  apiMock.mockImplementation(async (path) => {
    if (String(path).endsWith('/initials')) return { signed: true };
    if (String(path).endsWith('/complete')) return { ok: true };
    return payload();
  });
  render(<SignClient token="TOK" />);
  await flush();
  return pads();
}

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.mockReset();
  try { window.localStorage.clear(); } catch { /* jsdom */ }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('initials pad — multi-stroke', () => {
  it('does not commit when the customer lifts their finger mid-initial', async () => {
    const [initials] = await mount();

    stroke(initials);              // the "H"
    await tick(400);               // repositioning, the way a hand does

    // The old build had already POSTed and locked the pad by this point.
    expect(initialPosts()).toHaveLength(0);
  });

  it('commits ONCE after the last stroke of a four-stroke "H.P."', async () => {
    const [initials] = await mount();

    for (let i = 0; i < 4; i += 1) {
      stroke(initials, 5 + i * 4, 25 + i * 4);
      await tick(300);
    }
    expect(initialPosts()).toHaveLength(0);

    await tick(1400);

    const posts = initialPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].sectionKey).toBe('rental_period');
    expect(posts[0].initialDataUrl).toBe(INK);
  });

  it('cancels the pending commit when a new stroke starts inside the window', async () => {
    const [initials] = await mount();

    stroke(initials);
    await tick(1200);                 // nearly there…
    expect(initialPosts()).toHaveLength(0);

    stroke(initials, 40, 60);         // …and the customer keeps writing
    await tick(1200);                 // the ORIGINAL timer would have fired by now
    expect(initialPosts()).toHaveLength(0);

    await tick(300);
    expect(initialPosts()).toHaveLength(1);
  });

  it('keeps accepting strokes after the section has saved', async () => {
    const [initials] = await mount();

    stroke(initials);
    await tick(1500);
    expect(initialPosts()).toHaveLength(1);
    expect(screen.getByText('✓ Initialed')).toBeInTheDocument();

    // The freeze: start() used to return early on `disabled`, so this stroke
    // reached the canvas and did nothing at all.
    stroke(initials, 40, 70);
    await tick(1500);
    const posts = initialPosts();
    expect(posts).toHaveLength(2);
    expect(posts[1].sectionKey).toBe('rental_period');
  });
});

describe('initials pad — redo', () => {
  it('keeps Clear reachable in the saved state', async () => {
    const [initials] = await mount();

    stroke(initials);
    await tick(1500);
    expect(screen.getByText('✓ Initialed')).toBeInTheDocument();

    // Previously `{!disabled && hasContent && …}` — the button vanished at
    // exactly the moment it became the thing the customer needed.
    expect(screen.getAllByRole('button', { name: 'Clear' }).length).toBeGreaterThan(0);
  });

  it('clears a saved initial and lets the customer draw a fresh one', async () => {
    const [initials] = await mount();

    stroke(initials);
    await tick(1500);
    expect(screen.getByText('✓ Initialed')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]); });

    stroke(initials, 12, 44);
    await tick(1500);

    const posts = initialPosts();
    expect(posts).toHaveLength(2);
    // Same key twice — the backend upserts, so the second overwrites the first.
    expect(posts.map((p) => p.sectionKey)).toEqual(['rental_period', 'rental_period']);
  });

  it('never POSTs a blank initial when Clear lands inside the debounce window', async () => {
    const [initials] = await mount();

    stroke(initials);
    await tick(400);
    // A pending timer reads the canvas when it FIRES. Uncancelled, it would
    // find the blank canvas and overwrite a good initial with white.
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]); });
    await tick(2000);

    expect(initialPosts()).toHaveLength(0);
  });

  it('tells the customer, in both languages, that a saved section can be redone', async () => {
    const [initials] = await mount();

    stroke(initials);
    await tick(1500);
    expect(screen.getByText('Saved — draw again to redo')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ES' })); });
    expect(screen.getByText('Guardado — dibuja de nuevo para rehacer')).toBeInTheDocument();
    // Still reads as done, not merely as redoable.
    expect(screen.getByText('✓ Iniciales puestas')).toBeInTheDocument();
  });
});

describe('full signature pad — not regressed', () => {
  it('commits immediately, with no debounce in front of Complete', async () => {
    const all = await mount();
    const finalPad = all[all.length - 1];

    fireEvent.change(screen.getByPlaceholderText('First Last'), { target: { value: 'Hector Padilla' } });
    stroke(finalPad, 10, 90);
    // No timer advance at all: the value is there the instant the pen lifts.
    await act(async () => {});

    for (const p of all.slice(0, -1)) { stroke(p); }
    await tick(1500);

    expect(screen.getByRole('button', { name: /^Complete/ })).not.toBeDisabled();
  });

  it('still gates Complete on every section AND a real signature', async () => {
    const all = await mount();
    const finalPad = all[all.length - 1];
    const complete = () => screen.getByRole('button', { name: /^Complete/ });

    expect(complete()).toBeDisabled();

    // Name + signature, but only ONE of the two sections initialed.
    fireEvent.change(screen.getByPlaceholderText('First Last'), { target: { value: 'Hector Padilla' } });
    stroke(finalPad, 10, 90);
    stroke(all[0]);
    await tick(1500);
    expect(screen.getByText(/Complete \(1\/2 initials\)/)).toBeInTheDocument();
    expect(complete()).toBeDisabled();

    // Second section — now everything is present.
    stroke(all[1]);
    await tick(1500);
    expect(complete()).not.toBeDisabled();

    // Wiping the signature closes the gate again, debounce or no debounce.
    await act(async () => {
      const clears = screen.getAllByRole('button', { name: 'Clear' });
      fireEvent.click(clears[clears.length - 1]);
    });
    expect(complete()).toBeDisabled();
  });

  it('submits the signature and the typed name', async () => {
    const all = await mount();

    fireEvent.change(screen.getByPlaceholderText('First Last'), { target: { value: 'Hector Padilla' } });
    stroke(all[all.length - 1], 10, 90);
    for (const p of all.slice(0, -1)) { stroke(p); }
    await tick(1500);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Complete/ })); });
    await flush();

    const [, opts] = apiMock.mock.calls.find(([path]) => String(path).endsWith('/complete'));
    expect(JSON.parse(opts.body)).toEqual({ signatureDataUrl: INK, signerName: 'Hector Padilla' });
  });
});
