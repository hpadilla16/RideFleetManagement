function ok(description, schemaRef) {
  return {
    description,
    content: {
      'application/json': {
        schema: schemaRef ? { $ref: schemaRef } : { type: 'object', additionalProperties: true }
      }
    }
  };
}

function body(required = true, schemaRef = '#/components/schemas/GenericObject') {
  return {
    required,
    content: {
      'application/json': {
        schema: { $ref: schemaRef }
      }
    }
  };
}

function pathId(name = 'id', description = 'Resource identifier') {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string' }
  };
}

function bearerSecurity(required = true) {
  return required ? [{ BearerAuth: [] }] : [];
}

export function buildOpenApiSpec(serverUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Ride Fleet Management API',
      version: '1.0.0',
      description:
        'Interactive API documentation for the current Ride Fleet backend. This first Swagger pass focuses on the main live routes and the new structured reservation flows.'
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: 'Health', description: 'Service health checks' },
      { name: 'Auth', description: 'Authentication and lock PIN flows' },
      { name: 'Public Portal', description: 'Customer signature and payment token flows' },
      { name: 'Public Booking', description: 'Marketplace booking, guest signup, and host onboarding' },
      { name: 'Reservations', description: 'Reservation lifecycle and structured pricing/payments' },
      { name: 'Rental Agreements', description: 'Agreement lifecycle, payments, signatures, inspections' },
      { name: 'Customers', description: 'Customer management' },
      { name: 'Vehicles', description: 'Vehicle management' },
      { name: 'Issue Center', description: 'Internal incident handling and public response flows' },
      { name: 'Tolls', description: 'Puerto Rico toll sync, review, and reservation posting' },
      { name: 'Reports', description: 'Operational dashboards and exports' },
      { name: 'Settings', description: 'Tenant/location business settings' },
      { name: 'Tenants', description: 'Super-admin tenant management' }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      },
      schemas: {
        GenericObject: {
          type: 'object',
          additionalProperties: true
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Reservation not found' },
            details: {
              oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object', additionalProperties: true }]
            }
          }
        },
        LoginRequest: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', example: 'superadmin@fleetbeta.local' },
            password: { type: 'string', example: 'TempPass123!' }
          }
        },
        RegisterRequest: {
          type: 'object',
          required: ['email', 'password', 'fullName'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
            fullName: { type: 'string' }
          }
        },
        AuthUser: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string', format: 'email' },
            fullName: { type: 'string' },
            role: { type: 'string', example: 'SUPER_ADMIN' },
            tenantId: { type: 'string', nullable: true }
          }
        },
        LoginResponse: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            user: { $ref: '#/components/schemas/AuthUser' }
          }
        },
        LockPinPayload: {
          type: 'object',
          required: ['pin'],
          properties: {
            pin: { type: 'string', example: '1234' }
          }
        },
        ReservationCharge: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            code: { type: 'string', nullable: true },
            name: { type: 'string' },
            chargeType: { type: 'string', example: 'UNIT' },
            quantity: { type: 'number', example: 1 },
            rate: { type: 'number', example: 25 },
            total: { type: 'number', example: 25 },
            taxable: { type: 'boolean' },
            selected: { type: 'boolean' },
            sortOrder: { type: 'integer' }
          }
        },
        ReservationPricingSnapshot: {
          type: 'object',
          properties: {
            dailyRate: { type: 'number', nullable: true },
            taxRate: { type: 'number', nullable: true },
            selectedInsuranceCode: { type: 'string', nullable: true },
            selectedInsuranceName: { type: 'string', nullable: true },
            depositRequired: { type: 'boolean' },
            depositMode: { type: 'string', nullable: true },
            depositValue: { type: 'number', nullable: true },
            depositBasisJson: { type: 'string', nullable: true },
            depositAmountDue: { type: 'number' },
            securityDepositRequired: { type: 'boolean' },
            securityDepositAmount: { type: 'number' }
          }
        },
        ReservationPricingPayload: {
          type: 'object',
          properties: {
            snapshot: { $ref: '#/components/schemas/ReservationPricingSnapshot' },
            charges: {
              type: 'array',
              items: { $ref: '#/components/schemas/ReservationCharge' }
            }
          }
        },
        ReservationPaymentPayload: {
          type: 'object',
          required: ['method', 'amount'],
          properties: {
            method: { type: 'string', example: 'CARD' },
            amount: { type: 'number', example: 100 },
            reference: { type: 'string', nullable: true },
            notes: { type: 'string', nullable: true },
            status: { type: 'string', nullable: true },
            paidAt: { type: 'string', format: 'date-time', nullable: true },
            origin: { type: 'string', nullable: true }
          }
        },
        AdditionalDriver: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            address: { type: 'string', nullable: true },
            dateOfBirth: { type: 'string', format: 'date-time', nullable: true },
            licenseNumber: { type: 'string', nullable: true },
            licenseImageUploaded: { type: 'boolean' },
            notes: { type: 'string', nullable: true }
          }
        },
        AdditionalDriversPayload: {
          type: 'object',
          properties: {
            drivers: {
              type: 'array',
              items: { $ref: '#/components/schemas/AdditionalDriver' }
            }
          }
        },
        ReservationCreatePayload: {
          type: 'object',
          required: [
            'reservationNumber',
            'customerId',
            'vehicleTypeId',
            'pickupAt',
            'returnAt',
            'pickupLocationId',
            'returnLocationId'
          ],
          properties: {
            reservationNumber: { type: 'string' },
            customerId: { type: 'string' },
            vehicleTypeId: { type: 'string' },
            pickupAt: { type: 'string', format: 'date-time' },
            returnAt: { type: 'string', format: 'date-time' },
            pickupLocationId: { type: 'string' },
            returnLocationId: { type: 'string' },
            notes: { type: 'string', nullable: true },
            dailyRate: { type: 'number', nullable: true },
            estimatedTotal: { type: 'number', nullable: true }
          }
        },
        ReservationPatchPayload: {
          type: 'object',
          additionalProperties: true
        },
        CustomerPayload: {
          type: 'object',
          required: ['firstName', 'lastName', 'phone'],
          properties: {
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string', format: 'email', nullable: true },
            notes: { type: 'string', nullable: true }
          }
        },
        VehiclePayload: {
          type: 'object',
          additionalProperties: true
        },
        InspectionPayload: {
          type: 'object',
          required: ['phase'],
          properties: {
            phase: { type: 'string', enum: ['CHECKOUT', 'CHECKIN'] },
            exterior: { type: 'string', nullable: true },
            interior: { type: 'string', nullable: true },
            tires: { type: 'string', nullable: true },
            lights: { type: 'string', nullable: true },
            windshield: { type: 'string', nullable: true },
            fuelLevel: { type: 'string', nullable: true },
            odometer: { type: 'integer', nullable: true },
            damages: { type: 'string', nullable: true },
            notes: { type: 'string', nullable: true },
            photos: { type: 'array', items: { type: 'string' } }
          }
        },
        TenantPayload: {
          type: 'object',
          additionalProperties: true
        },
        EmailRequestPayload: {
          type: 'object',
          properties: {
            extraEmails: { type: 'array', items: { type: 'string', format: 'email' } },
            kind: { type: 'string', enum: ['signature', 'customer-info', 'payment'] }
          },
          example: {
            kind: 'payment',
            extraEmails: ['ops@ridefleetmanager.com']
          }
        },
        LinkTokenResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            link: { type: 'string', example: 'https://ridefleetmanager.com/customer/pay?token=abc123' },
            expiresAt: { type: 'string', format: 'date-time' }
          }
        },
        ReservationStatusPayload: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', example: 'CONFIRMED' },
            reason: { type: 'string', nullable: true, example: 'Manager approved after phone verification' }
          }
        },
        AgreementCustomerPayload: {
          type: 'object',
          required: ['customerFirstName', 'customerLastName'],
          properties: {
            customerFirstName: { type: 'string', example: 'Jane' },
            customerLastName: { type: 'string', example: 'Doe' },
            customerEmail: { type: 'string', format: 'email', nullable: true, example: 'jane@example.com' },
            customerPhone: { type: 'string', nullable: true, example: '787-555-1212' },
            customerAddress: { type: 'string', nullable: true, example: '123 Main St, San Juan PR' }
          }
        },
        AgreementDriverPayload: {
          type: 'object',
          required: ['firstName', 'lastName'],
          properties: {
            firstName: { type: 'string', example: 'Alex' },
            lastName: { type: 'string', example: 'Rivera' },
            licenseNumber: { type: 'string', nullable: true, example: 'PR1234567' },
            dateOfBirth: { type: 'string', format: 'date-time', nullable: true },
            notes: { type: 'string', nullable: true, example: 'Added at counter' }
          }
        },
        AgreementRentalPayload: {
          type: 'object',
          additionalProperties: true,
          example: {
            checkoutOdometer: 42510,
            checkoutFuelLevel: '3/4',
            returnLocationId: 'loc_return_001',
            vehicleId: 'veh_001'
          }
        },
        AgreementChargesPayload: {
          type: 'object',
          properties: {
            charges: {
              type: 'array',
              items: { $ref: '#/components/schemas/ReservationCharge' }
            }
          },
          example: {
            charges: [
              { name: 'Daily Rate', chargeType: 'UNIT', quantity: 3, rate: 49.99, total: 149.97, taxable: true, selected: true, sortOrder: 1 },
              { name: 'Airport Fee', chargeType: 'UNIT', quantity: 1, rate: 15, total: 15, taxable: true, selected: true, sortOrder: 2 }
            ]
          }
        },
        CreditAdjustmentPayload: {
          type: 'object',
          required: ['amount'],
          properties: {
            amount: { type: 'number', example: 25 },
            reason: { type: 'string', nullable: true, example: 'Loyalty goodwill credit' }
          }
        },
        AgreementStatusPayload: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', example: 'cancel' }
          }
        },
        CardOnFilePayload: {
          type: 'object',
          additionalProperties: true,
          example: {
            cardHolderName: 'Jane Doe',
            cardNumber: '4111111111111111',
            expiryMonth: '12',
            expiryYear: '2030',
            cvv: '123'
          }
        },
        ChargeCardPayload: {
          type: 'object',
          required: ['amount'],
          properties: {
            amount: { type: 'number', example: 125.5 },
            description: { type: 'string', nullable: true, example: 'Balance due at pickup' }
          }
        },
        SecurityDepositPayload: {
          type: 'object',
          additionalProperties: true,
          example: {
            amount: 250,
            reason: 'Hold at checkout'
          }
        },
        AgreementClosePayload: {
          type: 'object',
          additionalProperties: true,
          example: {
            returnFuelLevel: '1/2',
            returnOdometer: 42880,
            closeNotes: 'Vehicle returned with light dust on rear bumper'
          }
        },
        AgreementFinalizePayload: {
          type: 'object',
          additionalProperties: true,
          example: {
            waiveBalance: false,
            notes: 'Finalize after successful card capture'
          }
        },
        TenantAdminPayload: {
          type: 'object',
          required: ['email', 'fullName'],
          properties: {
            email: { type: 'string', format: 'email', example: 'admin+a@fleetbeta.local' },
            fullName: { type: 'string', example: 'Tenant A Admin' },
            password: { type: 'string', nullable: true, example: 'TempPass123!' }
          }
        },
        TenantAdminResetPayload: {
          type: 'object',
          properties: {
            password: { type: 'string', example: 'TempPass123!' }
          }
        },
        TenantImpersonatePayload: {
          type: 'object',
          properties: {
            userId: { type: 'string', nullable: true, example: 'user_123' }
          }
        },
        VehicleBulkRowsPayload: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            }
          },
          example: {
            rows: [
              { internalNumber: 'U-100', vin: '1HGCM82633A123456', vehicleTypeCode: 'SUV', make: 'Toyota', model: 'RAV4' }
            ]
          }
        },
        CustomerBulkRowsPayload: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            }
          },
          example: {
            rows: [
              { firstName: 'Jane', lastName: 'Doe', phone: '7875550000', email: 'jane@example.com' }
            ]
          }
        },
        ReservationBulkRowsPayload: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            }
          },
          example: {
            rows: [
              {
                reservationNumber: 'RES-1001',
                pickupAt: '2026-03-29T10:00:00.000Z',
                returnAt: '2026-03-31T10:00:00.000Z',
                pickupLocationCode: 'SJU',
                returnLocationCode: 'SJU',
                vehicleTypeCode: 'SUV'
              }
            ]
          }
        },
        VehicleAvailabilityBlockPayload: {
          type: 'object',
          properties: {
            blockedFrom: { type: 'string', format: 'date-time', nullable: true },
            availableFrom: { type: 'string', format: 'date-time' },
            blockType: { type: 'string', enum: ['MIGRATION_HOLD', 'MAINTENANCE_HOLD', 'WASH_HOLD', 'OUT_OF_SERVICE_HOLD'] },
            reason: { type: 'string', nullable: true },
            notes: { type: 'string', nullable: true }
          },
          required: ['availableFrom']
        },
        VehicleAvailabilityBlockBulkPayload: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            }
          },
          example: {
            rows: [
              {
                internalNumber: 'UNIT-001',
                blockType: 'MIGRATION_HOLD',
                availableFrom: '2026-04-15T10:00:00.000Z',
                reason: 'Legacy contract still open'
              }
            ]
          }
        },
        IssueIncidentPayload: {
          type: 'object',
          properties: {
            reservationId: { type: 'string', nullable: true },
            reservationNumber: { type: 'string', nullable: true },
            tripId: { type: 'string', nullable: true },
            tripCode: { type: 'string', nullable: true },
            type: { type: 'string', example: 'TOLL' },
            title: { type: 'string' },
            description: { type: 'string', nullable: true },
            amountClaimed: { type: 'number', nullable: true }
          },
          required: ['type', 'title']
        },
        TollProviderAccountPayload: {
          type: 'object',
          properties: {
            username: { type: 'string', nullable: true },
            password: { type: 'string', nullable: true },
            loginUrl: { type: 'string', nullable: true },
            notes: { type: 'string', nullable: true },
            active: { type: 'boolean', nullable: true }
          }
        },
        TollManualImportPayload: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            }
          },
          example: {
            rows: [
              {
                transactionAt: '2026-03-29T14:30:00.000Z',
                amount: 1.4,
                location: 'Buchanan',
                plate: 'ABC123',
                tag: 'TAG-1001',
                sello: 'PRHT-1001'
              }
            ]
          }
        },
        TollReviewActionPayload: {
          type: 'object',
          properties: {
            action: { type: 'string', example: 'MARK_DISPUTED' },
            reservationId: { type: 'string', nullable: true },
            notes: { type: 'string', nullable: true }
          },
          required: ['action']
        },
        PublicHostSignupPayload: {
          type: 'object',
          properties: {
            tenantSlug: { type: 'string', nullable: true },
            fullName: { type: 'string' },
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
            phone: { type: 'string', nullable: true },
            vehicleTypeId: { type: 'string', nullable: true },
            make: { type: 'string', nullable: true },
            model: { type: 'string', nullable: true },
            year: { type: 'integer', nullable: true },
            pickupSpotLabel: { type: 'string', nullable: true }
          },
          required: ['fullName', 'email', 'password']
        },
        ReportsOverviewResponse: {
          type: 'object',
          properties: {
            range: {
              type: 'object',
              properties: {
                start: { type: 'string', format: 'date-time' },
                end: { type: 'string', format: 'date-time' },
                days: { type: 'integer', example: 30 }
              }
            },
            filters: {
              type: 'object',
              properties: {
                tenantId: { type: 'string', nullable: true },
                tenantName: { type: 'string', nullable: true },
                locationId: { type: 'string', nullable: true },
                locationName: { type: 'string', nullable: true }
              }
            },
            locations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' }
                }
              }
            },
            tenants: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  status: { type: 'string' }
                }
              }
            },
            kpis: {
              type: 'object',
              properties: {
                reservationsCreated: { type: 'integer' },
                checkedOut: { type: 'integer' },
                checkedIn: { type: 'integer' },
                cancelled: { type: 'integer' },
                noShow: { type: 'integer' },
                activeAgreements: { type: 'integer' },
                agreementsClosed: { type: 'integer' },
                agreementsDueToday: { type: 'integer' },
                projectedRevenue: { type: 'number' },
                collectedPayments: { type: 'number' },
                openBalance: { type: 'number' },
                fleetTotal: { type: 'integer' },
                onRent: { type: 'integer' },
                vehiclesInMaintenance: { type: 'integer' },
                utilizationPct: { type: 'number' }
              }
            },
            reservationStatusBreakdown: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                  count: { type: 'integer' }
                }
              }
            },
            reservationsByDay: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  date: { type: 'string', example: '2026-03-18' },
                  count: { type: 'integer' }
                }
              }
            },
            paymentsByDay: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  date: { type: 'string', example: '2026-03-18' },
                  amount: { type: 'number' }
                }
              }
            },
            topPickupLocations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  locationId: { type: 'string' },
                  name: { type: 'string' },
                  count: { type: 'integer' }
                }
              }
            }
          }
        }
      }
    },
    paths: {
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Health check',
          responses: {
            200: ok('Backend health response')
          }
        }
      },
      '/api/auth/register': {
        post: {
          tags: ['Auth'],
          summary: 'Public register',
          description: 'Creates a new public user only when public registration is enabled.',
          requestBody: body(true, '#/components/schemas/RegisterRequest'),
          responses: {
            201: ok('User registered', '#/components/schemas/LoginResponse'),
            400: ok('Validation error', '#/components/schemas/ErrorResponse'),
            403: ok('Public registration disabled', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Login',
          requestBody: body(true, '#/components/schemas/LoginRequest'),
          responses: {
            200: ok('Login successful', '#/components/schemas/LoginResponse'),
            401: ok('Invalid credentials', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/auth/users': {
        get: {
          tags: ['Auth'],
          summary: 'List users',
          security: bearerSecurity(),
          responses: {
            200: {
              description: 'Users',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/AuthUser' }
                  }
                }
              }
            },
            401: ok('Unauthorized', '#/components/schemas/ErrorResponse'),
            403: ok('Forbidden', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/auth/users/{id}/reset-lock-pin': {
        post: {
          tags: ['Auth'],
          summary: 'Admin reset user lock PIN',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('PIN reset'),
            404: ok('User not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/auth/lock-pin/status': {
        get: {
          tags: ['Auth'],
          summary: 'Current user lock PIN status',
          security: bearerSecurity(),
          responses: {
            200: ok('Lock PIN status'),
            404: ok('User not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/auth/lock-pin/set': {
        post: {
          tags: ['Auth'],
          summary: 'Set current user lock PIN',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/LockPinPayload'),
          responses: {
            200: ok('PIN set'),
            400: ok('Invalid PIN', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/auth/lock-pin/verify': {
        post: {
          tags: ['Auth'],
          summary: 'Verify current user lock PIN',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/LockPinPayload'),
          responses: {
            200: ok('PIN verification result'),
            400: ok('Invalid PIN', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/auth/lock-pin/reset': {
        post: {
          tags: ['Auth'],
          summary: 'Reset current user lock PIN',
          security: bearerSecurity(),
          responses: {
            200: ok('PIN reset')
          }
        }
      },
      '/api/public/signature/{token}': {
        get: {
          tags: ['Public Portal'],
          summary: 'Get signature request by token',
          parameters: [pathId('token', 'Public signature token')],
          responses: {
            200: ok('Signature request payload'),
            404: ok('Token not found', '#/components/schemas/ErrorResponse')
          }
        },
        post: {
          tags: ['Public Portal'],
          summary: 'Submit signature by token',
          parameters: [pathId('token', 'Public signature token')],
          requestBody: body(true),
          responses: {
            200: ok('Signature saved'),
            400: ok('Invalid request', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/public/payment/{token}': {
        get: {
          tags: ['Public Portal'],
          summary: 'Get payment request by token',
          parameters: [pathId('token', 'Public payment token')],
          responses: {
            200: ok('Payment request payload'),
            404: ok('Token not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/public/payment/{token}/create-session': {
        post: {
          tags: ['Public Portal'],
          summary: 'Create public payment gateway session',
          parameters: [pathId('token', 'Public payment token')],
          responses: {
            200: ok('Gateway session created'),
            400: ok('Invalid gateway flow', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/public/payment/{token}/confirm': {
        post: {
          tags: ['Public Portal'],
          summary: 'Confirm public payment',
          description: 'Manual confirmation is restricted by gateway rules; non-Stripe flows are blocked.',
          parameters: [pathId('token', 'Public payment token')],
          requestBody: body(true),
          responses: {
            200: ok('Payment confirmed'),
            400: ok('Invalid confirmation request', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations': {
        get: {
          tags: ['Reservations'],
          summary: 'List reservations',
          security: bearerSecurity(),
          responses: {
            200: ok('Reservation list')
          }
        },
        post: {
          tags: ['Reservations'],
          summary: 'Create reservation',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/ReservationCreatePayload'),
          responses: {
            201: ok('Reservation created'),
            400: ok('Validation failed', '#/components/schemas/ErrorResponse'),
            409: ok('Conflict', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}': {
        get: {
          tags: ['Reservations'],
          summary: 'Get reservation',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Reservation detail'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        },
        patch: {
          tags: ['Reservations'],
          summary: 'Patch reservation',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ReservationPatchPayload'),
          responses: {
            200: ok('Reservation updated'),
            400: ok('Validation failed', '#/components/schemas/ErrorResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        },
        delete: {
          tags: ['Reservations'],
          summary: 'Delete reservation',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            204: { description: 'Reservation deleted' },
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/bulk/validate': {
        post: {
          tags: ['Reservations'],
          summary: 'Validate reservation migration rows',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/ReservationBulkRowsPayload'),
          responses: {
            200: ok('Validation report')
          }
        }
      },
      '/api/reservations/bulk/import': {
        post: {
          tags: ['Reservations'],
          summary: 'Import reservation migration rows',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/ReservationBulkRowsPayload'),
          responses: {
            200: ok('Bulk import result'),
            409: ok('Duplicate reservation or vehicle conflict', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/agreement': {
        get: {
          tags: ['Reservations'],
          summary: 'Get or build agreement from reservation',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Agreement payload'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/pricing': {
        get: {
          tags: ['Reservations'],
          summary: 'Get structured reservation pricing',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Structured pricing', '#/components/schemas/ReservationPricingPayload'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        },
        put: {
          tags: ['Reservations'],
          summary: 'Replace structured reservation pricing',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ReservationPricingPayload'),
          responses: {
            200: ok('Pricing updated', '#/components/schemas/ReservationPricingPayload'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/payments': {
        get: {
          tags: ['Reservations'],
          summary: 'List reservation payments',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Payments list'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        },
        post: {
          tags: ['Reservations'],
          summary: 'Create reservation payment',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ReservationPaymentPayload'),
          responses: {
            201: ok('Payment created'),
            400: ok('Invalid payment', '#/components/schemas/ErrorResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/additional-drivers': {
        get: {
          tags: ['Reservations'],
          summary: 'List reservation additional drivers',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: {
              description: 'Additional drivers',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/AdditionalDriver' }
                  }
                }
              }
            },
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        },
        put: {
          tags: ['Reservations'],
          summary: 'Replace reservation additional drivers',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/AdditionalDriversPayload'),
          responses: {
            200: ok('Additional drivers updated'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/available-vehicles': {
        get: {
          tags: ['Reservations'],
          summary: 'List available vehicles for a reservation window',
          description: 'Supports optional pickupAt and returnAt query overrides to evaluate availability before assigning a unit.',
          security: bearerSecurity(),
          parameters: [
            pathId(),
            {
              name: 'pickupAt',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' }
            },
            {
              name: 'returnAt',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' }
            }
          ],
          responses: {
            200: ok('Available vehicles'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/audit-logs': {
        get: {
          tags: ['Reservations'],
          summary: 'List reservation audit logs',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Audit log entries'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/admin-transition': {
        post: {
          tags: ['Reservations'],
          summary: 'Force reservation status transition as admin',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ReservationStatusPayload'),
          responses: {
            200: ok('Admin override applied'),
            400: ok('status is required', '#/components/schemas/ErrorResponse'),
            403: ok('Admin role required', '#/components/schemas/ErrorResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/start-rental': {
        post: {
          tags: ['Reservations'],
          summary: 'Start rental and create agreement from reservation',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            201: ok('Agreement created from reservation'),
            400: ok('Reservation cannot start rental', '#/components/schemas/ErrorResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/request-customer-info': {
        post: {
          tags: ['Reservations'],
          summary: 'Generate customer info portal link',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Customer info link generated', '#/components/schemas/LinkTokenResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/request-signature': {
        post: {
          tags: ['Reservations'],
          summary: 'Generate signature portal link',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Signature link generated', '#/components/schemas/LinkTokenResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/request-payment': {
        post: {
          tags: ['Reservations'],
          summary: 'Generate payment portal link',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Payment link generated', '#/components/schemas/LinkTokenResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/send-request-email': {
        post: {
          tags: ['Reservations'],
          summary: 'Send signature, customer-info or payment request email',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/EmailRequestPayload'),
          responses: {
            200: ok('Request email sent'),
            400: ok('Invalid kind or no recipient email', '#/components/schemas/ErrorResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/send-detail-email': {
        post: {
          tags: ['Reservations'],
          summary: 'Send reservation detail email',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(false, '#/components/schemas/EmailRequestPayload'),
          responses: {
            200: ok('Detail email sent'),
            400: ok('No recipient email found', '#/components/schemas/ErrorResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/agreement/payments/manual': {
        post: {
          tags: ['Reservations'],
          summary: 'Create manual agreement payment from reservation context',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ReservationPaymentPayload'),
          responses: {
            200: ok('Manual agreement payment created'),
            400: ok('No rental agreement exists for this reservation yet', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/agreement/payments/charge-card-on-file': {
        post: {
          tags: ['Reservations'],
          summary: 'Charge agreement card on file from reservation context',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ChargeCardPayload'),
          responses: {
            200: ok('Card on file charged'),
            400: ok('No rental agreement exists for this reservation yet', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/agreement/security-deposit/capture': {
        post: {
          tags: ['Reservations'],
          summary: 'Capture agreement security deposit from reservation context',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(false, '#/components/schemas/SecurityDepositPayload'),
          responses: {
            200: ok('Security deposit captured'),
            400: ok('No rental agreement exists for this reservation yet', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/agreement/security-deposit/release': {
        post: {
          tags: ['Reservations'],
          summary: 'Release agreement security deposit from reservation context',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Security deposit released'),
            400: ok('No rental agreement exists for this reservation yet', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/agreement/customer/card-on-file': {
        post: {
          tags: ['Reservations'],
          summary: 'Store customer card on file from reservation context',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/CardOnFilePayload'),
          responses: {
            200: ok('Customer card stored'),
            400: ok('No rental agreement exists for this reservation yet', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/agreement/credit': {
        post: {
          tags: ['Reservations'],
          summary: 'Adjust customer credit from reservation context',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/CreditAdjustmentPayload'),
          responses: {
            200: ok('Customer credit adjusted'),
            400: ok('amount must be > 0', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/payments/{paymentId}/delete': {
        post: {
          tags: ['Reservations'],
          summary: 'Delete reservation-linked agreement payment',
          security: bearerSecurity(),
          parameters: [pathId(), pathId('paymentId', 'Agreement payment identifier')],
          responses: {
            200: ok('Payment deleted and balances recalculated'),
            404: ok('Agreement or payment not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/payments/{paymentId}/refund': {
        post: {
          tags: ['Reservations'],
          summary: 'Refund reservation-linked agreement payment',
          security: bearerSecurity(),
          parameters: [pathId(), pathId('paymentId', 'Agreement payment identifier')],
          requestBody: body(false, '#/components/schemas/CreditAdjustmentPayload'),
          responses: {
            200: ok('Payment refunded'),
            400: ok('Invalid refund request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement or payment not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reservations/{id}/payments/charge-card-on-file': {
        post: {
          tags: ['Reservations'],
          summary: 'Charge reservation-linked agreement card on file',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ChargeCardPayload'),
          responses: {
            200: ok('Card on file charged'),
            400: ok('Invalid charge request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found for reservation', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/customers': {
        get: {
          tags: ['Customers'],
          summary: 'List customers',
          security: bearerSecurity(),
          responses: { 200: ok('Customer list') }
        },
        post: {
          tags: ['Customers'],
          summary: 'Create customer',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/CustomerPayload'),
          responses: {
            201: ok('Customer created'),
            400: ok('Validation failed', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/customers/{id}': {
        get: {
          tags: ['Customers'],
          summary: 'Get customer',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Customer detail'),
            404: ok('Customer not found', '#/components/schemas/ErrorResponse')
          }
        },
        patch: {
          tags: ['Customers'],
          summary: 'Update customer',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/CustomerPayload'),
          responses: {
            200: ok('Customer updated'),
            403: ok('Forbidden', '#/components/schemas/ErrorResponse'),
            404: ok('Customer not found', '#/components/schemas/ErrorResponse')
          }
        },
        delete: {
          tags: ['Customers'],
          summary: 'Delete customer',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            204: { description: 'Customer deleted' },
            404: ok('Customer not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/customers/{id}/password-reset': {
        post: {
          tags: ['Customers'],
          summary: 'Issue customer portal password reset',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Password reset issued'),
            403: ok('Admin approval required', '#/components/schemas/ErrorResponse'),
            404: ok('Customer not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/customers/bulk/validate': {
        post: {
          tags: ['Customers'],
          summary: 'Validate customer migration rows',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/CustomerBulkRowsPayload'),
          responses: {
            200: ok('Validation report')
          }
        }
      },
      '/api/customers/bulk/import': {
        post: {
          tags: ['Customers'],
          summary: 'Import customer migration rows',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/CustomerBulkRowsPayload'),
          responses: {
            200: ok('Bulk import result')
          }
        }
      },
      '/api/vehicles': {
        get: {
          tags: ['Vehicles'],
          summary: 'List vehicles',
          security: bearerSecurity(),
          responses: { 200: ok('Vehicle list') }
        },
        post: {
          tags: ['Vehicles'],
          summary: 'Create vehicle',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/VehiclePayload'),
          responses: {
            201: ok('Vehicle created'),
            400: ok('Validation failed', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/vehicles/{id}': {
        get: {
          tags: ['Vehicles'],
          summary: 'Get vehicle',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Vehicle detail'),
            404: ok('Vehicle not found', '#/components/schemas/ErrorResponse')
          }
        },
        patch: {
          tags: ['Vehicles'],
          summary: 'Update vehicle',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/VehiclePayload'),
          responses: {
            200: ok('Vehicle updated'),
            404: ok('Vehicle not found', '#/components/schemas/ErrorResponse')
          }
        },
        delete: {
          tags: ['Vehicles'],
          summary: 'Delete vehicle',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            204: { description: 'Vehicle deleted' },
            404: ok('Vehicle not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/vehicles/bulk/validate': {
        post: {
          tags: ['Vehicles'],
          summary: 'Validate bulk vehicle import rows',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/VehicleBulkRowsPayload'),
          responses: {
            200: ok('Validation report')
          }
        }
      },
      '/api/vehicles/bulk/import': {
        post: {
          tags: ['Vehicles'],
          summary: 'Import bulk vehicle rows',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/VehicleBulkRowsPayload'),
          responses: {
            200: ok('Bulk import result')
          }
        }
      },
      '/api/vehicles/availability-blocks/validate': {
        post: {
          tags: ['Vehicles'],
          summary: 'Validate bulk vehicle availability blocks',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/VehicleAvailabilityBlockBulkPayload'),
          responses: {
            200: ok('Validation report')
          }
        }
      },
      '/api/vehicles/availability-blocks/import': {
        post: {
          tags: ['Vehicles'],
          summary: 'Import bulk vehicle availability blocks',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/VehicleAvailabilityBlockBulkPayload'),
          responses: {
            200: ok('Bulk import result')
          }
        }
      },
      '/api/vehicles/{id}/availability-blocks': {
        post: {
          tags: ['Vehicles'],
          summary: 'Create a vehicle availability block',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/VehicleAvailabilityBlockPayload'),
          responses: {
            201: ok('Availability block created'),
            400: ok('Invalid availability block request', '#/components/schemas/ErrorResponse'),
            404: ok('Vehicle not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/vehicles/availability-blocks/{id}/release': {
        post: {
          tags: ['Vehicles'],
          summary: 'Release a vehicle availability block',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Availability block released'),
            404: ok('Availability block not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/issue-center/dashboard': {
        get: {
          tags: ['Issue Center'],
          summary: 'Get issue center dashboard',
          security: bearerSecurity(),
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string' } }
          ],
          responses: {
            200: ok('Issue center dashboard')
          }
        }
      },
      '/api/issue-center/incidents': {
        post: {
          tags: ['Issue Center'],
          summary: 'Create internal incident',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/IssueIncidentPayload'),
          responses: {
            201: ok('Incident created'),
            400: ok('Invalid incident payload', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tolls/dashboard': {
        get: {
          tags: ['Tolls'],
          summary: 'Get toll dashboard and review queue',
          security: bearerSecurity(),
          parameters: [
            { name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant scope for super admins' },
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'reservationId', in: 'query', schema: { type: 'string' } },
            { name: 'needsReview', in: 'query', schema: { type: 'boolean' } }
          ],
          responses: {
            200: ok('Toll dashboard'),
            403: ok('Tolls disabled', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tolls/provider-account': {
        get: {
          tags: ['Tolls'],
          summary: 'Get AutoExpreso provider account',
          security: bearerSecurity(),
          parameters: [{ name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant scope for super admins' }],
          responses: { 200: ok('Provider account') }
        },
        put: {
          tags: ['Tolls'],
          summary: 'Save AutoExpreso provider account',
          security: bearerSecurity(),
          parameters: [{ name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant scope for super admins' }],
          requestBody: body(true, '#/components/schemas/TollProviderAccountPayload'),
          responses: {
            200: ok('Provider account saved'),
            400: ok('Invalid provider account payload', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tolls/provider-account/health-check': {
        post: {
          tags: ['Tolls'],
          summary: 'Run AutoExpreso provider health check',
          security: bearerSecurity(),
          parameters: [{ name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant scope for super admins' }],
          responses: { 200: ok('Health check result') }
        }
      },
      '/api/tolls/provider-account/live-sync': {
        post: {
          tags: ['Tolls'],
          summary: 'Run live AutoExpreso sync',
          security: bearerSecurity(),
          parameters: [{ name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant scope for super admins' }],
          responses: {
            200: ok('Live sync result'),
            400: ok('Sync failed or provider not ready', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tolls/transactions/manual-import': {
        post: {
          tags: ['Tolls'],
          summary: 'Import manual toll transactions',
          security: bearerSecurity(),
          parameters: [{ name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant scope for super admins' }],
          requestBody: body(true, '#/components/schemas/TollManualImportPayload'),
          responses: {
            201: ok('Manual tolls created'),
            400: ok('Invalid toll import payload', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tolls/transactions/{id}/confirm-match': {
        post: {
          tags: ['Tolls'],
          summary: 'Confirm toll match to reservation',
          security: bearerSecurity(),
          parameters: [pathId(), { name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant scope for super admins' }],
          requestBody: body(false, '#/components/schemas/GenericObject'),
          responses: { 200: ok('Toll match confirmed') }
        }
      },
      '/api/tolls/transactions/{id}/review-action': {
        post: {
          tags: ['Tolls'],
          summary: 'Apply toll review action',
          security: bearerSecurity(),
          parameters: [pathId(), { name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant scope for super admins' }],
          requestBody: body(true, '#/components/schemas/TollReviewActionPayload'),
          responses: {
            200: ok('Review action applied'),
            400: ok('Invalid review action payload', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tolls/reservations/{reservationId}': {
        get: {
          tags: ['Tolls'],
          summary: 'List tolls linked to reservation',
          security: bearerSecurity(),
          parameters: [pathId('reservationId', 'Reservation identifier'), { name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant scope for super admins' }],
          responses: {
            200: ok('Reservation toll list'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/public/booking/vehicle-classes': {
        get: {
          tags: ['Public Booking'],
          summary: 'Get public vehicle classes',
          parameters: [
            { name: 'tenantId', in: 'query', schema: { type: 'string' } },
            { name: 'tenantSlug', in: 'query', schema: { type: 'string' } },
            { name: 'pickupLocationId', in: 'query', schema: { type: 'string' } },
            { name: 'pickupAt', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'returnAt', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } }
          ],
          responses: {
            200: ok('Public vehicle classes'),
            400: ok('Invalid public booking query', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/public/booking/host-signup': {
        post: {
          tags: ['Public Booking'],
          summary: 'Create public host signup submission',
          requestBody: body(true, '#/components/schemas/PublicHostSignupPayload'),
          responses: {
            201: ok('Host signup created'),
            400: ok('Invalid host signup payload', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reports/overview': {
        get: {
          tags: ['Reports'],
          summary: 'Get reports overview dashboard data',
          security: bearerSecurity(),
          parameters: [
            { name: 'start', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Range start date (YYYY-MM-DD)' },
            { name: 'end', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Range end date (YYYY-MM-DD)' },
            { name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant filter for super admins' },
            { name: 'locationId', in: 'query', schema: { type: 'string' }, description: 'Optional pickup/home location filter' }
          ],
          responses: {
            200: ok('Reports overview', '#/components/schemas/ReportsOverviewResponse'),
            401: ok('Unauthorized', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/reports/overview.csv': {
        get: {
          tags: ['Reports'],
          summary: 'Export reports overview as CSV',
          security: bearerSecurity(),
          parameters: [
            { name: 'start', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Range start date (YYYY-MM-DD)' },
            { name: 'end', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Range end date (YYYY-MM-DD)' },
            { name: 'tenantId', in: 'query', schema: { type: 'string' }, description: 'Optional tenant filter for super admins' },
            { name: 'locationId', in: 'query', schema: { type: 'string' }, description: 'Optional pickup/home location filter' }
          ],
          responses: {
            200: {
              description: 'CSV export',
              content: {
                'text/csv': {
                  schema: { type: 'string' }
                }
              }
            },
            401: ok('Unauthorized', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/settings/email-templates': {
        get: {
          tags: ['Settings'],
          summary: 'Get email templates',
          security: bearerSecurity(),
          responses: { 200: ok('Email templates') }
        },
        put: {
          tags: ['Settings'],
          summary: 'Update email templates',
          security: bearerSecurity(),
          requestBody: body(true),
          responses: { 200: ok('Email templates updated') }
        }
      },
      '/api/settings/insurance-plans': {
        get: {
          tags: ['Settings'],
          summary: 'Get insurance plans',
          security: bearerSecurity(),
          responses: { 200: ok('Insurance plans') }
        },
        put: {
          tags: ['Settings'],
          summary: 'Update insurance plans',
          security: bearerSecurity(),
          requestBody: body(true),
          responses: { 200: ok('Insurance plans updated') }
        }
      },
      '/api/settings/reservation-options': {
        get: {
          tags: ['Settings'],
          summary: 'Get reservation options',
          security: bearerSecurity(),
          responses: { 200: ok('Reservation options') }
        },
        put: {
          tags: ['Settings'],
          summary: 'Update reservation options',
          security: bearerSecurity(),
          requestBody: body(true),
          responses: { 200: ok('Reservation options updated') }
        }
      },
      '/api/settings/rental-agreement': {
        get: {
          tags: ['Settings'],
          summary: 'Get rental agreement settings',
          security: bearerSecurity(),
          responses: { 200: ok('Rental agreement settings') }
        },
        put: {
          tags: ['Settings'],
          summary: 'Update rental agreement settings',
          security: bearerSecurity(),
          requestBody: body(true),
          responses: { 200: ok('Rental agreement settings updated') }
        }
      },
      '/api/tenants': {
        get: {
          tags: ['Tenants'],
          summary: 'List tenants',
          security: bearerSecurity(),
          responses: {
            200: ok('Tenants list'),
            403: ok('Super admin only', '#/components/schemas/ErrorResponse')
          }
        },
        post: {
          tags: ['Tenants'],
          summary: 'Create tenant',
          security: bearerSecurity(),
          requestBody: body(true, '#/components/schemas/TenantPayload'),
          responses: {
            201: ok('Tenant created'),
            400: ok('Validation failed', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tenants/{id}': {
        patch: {
          tags: ['Tenants'],
          summary: 'Update tenant',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/TenantPayload'),
          responses: {
            200: ok('Tenant updated'),
            400: ok('Validation failed', '#/components/schemas/ErrorResponse'),
            403: ok('Super admin only', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tenants/{id}/admins': {
        get: {
          tags: ['Tenants'],
          summary: 'List tenant admins',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Tenant admins'),
            403: ok('Super admin only', '#/components/schemas/ErrorResponse')
          }
        },
        post: {
          tags: ['Tenants'],
          summary: 'Create tenant admin',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/TenantAdminPayload'),
          responses: {
            201: ok('Tenant admin created'),
            400: ok('Validation failed', '#/components/schemas/ErrorResponse'),
            403: ok('Super admin only', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tenants/{id}/admins/{userId}/reset-password': {
        post: {
          tags: ['Tenants'],
          summary: 'Reset tenant admin password',
          security: bearerSecurity(),
          parameters: [pathId(), pathId('userId', 'Tenant admin user identifier')],
          requestBody: body(false, '#/components/schemas/TenantAdminResetPayload'),
          responses: {
            200: ok('Tenant admin password reset'),
            400: ok('Reset failed', '#/components/schemas/ErrorResponse'),
            403: ok('Super admin only', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/tenants/{id}/impersonate': {
        post: {
          tags: ['Tenants'],
          summary: 'Impersonate tenant admin',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(false, '#/components/schemas/TenantImpersonatePayload'),
          responses: {
            200: ok('Impersonation token issued'),
            400: ok('Impersonation failed', '#/components/schemas/ErrorResponse'),
            403: ok('Super admin only', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements': {
        get: {
          tags: ['Rental Agreements'],
          summary: 'List rental agreements',
          security: bearerSecurity(),
          responses: { 200: ok('Agreement list') }
        }
      },
      '/api/rental-agreements/start-from-reservation/{reservationId}': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Create agreement from reservation',
          security: bearerSecurity(),
          parameters: [pathId('reservationId', 'Reservation identifier')],
          responses: {
            201: ok('Agreement created from reservation'),
            400: ok('Reservation cannot start agreement', '#/components/schemas/ErrorResponse'),
            404: ok('Reservation not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}': {
        get: {
          tags: ['Rental Agreements'],
          summary: 'Get agreement',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Agreement detail'),
            404: ok('Rental agreement not found', '#/components/schemas/ErrorResponse')
          }
        },
        delete: {
          tags: ['Rental Agreements'],
          summary: 'Delete draft agreement',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: ok('Draft agreement deleted'),
            400: ok('Only draft agreements can be deleted', '#/components/schemas/ErrorResponse'),
            404: ok('Rental agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/customer': {
        put: {
          tags: ['Rental Agreements'],
          summary: 'Update agreement customer section',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/AgreementCustomerPayload'),
          responses: {
            200: ok('Agreement customer updated'),
            400: ok('Missing required fields', '#/components/schemas/ErrorResponse'),
            404: ok('Rental agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/drivers': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Add agreement driver',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/AgreementDriverPayload'),
          responses: {
            201: ok('Driver added'),
            400: ok('Missing required fields', '#/components/schemas/ErrorResponse'),
            404: ok('Rental agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/rental': {
        put: {
          tags: ['Rental Agreements'],
          summary: 'Update rental details',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/AgreementRentalPayload'),
          responses: {
            200: ok('Rental details updated'),
            404: ok('Rental agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/charges': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Replace agreement charges',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/AgreementChargesPayload'),
          responses: {
            200: ok('Agreement charges updated'),
            404: ok('Rental agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/credit': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Adjust customer credit from agreement',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/CreditAdjustmentPayload'),
          responses: {
            200: ok('Customer credit adjusted'),
            400: ok('amount must be a non-zero number', '#/components/schemas/ErrorResponse'),
            403: ok('Admin approval required', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/print': {
        get: {
          tags: ['Rental Agreements'],
          summary: 'Render printable agreement HTML',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: {
            200: {
              description: 'Agreement HTML',
              content: {
                'text/html': {
                  schema: { type: 'string' }
                }
              }
            },
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/email-agreement': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Email agreement to recipients',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(false, '#/components/schemas/EmailRequestPayload'),
          responses: {
            200: ok('Agreement email sent'),
            400: ok('Invalid email request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/signature': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Save agreement signature',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true),
          responses: {
            200: ok('Agreement signed'),
            400: ok('Invalid signature request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/status': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Change agreement status',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/AgreementStatusPayload'),
          responses: {
            200: ok('Agreement status updated'),
            400: ok('Unsupported status action', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/close': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Close agreement',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(false, '#/components/schemas/AgreementClosePayload'),
          responses: {
            200: ok('Agreement closed'),
            400: ok('Agreement cannot be closed', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/payments/manual': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Create manual agreement payment',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ReservationPaymentPayload'),
          responses: {
            200: ok('Manual payment created'),
            400: ok('Invalid manual payment payload', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/customer/card-on-file': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Capture customer card on file',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/CardOnFilePayload'),
          responses: {
            200: ok('Customer card stored'),
            400: ok('Invalid card-on-file request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/payments/charge-card-on-file': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Charge stored customer card',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ChargeCardPayload'),
          responses: {
            200: ok('Card on file charged'),
            400: ok('Invalid charge request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/security-deposit/capture': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Capture security deposit',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(false, '#/components/schemas/SecurityDepositPayload'),
          responses: {
            200: ok('Security deposit captured'),
            400: ok('Invalid security deposit capture request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/security-deposit/release': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Release security deposit',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(false, '#/components/schemas/SecurityDepositPayload'),
          responses: {
            200: ok('Security deposit released'),
            400: ok('Invalid security deposit release request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/charge-card-on-file': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Compatibility alias for charging card on file',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/ChargeCardPayload'),
          responses: {
            200: ok('Card on file charged'),
            400: ok('Invalid charge request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/finalize': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Finalize agreement totals',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(false, '#/components/schemas/AgreementFinalizePayload'),
          responses: {
            200: ok('Agreement finalized'),
            404: ok('Agreement not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/inspection': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Save agreement inspection',
          security: bearerSecurity(),
          parameters: [pathId()],
          requestBody: body(true, '#/components/schemas/InspectionPayload'),
          responses: { 200: ok('Inspection saved') }
        }
      },
      '/api/rental-agreements/{id}/inspection-report': {
        get: {
          tags: ['Rental Agreements'],
          summary: 'Get agreement inspection report',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: { 200: ok('Inspection report') }
        }
      },
      '/api/rental-agreements/{id}/payments/{paymentId}/void': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Void agreement payment',
          security: bearerSecurity(),
          parameters: [pathId(), pathId('paymentId', 'Agreement payment identifier')],
          requestBody: body(false),
          responses: {
            200: ok('Payment voided'),
            400: ok('Payment cannot be voided', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement or payment not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/payments/{paymentId}/refund': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Refund agreement payment',
          security: bearerSecurity(),
          parameters: [pathId(), pathId('paymentId', 'Agreement payment identifier')],
          requestBody: body(false, '#/components/schemas/CreditAdjustmentPayload'),
          responses: {
            200: ok('Payment refunded'),
            400: ok('Invalid refund request', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement or payment not found', '#/components/schemas/ErrorResponse')
          }
        }
      },
      '/api/rental-agreements/{id}/payments/{paymentId}/delete': {
        post: {
          tags: ['Rental Agreements'],
          summary: 'Hard delete agreement payment',
          security: bearerSecurity(),
          parameters: [pathId(), pathId('paymentId', 'Agreement payment identifier')],
          requestBody: body(false),
          responses: {
            200: ok('Payment deleted'),
            400: ok('Payment cannot be deleted', '#/components/schemas/ErrorResponse'),
            404: ok('Agreement or payment not found', '#/components/schemas/ErrorResponse')
          }
        }
      }
    }
  };
}

export function swaggerHtml(specPath = '/api/docs/openapi.json') {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ride Fleet API Docs</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #f6f8fb; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = () => {
        window.ui = SwaggerUIBundle({
          url: '${specPath}',
          dom_id: '#swagger-ui',
          deepLinking: true,
          persistAuthorization: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: 'StandaloneLayout',
          displayRequestDuration: true
        });
      };
    </script>
  </body>
</html>`;
}
