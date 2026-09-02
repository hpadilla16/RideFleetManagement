/**
 * "Qué preguntan los agentes" — the copilot's authoring backlog card on the
 * People page (beside Team training). Pins, in order:
 *  (1) rows render the grouped miss: representative query, count, last-asked,
 *      the flagged badge ONLY on flagged groups, and "Buscar en KB" deep-links
 *      into the knowledge-base search prefill with the query encoded
 *  (2) the window is honest: the fetch asks for 7 days because the empty
 *      state says "this week"
 *  (3) the honest empty state renders on a successful empty answer
 *  (4) 403 (the ADMIN gate) renders NOTHING — the server owns the role
 *      decision, same idiom as TeamTraining
 *  (5) any other fetch failure also renders nothing — a network error is not
 *      "no unanswered questions"
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, dflt, opts) => {
      let out = typeof dflt === 'string' ? dflt : key;
      for (const [k, v] of Object.entries(opts && typeof opts === 'object' ? opts : {})) {
        out = out.replaceAll(`{{${k}}}`, String(v));
      }
      return out;
    },
  }),
}));

const apiCalls = [];
let apiHandler = async () => ({ items: [] });
vi.mock('../src/lib/client', () => ({
  api: async (path, opts, token) => {
    apiCalls.push({ path, token });
    return apiHandler(path, opts, token);
  },
}));

import { CopilotMisses, MISSES_DAYS, MISSES_LIMIT } from '../src/components/training/CopilotMisses';

const GROUPS = {
  days: 7,
  items: [
    {
      normalizedQuery: 'como configuro el descuento de aaa',
      query: '¿Cómo configuro el descuento de AAA?',
      count: 4,
      lastAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      flagged: true,
    },
    {
      normalizedQuery: 'how do i split a payment',
      query: 'how do I split a payment',
      count: 2,
      lastAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      flagged: false,
    },
  ],
};

beforeEach(() => {
  apiCalls.length = 0;
  apiHandler = async () => ({ items: [] });
});

describe('the top-misses admin card', () => {
  it('renders the grouped backlog: query, count, flagged badge, KB deep link', async () => {
    apiHandler = async () => GROUPS;
    render(<CopilotMisses token="jwt" />);

    await waitFor(() => expect(screen.getByText('What agents are asking')).toBeInTheDocument());
    expect(screen.getByText('¿Cómo configuro el descuento de AAA?')).toBeInTheDocument();
    expect(screen.getByText('how do I split a payment')).toBeInTheDocument();
    expect(screen.getByText(/Asked 4×/)).toBeInTheDocument();
    expect(screen.getByText(/Asked 2×/)).toBeInTheDocument();
    expect(screen.getByText(/last 3h ago/)).toBeInTheDocument();

    // The flagged badge marks the flagged group and ONLY the flagged group.
    expect(screen.getAllByText('Flagged')).toHaveLength(1);

    // "Buscar en KB" → the knowledge-base search prefill, query encoded.
    const links = screen.getAllByRole('link', { name: 'Search the KB' });
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe(
      `/knowledge-base?search=${encodeURIComponent('¿Cómo configuro el descuento de AAA?')}`
    );
  });

  it('asks for 7 days — the window the empty state claims', async () => {
    render(<CopilotMisses token="jwt" />);
    await waitFor(() => expect(apiCalls).toHaveLength(1));
    expect(MISSES_DAYS).toBe(7);
    expect(apiCalls[0].path).toBe(`/api/copilot/misses/top?days=7&limit=${MISSES_LIMIT}`);
    expect(apiCalls[0].token).toBe('jwt');
  });

  it('an empty week renders the honest empty state', async () => {
    render(<CopilotMisses token="jwt" />);
    await waitFor(() =>
      expect(screen.getByText('No unanswered questions this week.')).toBeInTheDocument()
    );
  });

  it('403 renders nothing — the ADMIN gate is the server’s call', async () => {
    apiHandler = async () => { throw new Error('403 Forbidden'); };
    const { container } = render(<CopilotMisses token="jwt" />);
    await waitFor(() => expect(apiCalls).toHaveLength(1));
    expect(container.firstChild).toBeNull();
  });

  it('a network failure renders nothing rather than a false "all clear"', async () => {
    apiHandler = async () => { throw new Error('fetch failed'); };
    const { container } = render(<CopilotMisses token="jwt" />);
    await waitFor(() => expect(apiCalls).toHaveLength(1));
    expect(container.firstChild).toBeNull();
  });
});
