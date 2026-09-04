/**
 * The per-location contract clause editor.
 *
 * WHAT THIS PINS — behavioral contracts, not markup:
 *
 *  1. The character count and the terminal verdict track the TEXTAREA, live.
 *     An admin typing past 250 has to be told while they are typing, not after
 *     they save, because past 250 the counter terminal refuses the clause and
 *     every check-out at that branch moves to the renter's phone.
 *  2. The consequence is spelled out in WORDS, not signalled by a colour.
 *  3. Going over does NOT disable saving. The editor makes the cost visible; it
 *     never quietly shortens a legal instrument, and never refuses a lawful one.
 *  4. Restore-to-standard is ONE action, and the PUT it produces simply omits
 *     the key — not an empty string, which the backend rejects and which would
 *     leave an admin unable to tell a restore from a failed save.
 *  5. The location being edited is named on screen.
 *  6. The damage clause — 353 characters, and never shown on a terminal — is
 *     not measured against the terminal cap.
 *  7. Spanish renders (the namespace-merge guard every recent surface carries).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../src/lib/client', () => ({ api: apiMock }));

import i18n from '../src/lib/i18n';
import { LocationClausesPanel } from '../src/components/settings/LocationClausesPanel';

const TERMINAL_MAX = 250;
const STANDARD_DEPOSIT = 'I authorize a security deposit hold of $500 against my card on file. '
  + 'I further authorize the merchant to charge the same card for unpaid tolls, traffic fines, '
  + 'parking citations, fuel, cleaning, and damage assessed after the rental ends.';

function clause(over = {}) {
  const canonicalBody = over.canonicalBody ?? STANDARD_DEPOSIT;
  const body = over.body ?? canonicalBody;
  return {
    key: 'deposit_post_charges',
    scope: 'ALWAYS',
    label: 'Deposit and post-rental charges',
    canonicalLabel: 'Deposit and post-rental charges',
    canonicalBody,
    canonicalLength: canonicalBody.trim().length,
    body,
    isOverridden: body !== canonicalBody,
    bodyOverridden: body !== canonicalBody,
    labelOverridden: false,
    length: body.trim().length,
    terminalText: body.trim(),
    ridesTerminal: true,
    fitsTerminal: body.trim().length <= TERMINAL_MAX,
    nearTerminalLimit: false,
    canonicalOverTerminal: false,
    ...over,
  };
}

const DAMAGE_BODY = 'I acknowledge that I caused the damage described in this report during my rental, '
  + 'and I accept responsibility for it under the terms of my rental agreement, up to the amounts and '
  + 'deductibles that apply to the coverage I selected. I have reviewed the description and the '
  + 'photographs included in this report and confirm they reflect the damage accurately.';

function payload(over = {}) {
  return {
    location: { id: 'loc1', code: 'LAX', name: 'Los Angeles Airport' },
    clauses: [clause()],
    terminal: { max: TERMINAL_MAX, warnAt: TERMINAL_MAX - 20, blockedKeys: [], terminalSigningAvailable: true },
    limits: { maxBody: 2000, maxLabel: 120 },
    storage: { ok: true, reason: null, detail: null, unknownKeys: [], rawLength: null },
    ...over,
  };
}

function mountWith(data) {
  apiMock.mockImplementation(async (path, opts) => {
    if (opts?.method === 'PUT') return payload({ changed: [{ key: 'deposit_post_charges', change: 'SET' }] });
    return data;
  });
  return render(
    <LocationClausesPanel locationId="loc1" locationName="Los Angeles Airport" locationCode="LAX" />,
  );
}

const textarea = () => screen.getByLabelText('Deposit and post-rental charges');

beforeEach(() => { apiMock.mockReset(); i18n.changeLanguage('en'); });
afterEach(() => { i18n.changeLanguage('en'); });

describe('location clause editor', () => {
  it('names the location being edited — scope is per branch and must not be guessed', async () => {
    mountWith(payload());
    expect(await screen.findByText('Los Angeles Airport')).toBeInTheDocument();
    expect(screen.getByText(/LAX/)).toBeInTheDocument();
    expect(screen.getByText(/THIS location only/i)).toBeInTheDocument();
  });

  it('shows the standard text, marked as standard, with restore unavailable', async () => {
    mountWith(payload());
    await screen.findByText('Standard text');
    expect(textarea()).toHaveValue(STANDARD_DEPOSIT);
    expect(screen.getByRole('button', { name: 'Restore standard text' })).toBeDisabled();
    // Nothing to save when nothing has changed.
    expect(screen.getByRole('button', { name: 'Save clauses' })).toBeDisabled();
  });

  it('counts characters LIVE against the terminal cap as the admin types', async () => {
    mountWith(payload());
    await screen.findByText('Standard text');
    expect(screen.getByText(`${STANDARD_DEPOSIT.length} / 250 characters`)).toBeInTheDocument();

    fireEvent.change(textarea(), { target: { value: 'Short.' } });
    expect(screen.getByText('6 / 250 characters')).toBeInTheDocument();
    // And the clause is now marked as this branch's own text, not the standard.
    expect(screen.getByText('Custom for this location')).toBeInTheDocument();
  });

  it('trims the way the terminal does — surrounding whitespace is not charged', async () => {
    mountWith(payload());
    await screen.findByText('Standard text');
    fireEvent.change(textarea(), { target: { value: '   Six!!   ' } });
    expect(screen.getByText('5 / 250 characters')).toBeInTheDocument();
  });

  it('warns BEFORE the edge, and says what crossing it costs', async () => {
    mountWith(payload());
    await screen.findByText('Standard text');
    fireEvent.change(textarea(), { target: { value: 'x'.repeat(240) } });
    expect(screen.getByText('240 / 250 characters')).toBeInTheDocument();
    // The sentence names the real consequence, with the exact runway left.
    expect(screen.getByText(/10 characters left before the terminal refuses this clause/i)).toBeInTheDocument();
    expect(screen.getByText(/check-outs move to the phone/i)).toBeInTheDocument();
    // Still fits, so still labelled as fitting.
    expect(screen.getByText('Fits the terminal')).toBeInTheDocument();
  });

  it('at exactly 250 the clause still fits; at 251 it does not', async () => {
    mountWith(payload());
    await screen.findByText('Standard text');

    fireEvent.change(textarea(), { target: { value: 'x'.repeat(250) } });
    expect(screen.getByText('Fits the terminal')).toBeInTheDocument();
    expect(screen.queryByText('Phone signing only')).toBeNull();

    fireEvent.change(textarea(), { target: { value: 'x'.repeat(251) } });
    expect(screen.getByText('Phone signing only')).toBeInTheDocument();
    expect(screen.queryByText('Fits the terminal')).toBeNull();
  });

  it('spells the consequence out in words — not merely a colour or a chip', async () => {
    mountWith(payload());
    await screen.findByText('Standard text');
    fireEvent.change(textarea(), { target: { value: 'x'.repeat(300) } });

    // Per clause.
    expect(screen.getByText(/The counter terminal will refuse this clause, so check-outs here move to the renter/i))
      .toBeInTheDocument();
    // And at the top of the panel, naming the clause responsible.
    expect(screen.getByText(/will be signed on the renter’s phone, not the counter terminal/i)).toBeInTheDocument();
    expect(screen.getByText(/Over the limit: Deposit and post-rental charges/)).toBeInTheDocument();
  });

  it('does NOT block saving an over-length clause — the editor informs, it does not degrade', async () => {
    mountWith(payload());
    await screen.findByText('Standard text');
    fireEvent.change(textarea(), { target: { value: 'x'.repeat(300) } });

    const save = screen.getByRole('button', { name: 'Save clauses' });
    expect(save).toBeEnabled();
    expect(screen.getByText(/You can still save it/i)).toBeInTheDocument();

    fireEvent.click(save);
    await waitFor(() => {
      const put = apiMock.mock.calls.find(([, o]) => o?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put[1].body).overrides.deposit_post_charges.body).toHaveLength(300);
    });
  });

  it('previews what the renter sees on the device, and what happens when it will not fit', async () => {
    mountWith(payload());
    await screen.findByText('On the counter terminal');
    // The accept/decline options are the terminal's own bilingual strings.
    expect(screen.getByText('I agree / Acepto')).toBeInTheDocument();
    expect(screen.getByText('Decline / No acepto')).toBeInTheDocument();

    fireEvent.change(textarea(), { target: { value: 'x'.repeat(300) } });
    expect(screen.getByText(/The terminal never shows this clause/i)).toBeInTheDocument();
    expect(screen.getByText(/the clause is not cut short/i)).toBeInTheDocument();
    expect(screen.queryByText('I agree / Acepto')).toBeNull();
  });

  it('restore-to-standard is ONE action, and the save OMITS the key rather than blanking it', async () => {
    mountWith(payload({ clauses: [clause({ body: 'Branch-specific deposit wording.' })] }));
    await screen.findByText('Custom for this location');
    expect(textarea()).toHaveValue('Branch-specific deposit wording.');

    fireEvent.click(screen.getByRole('button', { name: 'Restore standard text' }));
    expect(textarea()).toHaveValue(STANDARD_DEPOSIT);
    expect(screen.getByText('Standard text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore standard text' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save clauses' }));
    await waitFor(() => {
      const put = apiMock.mock.calls.find(([, o]) => o?.method === 'PUT');
      expect(put).toBeTruthy();
      const { overrides } = JSON.parse(put[1].body);
      // Absent — NOT { body: '' }, which the backend rejects precisely so a
      // restore and a failed save can never look the same.
      expect(overrides).toEqual({});
    });
  });

  it('shows the standard text beside the override so the admin can judge the change', async () => {
    mountWith(payload({ clauses: [clause({ body: 'Branch-specific deposit wording.' })] }));
    await screen.findByRole('button', { name: 'Show standard text' });
    expect(screen.queryByText(STANDARD_DEPOSIT)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show standard text' }));
    expect(screen.getByText(STANDARD_DEPOSIT)).toBeInTheDocument();
    expect(screen.getByText(`Standard text — ${STANDARD_DEPOSIT.length} characters`)).toBeInTheDocument();
  });

  it('says plainly when the STANDARD wording is the thing over the cap — nobody can fix that here', async () => {
    const declined = clause({
      key: 'declined_insurance',
      scope: 'DECLINED_INSURANCE',
      label: 'Declined insurance acknowledgement',
      canonicalLabel: 'Declined insurance acknowledgement',
      canonicalBody: 'y'.repeat(274),
      body: 'y'.repeat(274),
      canonicalLength: 274,
      length: 274,
      fitsTerminal: false,
      canonicalOverTerminal: true,
    });
    mountWith(payload({
      clauses: [declined],
      terminal: { max: TERMINAL_MAX, warnAt: 230, blockedKeys: ['declined_insurance'], terminalSigningAvailable: false },
    }));
    expect(await screen.findByText(/The standard wording for this clause is 274 characters/i)).toBeInTheDocument();
    expect(screen.getByText(/Only when the renter declines counter insurance/i)).toBeInTheDocument();
  });

  it('does not measure the damage clause against the terminal — it never goes near one', async () => {
    const damage = clause({
      key: 'damage_acknowledgement',
      scope: 'DAMAGE_REPORT',
      label: 'Damage acknowledgement',
      canonicalLabel: 'Damage acknowledgement',
      canonicalBody: DAMAGE_BODY,
      body: DAMAGE_BODY,
      canonicalLength: DAMAGE_BODY.length,
      length: DAMAGE_BODY.length,
      ridesTerminal: false,
      fitsTerminal: null,
      canonicalOverTerminal: false,
    });
    mountWith(payload({ clauses: [damage] }));
    await screen.findByText('Damage acknowledgement');
    // 353 characters and NOT flagged: the cap does not apply to this surface.
    expect(DAMAGE_BODY.length).toBeGreaterThan(TERMINAL_MAX);
    expect(screen.getByText(`${DAMAGE_BODY.length} characters`)).toBeInTheDocument();
    expect(screen.queryByText('Phone signing only')).toBeNull();
    expect(screen.queryByText(/On the counter terminal/)).toBeNull();
    expect(screen.getByText(/no length limit applies/i)).toBeInTheDocument();
  });

  it('surfaces a broken stored blob instead of showing a reassuring "all standard"', async () => {
    mountWith(payload({ storage: { ok: false, reason: 'NOT_JSON', detail: 'x', unknownKeys: [], rawLength: 12 } }));
    expect(await screen.findByText(/not readable/i)).toBeInTheDocument();
    expect(screen.getByText(/currently signing the standard text/i)).toBeInTheDocument();
  });

  it('names keys stranded in the column so a pre-existing typo cannot be erased unseen', async () => {
    mountWith(payload({
      storage: { ok: true, reason: null, detail: null, unknownKeys: ['deposit_post_chargez'], rawLength: 40 },
    }));
    expect(await screen.findByText(/deposit_post_chargez/)).toBeInTheDocument();
    expect(screen.getByText(/never taken effect/i)).toBeInTheDocument();
  });

  it('says that clauses save on their own — the modal footer does not carry them', async () => {
    mountWith(payload());
    expect(await screen.findByText(/Clauses save on their own/i)).toBeInTheDocument();
  });

  it('surfaces a rejected save rather than pretending it worked', async () => {
    apiMock.mockImplementation(async (path, opts) => {
      if (opts?.method === 'PUT') throw new Error('Unknown clause key: nope.');
      return payload();
    });
    render(<LocationClausesPanel locationId="loc1" locationName="Los Angeles Airport" locationCode="LAX" />);
    await screen.findByText('Standard text');
    fireEvent.change(textarea(), { target: { value: 'Branch wording.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save clauses' }));
    expect(await screen.findByText('Unknown clause key: nope.')).toBeInTheDocument();
    // And the admin's text is still in the box — a failed save must not eat it.
    expect(textarea()).toHaveValue('Branch wording.');
  });
});

describe('location clause editor (ES)', () => {
  it('renders in Spanish — the namespace-merge guard', async () => {
    await i18n.changeLanguage('es');
    mountWith(payload());
    expect(await screen.findByText('Texto estándar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar cláusulas' })).toBeInTheDocument();
    expect(screen.getByText(/SOLO en esta sucursal/i)).toBeInTheDocument();
    fireEvent.change(textarea(), { target: { value: 'x'.repeat(300) } });
    expect(screen.getByText(/La terminal del mostrador rechazará esta cláusula/i)).toBeInTheDocument();
    expect(screen.getByText('300 / 250 caracteres')).toBeInTheDocument();
  });
});
