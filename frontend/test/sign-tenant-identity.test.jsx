import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Gap #11 — whose brand does the renter see while they sign?
 *
 * The journey these tests stand in for: an agent shows a screen branded
 * "Autos del Valle", the customer scans the QR with their OWN phone, and
 * lands on /sign/<token>. Everything they can see at that moment comes from
 * this component. Before the fix it read "Ride Fleet · Terms & Conditions" —
 * our name, in English, on a contract they are about to sign with someone
 * else. So the assertions here are mostly about what must NEVER appear.
 */

const apiMock = vi.fn();
vi.mock('../src/lib/client', () => ({
  API_BASE: 'http://localhost:4000',
  api: (...args) => apiMock(...args),
}));

/**
 * jsdom ships no 2D canvas backend, so getContext('2d') returns null and the
 * signature pads' setup effect throws. That is an environment gap, not a
 * product bug — a real phone always hands back a context. Stub the handful of
 * calls the pads make so the page can mount and the header can be asserted.
 */
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => ({
    scale: () => {}, fillRect: () => {}, beginPath: () => {}, moveTo: () => {},
    lineTo: () => {}, stroke: () => {}, fillStyle: '', strokeStyle: '',
    lineWidth: 0, lineCap: '',
  });
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,stub';
});

const { SignClient, customerSafeMessage } = await import('../src/app/(public)/sign/[token]/SignClient.jsx');

const SECTIONS = [
  { key: 'rental_period', label: 'Rental period', body: 'I agree to return the vehicle…', signed: false },
];

/** A /api/sign/:token payload with the fields under test. */
function payload({ companyName = null, signerLocale = null } = {}) {
  return {
    reservationNumber: 'RES-1',
    agreementNumber: 'RA-20260817',
    brand: { companyName },
    signerLocale,
    sections: SECTIONS,
  };
}

