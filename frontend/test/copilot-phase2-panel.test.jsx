/**
 * Agent Copilot Phase 2 — the panel's live behaviors.
 * Pins, in order:
 *  (1) live article body: a KB-backed answer fetches the real Ride University
 *      article and renders the asker's language half inside the card,
 *      scrollable, with the curated summary still leading and the deep-link
 *      CTA still present
 *  (2) the fallback: any article-fetch error leaves the Phase 1 card exactly
 *      as it was — curated summary, steps, source chip, no crash
 *  (3) per-session cache: two answers on the same slug fetch once
 *  (4) the AI fallback OFF (the default): a miss renders the Phase 1 card
 *      and NOTHING else — no ask request ever leaves
 *  (5) the AI fallback ON: a miss still renders the honest card first, then
 *      the AI answer arrives as a DISTINCT bubble — AI chip, disclaimer,
 *      clickable sources
 *  (6) an unavailable answer (cap, no-answer, error) adds nothing
 *  (7) the micro-module: the owner's question now offers "Show me" and the
 *      record-scoped pre-flight asks for the reservation
 *  (8) telemetry: a miss triggers the opportunistic flush; "Tell an admin"
 *      hits the flag endpoint with the question
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const nav = { pathname: '/dashboard', push: vi.fn() };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

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
  return { useTranslation: () => ({ t: (k, o) => (typeof o === 'string' ? o : (o?.defaultValue ?? k)), i18n: i18nDouble }) };
});

// The network double. Route → handler; tests reprogram `routes` per case.
const netCalls = [];
const routes = { handlers: {} };
vi.mock('../src/lib/client', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readStoredToken: () => 'test-jwt',
    api: async (path, opts = {}) => {
      netCalls.push({ path, method: opts.method || 'GET', body: opts.body });
      for (const [prefix, handler] of Object.entries(routes.handlers)) {
        if (path.startsWith(prefix)) return handler(path, opts);
      }
      throw new Error(`unmocked route: ${path}`);
    },
  };
});

import { Copilot } from '../src/components/copilot/Copilot';
import { resetCopilotLiveCaches } from '../src/lib/training/copilot-live.js';

const AGENT = { role: 'AGENT', isModuleEnabled: () => true };

const TOLL_ARTICLE = {
  title: 'Processing Toll Charges',
  slug: 'processing-toll-charges',
  body: [
    '## Toll Processing',
    '',
    '1. Open the Tolls screen',
    '2. Match the crossing to the rental',
    '',
    '---',
    '',
    '## Procesar peajes (Español)',
    '',
    '1. Abre la pantalla de Tolls',
    '2. Cruza el peaje con la renta',
    '',
    '**El cruce decide quién paga.**',
  ].join('\n'),
};

function stubDefaults() {
  routes.handlers = {
    '/api/copilot/misses': async () => ({ accepted: 0 }),
    '/api/copilot/ai-status': async () => ({ enabled: false }),
    '/api/knowledge-base/article/': async () => TOLL_ARTICLE,
  };
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'How do I…?' }));
}

function ask(question) {
  const input = screen.getByPlaceholderText('Type your question…');
  fireEvent.change(input, { target: { value: question } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

const callsTo = (prefix) => netCalls.filter((c) => c.path.startsWith(prefix));

beforeEach(() => {
  nav.pathname = '/dashboard';
  nav.push = vi.fn();
  window.localStorage.clear();
  netCalls.length = 0;
  resetCopilotLiveCaches();
  stubDefaults();
});

describe('live article body (Phase 2 item 2)', () => {
  it('renders the Spanish half of the real article inside the card, curated lead intact, deep link kept', async () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('how do I process toll charges');

    // Phase 1 furniture is untouched and immediate.
    expect(screen.getByText(/caen en la pantalla de Tolls/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View article' })).toBeInTheDocument();

    // The live body arrives — the ES half (panel language), block-rendered.
    expect(await screen.findByText('Abre la pantalla de Tolls')).toBeInTheDocument();
    expect(screen.getByText(/From the article · Processing Toll Charges/)).toBeInTheDocument();
    expect(screen.getByText('El cruce decide quién paga.')).toBeInTheDocument();
    // The English half stayed on its side of the split.
    expect(screen.queryByText('Open the Tolls screen')).toBeNull();
  });

  it('any fetch error degrades to the exact Phase 1 card — summary, source chip, no body, no crash', async () => {
    routes.handlers['/api/knowledge-base/article/'] = async () => { throw new Error('503'); };
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('how do I process toll charges');

    expect(screen.getByText(/caen en la pantalla de Tolls/)).toBeInTheDocument();
    expect(screen.getByText(/Source · Processing Toll Charges/)).toBeInTheDocument();
    await waitFor(() => expect(callsTo('/api/knowledge-base/article/').length).toBe(1));
    expect(document.querySelector('[data-copilot="article-body"]')).toBeNull();
  });

  it('caches per session: the same slug asked twice fetches once', async () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('how do I process toll charges');
    expect(await screen.findByText('Abre la pantalla de Tolls')).toBeInTheDocument();
    ask('cargos de peaje');
    await waitFor(() => expect(screen.getAllByText('Abre la pantalla de Tolls')).toHaveLength(2));
    expect(callsTo('/api/knowledge-base/article/')).toHaveLength(1);
  });
});

describe('the AI fallback, OFF by default (Phase 2 item 4)', () => {
  it('a miss stays byte-identical to Phase 1: honest card, no ask request', async () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('¿Cómo configuro el descuento de AAA?');

    expect(screen.getByText(/I don't have that in the articles yet/)).toBeInTheDocument();
    await waitFor(() => expect(callsTo('/api/copilot/ai-status')).toHaveLength(1));
    expect(callsTo('/api/copilot/ask')).toHaveLength(0);
    expect(document.querySelector('[data-copilot="ai-answer"]')).toBeNull();
  });

  it('enabled: the honest card still comes first, then the AI bubble — chip, disclaimer, clickable source', async () => {
    routes.handlers['/api/copilot/ai-status'] = async () => ({ enabled: true });
    routes.handlers['/api/copilot/ask'] = async () => ({
      answer: 'Los depósitos se configuran en Settings → Fees.',
      sources: [{ slug: 'payment-processing', title: 'Payment Processing Guide' }],
      model: 'claude-haiku-4-5-20251001',
    });
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('¿Cómo configuro el descuento de AAA?');

    // Honest first — the miss card renders synchronously.
    expect(screen.getByText(/I don't have that in the articles yet/)).toBeInTheDocument();

    // Then the AI answer, visually its own thing.
    expect(await screen.findByText('Los depósitos se configuran en Settings → Fees.')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText(/AI-generated from Ride University articles/)).toBeInTheDocument();

    // The cited article deep-links like any other.
    fireEvent.click(screen.getByRole('button', { name: 'Payment Processing Guide' }));
    expect(nav.push).toHaveBeenCalledWith('/knowledge-base?article=payment-processing');

    const askBody = JSON.parse(callsTo('/api/copilot/ask')[0].body);
    expect(askBody).toEqual({ query: '¿Cómo configuro el descuento de AAA?', lang: 'es' });
  });

  it('an unavailable reply (cap, no answer, error) adds nothing to the conversation', async () => {
    routes.handlers['/api/copilot/ai-status'] = async () => ({ enabled: true });
    routes.handlers['/api/copilot/ask'] = async () => ({ unavailable: 'CAP_EXCEEDED' });
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('something the map does not know');

    await waitFor(() => expect(callsTo('/api/copilot/ask')).toHaveLength(1));
    expect(document.querySelector('[data-copilot="ai-answer"]')).toBeNull();
    expect(screen.getByText(/I don't have that in the articles yet/)).toBeInTheDocument();
  });
});

describe('the additional-drivers micro-module (Phase 2 item 3)', () => {
  it('the owner’s question now offers the tour, and pre-flight asks for the reservation', () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('¿Cómo añado un conductor adicional?');

    // The curated answer still leads; "Show me" now exists.
    expect(screen.getByText('Abre la reserva del cliente.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));

    // Record-scoped from /dashboard → the NEEDS_RECORD question, engine parks.
    expect(screen.getByText(/Which reservation is the problem on\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take me to Reservations' })).toBeInTheDocument();
  });
});

describe('telemetry (Phase 2 item 1, client side)', () => {
  it('a miss triggers the opportunistic flush with the buffered entry', async () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    netCalls.length = 0; // ignore the open-flush (buffer was empty anyway)
    ask('¿Cómo configuro el descuento de AAA?');

    await waitFor(() => expect(callsTo('/api/copilot/misses').length).toBeGreaterThan(0));
    const flush = callsTo('/api/copilot/misses').find((c) => !c.path.includes('/flag'));
    const body = JSON.parse(flush.body);
    expect(body.entries[0]).toMatchObject({
      query: '¿Cómo configuro el descuento de AAA?',
      lang: 'es',
      pathname: '/dashboard',
      flagged: false,
    });
  });

  it('"Tell an admin" hits the flag endpoint with the question', async () => {
    render(<Copilot viewer={AGENT} />);
    openPanel();
    ask('something the map does not know');
    fireEvent.click(screen.getByRole('button', { name: 'Tell an admin' }));

    expect(screen.getByText('Noted — an admin will see it.')).toBeInTheDocument();
    await waitFor(() => expect(callsTo('/api/copilot/misses/flag')).toHaveLength(1));
    const body = JSON.parse(callsTo('/api/copilot/misses/flag')[0].body);
    expect(body.query).toBe('something the map does not know');
    expect(body.pathname).toBe('/dashboard');
  });
});
