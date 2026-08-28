import { describe, it, expect } from 'vitest';
import { tenantBrandName, PLATFORM_DEFAULT_COMPANY_NAME } from '../src/lib/tenant-brand';

/**
 * The counter display is the screen that shows the QR the renter scans, and
 * it kept saying "Ride Fleet" while the phone they scanned it with said
 * "Autos del Valle" — the same customer, thirty seconds apart, told they were
 * dealing with two different companies, one of which is not a party to their
 * contract.
 *
 * Two ways the platform name used to reach that screen, and both are here:
 * a hard-coded `|| 'Ride Fleet'` fallback, and the tenant-wide setting, which
 * reads back the PLATFORM DEFAULT for a tenant who never configured it.
 */
describe('tenantBrandName', () => {
  it('returns the tenant business name', () => {
    expect(tenantBrandName({ companyName: 'Autos del Valle' })).toBe('Autos del Valle');
  });

  it('never returns the platform name, even when the API sends it', () => {
    // getRentalAgreementConfig hands back DEFAULTS.companyName for an
    // unconfigured tenant. That is the absence of an answer, not an answer.
    expect(tenantBrandName({ companyName: PLATFORM_DEFAULT_COMPANY_NAME })).toBe('');
    expect(tenantBrandName({ companyName: 'Ride Fleet' })).toBe('');
  });

  it('renders nothing rather than something wrong when no name is known', () => {
    // The backend resolver returns null when every source is empty; the honest
    // render of that is no wordmark at all.
    expect(tenantBrandName({ companyName: null })).toBe('');
    expect(tenantBrandName({})).toBe('');
    expect(tenantBrandName(null)).toBe('');
    expect(tenantBrandName(undefined)).toBe('');
  });

  it('does not mistake a tenant whose name merely contains ours', () => {
    expect(tenantBrandName({ companyName: 'Ride Fleet Rentals of Ponce' }))
      .toBe('Ride Fleet Rentals of Ponce');
  });

  it('trims, so a stray space cannot smuggle the default through', () => {
    expect(tenantBrandName({ companyName: '  Ride Fleet  ' })).toBe('');
    expect(tenantBrandName({ companyName: '  Autos del Valle ' })).toBe('Autos del Valle');
  });
});
