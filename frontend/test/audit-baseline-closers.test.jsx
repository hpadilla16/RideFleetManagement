/**
 * Audit/baseline closers (2026-09-06) — the three flywheel pieces:
 *  (1) Convert-to-damage-report handoff: the "Create damage report" CTA in
 *      the photo-pair pane appears ONLY on an OPEN damage finding and hands
 *      the finding to the page's convert flow; a converted finding shows the
 *      "Converted · <name>" note instead; a baselined one its own note.
 *  (2) ReportDamageWizard prefill: audit evidence pre-loads the mark, view,
 *      description and photos, shows the evidence banner, and the submit
 *      carries sourceAuditFindingId — while the money fields stay EMPTY (the
 *      agent enters them; canSubmit stays false until a cost is typed).
 *  (3) Checkout known-damage disclosure: renders the compact card ONLY when
 *      the vehicle has active baseline entries — empty/error → nothing.
 *  (4) Seed proposals: ProposedSeedRow approve/discard wiring with the
 *      view correction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

const apiMock = vi.fn();
vi.mock('../src/lib/client', () => ({
  api: (...args) => apiMock(...args),
}));

import { PhotoPairPane } from '../src/app/checkin-audit/page';
import { ReportDamageWizard } from '../src/components/reservations/ReportDamageWizard';
import { KnownDamageDisclosure } from '../src/components/reservations/KnownDamageDisclosure';
import { ProposedSeedRow } from '../src/app/vehicles/[id]/page';

beforeEach(() => { apiMock.mockReset(); });

const t = (key, opts) => {
  if (typeof opts === 'string') return opts;
  return (opts && opts.defaultValue) || key;
};

function suspectDetail({ status = 'OPEN', resolution = null, dismissedByName = null } = {}) {
  return {
    reservationId: 'res-2417',
    photoAiEnabled: true,
    t2Scan: { resolution: 'ANALYZED' },
    photoPairs: { rear: { checkout: 'http://x/out.jpg', checkin: 'http://x/in.jpg' } },
    findings: [{
      id: 'f-t2-rear',
      checkKey: 'DAMAGE_SUSPECTED:rear',
      category: 'DAMAGE',
      severity: 'ERROR',
      status,
      resolution,
      dismissedByName,
      reservationId: 'res-2417',
      details: {
        angle: 'rear', confidence: 78, kind: 'scuff',
        description: 'Scuff ~15 cm, lower-left rear bumper',
        region: { x: 0.14, y: 0.59, w: 0.24, h: 0.19 },
      },
    }],
  };
}

describe('convert handoff (PhotoPairPane)', () => {
  it('OPEN damage finding + onConvert → the CTA renders and hands the finding over', () => {
    const onConvert = vi.fn();
    render(<PhotoPairPane detail={suspectDetail()} onConvert={onConvert} />);
    expect(screen.getByTestId('convert-handoff')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('convert-cta'));
    expect(onConvert).toHaveBeenCalledTimes(1);
    expect(onConvert.mock.calls[0][0].id).toBe('f-t2-rear');
  });

  it('no onConvert callback → no CTA (pane stays render-only)', () => {
    render(<PhotoPairPane detail={suspectDetail()} />);
    expect(screen.queryByTestId('convert-cta')).toBeNull();
  });

  it('RESOLVED · CONVERTED_TO_REPORT → the converted note, no CTA', () => {
    render(
      <PhotoPairPane
        detail={suspectDetail({ status: 'RESOLVED', resolution: 'CONVERTED_TO_REPORT', dismissedByName: 'M. Rivera' })}
        onConvert={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('convert-cta')).toBeNull();
    expect(screen.getByTestId('converted-note').textContent).toContain('M. Rivera');
  });

  it('RESOLVED · PREEXISTING_BASELINED → the baselined note', () => {
    render(
      <PhotoPairPane
        detail={suspectDetail({ status: 'RESOLVED', resolution: 'PREEXISTING_BASELINED', dismissedByName: 'M. Rivera' })}
        onConvert={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('convert-cta')).toBeNull();
    expect(screen.getByTestId('baselined-note')).toBeInTheDocument();
  });
});

describe('ReportDamageWizard prefill', () => {
  const reservation = {
    id: 'res-2417',
    reservationNumber: 'RSV-2417',
    vehicle: { year: 2023, make: 'Toyota', model: 'Corolla', plate: 'ABC-124' },
    customer: { firstName: 'Ana', lastName: 'Cruz' },
  };
  const prefill = {
    sourceAuditFindingId: 'f-t2-rear',
    view: 'REAR',
    xPct: 26,
    yPct: 69,
    angle: 'rear',
    confidence: 78,
    description: 'Scuff ~15 cm, lower-left rear bumper — AI-flagged, agent-verified',
    damagePhotos: ['data:image/jpeg;base64,aW4=', 'data:image/jpeg;base64,b3V0'],
  };

  it('pre-loads description, photos, view + mark, and shows the evidence banner — money stays empty', () => {
    render(<ReportDamageWizard reservation={reservation} token="tk" onClose={() => {}} prefill={prefill} />);
    expect(screen.getByTestId('audit-prefill-note').textContent).toContain('check-in audit');
    expect(screen.getByDisplayValue(/AI-flagged, agent-verified/)).toBeInTheDocument();
    expect(screen.getByText('2 attached')).toBeInTheDocument();
    // the money gate still blocks submit — the agent must type a cost
    expect(screen.getByText('Submit damage report').closest('button')).toBeDisabled();
  });

  it('submit posts sourceAuditFindingId along with the human-completed payload', async () => {
    apiMock.mockResolvedValue({ damageReportId: 'dmg-9', vehicleStatus: 'IN_MAINTENANCE' });
    render(<ReportDamageWizard reservation={reservation} token="tk" onClose={() => {}} onDone={() => {}} prefill={prefill} />);
    fireEvent.change(screen.getByPlaceholderText('e.g. 1,250.00'), { target: { value: '350' } });
    const btn = screen.getByText('Submit damage report').closest('button');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    const [path, opts] = apiMock.mock.calls[0];
    expect(path).toBe('/api/report-damage/res-2417/report-damage');
    const body = JSON.parse(opts.body);
    expect(body.sourceAuditFindingId).toBe('f-t2-rear');
    expect(body.view).toBe('REAR');
    expect(body.xPct).toBe(26);
    expect(body.yPct).toBe(69);
    expect(body.damagePhotos).toHaveLength(2);
    expect(body.damageCostCents).toBe(35000);
  });

  it('without prefill nothing changes: no banner, no sourceAuditFindingId key possible', () => {
    render(<ReportDamageWizard reservation={reservation} token="tk" onClose={() => {}} />);
    expect(screen.queryByTestId('audit-prefill-note')).toBeNull();
    expect(screen.getByText('0 attached')).toBeInTheDocument();
  });
});

describe('checkout known-damage disclosure', () => {
  it('renders the compact card when the vehicle has active baseline entries', async () => {
    apiMock.mockResolvedValue({
      active: [
        { id: 'd1', view: 'REAR', description: 'Scuff — lower-left rear bumper', approvedAt: '2026-06-12T10:00:00Z' },
        { id: 'd2', view: 'RIGHT', description: 'Chip — door edge', approvedAt: '2026-04-03T10:00:00Z' },
      ],
    });
    render(<KnownDamageDisclosure vehicleId="veh-1" token="tk" />);
    await waitFor(() => expect(screen.getByTestId('known-damage-card')).toBeInTheDocument());
    expect(apiMock.mock.calls[0][0]).toBe('/api/customer-inspections/vehicle/veh-1');
    expect(screen.getByTestId('known-damage-count').textContent).toContain('2');
    expect(screen.getAllByTestId('known-damage-entry')).toHaveLength(2);
    expect(screen.getByText('Scuff — lower-left rear bumper')).toBeInTheDocument();
  });

  it('renders NOTHING when the ledger is empty (zero behavior change)', async () => {
    apiMock.mockResolvedValue({ active: [] });
    const { container } = render(<KnownDamageDisclosure vehicleId="veh-1" token="tk" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders NOTHING on a read error and when no vehicleId is known', async () => {
    apiMock.mockRejectedValue(new Error('boom'));
    const { container } = render(<KnownDamageDisclosure vehicleId="veh-1" token="tk" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();

    apiMock.mockClear();
    const { container: c2 } = render(<KnownDamageDisclosure vehicleId={null} token="tk" />);
    expect(apiMock).not.toHaveBeenCalled();
    expect(c2.firstChild).toBeNull();
  });
});

describe('seed proposals (ProposedSeedRow)', () => {
  const report = {
    id: 'seed-1', view: 'FRONT', description: '[CHECKOUT 2026-05-12] Door edge chip',
    seedSourceRef: 'insp:insp-1', reservationNumber: 'R-2',
  };

  it('approve sends the corrected view; discard needs none', () => {
    const onReview = vi.fn();
    render(<ProposedSeedRow report={report} busy={false} onReview={onReview} t={t} />);
    expect(screen.getByText('[CHECKOUT 2026-05-12] Door edge chip')).toBeInTheDocument();
    expect(screen.getByText(/inspection note/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'REAR' } });
    fireEvent.click(screen.getByTestId('seed-approve'));
    expect(onReview).toHaveBeenCalledWith(report, 'approve', 'REAR');
    fireEvent.click(screen.getByTestId('seed-discard'));
    expect(onReview).toHaveBeenCalledWith(report, 'discard');
  });

  it('busy disables both actions', () => {
    const onReview = vi.fn();
    render(<ProposedSeedRow report={report} busy onReview={onReview} t={t} />);
    expect(screen.getByTestId('seed-approve')).toBeDisabled();
    expect(screen.getByTestId('seed-discard')).toBeDisabled();
  });
});
