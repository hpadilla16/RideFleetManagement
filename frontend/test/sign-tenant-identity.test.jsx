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

const { SignClient } = await import('../src/app/sign/[token]/SignClient.jsx');

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
