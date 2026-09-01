/**
 * Check-in Audit page components (2026-09-03, T1 only).
 * Pins, in order:
 *  (1) KPI strip renders the four tiles and NO AI-spend tile (Mock 1 minus
 *      the T2 cost tile)
 *  (2) queue table: one row per reservation, T1 chips, and EVERY row's
 *      Photo AI · T2 column is the honest "not enabled" placeholder
 *  (3) the empty Possible-damage lane explains itself instead of showing a
 *      bare empty state
 *  (4) detail cards: mileage/fuel card renders the audited numbers; entry
 *      card marks the failing check; the photo pane is the T2 placeholder
 *  (5) dismiss dialog: NOT_ISSUE always available; the pre-existing verb is
 *      DISABLED for rules findings (awaits T2) and enabled for damage ones
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key, opts) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && opts.defaultValue) return opts.defaultValue;
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

import { KpiStrip, AuditQueueTable, AuditDetailCards, DismissDialog } from '../src/app/checkin-audit/page';

describe('KpiStrip', () => {
  it('renders the four T1 tiles and no AI-spend tile', () => {
    render(<KpiStrip kpis={{ auditedToday: 23, cleanPassToday: 17, openDamage: 0, openEntryErrors: 4 }} />);
    expect(screen.getByTestId('kpi-auditedToday')).toHaveTextContent('23');
    expect(screen.getByTestId('kpi-cleanPassToday')).toHaveTextContent('17');
    expect(screen.getByTestId('kpi-openEntryErrors')).toHaveTextContent('4');
    expect(screen.getByTestId('kpi-openDamage')).toHaveTextContent('0');
    const strip = screen.getByTestId('ca-kpis');
    expect(strip.children).toHaveLength(4);
    expect(strip.textContent).not.toMatch(/\$/);
    expect(strip.textContent.toLowerCase()).not.toContain('spend');
  });
});

const QUEUE_ROWS = [
  { id: 'f1', reservationId: 'r-2398', reservationNumber: 'RSV-2398', vehicleLabel: 'Kia Forte · KLM-310', checkKey: 'ODO_IMPOSSIBLE', category: 'ENTRY', severity: 'ERROR', status: 'OPEN', details: { odometerOut: 41210, odometerIn: 41190 }, closedByName: 'M. Rivera', returnedAt: '2026-08-28T18:04:00Z' },
  { id: 'f2', reservationId: 'r-2391', reservationNumber: 'RSV-2391', vehicleLabel: 'Toyota RAV4 · PQR-559', checkKey: 'MILES_OUTLIER', category: 'MILEAGE_FUEL', severity: 'WARN', status: 'OPEN', details: { milesPerDay: 861, band: 600 }, closedByName: 'A. Colón', returnedAt: '2026-08-28T16:31:00Z' },
];

describe('AuditQueueTable', () => {
  it('groups by reservation and shows T1 chips with the mockup numbers', () => {
    render(<AuditQueueTable rows={QUEUE_ROWS} lane="all" onOpen={() => {}} />);
    const table = screen.getByTestId('ca-table');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.getByText('RSV-2398')).toBeInTheDocument();
    expect(screen.getByTestId('chip-ODO_IMPOSSIBLE')).toHaveTextContent('Odometer < checkout');
    expect(screen.getByTestId('chip-MILES_OUTLIER')).toHaveTextContent('861');
  });

  it('every row shows the honest Photo AI placeholder — T2 is not enabled', () => {
    render(<AuditQueueTable rows={QUEUE_ROWS} lane="all" onOpen={() => {}} />);
    expect(screen.getAllByTestId('t2-placeholder')).toHaveLength(2);
    expect(screen.getAllByTestId('t2-placeholder')[0]).toHaveTextContent('Photo AI not enabled');
  });

  it('the empty Possible-damage lane says WHY it is empty', () => {
    render(<AuditQueueTable rows={[]} lane="damage" onOpen={() => {}} />);
    expect(screen.getByTestId('ca-empty').textContent).toMatch(/Photo AI is not enabled/);
    expect(screen.getByTestId('ca-empty').textContent).toMatch(/T2/);
  });

  it('other empty lanes use the plain empty copy', () => {
    render(<AuditQueueTable rows={[]} lane="entry" onOpen={() => {}} />);
    expect(screen.getByTestId('ca-empty').textContent).toMatch(/Nothing in this lane/);
  });
});

describe('AuditDetailCards', () => {
  it('renders the Mock-2 numbers on a clean audit: 12,404 → 12,981, refill fee billed', () => {
    const detail = {
      findings: [{
        id: 'p1', checkKey: 'PASS', category: 'PASS', status: 'RESOLVED',
        details: { odometerOut: 12404, odometerIn: 12981, rentalDays: 5, milesPerDay: 115, fuelOut: 1, fuelIn: 0.45, fuelRefillCharged: true, photoCount: 8, hasSignature: true },
      }],
    };
    render(<AuditDetailCards detail={detail} />);
    expect(screen.getByTestId('arow-odometer')).toHaveTextContent('12,404');
    expect(screen.getByTestId('arow-odometer')).toHaveTextContent('12,981');
    expect(screen.getByTestId('arow-odometer')).toHaveTextContent('115/day');
    expect(screen.getByTestId('arow-fuel')).toHaveTextContent('100%');
    expect(screen.getByTestId('arow-fuel')).toHaveTextContent('45%');
    expect(screen.getByTestId('arow-fuel')).toHaveTextContent('refill fee billed');
    expect(screen.getByTestId('card-entry-checks')).toHaveTextContent('3 / 3');
  });

  it('marks the failing rows on a flagged audit and keeps the T2 pane a placeholder', () => {
    const detail = {
      findings: [
        { id: 'f1', checkKey: 'ODO_IMPOSSIBLE', category: 'ENTRY', status: 'OPEN', details: { odometerOut: 41210, odometerIn: 41190 } },
        { id: 'f2', checkKey: 'ENTRIES_INCOMPLETE', category: 'ENTRY', status: 'OPEN', details: { missingAngles: ['rearSeat', 'trunk'], hasSignature: false } },
      ],
    };
    render(<AuditDetailCards detail={detail} />);
    expect(screen.getByTestId('arow-odometer').className).toContain('is-warn');
    expect(screen.getByTestId('arow-impossible')).toHaveTextContent('one entry is wrong');
    expect(screen.getByTestId('arow-entries')).toHaveTextContent('2 angle photos missing');
    expect(screen.getByTestId('arow-entries')).toHaveTextContent('no signature');
    expect(screen.getByTestId('t2-photo-pane').textContent).toMatch(/Photo AI is not enabled/);
    expect(screen.getByTestId('t2-photo-pane').textContent).toMatch(/nothing is ever charged automatically/);
  });
});

describe('DismissDialog', () => {
  it('rules findings: NOT_ISSUE selectable, pre-existing verb disabled with the T2 note', () => {
    const finding = { id: 'f1', checkKey: 'MILES_OUTLIER', category: 'MILEAGE_FUEL', status: 'OPEN' };
    render(<DismissDialog finding={finding} onCancel={() => {}} onDismiss={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).not.toBeDisabled();
    expect(radios[1]).toBeDisabled();
    expect(screen.getByTestId('dismiss-dialog').textContent).toMatch(/awaits the photo tier/);
  });

  it('damage findings (T2 shape): both verbs available; confirming fires the chosen classification', () => {
    const finding = { id: 'f2', checkKey: 'PHOTO_PAIR_REAR', category: 'DAMAGE', status: 'OPEN' };
    const onDismiss = vi.fn();
    render(<DismissDialog finding={finding} onCancel={() => {}} onDismiss={onDismiss} />);
    const radios = screen.getAllByRole('radio');
    expect(radios[1]).not.toBeDisabled();
    fireEvent.click(radios[1]);
    fireEvent.click(screen.getByTestId('dismiss-confirm'));
    expect(onDismiss).toHaveBeenCalledWith('PREEXISTING');
  });

  it('defaults to NOT_ISSUE', () => {
    const finding = { id: 'f1', checkKey: 'ODO_IMPOSSIBLE', category: 'ENTRY', status: 'OPEN' };
    const onDismiss = vi.fn();
    render(<DismissDialog finding={finding} onCancel={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('dismiss-confirm'));
    expect(onDismiss).toHaveBeenCalledWith('NOT_ISSUE');
  });
});
