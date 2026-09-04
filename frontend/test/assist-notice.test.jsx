import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistNotice } from '../src/components/kiosk/AssistNotice';

// Mirrors the real keys; the copy under test is the DECISION of which key
// fires, not the wording.
const t = (key, vars = {}) => (vars.name ? `${key}:${vars.name}` : key);

// QA on the first cut: the banner was never visible, and in the routine case it
// never even fired — the grant was consumed before a poll could see it. These
// pin the rework: the ACT is shown durably, the permit only while open, and the
// name is the verified actor or nothing.
describe('AssistNotice', () => {
  it('renders nothing when nobody has touched the check-in', () => {
    const { container } = render(<AssistNotice t={t} state={{ open: false, helperName: null, verifiedBy: null }} />);
    expect(container.firstChild).toBeNull();
  });

  it('while a grant is open, says someone is helping right now', () => {
    render(<AssistNotice t={t} state={{ open: true, helperName: 'Marta Ruiz', verifiedBy: null }} />);
    const el = screen.getByTestId('assist-notice');
    expect(el.dataset.tone).toBe('now');
    expect(el.textContent).toContain('kiosk.assistNowNamed:Marta Ruiz');
  });

  it('after a REMOTE override, says so durably even though the grant is gone', () => {
    // This is the case the first version lost entirely: grant consumed, open:false,
    // and nothing left to tell the guest their identity was just confirmed by
    // someone they could not see.
    render(<AssistNotice t={t} state={{ open: false, helperName: 'Marta Ruiz', verifiedBy: 'REMOTE' }} />);
    const el = screen.getByTestId('assist-notice');
    expect(el.dataset.tone).toBe('done');
    expect(el.textContent).toContain('kiosk.assistRemoteDoneNamed:Marta Ruiz');
  });

  it('after an IN-PERSON override, says so too — the guest is told either way', () => {
    render(<AssistNotice t={t} state={{ open: false, helperName: 'Ana Admin', verifiedBy: 'IN_PERSON' }} />);
    expect(screen.getByTestId('assist-notice').textContent).toContain('kiosk.assistInPersonDoneNamed:Ana Admin');
  });

  it('with no verified name, uses the generic copy rather than inventing one', () => {
    // A service account is not a person. The server sends null for it, and the
    // guest reads "someone from our team", not a bot's display name.
    render(<AssistNotice t={t} state={{ open: true, helperName: null, verifiedBy: null }} />);
    expect(screen.getByTestId('assist-notice').textContent).toContain('kiosk.assistNow');
    expect(screen.getByTestId('assist-notice').textContent).not.toContain(':');
  });

  it('the open permit wins over the durable act while both are true', () => {
    // Second override in one session: the act is recorded AND a new grant is open.
    // "Helping you right now" is the more urgent, more current statement.
    render(<AssistNotice t={t} state={{ open: true, helperName: 'Marta Ruiz', verifiedBy: 'REMOTE' }} />);
    expect(screen.getByTestId('assist-notice').dataset.tone).toBe('now');
  });

  it('informs without ever blocking: role=status, polite, no interactive children', () => {
    render(<AssistNotice t={t} state={{ open: true, helperName: null, verifiedBy: null }} />);
    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.querySelector('button, a, input')).toBeNull();
  });
});