beforeEach(() => {
  apiMock.mockReset();
  try { window.localStorage.clear(); } catch { /* jsdom */ }
  document.title = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sign page — tenant identity', () => {
  it('shows the renting business name, not the platform name', async () => {
    apiMock.mockResolvedValue(payload({ companyName: 'Autos del Valle' }));
    render(<SignClient token="TOK" />);

    expect(await screen.findByText('Autos del Valle')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Ride Fleet');
  });

  it('puts the business name in the tab title', async () => {
    apiMock.mockResolvedValue(payload({ companyName: 'Autos del Valle' }));
    render(<SignClient token="TOK" />);

    await waitFor(() => expect(document.title).toContain('Autos del Valle'));
    expect(document.title).not.toContain('Ride Fleet');
  });

  it('keeps identifying data out of the (public, cacheable) title', async () => {
    apiMock.mockResolvedValue(payload({ companyName: 'Autos del Valle' }));
    render(<SignClient token="TOK" />);

    await waitFor(() => expect(document.title).toContain('Autos del Valle'));
    // The agreement number is fine on-screen but must not ride in the title.
    expect(document.title).not.toContain('RA-20260817');
    expect(document.title).not.toContain('TOK');
  });

  it('falls back to the plain document name when no business name resolves', async () => {
    apiMock.mockResolvedValue(payload({ companyName: null }));
    render(<SignClient token="TOK" />);

    expect(await screen.findByText('Terms & Conditions')).toBeInTheDocument();
    expect(document.title).toBe('Terms & Conditions');
    expect(document.body.textContent).not.toContain('Ride Fleet');
  });

  it('still renders the sections the customer has to initial', async () => {
    apiMock.mockResolvedValue(payload({ companyName: 'Autos del Valle' }));
    render(<SignClient token="TOK" />);

    // The signature flow itself is the critical path — branding must not
    // have displaced it.
    expect(await screen.findByText('Rental period')).toBeInTheDocument();
    expect(screen.getByText('I agree to return the vehicle…')).toBeInTheDocument();
  });
});

describe('sign page — language', () => {
  it("uses the signer's stored locale over the browser default", async () => {
    vi.stubGlobal('navigator', { ...window.navigator, language: 'en-US' });
    apiMock.mockResolvedValue(payload({ companyName: 'Autos del Valle', signerLocale: 'es' }));
    render(<SignClient token="TOK" />);

    expect(await screen.findByText('Términos y Condiciones')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.lang).toBe('es'));
  });

  it("falls back to the customer's own browser language, not the staff device's", async () => {
    // The app-wide i18next instance reads localStorage['ridefleet_lang'],
    // which is set on the AGENT's machine and is always absent here. Writing
    // it must not influence this page.
    try { window.localStorage.setItem('ridefleet_lang', 'en'); } catch { /* jsdom */ }
    vi.stubGlobal('navigator', { ...window.navigator, language: 'es-PR' });
    apiMock.mockResolvedValue(payload({ companyName: 'Autos del Valle', signerLocale: null }));
    render(<SignClient token="TOK" />);

    expect(await screen.findByText('Términos y Condiciones')).toBeInTheDocument();
  });

  it('falls back to English for an unsupported locale', async () => {
    vi.stubGlobal('navigator', { ...window.navigator, language: 'fr-CA' });
    apiMock.mockResolvedValue(payload({ companyName: 'Autos del Valle', signerLocale: 'fr' }));
    render(<SignClient token="TOK" />);

    expect(await screen.findByText('Terms & Conditions')).toBeInTheDocument();
  });

  it('offers an explicit toggle, because locale detection only ever guesses', async () => {
    apiMock.mockResolvedValue(payload({ companyName: 'Autos del Valle' }));
    render(<SignClient token="TOK" />);

    await screen.findByText('Autos del Valle');
    expect(screen.getByRole('button', { name: 'ES' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EN' })).toBeInTheDocument();
  });
});

/**
 * When the page cannot load, what the customer used to see was
 * `/api/sign/<their token> failed (410)` — their own credential, rendered in
 * English in the register of a console log, with nothing to do about it.
 *
 * The token has to stay out of the DOM entirely: this page is on a phone the
 * customer may hand to somebody, and a screenshot of it travels.
 */
const TOKEN = 'hh7Qm2v9TokenLooksLikeThis';

/** The exact string lib/client.js synthesises when a response has no JSON. */
function gatewayError(status) {
  const err = new Error(`/api/sign/${TOKEN} failed (${status})`);
  err.status = status;
  return err;
}

describe('sign page — failure states', () => {
  it('never prints the token when the load fails', async () => {
    apiMock.mockRejectedValue(gatewayError(502));
    render(<SignClient token={TOKEN} />);

    await screen.findByText("We couldn't open your agreement");
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.textContent).not.toContain('/api/sign');
    expect(document.body.textContent).not.toContain('502');
  });

  it('tells a customer with a dead link what actually helps', async () => {
    apiMock.mockRejectedValue(gatewayError(410));
    render(<SignClient token={TOKEN} />);

    expect(await screen.findByText('This link is no longer active')).toBeInTheDocument();
    expect(screen.getByText(/Ask your agent for a new code/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('treats a 404 the same as a 410 — the link is gone either way', async () => {
    apiMock.mockRejectedValue(gatewayError(404));
    render(<SignClient token={TOKEN} />);

    expect(await screen.findByText('This link is no longer active')).toBeInTheDocument();
  });

  it('separates a link that died from a request that merely failed', async () => {
    // A 500, or no network at all, is worth retrying with the SAME code —
    // telling that customer to go ask for a new one sends them to the counter
    // for nothing.
    apiMock.mockRejectedValue(new Error('Failed to fetch'));
    render(<SignClient token={TOKEN} />);

    expect(await screen.findByText("We couldn't open your agreement")).toBeInTheDocument();
    expect(screen.getByText('Ask your agent to show you the code again.')).toBeInTheDocument();
  });

  it('speaks the customer’s language on the dead end, and lets them switch', async () => {
    vi.stubGlobal('navigator', { ...window.navigator, language: 'es-PR' });
    apiMock.mockRejectedValue(gatewayError(410));
    render(<SignClient token={TOKEN} />);

    expect(await screen.findByText('Este enlace ya no está activo')).toBeInTheDocument();
    expect(screen.getByText(/Pídele a tu agente un código nuevo/)).toBeInTheDocument();
    // The toggle has to be reachable HERE too: a failure state with no way to
    // change language strands whoever the guess got wrong.
    expect(screen.getByRole('button', { name: 'ES' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EN' })).toBeInTheDocument();
  });

  it('shows no platform branding on the failure states either', async () => {
    apiMock.mockRejectedValue(gatewayError(410));
    render(<SignClient token={TOKEN} />);

    await screen.findByText('This link is no longer active');
    expect(document.body.textContent).not.toContain('Ride Fleet');
  });
});

/**
 * The OTHER half of the token defence — the one that runs mid-signature, when
 * the customer's POST to /initials or /complete fails behind an nginx 502.
 * The load path above is covered through the component; this path is not
 * reachable from jsdom without driving a canvas, so it is tested directly.
 *
 * It is also the half that matters most: by then the renter has already
 * started signing, and the screen they get is the one they will screenshot to
 * show the agent.
 */
describe('customerSafeMessage', () => {
  const FALLBACK = 'No se pudo guardar';
  const TOO_FAST = 'Espera un minuto';

  const opts = { token: TOKEN, fallback: FALLBACK, tooFast: TOO_FAST };

  it('drops a synthesised message that carries the token', () => {
    const err = new Error(`/api/sign/${TOKEN}/initials failed (502)`);
    err.status = 502;
    expect(customerSafeMessage(err, opts)).toBe(FALLBACK);
  });

  it('drops anything shaped like a bare API path, token or not', () => {
    // A 504 from nginx can truncate the body; the path prefix is the tell.
    expect(customerSafeMessage(new Error('/api/sign/x/complete failed (504)'), opts)).toBe(FALLBACK);
  });

  it('keeps a real server instruction, because the customer needs it', () => {
    // The blank-canvas guard: this exact sentence is how a renter learns to
    // actually draw something. Swallowing it would be its own bug.
    const err = new Error('The signature is blank — please sign before submitting');
    err.status = 400;
    expect(customerSafeMessage(err, opts))
      .toBe('The signature is blank — please sign before submitting');
  });

  it('translates a 429 instead of printing our rate limiter’s bucket name', () => {
    // The guard's own body — no token, no leading slash, so it would otherwise
    // pass straight through to a Spanish-speaking customer, in English.
    const err = new Error('Rate limit exceeded for terms-signing-write. Try again shortly.');
    err.status = 429;
    const out = customerSafeMessage(err, opts);
    expect(out).toBe(TOO_FAST);
    expect(out).not.toContain('terms-signing-write');
  });

  it('falls back when there is no message at all (a dropped connection)', () => {
    expect(customerSafeMessage(new Error(''), opts)).toBe(FALLBACK);
    expect(customerSafeMessage(undefined, opts)).toBe(FALLBACK);
  });
});
