import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * The two autopay pages are where a tenant's owner authorises a recurring
 * charge against their card. They used to be hardcoded Spanish with no language
 * choice at all; most tenants are not in Puerto Rico, so English is now the
 * default and Spanish is reachable.
 *
 * What these tests actually pin, in order of how much it would cost to get
 * wrong:
 *
 *   1. ENGLISH IS THE DEFAULT with no stored choice and no Spanish browser
 *      hint. This is the whole point of the change and the one thing a future
 *      refactor is most likely to flip by accident.
 *   2. SPANISH IS NOT LOST — the browser hint reaches it, the toggle reaches
 *      it, and the choice survives to the return leg.
 *   3. FIRST vs NEXT charge survives translation in BOTH languages. An
 *      enrollment that says "next charge" is the "why was I charged, I thought
 *      this was free" call.
 *   4. The billing DATE is the same calendar day in both languages. The
 *      timeZone: 'UTC' option is load-bearing: drop it and a UTC-4 reader
 *      authorises the day before the one that charges.
 *   5. The consent disclosure is rendered VERBATIM from the server payload in
 *      both languages — it is the archived artefact, and translating it in the
 *      browser would put text on screen that no stored record matches.
 */

const apiMock = vi.fn();
vi.mock('../src/lib/client', () => ({
  API_BASE: 'http://localhost:4000',
  api: (...args) => apiMock(...args),
}));

const { AutopayClient } = await import('../src/app/(public)/autopay/[token]/AutopayClient.jsx');
const { AutopayReturnClient } = await import('../src/app/(public)/autopay/[token]/return/AutopayReturnClient.jsx');

const DISCLOSURE = 'Autos del Valle autoriza a Ride Car Sharing LLC a cobrar automáticamente…';

/** A /api/public/billing/autopay/:token payload with the fields under test. */
function invite(over = {}) {
  return {
    mode: 'enroll',
    companyName: 'Autos del Valle',
    email: 'owner@autosdelvalle.test',
    planName: 'Fleet Pro',
    amount: '249.00',
    currency: 'USD',
    intervalUnit: 'months',
    intervalLength: 1,
    startDate: '2026-09-01',
    nextChargeDate: null,
    trialOccurrences: 0,
    disclosureText: DISCLOSURE,
    cardBrand: null,
    cardLast4: null,
    alreadyEnrolled: false,
    ...over,
  };
}

/** A /return payload — the activated receipt unless told otherwise. */
function receipt(over = {}) {
  return {
    status: 'activated',
    companyName: 'Autos del Valle',
    planName: 'Fleet Pro',
    amount: '249.00',
    currency: 'USD',
    cardBrand: 'Visa',
    cardLast4: '4242',
    firstChargeDate: '2026-09-01',
    nextChargeDate: null,
    reference: 'ARB-991',
    ...over,
  };
}

/**
 * navigator.language is the only "hint" input. Default it to English so no test
 * accidentally depends on the machine running the suite.
 */
function browserLanguage(tag) {
  vi.stubGlobal('navigator', new Proxy(window.navigator, {
    get: (target, prop) => (prop === 'language' ? tag : Reflect.get(target, prop)),
  }));
}

