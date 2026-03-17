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
      { name: 'Reservations', description: 'Reservation lifecycle and structured pricing/payments' },
      { name: 'Rental Agreements', description: 'Agreement lifecycle, payments, signatures, inspections' },
      { name: 'Customers', description: 'Customer management' },
      { name: 'Vehicles', description: 'Vehicle management' },
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
      '/api/rental-agreements': {
        get: {
          tags: ['Rental Agreements'],
          summary: 'List rental agreements',
          security: bearerSecurity(),
          responses: { 200: ok('Agreement list') }
        }
      },
      '/api/rental-agreements/{id}': {
        get: {
          tags: ['Rental Agreements'],
          summary: 'Get agreement',
          security: bearerSecurity(),
          parameters: [pathId()],
          responses: { 200: ok('Agreement detail') }
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
