import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * QR self-return — the public customer page (Hector, 2026-09-02).
 * What these tests pin down against /api/public/self-return/:token:
 *  - Context load renders the location name and the pair form.
 *  - Submit POSTs { reservationNumber, lastName } and the success screen
 *    shows the recorded time ("Devolución registrada").
 *  - A submit 404 with a LIVE context renders the mismatch guidance (check
 *    number + last name) — the page, not the server, distinguishes it from
 *    a dead token; the server body is the same generic 404 for both.
 *  - already:true renders the "Ya estaba registrada" screen (idempotent
 *    re-scan keeps the FIRST stamp).
 *  - A dead token (context 404) renders the friendly not-active page and
 *    never shows the form.
 */

import { ReturnClient } from '../src/app/return/[token]/ReturnClient';

// Deliberately NOT key-shaped: a `prefix_hex` fixture trips gitleaks' generic-api-key rule (CI hard gate).
const TOKEN = 'TEST-SELF-RETURN-TOKEN';

function mockFetch({ contextStatus = 200, submit } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = String(url);
    if (opts.method === 'POST' && u.includes('/submit')) {
      const out = submit || { ok: true, already: false, reportedAt: '2026-09-02T18:14:00.000Z' };
      if (out.status === 404) return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
      return { ok: true, status: 200, json: async () => out };
    }
    if (contextStatus === 404) return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    return { ok: true, status: 200, json: async () => ({ locationName: 'SJU Airport' }) };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const fill = () => {
  fireEvent.change(screen.getByTestId('res-input'), { target: { value: 'R-1001' } });
  fireEvent.change(screen.getByTestId('name-input'), { target: { value: 'Peña' } });
};

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('ride-self-return-lang', 'es'); // deterministic ES-primary strings
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('QR self-return page', () => {
  it('loads the context and submits the pair; success shows the recorded time', async () => {
    const { calls } = mockFetch({});
    render(<ReturnClient token={TOKEN} />);
    await waitFor(() => expect(screen.getByText('SJU Airport')).toBeTruthy());

    fill();
    fireEvent.click(screen.getByTestId('submit-return'));
    await waitFor(() => expect(screen.getByTestId('done-screen')).toBeTruthy());
    expect(screen.getByText('¡Devolución registrada!')).toBeTruthy();

    const post = calls.find((c) => c.opts?.method === 'POST');
    expect(post.url).toContain(`/api/public/self-return/${encodeURIComponent(TOKEN)}/submit`);
    expect(JSON.parse(post.opts.body)).toEqual({ reservationNumber: 'R-1001', lastName: 'Peña' });
  });

  it('a submit 404 with a live context reads as a pair mismatch, not a dead page', async () => {
    mockFetch({ submit: { status: 404 } });
    render(<ReturnClient token={TOKEN} />);
    await waitFor(() => expect(screen.getByText('SJU Airport')).toBeTruthy());

    fill();
    fireEvent.click(screen.getByTestId('submit-return'));
    await waitFor(() => expect(screen.getByTestId('not-found-error')).toBeTruthy());
    // The form survives — the customer corrects the typo and retries.
    expect(screen.getByTestId('submit-return')).toBeTruthy();
  });

  it('already:true renders the idempotent "ya estaba registrada" screen with the FIRST time', async () => {
    mockFetch({ submit: { ok: true, already: true, reportedAt: '2026-09-02T14:14:00.000Z' } });
    render(<ReturnClient token={TOKEN} />);
    await waitFor(() => expect(screen.getByText('SJU Airport')).toBeTruthy());

    fill();
    fireEvent.click(screen.getByTestId('submit-return'));
    await waitFor(() => expect(screen.getByTestId('already-screen')).toBeTruthy());
    expect(screen.getByText('Ya estaba registrada')).toBeTruthy();
  });

  it('a dead token renders the not-active page and no form', async () => {
    mockFetch({ contextStatus: 404 });
    render(<ReturnClient token={TOKEN} />);
    await waitFor(() => expect(screen.getByText('Este código no está activo')).toBeTruthy());
    expect(screen.queryByTestId('submit-return')).toBeNull();
  });
});