beforeEach(() => {
  apiMock.mockReset();
  try { window.localStorage.clear(); } catch { /* jsdom */ }
  document.documentElement.lang = '';
  document.title = '';
  browserLanguage('en-US');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('autopay enrollment — language', () => {
  it('defaults to English with no stored choice and no Spanish browser hint', async () => {
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('Authorize automatic payment')).toBeInTheDocument();
    expect(screen.getByText('First charge')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Autorizar cobro automático');
    expect(document.body.textContent).not.toContain('Primer cargo');
  });

  it('still defaults to English when the browser reports a language we do not ship', async () => {
    browserLanguage('fr-FR');
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('Authorize automatic payment')).toBeInTheDocument();
  });

  it('follows a Spanish browser hint', async () => {
    browserLanguage('es-PR');
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('Autorizar cobro automático')).toBeInTheDocument();
    expect(screen.getByText('Primer cargo')).toBeInTheDocument();
  });

  it('honours a stored choice over the browser hint, and stores what the toggle picks', async () => {
    apiMock.mockResolvedValue(invite());
    const { unmount } = render(<AutopayClient token="TOK" />);

    await screen.findByText('Authorize automatic payment');
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText('Autorizar cobro automático')).toBeInTheDocument();
    expect(window.localStorage.getItem('ride-autopay-lang')).toBe('es');

    // A reload with an English browser must NOT undo the choice.
    unmount();
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);
    expect(await screen.findByText('Autorizar cobro automático')).toBeInTheDocument();
  });

  it('does not read the agent-side app language key', async () => {
    // ridefleet_lang lives on the AGENT's device inside the authenticated app.
    // This page opens from an email on the subscriber's own machine; reading it
    // here would be reading a value that has nothing to do with this reader.
    window.localStorage.setItem('ridefleet_lang', 'es');
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('Authorize automatic payment')).toBeInTheDocument();
  });

  it('keeps <html lang> and the tab title in step with the chosen language', async () => {
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);

    await screen.findByText('Authorize automatic payment');
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(document.title).toBe('Payment method');

    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('es'));
    expect(document.title).toBe('Método de pago');
  });

  it('offers the toggle on the dead-end state too', async () => {
    apiMock.mockRejectedValue(new Error('nope'));
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('This link is no longer active')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText('Este enlace ya no está activo')).toBeInTheDocument();
  });

  it('translates the already-enrolled state', async () => {
    apiMock.mockResolvedValue(invite({ alreadyEnrolled: true }));
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('Autopay is already active')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText('El autopago ya está activo')).toBeInTheDocument();
  });
});

describe('autopay enrollment — the charge facts', () => {
  it('labels a NEW enrollment the FIRST charge in both languages, never the next one', async () => {
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('First charge')).toBeInTheDocument();
    expect(screen.queryByText('Next charge')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText('Primer cargo')).toBeInTheDocument();
    expect(screen.queryByText('Próximo cargo')).not.toBeInTheDocument();
  });

  it('labels an UPDATE the next charge in both languages', async () => {
    apiMock.mockResolvedValue(invite({ mode: 'update', nextChargeDate: '2026-10-01' }));
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('Next charge')).toBeInTheDocument();
    expect(screen.queryByText('First charge')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText('Próximo cargo')).toBeInTheDocument();
    expect(screen.queryByText('Primer cargo')).not.toBeInTheDocument();
  });

  it('renders the billing date as the SAME calendar day in both languages', async () => {
    // '2026-09-01' must never render as 31 August. That is what the
    // timeZone: 'UTC' option in formatCalendarDate exists to prevent, and it
    // does not vary with the locale tag.
    apiMock.mockResolvedValue(invite({ startDate: '2026-09-01' }));
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('September 1, 2026')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText(/1 de septiembre de 2026/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('agosto');
  });

  it('keeps the amount and the cadence unmistakable in both languages', async () => {
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('$249.00 USD')).toBeInTheDocument();
    expect(screen.getByText('monthly')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText('mensual')).toBeInTheDocument();
    expect(screen.getByText('$249.00 USD')).toBeInTheDocument();
  });
});

describe('autopay enrollment — the consent archive', () => {
  it('renders the archived disclosure VERBATIM whichever language is on screen', async () => {
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
  });

  it('tells an English reader what language the archived authorization is in', async () => {
    apiMock.mockResolvedValue(invite());
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText(/shown exactly as it was issued, in Spanish/)).toBeInTheDocument();
  });

  it('drops that note once the disclosure arrives in the language on screen', async () => {
    // Forward compatibility: the day the backend issues the disclosure in the
    // subscriber's language and sends the tag, the note must retire itself
    // rather than keep announcing a mismatch that no longer exists.
    apiMock.mockResolvedValue(invite({ disclosureLang: 'en', disclosureText: 'Autos del Valle authorizes…' }));
    render(<AutopayClient token="TOK" />);

    expect(await screen.findByText('Autos del Valle authorizes…')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('shown exactly as it was issued');
  });
});

