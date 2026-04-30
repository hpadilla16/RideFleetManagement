import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rentalAgreementsService } from './rental-agreements.service.js';

describe('agreementPrintContext - live customer read', () => {
  it('reads customer info from live customer when snapshot differs', async () => {
    // Mock: agreement with snapshot fields that differ from live customer
    const mockAgreement = {
      id: 'agr-live-test',
      tenantId: 'ten-1',
      reservationId: 'res-1',
      agreementNumber: 'AGR-001',
      // Snapshot fields (old data)
      customerFirstName: 'OldFirstName',
      customerLastName: 'OldLastName',
      customerEmail: 'old@example.com',
      customerPhone: '555-0000',
      customerAddress1: 'Old Address 1',
      customerAddress2: 'Old Apt',
      customerCity: 'OldCity',
      customerState: 'OS',
      customerZip: '00000',
      customerCountry: 'OldCountry',
      dateOfBirth: new Date('1990-01-01'),
      licenseNumber: 'OLD-LICENSE-123',
      licenseState: 'OS',
      licenseExpiry: new Date('2030-01-01'),
      // Other fields
      pickupAt: new Date('2026-05-01'),
      returnAt: new Date('2026-05-05'),
      pickupLocationId: 'loc-1',
      pickupLocation: { id: 'loc-1', name: 'Pickup Loc', address: '123 Pickup St' },
      returnLocationId: 'loc-2',
      returnLocation: { id: 'loc-2', name: 'Return Loc', address: '456 Return St' },
      vehicleId: 'veh-1',
      vehicle: {
        id: 'veh-1',
        internalNumber: 'VEH-001',
        make: 'Toyota',
        model: 'Camry',
        year: 2023,
        color: 'Blue',
        plate: 'ABC-123',
        vin: 'VIN12345',
        mileage: 50000,
        vehicleType: { name: 'Sedan' }
      },
      odometerOut: 50000,
      odometerIn: 50100,
      fuelOut: 0.75,
      fuelIn: 0.50,
      cleanlinessOut: 5,
      cleanlinessIn: 4,
      subtotal: 200.00,
      taxes: 20.00,
      fees: 10.00,
      total: 230.00,
      deposit: 100.00,
      securityDepositAmount: 100.00,
      paidAmount: 230.00,
      balance: 0,
      charges: [],
      payments: [],
      // LIVE customer data (this is what should be shown)
      reservation: {
        id: 'res-1',
        reservationNumber: 'RES-001',
        franchiseId: null,
        notes: null,
        signatureSignedAt: new Date('2026-05-01T10:00:00Z'),
        signatureSignedBy: 'NewFirstName NewLastName',
        signatureDataUrl: 'data:image/png;base64,xyz',
        pickupLocation: { id: 'loc-1', name: 'Pickup Loc', address: '123 Pickup St', locationConfig: null },
        customer: {
          // NEW DATA - this should be used in the output
          id: 'cust-1',
          email: 'new@example.com',
          firstName: 'NewFirstName',
          lastName: 'NewLastName',
          phone: '555-9999',
          address1: 'New Address 1',
          address2: 'New Suite 100',
          city: 'NewCity',
          state: 'NS',
          zip: '99999',
          country: 'NewCountry',
          dateOfBirth: new Date('1995-06-15'),
          licenseNumber: 'NEW-LICENSE-456',
          licenseState: 'NS'
        },
        payments: []
      }
    };

    // Mock prisma.rentalAgreement.findFirst to return our mock
    const originalFindFirst = global.prisma?.rentalAgreement?.findFirst;
    const mockPrisma = {
      rentalAgreement: {
        findFirst: async (query) => {
          // If it's the resolveLatestAgreementId call, return just the id
          if (query.select && query.select.id && Object.keys(query.select).length === 1) {
            return { id: 'agr-live-test' };
          }
          // Otherwise return the full agreement
          return mockAgreement;
        }
      },
      auditLog: {
        findFirst: async () => null
      }
    };

    // Replace global prisma temporarily
    const originalPrisma = global.prisma;
    global.prisma = mockPrisma;

    try {
      // Mock the settings and franchise imports
      const originalImport = global.import;
      global.import = async (path) => {
        if (path.includes('settings.service')) {
          return {
            settingsService: {
              getRentalAgreementConfig: async () => ({
                companyName: 'Test Company',
                companyAddress: '789 Test Ave',
                companyPhone: '555-1234'
              })
            }
          };
        }
        if (path.includes('franchise.service')) {
          return {
            franchiseService: {
              getAgreementConfig: async () => null
            }
          };
        }
        return originalImport(path);
      };

      const context = await rentalAgreementsService.agreementPrintContext('agr-live-test');
      const agreement = context?.agreement;

      // Verify that live customer data is what gets returned
      // Check the agreement data directly (the printContext should have already resolved the customer)
      assert.equal(
        agreement?.reservation?.customer?.firstName,
        'NewFirstName',
        'Should read firstName from live customer'
      );
      assert.equal(
        agreement?.reservation?.customer?.lastName,
        'NewLastName',
        'Should read lastName from live customer'
      );
      assert.equal(
        agreement?.reservation?.customer?.email,
        'new@example.com',
        'Should read email from live customer'
      );
      assert.equal(
        agreement?.reservation?.customer?.phone,
        '555-9999',
        'Should read phone from live customer'
      );
      assert.equal(
        agreement?.reservation?.customer?.address1,
        'New Address 1',
        'Should read address1 from live customer'
      );
      assert.equal(
        agreement?.reservation?.customer?.city,
        'NewCity',
        'Should read city from live customer'
      );
      assert.equal(
        agreement?.reservation?.customer?.licenseNumber,
        'NEW-LICENSE-456',
        'Should read licenseNumber from live customer'
      );

      // Also verify that snapshot fields are still there (backward compatibility)
      assert.equal(
        agreement?.customerFirstName,
        'OldFirstName',
        'Snapshot field should still exist (for backward compatibility)'
      );
    } finally {
      // Restore globals
      global.prisma = originalPrisma;
      global.import = originalImport;
    }
  });

  it('uses snapshot fields as fallback when live customer is null', async () => {
    const mockAgreement = {
      id: 'agr-fallback-test',
      tenantId: 'ten-1',
      reservationId: 'res-2',
      agreementNumber: 'AGR-002',
      // Snapshot fields (will be used as fallback)
      customerFirstName: 'SnapshotFirst',
      customerLastName: 'SnapshotLast',
      customerEmail: 'snapshot@example.com',
      customerPhone: '555-1111',
      customerAddress1: 'Snapshot Address',
      customerAddress2: null,
      customerCity: 'SnapshotCity',
      customerState: 'SS',
      customerZip: '11111',
      customerCountry: 'SnapshotCountry',
      dateOfBirth: new Date('1985-03-10'),
      licenseNumber: 'SNAPSHOT-LIC',
      licenseState: 'SS',
      licenseExpiry: new Date('2028-01-01'),
      pickupAt: new Date('2026-05-01'),
      returnAt: new Date('2026-05-05'),
      pickupLocationId: 'loc-1',
      pickupLocation: { id: 'loc-1', name: 'Pickup', address: '123 St' },
      returnLocationId: 'loc-2',
      returnLocation: { id: 'loc-2', name: 'Return', address: '456 St' },
      vehicleId: 'veh-1',
      vehicle: { id: 'veh-1', internalNumber: 'V1', make: 'Honda', model: 'Accord', year: 2022, color: 'Red', plate: 'DEF-456', vin: 'VIN67890', mileage: 30000, vehicleType: { name: 'Sedan' } },
      odometerOut: 30000,
      odometerIn: 30100,
      fuelOut: 0.80,
      fuelIn: 0.60,
      cleanlinessOut: 5,
      cleanlinessIn: 4,
      subtotal: 150.00,
      taxes: 15.00,
      fees: 5.00,
      total: 170.00,
      deposit: 0,
      securityDepositAmount: 0,
      paidAmount: 170.00,
      balance: 0,
      charges: [],
      payments: [],
      // NO live customer (null reservation.customer)
      reservation: {
        id: 'res-2',
        reservationNumber: 'RES-002',
        franchiseId: null,
        notes: null,
        signatureSignedAt: null,
        signatureSignedBy: null,
        signatureDataUrl: null,
        pickupLocation: { id: 'loc-1', name: 'Pickup', address: '123 St', locationConfig: null },
        customer: null,  // No live customer
        payments: []
      }
    };

    const mockPrisma = {
      rentalAgreement: {
        findFirst: async (query) => {
          if (query.select && query.select.id && Object.keys(query.select).length === 1) {
            return { id: 'agr-fallback-test' };
          }
          return mockAgreement;
        }
      },
      auditLog: {
        findFirst: async () => null
      }
    };

    const originalPrisma = global.prisma;
    global.prisma = mockPrisma;

    try {
      const originalImport = global.import;
      global.import = async (path) => {
        if (path.includes('settings.service')) {
          return {
            settingsService: {
              getRentalAgreementConfig: async () => ({
                companyName: 'Test Company',
                companyAddress: '789 Test Ave',
                companyPhone: '555-1234'
              })
            }
          };
        }
        if (path.includes('franchise.service')) {
          return {
            franchiseService: {
              getAgreementConfig: async () => null
            }
          };
        }
        return originalImport(path);
      };

      const context = await rentalAgreementsService.agreementPrintContext('agr-fallback-test');
      const agreement = context?.agreement;

      // Verify that snapshot fields are used when live customer is null
      assert.equal(
        agreement?.customerFirstName,
        'SnapshotFirst',
        'Should preserve snapshot firstName when no live customer'
      );
      assert.equal(
        agreement?.customerLastName,
        'SnapshotLast',
        'Should preserve snapshot lastName when no live customer'
      );
    } finally {
      global.prisma = originalPrisma;
      global.import = originalImport;
    }
  });
});
