/**
 * Check-in Audit — T2 photo AI UI (2026-09-02).
 * Pins, in order:
 *  (1) lane/chip logic: DAMAGE_SUSPECTED chips, the Photo AI queue cell in
 *      every sweep state, the KPI list conditional (AI tile only when
 *      enabled)
 *  (2) KPI strip: 5 tiles with the $ spend tile when photoAiEnabled, the T1
 *      four when not
 *  (3) queue table: the Possible-damage lane FILLS (suspected chips with
 *      confidence), per-row Photo AI verdict cells, and the enabled-tenant
 *      empty-lane copy
 *  (4) pair viewer: angle strip (warm dot on the flagged angle), checkout +
 *      check-in photos, the suspected-region overlay, the verdict card with
 *      confidence + the suggestion-only disclaimer, the known-damage
 *      annotation, and the skipped/pending notes
 *  (5) T1-only tenants keep the placeholder pane (honesty preserved)
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

import {
  photoAiCell,
  findingChip,
  checkinAuditKpis,
  angleFromCheckKey,
  CHECKIN_AUDIT_KPIS,
  DAMAGE_SUSPECTED_PREFIX,
} from '../src/lib/checkin-audit-lanes';
import { KpiStrip, AuditQueueTable, AuditDetailCards, PhotoPairPane } from '../src/app/checkin-audit/page';

describe('lane logic (T2)', () => {
  it('findingChip: DAMAGE_SUSPECTED:<angle> renders confidence, danger for ERROR, warn otherwise', () => {
    const err = findingChip({ checkKey: 'DAMAGE_SUSPECTED:rear', severity: 'ERROR', details: { confidence: 78 } });
    expect(err.tone).toBe('danger');
    expect(err.params.conf).toBe(78);
    expect(err.defaultLabel).toBe('Possible damage 78%');
    const warn = findingChip({ checkKey: 'DAMAGE_SUSPECTED:front', severity: 'WARN', details: { confidence: 55 } });
    expect(warn.tone).toBe('warn');
  });

  it('photoAiCell: placeholder when disabled; verdict states when enabled; worst suspected wins', () => {
    expect(photoAiCell({ status: 'ANALYZED' }, false).key).toBe('off');
    expect(photoAiCell(undefined, true).key).toBe('pending');
    expect(photoAiCell({ status: 'ANALYZED', suspected: [] }, true).key).toBe('clean');
    expect(photoAiCell({ status: 'SKIPPED_BUDGET' }, true).key).toBe('skippedBudget');
    expect(photoAiCell({ status: 'SKIPPED_NO_PHOTOS' }, true).key).toBe('skippedPhotos');
    expect(photoAiCell({ status: 'FAILED' }, true).key).toBe('failed');
    const sus = photoAiCell({
      status: 'ANALYZED',
      suspected: [
        { angle: 'front', confidence: 45, severity: 'WARN' },
        { angle: 'rear', confidence: 78, severity: 'ERROR' },
      ],
    }, true);
    expect(sus.key).toBe('suspected');
    expect(sus.tone).toBe('danger');
    expect(sus.params.conf).toBe(78);
  });

  it('KPI list: the AI tile appears ONLY when photo AI is enabled', () => {
    expect(checkinAuditKpis(false)).toHaveLength(4);
    expect(checkinAuditKpis(false)).toEqual(CHECKIN_AUDIT_KPIS);
    const withAi = checkinAuditKpis(true);
    expect(withAi).toHaveLength(5);
    expect(withAi[4].id).toBe('aiSpendToday');
  });

  it('angleFromCheckKey recovers the angle', () => {
    expect(angleFromCheckKey(`${DAMAGE_SUSPECTED_PREFIX}frontSeat`)).toBe('frontSeat');
    expect(angleFromCheckKey('ODO_IMPOSSIBLE')).toBe(null);
  });
});

describe('KpiStrip (T2)', () => {
  it('renders the $ spend tile with analyzed/skipped detail when enabled', () => {
    render(<KpiStrip photoAiEnabled kpis={{ auditedToday: 23, cleanPassToday: 17, openDamage: 2, openEntryErrors: 4, aiSpendTodayUsd: 0.61, aiAnalyzedToday: 21, aiSkippedBudgetToday: 3 }} />);
    const strip = screen.getByTestId('ca-kpis');
    expect(strip.children).toHaveLength(5);
    expect(screen.getByTestId('kpi-aiSpendToday')).toHaveTextContent('$0.61');
    expect(screen.getByTestId('kpi-aiSpendToday')).toHaveTextContent('21 analyzed · 3 over budget');
  });

  it('stays the honest T1 four when disabled', () => {
    render(<KpiStrip photoAiEnabled={false} kpis={{ auditedToday: 5, aiSpendTodayUsd: 9 }} />);
    const strip = screen.getByTestId('ca-kpis');
    expect(strip.children).toHaveLength(4);
    expect(strip.textContent).not.toMatch(/\$/);
  });
});

const DAMAGE_ROW = {
  id: 'f9', reservationId: 'r-2417', reservationNumber: 'RSV-2417', vehicleLabel: 'Toyota Corolla · ABC-124',
  checkKey: 'DAMAGE_SUSPECTED:rear', category: 'DAMAGE', severity: 'ERROR', status: 'OPEN',
  details: { angle: 'rear', confidence: 78 }, closedByName: 'M. Rivera', returnedAt: '2026-08-29T13:42:00Z',
};

describe('AuditQueueTable (T2)', () => {
  it('the Possible-damage lane FILLS: suspected chip with confidence + Photo AI verdict cell', () => {
    const t2 = { 'r-2417': { status: 'ANALYZED', suspected: [{ angle: 'rear', confidence: 78, severity: 'ERROR' }] } };
    render(<AuditQueueTable rows={[DAMAGE_ROW]} lane="damage" onOpen={() => {}} t2={t2} photoAiEnabled />);
    expect(screen.getByTestId('chip-DAMAGE_SUSPECTED:rear')).toHaveTextContent('Possible damage 78%');
    expect(screen.getByTestId('t2-cell-suspected')).toHaveTextContent('78');
    expect(screen.queryByTestId('t2-placeholder')).toBeNull();
  });

  it('verdict cells per sweep state: clean, budget-skipped, pending', () => {
    const rows = [
      { ...DAMAGE_ROW, id: 'a', reservationId: 'r1', checkKey: 'MILES_OUTLIER', category: 'MILEAGE_FUEL', severity: 'WARN', details: { milesPerDay: 700 } },
      { ...DAMAGE_ROW, id: 'b', reservationId: 'r2', checkKey: 'PASS', category: 'PASS', status: 'RESOLVED', details: {} },
      { ...DAMAGE_ROW, id: 'c', reservationId: 'r3', checkKey: 'PASS', category: 'PASS', status: 'RESOLVED', details: {} },
    ];
    const t2 = {
      r1: { status: 'ANALYZED', suspected: [] },
      r2: { status: 'SKIPPED_BUDGET', suspected: [] },
      // r3 has no summary yet → pending
    };
    render(<AuditQueueTable rows={rows} lane="all" onOpen={() => {}} t2={t2} photoAiEnabled />);
    expect(screen.getByTestId('t2-cell-clean')).toHaveTextContent('No new marks');
    expect(screen.getByTestId('t2-cell-skippedBudget')).toHaveTextContent('daily budget');
    expect(screen.getByTestId('t2-cell-pending')).toHaveTextContent('Queued');
  });

  it('an enabled tenant with a clear damage lane gets the clear copy, not the not-enabled copy', () => {
    render(<AuditQueueTable rows={[]} lane="damage" onOpen={() => {}} t2={{}} photoAiEnabled />);
    expect(screen.getByTestId('ca-empty').textContent).toMatch(/No possible-damage flags right now/);
    expect(screen.getByTestId('ca-empty').textContent).not.toMatch(/not enabled/);
  });
});

const T2_DETAIL = {
  reservationId: 'r-2417',
  photoAiEnabled: true,
  t2Scan: { resolution: 'ANALYZED', details: { pairsAnalyzed: 2 } },
  photoPairs: {
    front: { checkout: 'https://signed/front-out.jpg', checkin: 'https://signed/front-in.jpg' },
    rear: { checkout: 'https://signed/rear-out.jpg', checkin: 'https://signed/rear-in.jpg' },
  },
  findings: [
    { id: 'p1', checkKey: 'PASS', category: 'PASS', status: 'RESOLVED', details: { odometerOut: 12404, odometerIn: 12981, milesPerDay: 115, fuelOut: 1, fuelIn: 0.9 } },
    {
      id: 'f9', checkKey: 'DAMAGE_SUSPECTED:rear', category: 'DAMAGE', severity: 'ERROR', status: 'OPEN', tier: 'T2',
      details: {
        angle: 'rear', view: 'REAR', confidence: 78, kind: 'scuff',
        description: 'A light-colored scuff appears on the lower-left rear bumper',
        region: { x: 0.14, y: 0.59, w: 0.24, h: 0.19 },
        knownDamageMatched: ['kd-1'],
      },
    },
  ],
};

describe('PhotoPairPane (Mock 2)', () => {
  it('renders the pair for the flagged angle first: both photos, region overlay, verdict card with confidence + disclaimer', () => {
    render(<PhotoPairPane detail={T2_DETAIL} />);
    // Flagged angle selected by default; warm dot on it, tick on the clean one.
    expect(screen.getByTestId('angle-rear').className).toContain('is-on');
    expect(screen.getByTestId('angle-rear').className).toContain('is-flagged');
    expect(screen.getByTestId('angle-front').className).not.toContain('is-flagged');
    // The pair.
    const pair = screen.getByTestId('pair-rear');
    const imgs = pair.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('src')).toBe('https://signed/rear-out.jpg');
    expect(imgs[1].getAttribute('src')).toBe('https://signed/rear-in.jpg');
    // Region overlay is %-positioned from the model's region estimate.
    const region = screen.getByTestId('suspect-region');
    expect(region.style.left).toBe('14%');
    expect(region.style.top).toBe('59%');
    expect(region.textContent).toMatch(/Suspected · scuff/);
    // Verdict card: suggestion-only, confidence shown, disclaimer inside.
    const card = screen.getByTestId('ai-verdict-card');
    expect(card.textContent).toMatch(/Possible new damage/);
    expect(card.textContent).toMatch(/78%/);
    expect(card.textContent).toMatch(/lower-left rear bumper/);
    expect(card.textContent).toMatch(/nothing is ever charged automatically/i);
    // The known-damage match is ANNOTATED, never hidden.
    expect(screen.getByTestId('known-damage-note')).toBeInTheDocument();
  });

  it('switching to a clean angle shows its pair and the no-marks note instead of a verdict card', () => {
    render(<PhotoPairPane detail={T2_DETAIL} />);
    fireEvent.click(screen.getByTestId('angle-front'));
    expect(screen.getByTestId('pair-front')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-verdict-card')).toBeNull();
    expect(screen.getByTestId('t2-angle-clean')).toHaveTextContent('No new marks suspected');
  });

  it('a budget-skipped close says so explicitly', () => {
    render(<PhotoPairPane detail={{ photoAiEnabled: true, t2Scan: { resolution: 'SKIPPED_BUDGET' }, photoPairs: null, findings: [] }} />);
    expect(screen.getByTestId('t2-pane-note').textContent).toMatch(/daily photo-AI budget/);
  });

  it('a not-yet-swept close reads as queued', () => {
    render(<PhotoPairPane detail={{ photoAiEnabled: true, t2Scan: null, photoPairs: null, findings: [] }} />);
    expect(screen.getByTestId('t2-pane-note').textContent).toMatch(/Queued for the photo sweep/);
  });
});

describe('AuditDetailCards routing', () => {
  it('with photo AI data the placeholder is replaced by the pair viewer', () => {
    render(<AuditDetailCards detail={T2_DETAIL} />);
    expect(screen.getByTestId('t2-pair-viewer')).toBeInTheDocument();
    expect(screen.queryByTestId('t2-photo-pane')).toBeNull();
  });

  it('a T1-only tenant keeps the honest placeholder', () => {
    render(<AuditDetailCards detail={{ photoAiEnabled: false, findings: [{ id: 'p1', checkKey: 'PASS', category: 'PASS', status: 'RESOLVED', details: {} }] }} />);
    expect(screen.getByTestId('t2-photo-pane').textContent).toMatch(/Photo AI is not enabled/);
    expect(screen.queryByTestId('t2-pair-viewer')).toBeNull();
  });
});