describe('autopay return leg — language', () => {
  it('defaults to English on the activated receipt', async () => {
    apiMock.mockResolvedValue(receipt());
    render(<AutopayReturnClient token="TOK" />);

    expect(await screen.findByText('Autopay is active')).toBeInTheDocument();
    expect(screen.getByText('First charge')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Autopago activado');
  });

  it('defaults to English on the updated receipt', async () => {
    apiMock.mockResolvedValue(receipt({ status: 'updated', nextChargeDate: '2026-10-01' }));
    render(<AutopayReturnClient token="TOK" />);

    expect(await screen.findByText('Payment method updated')).toBeInTheDocument();
    expect(screen.getByText('Next charge')).toBeInTheDocument();
    expect(screen.queryByText('First charge')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Método de pago actualizado');
  });

  it('reaches Spanish on both receipts, keeping first-vs-next intact', async () => {
    apiMock.mockResolvedValue(receipt());
    const { unmount } = render(<AutopayReturnClient token="TOK" />);

    await screen.findByText('Autopay is active');
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText('Autopago activado')).toBeInTheDocument();
    expect(screen.getByText('Primer cargo')).toBeInTheDocument();
    expect(screen.queryByText('Próximo cargo')).not.toBeInTheDocument();

    // The choice carries over from the enrollment page — same page-local key.
    unmount();
    apiMock.mockResolvedValue(receipt({ status: 'updated', nextChargeDate: '2026-10-01' }));
    render(<AutopayReturnClient token="TOK" />);
    expect(await screen.findByText('Método de pago actualizado')).toBeInTheDocument();
    expect(screen.getByText('Próximo cargo')).toBeInTheDocument();
  });

  it.each([
    ['no_method', 'No payment method was saved', 'No se guardó ningún método'],
    ['method_saved_not_activated', 'We saved your payment method', 'Guardamos tu método de pago'],
    ['method_saved_not_repointed', 'We saved your new method', 'Guardamos tu método nuevo'],
    ['in_progress', 'We are activating your autopay', 'Estamos activando tu autopago'],
  ])('translates the %s outcome', async (status, en, es) => {
    apiMock.mockResolvedValue(receipt({ status }));
    render(<AutopayReturnClient token="TOK" />);

    expect(await screen.findByText(en)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText(es)).toBeInTheDocument();
  });

  it('translates the dead end', async () => {
    apiMock.mockRejectedValue(new Error('nope'));
    render(<AutopayReturnClient token="TOK" />);

    expect(await screen.findByText('This link is no longer active')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText('Este enlace ya no está activo')).toBeInTheDocument();
  });

  it('keeps the 30-day cancellation promise identical in meaning in both languages', async () => {
    // Policy copy, translated faithfully and NOT restated: the 30-day notice is
    // unconfirmed by the owner, so both languages must say the same thing until
    // they decide otherwise.
    apiMock.mockResolvedValue(receipt());
    render(<AutopayReturnClient token="TOK" />);

    expect(await screen.findByText(/You can cancel autopay by giving us 30 days’ notice\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText(/cancelar el autopago avisándonos con 30 días de anticipación\./)).toBeInTheDocument();
  });

  it('names the card in both languages without ever showing more than the last four', async () => {
    apiMock.mockResolvedValue(receipt());
    render(<AutopayReturnClient token="TOK" />);

    expect(await screen.findByText(/Visa card ending in 4242/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText(/tarjeta Visa terminada en 4242/)).toBeInTheDocument();
  });

  it('renders the receipt date as the same calendar day in both languages', async () => {
    apiMock.mockResolvedValue(receipt({ firstChargeDate: '2026-09-01' }));
    render(<AutopayReturnClient token="TOK" />);

    expect(await screen.findByText('September 1, 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(await screen.findByText(/1 de septiembre de 2026/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('agosto');
  });
});
