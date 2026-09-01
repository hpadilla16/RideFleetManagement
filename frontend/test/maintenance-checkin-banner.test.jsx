/**
 * Maintenance detection at check-in (Feature A, 2026-09-01).
 * Pins, in order:
 *  (1) lib/maintenance-eval mirrors the backend evalSchedule against the
 *      TYPED reading — the banner appears exactly when the typed odometer
 *      crosses an interval, with the concrete gap (mockup numbers: 48,730
 *      → "Oil change — 1,230 mi overdue", tire rotation due in 370 mi)
 *  (2) the Continue gate: blocked only while an OVERDUE row is pending a
 *      decision — due-soon rows ride along informationally and never gate
 *  (3) the banner lists every overdue + due-soon schedule with its gap chip
 *  (4) ARMED state: "will send at close" strip + Undo (armed, not fired)
 *  (5) the snooze confirm: one confirm with the re-prompt rule, optional
 *      collapsed note, automatic stamp preview — confirming reports the note
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// t() that keeps interpolation visible: "key|param,param" so copy assertions
// can pin BOTH the key and the concrete numbers that reached it.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      if (opts && typeof opts === 'object') {
        const params = Object.entries(opts)
          .filter(([k]) => k !== 'defaultValue')
          .map(([, v]) => String(v));
        if (params.length) return `${key}|${params.join(',')}`;
        if (opts.defaultValue) return opts.defaultValue;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

import { buildDueItems, maintenanceGateBlocked, evalScheduleAt } from '../src/lib/maintenance-eval';
import { MaintenanceCheckinBanner } from '../src/components/wizard/MaintenanceCheckinBanner';

const NOW = new Date('2026-09-01T14:14:00Z').getTime();
// The mockup's vehicle: LOF every 5,000 (last 42,500 → due 47,500),
// tire rotation every 7,500 (last 41,600 → due 49,100).
const SCHEDULES = [
  { serviceType: 'LOF', intervalMiles: 5000, intervalDays: null, lastServiceMiles: 42500, lastServiceAt: null, active: true },
  { serviceType: 'TIRE_ROTATION', intervalMiles: 7500, intervalDays: null, lastServiceMiles: 41600, lastServiceAt: null, active: true },
];

describe('maintenance-eval (typed-reading arithmetic)', () => {
  it('no rows below the interval — the banner has nothing to show', () => {
    expect(buildDueItems(SCHEDULES, 46900, NOW)).toEqual([]);
    expect(buildDueItems(SCHEDULES, null, NOW)).toEqual([]);
    expect(buildDueItems(SCHEDULES, '', NOW)).toEqual([]);
  });

  it('typed 48,730 crosses LOF (1,230 mi overdue) and pulls tires into due-soon (370 mi)', () => {
    const items = buildDueItems(SCHEDULES, 48730, NOW);
    expect(items).toHaveLength(2);
    // Overdue first.
    expect(items[0].serviceType).toBe('LOF');
    expect(items[0].state).toBe('OVERDUE');
    expect(items[0].gapMiles).toBe(1230);
    expect(items[0].nextDueMiles).toBe(47500);
    expect(items[1].serviceType).toBe('TIRE_ROTATION');
    expect(items[1].state).toBe('SOON');
    expect(items[1].gapMiles).toBe(370);
  });

  it('inactive schedules never surface; days-only schedules use the day basis', () => {
    const items = buildDueItems([
      { ...SCHEDULES[0], active: false },
      { serviceType: 'INSPECTION', intervalMiles: null, intervalDays: 30, lastServiceMiles: null, lastServiceAt: new Date(NOW - 40 * 86400000).toISOString(), active: true },
    ], 48730, NOW);
    expect(items).toHaveLength(1);
    expect(items[0].serviceType).toBe('INSPECTION');
    expect(items[0].basis).toBe('DAYS');
    expect(items[0].state).toBe('OVERDUE');
    expect(items[0].gapDays).toBe(10);
  });

  it('mirrors the backend contract: miles decide when a mileage basis exists', () => {
    const ev = evalScheduleAt(
      { intervalMiles: 5000, intervalDays: 90, lastServiceMiles: 10000, lastServiceAt: new Date(NOW - 120 * 86400000) },
      11000, NOW,
    );
    expect(ev.basis).toBe('MILES');
    expect(ev.overdue).toBe(false); // calendar lapsed, odometer says fine
  });

  it('Continue gate: OVERDUE + pending blocks; due-soon-only or a made decision never does', () => {
    const items = buildDueItems(SCHEDULES, 48730, NOW);
    expect(maintenanceGateBlocked(items, 'PENDING')).toBe(true);
    expect(maintenanceGateBlocked(items, 'ARMED')).toBe(false);
    expect(maintenanceGateBlocked(items, 'SNOOZED')).toBe(false);
    const soonOnly = buildDueItems(SCHEDULES, 47400, NOW); // 100 mi shy of the LOF interval
    expect(soonOnly.every((i) => i.state === 'SOON')).toBe(true);
    expect(maintenanceGateBlocked(soonOnly, 'PENDING')).toBe(false);
    expect(maintenanceGateBlocked([], 'PENDING')).toBe(false);
  });
});

const baseProps = (overrides = {}) => ({
  items: buildDueItems(SCHEDULES, 48730, NOW),
  unit: 'UNIT-025',
  typedOdometer: 48730,
  decision: { status: 'PENDING', note: null },
  onArm: vi.fn(),
  onUndo: vi.fn(),
  onSnooze: vi.fn(),
  stampPreview: { who: 'J. Rivera', res: 'RES-849112', when: 'Sep 1, 2:14 PM' },
  prevSnooze: null,
  ...overrides,
});

describe('MaintenanceCheckinBanner', () => {
  it('renders nothing when the typed reading crosses no interval', () => {
    const { container } = render(<MaintenanceCheckinBanner {...baseProps({ items: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each due schedule with its concrete gap chip', () => {
    render(<MaintenanceCheckinBanner {...baseProps()} />);
    expect(screen.getByTestId('maint-banner')).toBeInTheDocument();
    expect(screen.getByTestId('maint-row-LOF')).toHaveTextContent('maintCheckin.chip.overdueMi|1,230');
    expect(screen.getByTestId('maint-row-TIRE_ROTATION')).toHaveTextContent('maintCheckin.chip.dueSoonMi|370');
    // The header names the typed reading it recomputed from.
    expect(screen.getByText('maintCheckin.sub|48,730')).toBeInTheDocument();
    // One primary action + snooze + the consequence sentence.
    expect(screen.getByTestId('maint-send')).toBeInTheDocument();
    expect(screen.getByTestId('maint-snooze-open')).toBeInTheDocument();
    expect(screen.getByText('maintCheckin.consequence|UNIT-025')).toBeInTheDocument();
  });

  it('Send to maintenance arms the decision (fired later, at close)', () => {
    const props = baseProps();
    render(<MaintenanceCheckinBanner {...props} />);
    fireEvent.click(screen.getByTestId('maint-send'));
    expect(props.onArm).toHaveBeenCalledTimes(1);
  });

  it('ARMED state shows the will-send-at-close strip with a working Undo', () => {
    const props = baseProps({ decision: { status: 'ARMED', note: null } });
    render(<MaintenanceCheckinBanner {...props} />);
    expect(screen.getByTestId('maint-armed')).toHaveTextContent('maintCheckin.armed.msg');
    // The action bar is gone — armed replaces pending.
    expect(screen.queryByTestId('maint-send')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('maintCheckin.undo'));
    expect(props.onUndo).toHaveBeenCalledTimes(1);
  });

  it('snooze confirm: one confirm with the re-prompt rule, stamp preview, and the optional note', () => {
    const props = baseProps();
    render(<MaintenanceCheckinBanner {...props} />);
    fireEvent.click(screen.getByTestId('maint-snooze-open'));
    const dialog = screen.getByTestId('maint-snooze-confirm');
    expect(dialog).toHaveTextContent('maintCheckin.snooze.title|UNIT-025');
    expect(dialog).toHaveTextContent('maintCheckin.snooze.body');
    // The automatic stamp preview — who · reservation · odometer · when.
    expect(dialog).toHaveTextContent('maintCheckin.snooze.stamp|J. Rivera,RES-849112,48,730,Sep 1, 2:14 PM');
    fireEvent.change(screen.getByTestId('maint-snooze-note'), { target: { value: 'shop at capacity' } });
    fireEvent.click(screen.getByTestId('maint-snooze-confirm-btn'));
    expect(props.onSnooze).toHaveBeenCalledWith('shop at capacity');
  });

  it('snooze confirm without a note reports null (no mandatory reason)', () => {
    const props = baseProps();
    render(<MaintenanceCheckinBanner {...props} />);
    fireEvent.click(screen.getByTestId('maint-snooze-open'));
    fireEvent.click(screen.getByTestId('maint-snooze-confirm-btn'));
    expect(props.onSnooze).toHaveBeenCalledWith(null);
  });

  it('SNOOZED state shows the quiet re-surface strip; a prior snooze stamp is surfaced', () => {
    render(<MaintenanceCheckinBanner {...baseProps({
      decision: { status: 'SNOOZED', note: null },
      prevSnooze: { byName: 'M. Ortiz', at: '2026-08-20T12:00:00Z', note: 'shop full' },
    })} />);
    expect(screen.getByTestId('maint-snoozed')).toHaveTextContent('maintCheckin.snoozed.msg|UNIT-025');
    expect(screen.getByText(/maintCheckin\.prevSnooze\|M\. Ortiz/)).toBeInTheDocument();
  });
});
