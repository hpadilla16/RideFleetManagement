/**
 * Route inventory for the OpenAPI spec — GENERATED. Do not hand-edit paths.
 *
 * Produced by scripts/generate-openapi-routes.mjs, which reads main.js's mounts
 * and each router file. Re-run it after adding routes:
 *
 *     node scripts/generate-openapi-routes.mjs --write
 *
 * DESCRIPTIONS ARE THE PART WORTH KEEPING. The generator carries every existing
 * one over verbatim and only derives text for routes it has never seen, marking
 * those `// TODO(describe)` — a derived description says the shape of a URL,
 * not what the endpoint is for. Replacing those with real wording is the one
 * edit to make here by hand, and it survives the next regeneration.
 *
 * Last generated: 2026-09-11
 */
export const EXTRA_ROUTES = [
  // ── Admin ─────────────────────────────────────────────────────────────────
  ['POST', '/api/admin/customers/{id}/erase', 'Admin', 'Create or run customers erase'], // TODO(describe)
  ['GET', '/api/admin/customers/{id}/export', 'Admin', 'Get customers export'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage-email/credentials', 'Admin', 'Create or run integrations advantage email credentials'], // TODO(describe)
  ['PUT', '/api/admin/integrations/advantage-email/enabled', 'Admin', 'Replace integrations advantage email enabled'], // TODO(describe)
  ['GET', '/api/admin/integrations/advantage-email/messages', 'Admin', 'Get integrations advantage email messages'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage-email/messages/{id}/retry', 'Admin', 'Create or run integrations advantage email messages retry'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage-email/run-now', 'Admin', 'Create or run integrations advantage email run now'], // TODO(describe)
  ['GET', '/api/admin/integrations/advantage-email/runs', 'Admin', 'Get integrations advantage email runs'], // TODO(describe)
  ['GET', '/api/admin/integrations/advantage-email/status', 'Admin', 'Get integrations advantage email status'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage-email/test-connection', 'Admin', 'Create or run integrations advantage email test connection'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage/credentials', 'Admin', 'Create or run integrations advantage credentials'], // TODO(describe)
  ['PUT', '/api/admin/integrations/advantage/enabled', 'Admin', 'Replace integrations advantage enabled'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage/force-relogin', 'Admin', 'Create or run integrations advantage force relogin'], // TODO(describe)
  ['GET', '/api/admin/integrations/advantage/locations', 'Admin', 'Get integrations advantage locations'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage/locations', 'Admin', 'Create or run integrations advantage locations'], // TODO(describe)
  ['DELETE', '/api/admin/integrations/advantage/locations/{id}', 'Admin', 'Delete integrations advantage locations'], // TODO(describe)
  ['PUT', '/api/admin/integrations/advantage/locations/{id}', 'Admin', 'Replace integrations advantage locations'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage/locations/{id}/toggle', 'Admin', 'Create or run integrations advantage locations toggle'], // TODO(describe)
  ['GET', '/api/admin/integrations/advantage/pending-imports', 'Admin', 'Get integrations advantage pending imports'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage/pending-imports/{id}/promote', 'Admin', 'Create or run integrations advantage pending imports promote'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage/pending-imports/{id}/reject', 'Admin', 'Create or run integrations advantage pending imports reject'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage/run-now', 'Admin', 'Create or run integrations advantage run now'], // TODO(describe)
  ['GET', '/api/admin/integrations/advantage/runs', 'Admin', 'Get integrations advantage runs'], // TODO(describe)
  ['GET', '/api/admin/integrations/advantage/status', 'Admin', 'Get integrations advantage status'], // TODO(describe)
  ['POST', '/api/admin/integrations/advantage/test-auth', 'Admin', 'Create or run integrations advantage test auth'], // TODO(describe)
  ['GET', '/api/admin/integrations/economy/rate-push/approvals', 'Admin', 'Get integrations economy rate push approvals'], // TODO(describe)
  ['POST', '/api/admin/integrations/economy/rate-push/approvals/{id}', 'Admin', 'Create or run integrations economy rate push approvals'], // TODO(describe)
  ['GET', '/api/admin/integrations/economy/rate-push/log', 'Admin', 'Get integrations economy rate push log'], // TODO(describe)
  ['POST', '/api/admin/integrations/economy/rate-push/run', 'Admin', 'Create or run integrations economy rate push run'], // TODO(describe)
  ['POST', '/api/admin/integrations/flexways/credentials', 'Admin', 'Create or run integrations flexways credentials'], // TODO(describe)
  ['PUT', '/api/admin/integrations/flexways/enabled', 'Admin', 'Replace integrations flexways enabled'], // TODO(describe)
  ['POST', '/api/admin/integrations/flexways/force-relogin', 'Admin', 'Create or run integrations flexways force relogin'], // TODO(describe)
  ['GET', '/api/admin/integrations/flexways/locations', 'Admin', 'Get integrations flexways locations'], // TODO(describe)
  ['POST', '/api/admin/integrations/flexways/locations', 'Admin', 'Create or run integrations flexways locations'], // TODO(describe)
  ['DELETE', '/api/admin/integrations/flexways/locations/{id}', 'Admin', 'Delete integrations flexways locations'], // TODO(describe)
  ['PUT', '/api/admin/integrations/flexways/locations/{id}', 'Admin', 'Replace integrations flexways locations'], // TODO(describe)
  ['POST', '/api/admin/integrations/flexways/locations/{id}/toggle', 'Admin', 'Create or run integrations flexways locations toggle'], // TODO(describe)
  ['GET', '/api/admin/integrations/flexways/pending-imports', 'Admin', 'Get integrations flexways pending imports'], // TODO(describe)
  ['POST', '/api/admin/integrations/flexways/pending-imports/{id}/promote', 'Admin', 'Create or run integrations flexways pending imports promote'], // TODO(describe)
  ['POST', '/api/admin/integrations/flexways/pending-imports/{id}/reject', 'Admin', 'Create or run integrations flexways pending imports reject'], // TODO(describe)
  ['POST', '/api/admin/integrations/flexways/run-now', 'Admin', 'Create or run integrations flexways run now'], // TODO(describe)
  ['GET', '/api/admin/integrations/flexways/runs', 'Admin', 'Get integrations flexways runs'], // TODO(describe)
  ['GET', '/api/admin/integrations/flexways/status', 'Admin', 'Get integrations flexways status'], // TODO(describe)
  ['POST', '/api/admin/integrations/flexways/test-auth', 'Admin', 'Create or run integrations flexways test auth'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/credentials', 'Admin', 'Create or run integrations mex credentials'], // TODO(describe)
  ['PUT', '/api/admin/integrations/mex/enabled', 'Admin', 'Replace integrations mex enabled'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/force-relogin', 'Admin', 'Create or run integrations mex force relogin'], // TODO(describe)
  ['GET', '/api/admin/integrations/mex/locations', 'Admin', 'Get integrations mex locations'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/locations', 'Admin', 'Create or run integrations mex locations'], // TODO(describe)
  ['DELETE', '/api/admin/integrations/mex/locations/{id}', 'Admin', 'Delete integrations mex locations'], // TODO(describe)
  ['PUT', '/api/admin/integrations/mex/locations/{id}', 'Admin', 'Replace integrations mex locations'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/locations/{id}/toggle', 'Admin', 'Create or run integrations mex locations toggle'], // TODO(describe)
  ['GET', '/api/admin/integrations/mex/pending-imports', 'Admin', 'Get integrations mex pending imports'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/pending-imports/{id}/promote', 'Admin', 'Create or run integrations mex pending imports promote'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/pending-imports/{id}/reject', 'Admin', 'Create or run integrations mex pending imports reject'], // TODO(describe)
  ['GET', '/api/admin/integrations/mex/rate-push/log', 'Admin', 'Get integrations mex rate push log'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/rate-push/plan', 'Admin', 'Create or run integrations mex rate push plan'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/rate-push/run', 'Admin', 'Create or run integrations mex rate push run'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/run-now', 'Admin', 'Create or run integrations mex run now'], // TODO(describe)
  ['GET', '/api/admin/integrations/mex/runs', 'Admin', 'Get integrations mex runs'], // TODO(describe)
  ['GET', '/api/admin/integrations/mex/status', 'Admin', 'Get integrations mex status'], // TODO(describe)
  ['POST', '/api/admin/integrations/mex/test-auth', 'Admin', 'Create or run integrations mex test auth'], // TODO(describe)
  ['POST', '/api/admin/integrations/nu/credentials', 'Admin', 'Create or run integrations nu credentials'], // TODO(describe)
  ['PUT', '/api/admin/integrations/nu/enabled', 'Admin', 'Replace integrations nu enabled'], // TODO(describe)
  ['GET', '/api/admin/integrations/nu/locations', 'Admin', 'Get integrations nu locations'], // TODO(describe)
  ['POST', '/api/admin/integrations/nu/locations', 'Admin', 'Create or run integrations nu locations'], // TODO(describe)
  ['DELETE', '/api/admin/integrations/nu/locations/{id}', 'Admin', 'Delete integrations nu locations'], // TODO(describe)
  ['PUT', '/api/admin/integrations/nu/locations/{id}', 'Admin', 'Replace integrations nu locations'], // TODO(describe)
  ['POST', '/api/admin/integrations/nu/locations/{id}/toggle', 'Admin', 'Create or run integrations nu locations toggle'], // TODO(describe)
  ['GET', '/api/admin/integrations/nu/pending-imports', 'Admin', 'Get integrations nu pending imports'], // TODO(describe)
  ['POST', '/api/admin/integrations/nu/pending-imports/{id}/promote', 'Admin', 'Create or run integrations nu pending imports promote'], // TODO(describe)
  ['POST', '/api/admin/integrations/nu/pending-imports/{id}/reject', 'Admin', 'Create or run integrations nu pending imports reject'], // TODO(describe)
  ['POST', '/api/admin/integrations/nu/run-now', 'Admin', 'Create or run integrations nu run now'], // TODO(describe)
  ['GET', '/api/admin/integrations/nu/runs', 'Admin', 'Get integrations nu runs'], // TODO(describe)
  ['GET', '/api/admin/integrations/nu/status', 'Admin', 'Get integrations nu status'], // TODO(describe)
  ['POST', '/api/admin/integrations/nu/test-auth', 'Admin', 'Create or run integrations nu test auth'], // TODO(describe)
  ['GET', '/api/admin/integrations/price-policy', 'Admin', 'Get integrations price policy'], // TODO(describe)
  ['PUT', '/api/admin/integrations/price-policy', 'Admin', 'Replace integrations price policy'], // TODO(describe)
  ['GET', '/api/admin/reservations/{id}/override-preview', 'Admin', 'Preview reservation status override'],
  ['PATCH', '/api/admin/reservations/{id}/status', 'Admin', 'Apply reservation status override'],

  // ── Auth ──────────────────────────────────────────────────────────────────
  ['POST', '/api/auth/2fa/backup-codes/regenerate', 'Auth', 'Create or run 2fa backup codes regenerate'], // TODO(describe)
  ['POST', '/api/auth/2fa/disable', 'Auth', 'Create or run 2fa disable'], // TODO(describe)
  ['POST', '/api/auth/2fa/enroll/start', 'Auth', 'Create or run 2fa enroll start'], // TODO(describe)
  ['POST', '/api/auth/2fa/enroll/verify', 'Auth', 'Create or run 2fa enroll verify'], // TODO(describe)
  ['GET', '/api/auth/2fa/status', 'Auth', 'Get 2fa status'], // TODO(describe)
  ['POST', '/api/auth/2fa/verify-login', 'Auth', 'Create or run 2fa verify login'], // TODO(describe)
  ['POST', '/api/auth/change-password', 'Auth', 'Create or run change password'], // TODO(describe)
  ['POST', '/api/auth/lock-pin/reset', 'Auth', 'Create or run lock pin reset'], // TODO(describe)
  ['POST', '/api/auth/lock-pin/set', 'Auth', 'Create or run lock pin set'], // TODO(describe)
  ['GET', '/api/auth/lock-pin/status', 'Auth', 'Get lock pin status'], // TODO(describe)
  ['POST', '/api/auth/lock-pin/verify', 'Auth', 'Create or run lock pin verify'], // TODO(describe)
  ['POST', '/api/auth/login', 'Auth', 'Create or run login'], // TODO(describe)
  ['POST', '/api/auth/logout', 'Auth', 'Create or run logout'], // TODO(describe)
  ['GET', '/api/auth/me', 'Auth', 'Get current authenticated user'],
  ['POST', '/api/auth/refresh', 'Auth', 'Refresh JWT token'],
  ['POST', '/api/auth/register', 'Auth', 'Create or run register'], // TODO(describe)
  ['POST', '/api/auth/service-token', 'Auth', 'Create or run service token'], // TODO(describe)
  ['POST', '/api/auth/service-token/revoke', 'Auth', 'Create or run service token revoke'], // TODO(describe)
  ['GET', '/api/auth/users', 'Auth', 'Get users'], // TODO(describe)
  ['POST', '/api/auth/users/{id}/reset-2fa', 'Auth', 'Create or run users reset 2fa'], // TODO(describe)
  ['POST', '/api/auth/users/{id}/reset-lock-pin', 'Auth', 'Create or run users reset lock pin'], // TODO(describe)
  ['POST', '/api/auth/users/{id}/screen-lock-exempt', 'Auth', 'Set user screen-lock exempt flag'],

  // ── Billing ───────────────────────────────────────────────────────────────
  ['GET', '/api/billing/self', 'Billing', 'Get self'], // TODO(describe)
  ['POST', '/api/billing/self/payment-link', 'Billing', 'Create or run self payment link'], // TODO(describe)

  // ── Car Sharing ───────────────────────────────────────────────────────────
  ['DELETE', '/api/car-sharing/availability/{id}', 'Car Sharing', 'Delete availability window'],
  ['PATCH', '/api/car-sharing/availability/{id}', 'Car Sharing', 'Update availability window'],
  ['GET', '/api/car-sharing/config', 'Car Sharing', 'Get car-sharing config'],
  ['GET', '/api/car-sharing/eligible-vehicles', 'Car Sharing', 'List eligible vehicles'],
  ['GET', '/api/car-sharing/hosts', 'Car Sharing', 'List hosts'],
  ['POST', '/api/car-sharing/hosts', 'Car Sharing', 'Create host'],
  ['PATCH', '/api/car-sharing/hosts/{id}', 'Car Sharing', 'Update host'],
  ['GET', '/api/car-sharing/listings', 'Car Sharing', 'List listings'],
  ['POST', '/api/car-sharing/listings', 'Car Sharing', 'Create listing'],
  ['PATCH', '/api/car-sharing/listings/{id}', 'Car Sharing', 'Update listing'],
  ['GET', '/api/car-sharing/listings/{id}/availability', 'Car Sharing', 'List availability windows'],
  ['POST', '/api/car-sharing/listings/{id}/availability', 'Car Sharing', 'Create availability window'],
  ['GET', '/api/car-sharing/ops/handoff-alerts', 'Car Sharing', 'List handoff confirmation alerts'],
  ['POST', '/api/car-sharing/ops/send-handoff-reminders', 'Car Sharing', 'Send handoff confirmation reminders'],
  ['PATCH', '/api/car-sharing/search-places/{id}/approve', 'Car Sharing', 'Approve search place'],
  ['PATCH', '/api/car-sharing/search-places/{id}/reject', 'Car Sharing', 'Reject search place'],
  ['GET', '/api/car-sharing/search-places/pending', 'Car Sharing', 'List pending search places'],
  ['GET', '/api/car-sharing/trips', 'Car Sharing', 'List trips'],
  ['POST', '/api/car-sharing/trips', 'Car Sharing', 'Create trip'],
  ['POST', '/api/car-sharing/trips/{id}/provision-workflow', 'Car Sharing', 'Provision trip workflow'],
  ['PATCH', '/api/car-sharing/trips/{id}/status', 'Car Sharing', 'Update trip status'],

  // ── Catalog ───────────────────────────────────────────────────────────────
  ['GET', '/api/additional-services', 'Catalog', 'List additional services'],
  ['POST', '/api/additional-services', 'Catalog', 'Create additional service'],
  ['DELETE', '/api/additional-services/{id}', 'Catalog', 'Delete additional service'],
  ['GET', '/api/additional-services/{id}', 'Catalog', 'Get additional service'],
  ['PATCH', '/api/additional-services/{id}', 'Catalog', 'Update additional service'],
  ['GET', '/api/locations', 'Catalog', 'List locations'],
  ['POST', '/api/locations', 'Catalog', 'Create location'],
  ['DELETE', '/api/locations/{id}', 'Catalog', 'Delete location'],
  ['GET', '/api/locations/{id}', 'Catalog', 'Get location'],
  ['PATCH', '/api/locations/{id}', 'Catalog', 'Update location'],
  ['GET', '/api/rates', 'Catalog', 'List rates'],
  ['POST', '/api/rates', 'Catalog', 'Create rate'],
  ['DELETE', '/api/rates/{id}', 'Catalog', 'Delete rate'],
  ['PATCH', '/api/rates/{id}', 'Catalog', 'Update rate'],
  ['DELETE', '/api/rates/{id}/daily-prices/{dailyPriceId}', 'Catalog', 'Remove a daily price'],
  ['POST', '/api/rates/{id}/daily-prices/import', 'Catalog', 'Import daily-price rows'],
  ['POST', '/api/rates/{id}/daily-prices/validate', 'Catalog', 'Validate daily-price rows'],
  ['GET', '/api/rates/lookup-by-location/{code}', 'Catalog', 'Auto-detect rates by location code'],
  ['POST', '/api/rates/parse-excel', 'Catalog', 'Parse uploaded rate Excel'],
  ['GET', '/api/rates/resolve', 'Catalog', 'Resolve rate for window'],
  ['GET', '/api/rates/revenue-recommendation', 'Catalog', 'Revenue-managed rate recommendation'],
  ['GET', '/api/stop-sales', 'Catalog', 'List stop sales'],
  ['POST', '/api/stop-sales', 'Catalog', 'Create stop sale'],
  ['DELETE', '/api/stop-sales/{id}', 'Catalog', 'Delete stop sale'],
  ['GET', '/api/stop-sales/{id}', 'Catalog', 'Get stop sale'],
  ['PATCH', '/api/stop-sales/{id}', 'Catalog', 'Update stop sale'],
  ['GET', '/api/vehicle-types', 'Catalog', 'List vehicle types'],
  ['POST', '/api/vehicle-types', 'Catalog', 'Create vehicle type'],
  ['DELETE', '/api/vehicle-types/{id}', 'Catalog', 'Delete vehicle type'],
  ['GET', '/api/vehicle-types/{id}', 'Catalog', 'Get vehicle type'],
  ['PATCH', '/api/vehicle-types/{id}', 'Catalog', 'Update vehicle type'],

  // ── Checkin Audit ─────────────────────────────────────────────────────────
  ['GET', '/api/checkin-audit', 'Checkin Audit', 'Get checkin audit'], // TODO(describe)
  ['GET', '/api/checkin-audit/{reservationId}', 'Checkin Audit', 'Get checkin audit'], // TODO(describe)
  ['GET', '/api/checkin-audit/findings/{id}/convert-prefill', 'Checkin Audit', 'Get findings convert prefill'], // TODO(describe)
  ['POST', '/api/checkin-audit/findings/{id}/dismiss', 'Checkin Audit', 'Create or run findings dismiss'], // TODO(describe)

  // ── Checkout ──────────────────────────────────────────────────────────────
  ['POST', '/api/checkout-sessions', 'Checkout', 'Create checkout session for reservation'],
  ['GET', '/api/checkout-sessions/{id}', 'Checkout', 'Get checkout session'],
  ['POST', '/api/checkout-sessions/{id}/abandon', 'Checkout', 'Mark checkout session abandoned'],
  ['POST', '/api/checkout-sessions/{id}/charge', 'Checkout', 'Run checkout charge sequence'],
  ['POST', '/api/checkout-sessions/{id}/charge-sale', 'Checkout', 'Run checkout sale charge'],
  ['POST', '/api/checkout-sessions/{id}/declined-insurance', 'Checkout', 'Set declined insurance'],
  ['POST', '/api/checkout-sessions/{id}/handoff-token', 'Checkout', 'Mint mobile inspection token'],
  ['POST', '/api/checkout-sessions/{id}/hold-deposit', 'Checkout', 'Run checkout deposit hold'],
  ['POST', '/api/checkout-sessions/{id}/record-manual-deposit', 'Checkout', 'Record manual deposit'],
  ['POST', '/api/checkout-sessions/{id}/record-manual-payment', 'Checkout', 'Record manual sale payment'],
  ['POST', '/api/checkout-sessions/{id}/send-customer-inspection', 'Checkout', 'Send customer inspection link'],
  ['POST', '/api/checkout-sessions/{id}/stamp', 'Checkout', 'Stamp checkout side effect'],
  ['GET', '/api/checkout-sessions/{id}/terminal-status', 'Checkout', 'Get checkout terminal status'],
  ['POST', '/api/checkout-sessions/{id}/terms-token', 'Checkout', 'Mint terms signing token'],
  ['POST', '/api/checkout-sessions/{id}/transition', 'Checkout', 'Transition checkout session'],
  ['POST', '/api/checkout-sessions/{id}/vehicle', 'Checkout', 'Swap checkout session vehicle'],
  ['GET', '/api/checkout-sessions/by-reservation/{reservationId}', 'Checkout', 'Get checkout session by reservation'],

  // ── Checkout Sessions ─────────────────────────────────────────────────────
  ['POST', '/api/checkout-sessions/{id}/customer-signature', 'Checkout Sessions', 'Create or run customer signature'], // TODO(describe)
  ['POST', '/api/checkout-sessions/{id}/presence', 'Checkout Sessions', 'Create or run presence'], // TODO(describe)
  ['GET', '/api/checkout-sessions/{id}/terminal-contract', 'Checkout Sessions', 'Get terminal contract'], // TODO(describe)
  ['POST', '/api/checkout-sessions/{id}/terminal-contract/clause', 'Checkout Sessions', 'Create or run terminal contract clause'], // TODO(describe)
  ['POST', '/api/checkout-sessions/{id}/terminal-contract/fallback', 'Checkout Sessions', 'Create or run terminal contract fallback'], // TODO(describe)
  ['POST', '/api/checkout-sessions/{id}/terminal-contract/signature', 'Checkout Sessions', 'Create or run terminal contract signature'], // TODO(describe)
  ['GET', '/api/checkout-sessions/{id}/terminal-options', 'Checkout Sessions', 'Get terminal options'], // TODO(describe)
  ['POST', '/api/checkout-sessions/{id}/terminal-select', 'Checkout Sessions', 'Create or run terminal select'], // TODO(describe)

  // ── Citations ─────────────────────────────────────────────────────────────
  ['GET', '/api/citations', 'Citations', 'List citations'],
  ['GET', '/api/citations/{id}', 'Citations', 'Get citation detail'],
  ['GET', '/api/citations/{id}/affidavit/pdf', 'Citations', 'Get affidavit pdf'], // TODO(describe)
  ['GET', '/api/citations/{id}/attachments', 'Citations', 'Get attachments'], // TODO(describe)
  ['POST', '/api/citations/{id}/attachments', 'Citations', 'Create or run attachments'], // TODO(describe)
  ['GET', '/api/citations/{id}/document', 'Citations', 'Get document'], // TODO(describe)
  ['GET', '/api/citations/{id}/export/pdf', 'Citations', 'Get export pdf'], // TODO(describe)
  ['POST', '/api/citations/{id}/review', 'Citations', 'Review citation decision'],
  ['DELETE', '/api/citations/attachments/{attachmentId}', 'Citations', 'Delete attachments'], // TODO(describe)
  ['GET', '/api/citations/attachments/{attachmentId}/download', 'Citations', 'Get attachments download'], // TODO(describe)
  ['GET', '/api/citations/documents', 'Citations', 'List citation notice documents'],
  ['POST', '/api/citations/documents', 'Citations', 'Upload citation notice document'],
  ['GET', '/api/citations/documents/{id}/download', 'Citations', 'Get documents download'], // TODO(describe)
  ['POST', '/api/citations/documents/{id}/retry', 'Citations', 'Retry citation document OCR'],
  ['GET', '/api/citations/location-breakdown', 'Citations', 'Citation counts per branch, for the location filter'],
  ['POST', '/api/citations/manual-import', 'Citations', 'Manual citation import'],
  ['GET', '/api/citations/summary', 'Citations', 'Citation dashboard summary'],
  ['GET', '/api/citations/vehicle/{vehicleId}', 'Citations', 'Citation history for vehicle'],

  // ── Commissions ───────────────────────────────────────────────────────────
  ['POST', '/api/commissions/car-sharing/calculate', 'Commissions', 'Calculate car-sharing commission'],
  ['GET', '/api/commissions/car-sharing/host-tiers', 'Commissions', 'List host tier options'],
  ['GET', '/api/commissions/car-sharing/policies', 'Commissions', 'Get car-sharing policies'],
  ['GET', '/api/commissions/car-sharing/protection', 'Commissions', 'List trip protection tiers'],
  ['GET', '/api/commissions/employees', 'Commissions', 'List employees with commission plan'],
  ['PATCH', '/api/commissions/employees/{id}/plan', 'Commissions', 'Assign commission plan to employee'],
  ['GET', '/api/commissions/ledger', 'Commissions', 'Get commission ledger'],
  ['POST', '/api/commissions/ledger/{id}/approve', 'Commissions', 'Create or run ledger approve'], // TODO(describe)
  ['POST', '/api/commissions/ledger/{id}/mark-paid', 'Commissions', 'Create or run ledger mark paid'], // TODO(describe)
  ['POST', '/api/commissions/ledger/{id}/void', 'Commissions', 'Create or run ledger void'], // TODO(describe)
  ['GET', '/api/commissions/plans', 'Commissions', 'List commission plans'],
  ['POST', '/api/commissions/plans', 'Commissions', 'Create commission plan'],
  ['DELETE', '/api/commissions/plans/{id}', 'Commissions', 'Delete commission plan'],
  ['GET', '/api/commissions/plans/{id}', 'Commissions', 'Get commission plan'],
  ['PATCH', '/api/commissions/plans/{id}', 'Commissions', 'Update commission plan'],
  ['GET', '/api/commissions/plans/{id}/rules', 'Commissions', 'List commission plan rules'],
  ['POST', '/api/commissions/plans/{id}/rules', 'Commissions', 'Create commission plan rule'],
  ['GET', '/api/commissions/review-proofs', 'Commissions', 'Get review proofs'], // TODO(describe)
  ['POST', '/api/commissions/review-proofs', 'Commissions', 'Create or run review proofs'], // TODO(describe)
  ['PATCH', '/api/commissions/review-proofs/{id}/status', 'Commissions', 'Update review proofs status'], // TODO(describe)
  ['DELETE', '/api/commissions/rules/{id}', 'Commissions', 'Delete commission rule'],
  ['PATCH', '/api/commissions/rules/{id}', 'Commissions', 'Update commission rule'],

  // ── Copilot ───────────────────────────────────────────────────────────────
  ['GET', '/api/copilot/ai-status', 'Copilot', 'Get ai status'], // TODO(describe)
  ['POST', '/api/copilot/ask', 'Copilot', 'Create or run ask'], // TODO(describe)
  ['POST', '/api/copilot/misses', 'Copilot', 'Create or run misses'], // TODO(describe)
  ['POST', '/api/copilot/misses/flag', 'Copilot', 'Create or run misses flag'], // TODO(describe)
  ['GET', '/api/copilot/misses/top', 'Copilot', 'Get misses top'], // TODO(describe)

  // ── Customer Inspection ───────────────────────────────────────────────────
  ['GET', '/api/customer-inspection/{token}', 'Customer Inspection', 'Get customer inspection'], // TODO(describe)
  ['POST', '/api/customer-inspection/{token}/complete', 'Customer Inspection', 'Create or run complete'], // TODO(describe)
  ['POST', '/api/customer-inspection/{token}/damage', 'Customer Inspection', 'Create or run damage'], // TODO(describe)
  ['GET', '/api/customer-inspection/r/{payload}', 'Customer Inspection', 'Get r'], // TODO(describe)
  ['GET', '/api/customer-inspection/v/{payload}', 'Customer Inspection', 'Get v'], // TODO(describe)

  // ── Customer Inspections ──────────────────────────────────────────────────
  ['POST', '/api/customer-inspections/checkin/{reservationId}', 'Customer Inspections', 'Create or run checkin'], // TODO(describe)
  ['POST', '/api/customer-inspections/reports/{reportId}/clear', 'Customer Inspections', 'Create or run reports clear'], // TODO(describe)
  ['POST', '/api/customer-inspections/reports/{reportId}/seed-review', 'Customer Inspections', 'Create or run reports seed review'], // TODO(describe)
  ['GET', '/api/customer-inspections/vehicle/{vehicleId}/checkin-qr', 'Customer Inspections', 'Get vehicle checkin qr'], // TODO(describe)
  ['POST', '/api/customer-inspections/vehicle/{vehicleId}/seed-baseline', 'Customer Inspections', 'Create or run vehicle seed baseline'], // TODO(describe)

  // ── Customers ─────────────────────────────────────────────────────────────
  ['GET', '/api/customers', 'Customers', 'Get customers'], // TODO(describe)
  ['POST', '/api/customers', 'Customers', 'Create or run customers'], // TODO(describe)
  ['DELETE', '/api/customers/{id}', 'Customers', 'Delete customers'], // TODO(describe)
  ['GET', '/api/customers/{id}', 'Customers', 'Get customers'], // TODO(describe)
  ['PATCH', '/api/customers/{id}', 'Customers', 'Update customers'], // TODO(describe)
  ['GET', '/api/customers/{id}/id-photo', 'Customers', 'Get id photo'], // TODO(describe)
  ['GET', '/api/customers/{id}/insurance-doc', 'Customers', 'Get insurance doc'], // TODO(describe)
  ['GET', '/api/customers/{id}/license-back', 'Customers', 'Get license back'], // TODO(describe)
  ['POST', '/api/customers/{id}/password-reset', 'Customers', 'Create or run password reset'], // TODO(describe)
  ['POST', '/api/customers/bulk/import', 'Customers', 'Create or run bulk import'], // TODO(describe)
  ['POST', '/api/customers/bulk/validate', 'Customers', 'Create or run bulk validate'], // TODO(describe)

  // ── Dealership Loaner ─────────────────────────────────────────────────────
  ['GET', '/api/dealership-loaner/billing-export', 'Dealership Loaner', 'Get billing export'], // TODO(describe)
  ['GET', '/api/dealership-loaner/config', 'Dealership Loaner', 'Get loaner config'],
  ['GET', '/api/dealership-loaner/customer-requests', 'Dealership Loaner', 'Get customer requests'], // TODO(describe)
  ['POST', '/api/dealership-loaner/customer-requests/{id}/resolve', 'Dealership Loaner', 'Create or run customer requests resolve'], // TODO(describe)
  ['GET', '/api/dealership-loaner/dashboard', 'Dealership Loaner', 'Get loaner dashboard'],
  ['POST', '/api/dealership-loaner/intake', 'Dealership Loaner', 'Loaner intake'],
  ['GET', '/api/dealership-loaner/intake-options', 'Dealership Loaner', 'Get loaner intake options'],
  ['GET', '/api/dealership-loaner/requests', 'Dealership Loaner', 'Get requests'], // TODO(describe)
  ['PATCH', '/api/dealership-loaner/requests/{id}', 'Dealership Loaner', 'Update requests'], // TODO(describe)
  ['GET', '/api/dealership-loaner/reservations/{id}', 'Dealership Loaner', 'Get loaner reservation'],
  ['POST', '/api/dealership-loaner/reservations/{id}/accounting-closeout', 'Dealership Loaner', 'Save accounting closeout'],
  ['POST', '/api/dealership-loaner/reservations/{id}/advisor-ops', 'Dealership Loaner', 'Save advisor ops'],
  ['POST', '/api/dealership-loaner/reservations/{id}/billing', 'Dealership Loaner', 'Save loaner billing'],
  ['GET', '/api/dealership-loaner/reservations/{id}/billing-print', 'Dealership Loaner', 'Get reservations billing print'], // TODO(describe)
  ['POST', '/api/dealership-loaner/reservations/{id}/borrower-packet', 'Dealership Loaner', 'Save borrower packet'],
  ['POST', '/api/dealership-loaner/reservations/{id}/complete-service', 'Dealership Loaner', 'Complete loaner service'],
  ['POST', '/api/dealership-loaner/reservations/{id}/extend', 'Dealership Loaner', 'Extend loaner'],
  ['GET', '/api/dealership-loaner/reservations/{id}/handoff-print', 'Dealership Loaner', 'Get reservations handoff print'], // TODO(describe)
  ['GET', '/api/dealership-loaner/reservations/{id}/purchase-order-print', 'Dealership Loaner', 'Get reservations purchase order print'], // TODO(describe)
  ['POST', '/api/dealership-loaner/reservations/{id}/return-exception', 'Dealership Loaner', 'Save return exception'],
  ['POST', '/api/dealership-loaner/reservations/{id}/send-prearrival', 'Dealership Loaner', 'Create or run reservations send prearrival'], // TODO(describe)
  ['POST', '/api/dealership-loaner/reservations/{id}/swap-vehicle', 'Dealership Loaner', 'Swap loaner vehicle'],
  ['GET', '/api/dealership-loaner/statement-export', 'Dealership Loaner', 'Get statement export'], // TODO(describe)
  ['GET', '/api/dealership-loaner/statement-print', 'Dealership Loaner', 'Get statement print'], // TODO(describe)
  ['GET', '/api/loaner-agreements/{id}', 'Dealership Loaner', 'Get loaner agreement'],
  ['PATCH', '/api/loaner-agreements/{id}', 'Dealership Loaner', 'Update loaner agreement'],
  ['POST', '/api/loaner-agreements/{id}/check-in', 'Dealership Loaner', 'Check in loaner agreement'],
  ['POST', '/api/loaner-agreements/{id}/close', 'Dealership Loaner', 'Close loaner agreement'],
  ['POST', '/api/loaner-agreements/{id}/damage-points', 'Dealership Loaner', 'Add loaner damage point'],
  ['POST', '/api/loaner-agreements/{id}/photos', 'Dealership Loaner', 'Upload loaner agreement photos'],
  ['POST', '/api/loaner-agreements/{id}/sign', 'Dealership Loaner', 'Sign loaner agreement'],
  ['POST', '/api/loaner-agreements/{id}/signature-token', 'Dealership Loaner', 'Issue loaner signature token'],
  ['GET', '/api/loaner-agreements/reservations/{reservationId}', 'Dealership Loaner', 'Get loaner agreement by reservation'],
  ['POST', '/api/loaner-agreements/reservations/{reservationId}', 'Dealership Loaner', 'Create loaner agreement for reservation'],

  // ── Economy (RezLight) ────────────────────────────────────────────────────
  ['POST', '/api/admin/integrations/economy/credentials', 'Economy (RezLight)', 'Set/rotate username+password (encrypted; password never returned)'],
  ['PUT', '/api/admin/integrations/economy/enabled', 'Economy (RezLight)', 'Master enable/disable for tenant'],
  ['GET', '/api/admin/integrations/economy/locations', 'Economy (RezLight)', 'List EconomyLocationConfig rows'],
  ['POST', '/api/admin/integrations/economy/locations', 'Economy (RezLight)', 'Create an area config'],
  ['DELETE', '/api/admin/integrations/economy/locations/{id}', 'Economy (RezLight)', 'Delete an area config'],
  ['PUT', '/api/admin/integrations/economy/locations/{id}', 'Economy (RezLight)', 'Update an area config (mapping/window/enabled)'],
  ['POST', '/api/admin/integrations/economy/locations/{id}/toggle', 'Economy (RezLight)', 'Toggle an area on/off'],
  ['GET', '/api/admin/integrations/economy/pending-imports', 'Economy (RezLight)', 'List pending imports'],
  ['POST', '/api/admin/integrations/economy/pending-imports/{id}/promote', 'Economy (RezLight)', 'Promote pending import'],
  ['POST', '/api/admin/integrations/economy/pending-imports/{id}/reject', 'Economy (RezLight)', 'Reject pending import'],
  ['POST', '/api/admin/integrations/economy/run-now', 'Economy (RezLight)', 'Enqueue one-off sync job'],
  ['GET', '/api/admin/integrations/economy/runs', 'Economy (RezLight)', 'List recent sync runs'],
  ['GET', '/api/admin/integrations/economy/status', 'Economy (RezLight)', 'Integration health summary'],
  ['POST', '/api/admin/integrations/economy/test-auth', 'Economy (RezLight)', 'Live auth probe'],

  // ── Employee App ──────────────────────────────────────────────────────────
  ['GET', '/api/employee-app/dashboard', 'Employee App', 'Get employee dashboard'],

  // ── Fees & Rates ──────────────────────────────────────────────────────────
  ['GET', '/api/fees', 'Fees & Rates', 'List fees'],
  ['POST', '/api/fees', 'Fees & Rates', 'Create fee'],
  ['DELETE', '/api/fees/{id}', 'Fees & Rates', 'Delete fee'],
  ['PATCH', '/api/fees/{id}', 'Fees & Rates', 'Update fee'],
  ['GET', '/api/settings/fee-rates', 'Fees & Rates', 'List fee rates for scope'],
  ['PUT', '/api/settings/fee-rates', 'Fees & Rates', 'Bulk upsert fee rates'],
  ['DELETE', '/api/settings/fee-rates/{feeType}', 'Fees & Rates', 'Delete fee-rate override'],
  ['GET', '/api/settings/fee-rates/audit', 'Fees & Rates', 'Fee-rate audit log'],
  ['GET', '/api/settings/fee-rates/effective', 'Fees & Rates', 'Get effective merged fee rates'],
  ['GET', '/api/settings/fee-rates/locations-with-overrides', 'Fees & Rates', 'Locations with fee-rate overrides'],

  // ── Host App ──────────────────────────────────────────────────────────────
  ['GET', '/api/host-app/access', 'Host App', 'Get host app access'],
  ['DELETE', '/api/host-app/availability/{id}', 'Host App', 'Delete host availability'],
  ['PATCH', '/api/host-app/availability/{id}', 'Host App', 'Update host availability'],
  ['GET', '/api/host-app/dashboard', 'Host App', 'Get host dashboard'],
  ['PATCH', '/api/host-app/listings/{id}', 'Host App', 'Update host listing'],
  ['GET', '/api/host-app/listings/{id}/availability', 'Host App', 'List host availability'],
  ['POST', '/api/host-app/listings/{id}/availability', 'Host App', 'Create host availability'],
  ['POST', '/api/host-app/listings/{id}/discovery-sync', 'Host App', 'Sync listing discovery'],
  ['GET', '/api/host-app/messages', 'Host App', 'List host conversations'],
  ['POST', '/api/host-app/messages', 'Host App', 'Create host conversation'],
  ['GET', '/api/host-app/messages/{id}', 'Host App', 'Get host conversation'],
  ['POST', '/api/host-app/messages/{id}/messages', 'Host App', 'Send host message'],
  ['POST', '/api/host-app/messages/{id}/read', 'Host App', 'Mark host conversation read'],
  ['POST', '/api/host-app/pickup-spots', 'Host App', 'Create pickup spot'],
  ['PATCH', '/api/host-app/pickup-spots/{id}', 'Host App', 'Update pickup spot'],
  ['PATCH', '/api/host-app/search-places/{id}', 'Host App', 'Update host search place'],
  ['PATCH', '/api/host-app/service-areas/{id}', 'Host App', 'Update host service area'],
  ['PATCH', '/api/host-app/trips/{id}/fulfillment-plan', 'Host App', 'Update trip fulfillment plan'],
  ['POST', '/api/host-app/trips/{id}/incidents', 'Host App', 'Create host trip incident'],
  ['PATCH', '/api/host-app/trips/{id}/status', 'Host App', 'Update host trip status'],
  ['POST', '/api/host-app/vehicle-submissions', 'Host App', 'Create vehicle submission'],

  // ── Incident Reports ──────────────────────────────────────────────────────
  ['GET', '/api/incident-reports', 'Incident Reports', 'Get incident reports'], // TODO(describe)
  ['POST', '/api/incident-reports/{id}/email', 'Incident Reports', 'Create or run email'], // TODO(describe)
  ['GET', '/api/incident-reports/{id}/print', 'Incident Reports', 'Get print'], // TODO(describe)

  // ── Incidents ─────────────────────────────────────────────────────────────
  ['GET', '/api/incident-reports/{id}', 'Incidents', 'Get incident report'],
  ['PATCH', '/api/incident-reports/{id}', 'Incidents', 'Update incident report'],
  ['POST', '/api/incident-reports/{id}/certify', 'Incidents', 'Certify and issue incident report'],
  ['POST', '/api/incident-reports/{id}/clauses', 'Incidents', 'Set incident report clauses'],
  ['POST', '/api/incident-reports/{id}/evidence', 'Incidents', 'Add incident evidence'],
  ['DELETE', '/api/incident-reports/{id}/evidence/{evidenceId}', 'Incidents', 'Remove incident evidence'],
  ['PATCH', '/api/incident-reports/{id}/evidence/{evidenceId}', 'Incidents', 'Update incident evidence'],
  ['POST', '/api/incident-reports/{id}/evidence/pull', 'Incidents', 'Pull inspection evidence'],
  ['POST', '/api/incident-reports/{id}/revise', 'Incidents', 'Revise incident report'],
  ['POST', '/api/incident-reports/{id}/status', 'Incidents', 'Set incident report status'],
  ['GET', '/api/incident-reports/clauses', 'Incidents', 'List incident clause library'],
  ['POST', '/api/incident-reports/clauses', 'Incidents', 'Create incident clause'],
  ['DELETE', '/api/incident-reports/clauses/{id}', 'Incidents', 'Delete incident clause'],
  ['PATCH', '/api/incident-reports/clauses/{id}', 'Incidents', 'Update incident clause'],
  ['POST', '/api/incident-reports/clauses/seed', 'Incidents', 'Seed default incident clauses'],
  ['GET', '/api/incident-reports/reservations/{reservationId}', 'Incidents', 'List incident reports for reservation'],
  ['POST', '/api/incident-reports/reservations/{reservationId}', 'Incidents', 'Create incident report for reservation'],

  // ── Inspections ───────────────────────────────────────────────────────────
  ['GET', '/api/customer-inspections', 'Inspections', 'List customer inspections'],
  ['GET', '/api/customer-inspections/{id}', 'Inspections', 'Get customer inspection detail'],
  ['POST', '/api/customer-inspections/{id}/reports/{reportId}/review', 'Inspections', 'Review damage report'],
  ['POST', '/api/customer-inspections/reports/{reportId}/fix', 'Inspections', 'Mark damage report fixed'],
  ['GET', '/api/customer-inspections/vehicle/{vehicleId}', 'Inspections', 'Vehicle damage history'],
  ['POST', '/api/customer-inspections/vehicle/{vehicleId}/manual-damage', 'Inspections', 'Manually record an existing damage'],

  // ── Internal ──────────────────────────────────────────────────────────────
  ['POST', '/api/internal/citations/ingest', 'Internal', 'Create or run citations ingest'], // TODO(describe)
  ['GET', '/api/internal/citations/plates', 'Internal', 'Get citations plates'], // TODO(describe)
  ['GET', '/api/internal/fleet', 'Internal', 'Get fleet'], // TODO(describe)
  ['POST', '/api/internal/pricing-engine/run', 'Internal', 'Create or run pricing engine run'], // TODO(describe)
  ['POST', '/api/internal/tolls/ingest', 'Internal', 'Create or run tolls ingest'], // TODO(describe)

  // ── Inventory ─────────────────────────────────────────────────────────────
  ['POST', '/api/inventory/reconciliation/{flagId}/resolve', 'Inventory', 'Resolve reconciliation flag'],
  ['GET', '/api/inventory/reconciliation/open', 'Inventory', 'List open reconciliation flags'],
  ['GET', '/api/inventory/reports', 'Inventory', 'List inventory reports'],
  ['GET', '/api/inventory/reports/{id}/download', 'Inventory', 'Get reports download'], // TODO(describe)
  ['POST', '/api/inventory/session', 'Inventory', 'Start or resume inventory session'],
  ['GET', '/api/inventory/session/{id}', 'Inventory', 'Get inventory session'],
  ['POST', '/api/inventory/session/{id}/complete', 'Inventory', 'Complete inventory session'],
  ['POST', '/api/inventory/session/{id}/items/{itemId}/confirm', 'Inventory', 'Confirm inventory item'],
  ['POST', '/api/inventory/session/{id}/items/{itemId}/exception', 'Inventory', 'Mark inventory item exception'],
  ['POST', '/api/inventory/session/{id}/items/{itemId}/maintenance-note', 'Inventory', 'Add item maintenance note'],
  ['POST', '/api/inventory/session/{id}/items/{itemId}/resolve-mismatch', 'Inventory', 'Resolve item mismatch'],
  ['GET', '/api/inventory/session/active', 'Inventory', 'Get active inventory session'],

  // ── Issue Center ──────────────────────────────────────────────────────────
  ['GET', '/api/issue-center/dashboard', 'Issue Center', 'Get dashboard'], // TODO(describe)
  ['POST', '/api/issue-center/incidents', 'Issue Center', 'Create or run incidents'], // TODO(describe)
  ['PATCH', '/api/issue-center/incidents/{id}', 'Issue Center', 'Update incident'],
  ['POST', '/api/issue-center/incidents/{id}/actions', 'Issue Center', 'Apply incident workflow action'],
  ['POST', '/api/issue-center/incidents/{id}/charge-card-on-file', 'Issue Center', 'Charge incident card on file'],
  ['POST', '/api/issue-center/incidents/{id}/charge-draft', 'Issue Center', 'Create incident charge draft'],
  ['GET', '/api/issue-center/incidents/{id}/packet-print', 'Issue Center', 'Get incidents packet print'], // TODO(describe)
  ['GET', '/api/issue-center/incidents/{id}/packet.txt', 'Issue Center', 'Get incidents packet.txt'], // TODO(describe)
  ['POST', '/api/issue-center/incidents/{id}/request-info', 'Issue Center', 'Request more info on incident'],
  ['POST', '/api/issue-center/vehicle-submissions/{id}/approve', 'Issue Center', 'Approve vehicle submission'],
  ['POST', '/api/issue-center/vehicle-submissions/{id}/request-info', 'Issue Center', 'Request info on vehicle submission'],

  // ── Kiosk ─────────────────────────────────────────────────────────────────
  ['GET', '/api/kiosk/admin/sessions/{kioskSessionId}/assist-view', 'Kiosk', 'Get admin sessions assist view'], // TODO(describe)
  ['POST', '/api/kiosk/admin/sessions/{kioskSessionId}/remote-assist/confirm-name', 'Kiosk', 'Create or run admin sessions remote assist confirm name'], // TODO(describe)
  ['POST', '/api/kiosk/admin/sessions/{kioskSessionId}/remote-assist/unlock', 'Kiosk', 'Create or run admin sessions remote assist unlock'], // TODO(describe)
  ['POST', '/api/kiosk/admin/sessions/{kioskSessionId}/remote-assist/verify-id', 'Kiosk', 'Create or run admin sessions remote assist verify id'], // TODO(describe)
  ['GET', '/api/kiosk/device', 'Kiosk', 'Get device'], // TODO(describe)
  ['GET', '/api/kiosk/devices', 'Kiosk', 'Get devices'], // TODO(describe)
  ['POST', '/api/kiosk/devices', 'Kiosk', 'Create or run devices'], // TODO(describe)
  ['PATCH', '/api/kiosk/devices/{id}', 'Kiosk', 'Update devices'], // TODO(describe)
  ['POST', '/api/kiosk/devices/{id}/pairing-code', 'Kiosk', 'Create or run devices pairing code'], // TODO(describe)
  ['POST', '/api/kiosk/devices/{id}/revoke', 'Kiosk', 'Create or run devices revoke'], // TODO(describe)
  ['POST', '/api/kiosk/devices/{id}/rotate', 'Kiosk', 'Create or run devices rotate'], // TODO(describe)
  ['GET', '/api/kiosk/key-handoff', 'Kiosk', 'Get key handoff'], // TODO(describe)
  ['PUT', '/api/kiosk/key-handoff', 'Kiosk', 'Replace key handoff'], // TODO(describe)
  ['GET', '/api/kiosk/packages', 'Kiosk', 'Get packages'], // TODO(describe)
  ['PUT', '/api/kiosk/packages', 'Kiosk', 'Replace packages'], // TODO(describe)
  ['POST', '/api/kiosk/pair', 'Kiosk', 'Create or run pair'], // TODO(describe)
  ['GET', '/api/kiosk/payment-return', 'Kiosk', 'Get payment return'], // TODO(describe)
  ['GET', '/api/kiosk/sessions', 'Kiosk', 'Get sessions'], // TODO(describe)
  ['POST', '/api/kiosk/sessions', 'Kiosk', 'Create or run sessions'], // TODO(describe)
  ['GET', '/api/kiosk/sessions/{id}/agreement', 'Kiosk', 'Get sessions agreement'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/assign-vehicle', 'Kiosk', 'Create or run sessions assign vehicle'], // TODO(describe)
  ['GET', '/api/kiosk/sessions/{id}/assist-state', 'Kiosk', 'Get sessions assist state'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/attach-reservation', 'Kiosk', 'Create or run sessions attach reservation'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/complete', 'Kiosk', 'Create or run sessions complete'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/escalate', 'Kiosk', 'Create or run sessions escalate'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/events', 'Kiosk', 'Create or run sessions events'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/id-photo-extract', 'Kiosk', 'Create or run sessions id photo extract'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/lookup', 'Kiosk', 'Create or run sessions lookup'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/name-update/confirm', 'Kiosk', 'Create or run sessions name update confirm'], // TODO(describe)
  ['GET', '/api/kiosk/sessions/{id}/name-update/destinations', 'Kiosk', 'Get sessions name update destinations'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/name-update/send-code', 'Kiosk', 'Create or run sessions name update send code'], // TODO(describe)
  ['GET', '/api/kiosk/sessions/{id}/offers', 'Kiosk', 'Get sessions offers'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/offers', 'Kiosk', 'Create or run sessions offers'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/payment-link', 'Kiosk', 'Create or run sessions payment link'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/sandbox-payment', 'Kiosk', 'Create or run sessions sandbox payment'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/sign', 'Kiosk', 'Create or run sessions sign'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/staff-assist/confirm-name', 'Kiosk', 'Create or run sessions staff assist confirm name'], // TODO(describe)
  ['GET', '/api/kiosk/sessions/{id}/staff-assist/staff', 'Kiosk', 'Get sessions staff assist staff'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/staff-assist/unlock', 'Kiosk', 'Create or run sessions staff assist unlock'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/staff-assist/verify-id', 'Kiosk', 'Create or run sessions staff assist verify id'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/verify-id', 'Kiosk', 'Create or run sessions verify id'], // TODO(describe)
  ['POST', '/api/kiosk/sessions/{id}/vozia-conversation', 'Kiosk', 'Create or run sessions vozia conversation'], // TODO(describe)
  ['GET', '/api/kiosk/upsell-rules', 'Kiosk', 'Get upsell rules'], // TODO(describe)
  ['PUT', '/api/kiosk/upsell-rules', 'Kiosk', 'Replace upsell rules'], // TODO(describe)
  ['GET', '/api/kiosk/vozia-config', 'Kiosk', 'Get vozia config'], // TODO(describe)
  ['PUT', '/api/kiosk/vozia-config', 'Kiosk', 'Replace vozia config'], // TODO(describe)

  // ── Knowledge Base ────────────────────────────────────────────────────────
  ['GET', '/api/knowledge-base', 'Knowledge Base', 'List knowledge base articles'],
  ['POST', '/api/knowledge-base', 'Knowledge Base', 'Create article'],
  ['DELETE', '/api/knowledge-base/{id}', 'Knowledge Base', 'Delete article'],
  ['PATCH', '/api/knowledge-base/{id}', 'Knowledge Base', 'Update article'],
  ['POST', '/api/knowledge-base/{id}/helpful', 'Knowledge Base', 'Mark article helpful'],
  ['GET', '/api/knowledge-base/article/{slug}', 'Knowledge Base', 'Get article by slug'],
  ['GET', '/api/knowledge-base/categories', 'Knowledge Base', 'List knowledge base categories'],
  ['POST', '/api/knowledge-base/seed', 'Knowledge Base', 'Seed default articles'],

  // ── Locations ─────────────────────────────────────────────────────────────
  ['GET', '/api/locations/{id}/clauses', 'Locations', 'This branch\'s rental-agreement clause overrides'],
  ['PUT', '/api/locations/{id}/clauses', 'Locations', 'Replace this branch\'s clause overrides (audited, ADMIN only)'],
  ['GET', '/api/locations/{id}/documents', 'Locations', 'Get documents'], // TODO(describe)
  ['POST', '/api/locations/{id}/documents', 'Locations', 'Create or run documents'], // TODO(describe)
  ['GET', '/api/locations/{id}/hours', 'Locations', 'Get hours'], // TODO(describe)
  ['DELETE', '/api/locations/documents/{docId}', 'Locations', 'Delete documents'], // TODO(describe)
  ['PATCH', '/api/locations/documents/{docId}', 'Locations', 'Update documents'], // TODO(describe)
  ['GET', '/api/locations/documents/{docId}/url', 'Locations', 'Get documents url'], // TODO(describe)
  ['GET', '/api/locations/documents/expiring', 'Locations', 'Get documents expiring'], // TODO(describe)
  ['GET', '/api/locations/selectable', 'Locations', 'Get selectable'], // TODO(describe)

  // ── Long-Term Rentals ─────────────────────────────────────────────────────
  ['POST', '/api/long-term/cycles/{cycleId}/mark-paid', 'Long-Term Rentals', 'Mark billing cycle paid'],
  ['GET', '/api/long-term/plans', 'Long-Term Rentals', 'List long-term plans'],
  ['PATCH', '/api/long-term/plans/{planId}', 'Long-Term Rentals', 'Update long-term plan'],
  ['POST', '/api/long-term/plans/{planId}/close-cycle', 'Long-Term Rentals', 'Close next billing cycle'],
  ['GET', '/api/long-term/reservations/{reservationId}/plan', 'Long-Term Rentals', 'Get plan by reservation'],
  ['POST', '/api/long-term/reservations/{reservationId}/plan', 'Long-Term Rentals', 'Attach plan to reservation'],

  // ── Maintenance ───────────────────────────────────────────────────────────
  ['GET', '/api/maintenance/board', 'Maintenance', 'Maintenance work-item board'],
  ['POST', '/api/maintenance/checkin-decisions/{id}/retry', 'Maintenance', 'Create or run checkin decisions retry'], // TODO(describe)
  ['GET', '/api/maintenance/due', 'Maintenance', 'Service intervals due/overdue'],
  ['GET', '/api/maintenance/summary', 'Maintenance', 'Maintenance hub KPIs'],
  ['GET', '/api/maintenance/vehicles/{vehicleId}/schedules', 'Maintenance', 'List service schedules'],
  ['PUT', '/api/maintenance/vehicles/{vehicleId}/schedules', 'Maintenance', 'Upsert a service schedule'],
  ['DELETE', '/api/maintenance/vehicles/{vehicleId}/schedules/{serviceType}', 'Maintenance', 'Delete a service schedule'],
  ['POST', '/api/maintenance/vehicles/{vehicleId}/schedules/{serviceType}/log-service', 'Maintenance', 'Create or run vehicles schedules log service'], // TODO(describe)
  ['POST', '/api/maintenance/vehicles/{vehicleId}/snooze/consume', 'Maintenance', 'Create or run vehicles snooze consume'], // TODO(describe)
  ['GET', '/api/repair-orders', 'Maintenance', 'List repair orders'],
  ['POST', '/api/repair-orders', 'Maintenance', 'Create a repair order'],
  ['GET', '/api/repair-orders/{id}', 'Maintenance', 'Repair order detail'],
  ['PATCH', '/api/repair-orders/{id}', 'Maintenance', 'Update a repair order'],
  ['POST', '/api/repair-orders/{id}/cancel', 'Maintenance', 'Cancel a repair order'],
  ['POST', '/api/repair-orders/{id}/complete', 'Maintenance', 'Complete a repair order (damages → FIXED)'],
  ['POST', '/api/repair-orders/{id}/lines', 'Maintenance', 'Add a repair order line'],
  ['DELETE', '/api/repair-orders/{id}/lines/{lineId}', 'Maintenance', 'Delete a repair order line'],
  ['POST', '/api/repair-orders/from-damage', 'Maintenance', 'Roll damages into a repair order'],
  ['GET', '/api/repair-orders/vehicle/{vehicleId}', 'Maintenance', 'Repair order history for a vehicle'],

  // ── Market ────────────────────────────────────────────────────────────────
  ['GET', '/api/market/airports', 'Market', 'Get airports'], // TODO(describe)
  ['GET', '/api/market/export.xlsx', 'Market', 'Get export.xlsx'], // TODO(describe)
  ['GET', '/api/market/providers', 'Market', 'Get providers'], // TODO(describe)

  // ── Market Intelligence ───────────────────────────────────────────────────
  ['POST', '/api/market-onboarding/airports', 'Market Intelligence', 'Create scrape profile trio'],
  ['POST', '/api/market-onboarding/apply', 'Market Intelligence', 'Create rates and pricing rule'],
  ['POST', '/api/market-onboarding/discovery', 'Market Intelligence', 'Discover distinct SIPPs'],
  ['GET', '/api/market-onboarding/state', 'Market Intelligence', 'Onboarding wizard snapshot'],
  ['GET', '/api/market-scraper/profiles', 'Market Intelligence', 'List scrape profiles'],
  ['POST', '/api/market-scraper/profiles', 'Market Intelligence', 'Create scrape profile'],
  ['DELETE', '/api/market-scraper/profiles/{id}', 'Market Intelligence', 'Delete scrape profile'],
  ['GET', '/api/market-scraper/profiles/{id}', 'Market Intelligence', 'Get scrape profile'],
  ['PATCH', '/api/market-scraper/profiles/{id}', 'Market Intelligence', 'Update scrape profile'],
  ['GET', '/api/market-scraper/profiles/{id}/observations', 'Market Intelligence', 'List profile observations'],
  ['GET', '/api/market-scraper/profiles/{id}/runs', 'Market Intelligence', 'List runs for profile'],
  ['GET', '/api/market-scraper/runs/{runId}', 'Market Intelligence', 'Get scrape run detail'],
  ['POST', '/api/market-scraper/runs/{runId}/apply', 'Market Intelligence', 'Apply run suggestions to prices'],
  ['GET', '/api/market-scraper/runs/{runId}/cheapest', 'Market Intelligence', 'Cheapest per date and SIPP'],
  ['GET', '/api/market-scraper/runs/{runId}/comparison', 'Market Intelligence', 'Compare run vs current prices'],
  ['GET', '/api/market/history', 'Market Intelligence', 'Price history by airport and SIPP'],
  ['GET', '/api/market/summary', 'Market Intelligence', 'Market summary for airport'],
  ['POST', '/api/pricing-rules', 'Market Intelligence', 'Upsert pricing rule'],
  ['DELETE', '/api/pricing-rules/{id}', 'Market Intelligence', 'Delete pricing rule'],
  ['PATCH', '/api/pricing-rules/{id}', 'Market Intelligence', 'Update pricing rule'],
  ['POST', '/api/pricing-rules/{id}/preview', 'Market Intelligence', 'Preview pricing rule dry-run'],
  ['GET', '/api/pricing-rules/by-rate/{rateId}', 'Market Intelligence', 'Get pricing rule for rate'],
  ['GET', '/api/pricing-suggestions', 'Market Intelligence', 'Suggestion inbox feed'],
  ['GET', '/api/pricing-suggestions/{id}', 'Market Intelligence', 'Get pricing suggestion detail'],
  ['POST', '/api/pricing-suggestions/{id}/apply', 'Market Intelligence', 'Apply pricing suggestion'],
  ['POST', '/api/pricing-suggestions/{id}/reject', 'Market Intelligence', 'Reject pricing suggestion'],

  // ── Market Scraper ────────────────────────────────────────────────────────
  ['GET', '/api/market-scraper/profiles/{id}/targets', 'Market Scraper', 'Get profiles targets'], // TODO(describe)
  ['POST', '/api/market-scraper/profiles/{id}/targets', 'Market Scraper', 'Create or run profiles targets'], // TODO(describe)
  ['GET', '/api/market-scraper/runs/{runId}/export.xlsx', 'Market Scraper', 'Get runs export.xlsx'], // TODO(describe)
  ['GET', '/api/market-scraper/self-check', 'Market Scraper', 'Get self check'], // TODO(describe)
  ['DELETE', '/api/market-scraper/targets/{targetId}', 'Market Scraper', 'Delete targets'], // TODO(describe)
  ['PATCH', '/api/market-scraper/targets/{targetId}', 'Market Scraper', 'Update targets'], // TODO(describe)

  // ── Mobile Inspection ─────────────────────────────────────────────────────
  ['GET', '/api/mobile-inspection/{token}', 'Mobile Inspection', 'Get mobile inspection'], // TODO(describe)
  ['POST', '/api/mobile-inspection/{token}/complete', 'Mobile Inspection', 'Create or run complete'], // TODO(describe)
  ['POST', '/api/mobile-inspection/{token}/photo', 'Mobile Inspection', 'Create or run photo'], // TODO(describe)

  // ── Notifications ─────────────────────────────────────────────────────────
  ['GET', '/api/notifications', 'Notifications', 'Get notifications'], // TODO(describe)
  ['POST', '/api/notifications/{id}/acknowledge', 'Notifications', 'Create or run acknowledge'], // TODO(describe)
  ['POST', '/api/notifications/{id}/read', 'Notifications', 'Create or run read'], // TODO(describe)
  ['POST', '/api/notifications/read-all', 'Notifications', 'Create or run read all'], // TODO(describe)
  ['GET', '/api/notifications/unread-count', 'Notifications', 'Get unread count'], // TODO(describe)

  // ── OneStepGPS ────────────────────────────────────────────────────────────
  ['DELETE', '/api/admin/integrations/onestepgps/credentials', 'OneStepGPS', 'Clear the stored API key'],
  ['POST', '/api/admin/integrations/onestepgps/credentials', 'OneStepGPS', 'Set/rotate the API key (encrypted; never returned)'],
  ['GET', '/api/admin/integrations/onestepgps/device-mappings', 'OneStepGPS', 'List device→vehicle mappings'],
  ['POST', '/api/admin/integrations/onestepgps/device-mappings', 'OneStepGPS', 'Upsert a device→vehicle mapping'],
  ['DELETE', '/api/admin/integrations/onestepgps/device-mappings/{id}', 'OneStepGPS', 'Deactivate a mapping'],
  ['GET', '/api/admin/integrations/onestepgps/devices', 'OneStepGPS', 'Live device list with mapped vehicle ids'],
  ['GET', '/api/admin/integrations/onestepgps/status', 'OneStepGPS', 'Connector status (hasApiKey/lastTest; key never returned)'],
  ['POST', '/api/admin/integrations/onestepgps/test-connection', 'OneStepGPS', 'Live device-info probe (ok + device count)'],

  // ── Partnerships ──────────────────────────────────────────────────────────
  ['GET', '/api/partnerships', 'Partnerships', 'Get partnerships'], // TODO(describe)
  ['POST', '/api/partnerships', 'Partnerships', 'Create or run partnerships'], // TODO(describe)
  ['GET', '/api/partnerships/{id}', 'Partnerships', 'Get partnerships'], // TODO(describe)
  ['PATCH', '/api/partnerships/{id}', 'Partnerships', 'Update partnerships'], // TODO(describe)
  ['GET', '/api/partnerships/{id}/hosted', 'Partnerships', 'Get hosted'], // TODO(describe)
  ['POST', '/api/partnerships/{id}/logo', 'Partnerships', 'Create or run logo'], // TODO(describe)
  ['GET', '/api/partnerships/{id}/pricing-grid', 'Partnerships', 'Get pricing grid'], // TODO(describe)
  ['DELETE', '/api/partnerships/{id}/rate', 'Partnerships', 'Delete rate'], // TODO(describe)
  ['POST', '/api/partnerships/{id}/rate', 'Partnerships', 'Create or run rate'], // TODO(describe)
  ['PUT', '/api/partnerships/{id}/rate/items', 'Partnerships', 'Replace rate items'], // TODO(describe)
  ['GET', '/api/partnerships/{id}/reservations', 'Partnerships', 'Get reservations'], // TODO(describe)
  ['PUT', '/api/partnerships/{id}/services', 'Partnerships', 'Replace services'], // TODO(describe)
  ['POST', '/api/partnerships/{id}/services/custom', 'Partnerships', 'Create or run services custom'], // TODO(describe)
  ['POST', '/api/partnerships/{id}/status', 'Partnerships', 'Create or run status'], // TODO(describe)
  ['GET', '/api/partnerships/settings', 'Partnerships', 'Get settings'], // TODO(describe)
  ['PUT', '/api/partnerships/settings', 'Partnerships', 'Replace settings'], // TODO(describe)
  ['GET', '/api/partnerships/summary', 'Partnerships', 'Get summary'], // TODO(describe)

  // ── Payment Gateway ───────────────────────────────────────────────────────
  ['POST', '/api/payment-gateway/auth-hold', 'Payment Gateway', 'Authorize security deposit hold'],
  ['POST', '/api/payment-gateway/callback', 'Payment Gateway', 'Create or run callback'], // TODO(describe)
  ['POST', '/api/payment-gateway/capture', 'Payment Gateway', 'Capture a hold'],
  ['POST', '/api/payment-gateway/charge', 'Payment Gateway', 'Charge a reservation'],
  ['GET', '/api/payment-gateway/ops-queue', 'Payment Gateway', 'Get ops queue'], // TODO(describe)
  ['POST', '/api/payment-gateway/ops-queue/{id}/resolve', 'Payment Gateway', 'Create or run ops queue resolve'], // TODO(describe)
  ['POST', '/api/payment-gateway/refund', 'Payment Gateway', 'Refund a transaction'],
  ['POST', '/api/payment-gateway/settle', 'Payment Gateway', 'Settle batch'],
  ['GET', '/api/payment-gateway/summary', 'Payment Gateway', 'Payment gateway summary report'],
  ['GET', '/api/payment-gateway/terminal-status', 'Payment Gateway', 'Get terminal status'],
  ['POST', '/api/payment-gateway/tokenize', 'Payment Gateway', 'Tokenize card on file'],
  ['POST', '/api/payment-gateway/void', 'Payment Gateway', 'Void a transaction'],

  // ── People ────────────────────────────────────────────────────────────────
  ['GET', '/api/people', 'People', 'List people'],
  ['POST', '/api/people', 'People', 'Create person'],
  ['PATCH', '/api/people/{personId}', 'People', 'Update person'],
  ['POST', '/api/people/{userId}/reset-password', 'People', 'Reset user password'],

  // ── Planner ───────────────────────────────────────────────────────────────
  ['POST', '/api/planner/apply-plan', 'Planner', 'Apply planner scenario actions'],
  ['POST', '/api/planner/assign', 'Planner', 'Create or run assign'], // TODO(describe)
  ['POST', '/api/planner/copilot', 'Planner', 'Planner copilot advise'],
  ['GET', '/api/planner/copilot-config', 'Planner', 'Get planner copilot config'],
  ['GET', '/api/planner/rules', 'Planner', 'Get planner rule set'],
  ['PUT', '/api/planner/rules', 'Planner', 'Upsert planner rule set'],
  ['POST', '/api/planner/simulate-auto-accommodate', 'Planner', 'Simulate auto-accommodate scenario'],
  ['POST', '/api/planner/simulate-maintenance', 'Planner', 'Simulate maintenance scenario'],
  ['POST', '/api/planner/simulate-wash-plan', 'Planner', 'Simulate wash plan scenario'],
  ['GET', '/api/planner/snapshot', 'Planner', 'Get planner snapshot'],
  ['POST', '/api/planner/suggest', 'Planner', 'Create or run suggest'], // TODO(describe)

  // ── Public ────────────────────────────────────────────────────────────────
  ['GET', '/api/public/addendum-signature/{token}', 'Public', 'Get addendum signature'], // TODO(describe)
  ['POST', '/api/public/addendum-signature/{token}/signature', 'Public', 'Create or run addendum signature signature'], // TODO(describe)
  ['POST', '/api/public/billing/authorizenet/webhook', 'Public', 'Create or run billing authorizenet webhook'], // TODO(describe)
  ['GET', '/api/public/billing/autopay/{token}', 'Public', 'Get billing autopay'], // TODO(describe)
  ['POST', '/api/public/billing/autopay/{token}/return', 'Public', 'Create or run billing autopay return'], // TODO(describe)
  ['POST', '/api/public/billing/autopay/{token}/start', 'Public', 'Create or run billing autopay start'], // TODO(describe)
  ['POST', '/api/public/booking/{reservationRef}/documents', 'Public', 'Create or run booking documents'], // TODO(describe)
  ['POST', '/api/public/booking/account/delete-confirm/{token}', 'Public', 'Create or run booking account delete confirm'], // TODO(describe)
  ['POST', '/api/public/booking/account/delete-request', 'Public', 'Create or run booking account delete request'], // TODO(describe)
  ['GET', '/api/public/booking/additional-services', 'Public', 'Get booking additional services'], // TODO(describe)
  ['POST', '/api/public/booking/ai-search/intent', 'Public', 'Extract search intent from a natural-language query'],
  ['GET', '/api/public/booking/bootstrap', 'Public', 'Get booking bootstrap'], // TODO(describe)
  ['POST', '/api/public/booking/cancel', 'Public', 'Create or run booking cancel'], // TODO(describe)
  ['POST', '/api/public/booking/car-sharing-search', 'Public', 'Create or run booking car sharing search'], // TODO(describe)
  ['POST', '/api/public/booking/checkout', 'Public', 'Create or run booking checkout'], // TODO(describe)
  ['POST', '/api/public/booking/contact', 'Public', 'Create or run booking contact'], // TODO(describe)
  ['GET', '/api/public/booking/guest-signin/{token}', 'Public', 'Get booking guest signin'], // TODO(describe)
  ['POST', '/api/public/booking/guest-signin/request', 'Public', 'Create or run booking guest signin request'], // TODO(describe)
  ['POST', '/api/public/booking/guest-signin/verify', 'Public', 'Create or run booking guest signin verify'], // TODO(describe)
  ['POST', '/api/public/booking/guest-signup', 'Public', 'Create or run booking guest signup'], // TODO(describe)
  ['GET', '/api/public/booking/host-reviews/{token}', 'Public', 'Get booking host reviews'], // TODO(describe)
  ['POST', '/api/public/booking/host-reviews/{token}', 'Public', 'Create or run booking host reviews'], // TODO(describe)
  ['POST', '/api/public/booking/host-signup', 'Public', 'Create or run booking host signup'], // TODO(describe)
  ['GET', '/api/public/booking/hosts/{id}', 'Public', 'Get booking hosts'], // TODO(describe)
  ['GET', '/api/public/booking/insurance-plans', 'Public', 'Get booking insurance plans'], // TODO(describe)
  ['POST', '/api/public/booking/issues', 'Public', 'Create or run booking issues'], // TODO(describe)
  ['POST', '/api/public/booking/lookup', 'Public', 'Create or run booking lookup'], // TODO(describe)
  ['POST', '/api/public/booking/messages/{id}/messages', 'Public', 'Send a guest message'],
  ['POST', '/api/public/booking/messages/{id}/read', 'Public', 'Mark a guest conversation read'],
  ['POST', '/api/public/booking/messages/conversation', 'Public', 'Start a guest conversation'],
  ['POST', '/api/public/booking/messages/list', 'Public', 'List the guest\'s conversations'],
  ['GET', '/api/public/booking/partners/{slug}', 'Public', 'Get booking partners'], // TODO(describe)
  ['POST', '/api/public/booking/payment-gateway/payarc/webhook', 'Public', 'Create or run booking payment gateway payarc webhook'], // TODO(describe)
  ['GET', '/api/public/booking/policies', 'Public', 'Get booking policies'], // TODO(describe)
  ['GET', '/api/public/booking/rental-agreements/{token}', 'Public', 'Get booking rental agreements'], // TODO(describe)
  ['POST', '/api/public/booking/rental-agreements/{token}/signature', 'Public', 'Create or run booking rental agreements signature'], // TODO(describe)
  ['POST', '/api/public/booking/rental-search', 'Public', 'Create or run booking rental search'], // TODO(describe)
  ['GET', '/api/public/booking/trip-chat/{token}', 'Public', 'Open a trip chat room by token'],
  ['POST', '/api/public/booking/trip-chat/{token}/action', 'Public', 'Hot action button - arrived, running late, and the like'],
  ['POST', '/api/public/booking/trip-chat/{token}/block', 'Public', 'Block or mute the other party'],
  ['POST', '/api/public/booking/trip-chat/{token}/image', 'Public', 'Send an image or file in the trip chat'],
  ['POST', '/api/public/booking/trip-chat/{token}/messages', 'Public', 'Send a trip-chat message'],
  ['POST', '/api/public/booking/trip-chat/{token}/notify', 'Public', 'Email the other party about unread messages'],
  ['PATCH', '/api/public/booking/trip-chat/{token}/pickup', 'Public', 'Update pickup details (host token only)'],
  ['POST', '/api/public/booking/trip-chat/{token}/read', 'Public', 'Mark the trip chat read'],
  ['POST', '/api/public/booking/trip-chat/{token}/report-issue', 'Public', 'Report a trip-chat issue with transcript (host only)'],
  ['GET', '/api/public/booking/trip-chat/{token}/stream', 'Public', 'Server-sent event stream of trip-chat updates'],
  ['POST', '/api/public/booking/trip-chat/{token}/template', 'Public', 'Send a templated host message'],
  ['GET', '/api/public/booking/trip-chat/{token}/templates', 'Public', 'Host message templates'],
  ['POST', '/api/public/booking/trip-chat/{token}/typing', 'Public', 'Typing indicator'],
  ['POST', '/api/public/booking/trips/{tripCode}/cancel', 'Public', 'Create or run booking trips cancel'], // TODO(describe)
  ['GET', '/api/public/booking/trips/{tripCode}/documents', 'Public', 'Get booking trips documents'], // TODO(describe)
  ['POST', '/api/public/booking/trips/{tripCode}/documents', 'Public', 'Create or run booking trips documents'], // TODO(describe)
  ['POST', '/api/public/booking/trips/{tripCode}/inspection-photos', 'Public', 'Create or run booking trips inspection photos'], // TODO(describe)
  ['GET', '/api/public/booking/trips/{tripCode}/payarc-bridge', 'Public', 'Get booking trips payarc bridge'], // TODO(describe)
  ['POST', '/api/public/booking/trips/{tripCode}/payarc-charge', 'Public', 'Create or run booking trips payarc charge'], // TODO(describe)
  ['GET', '/api/public/booking/trips/{tripCode}/payment-cancel', 'Public', 'Get booking trips payment cancel'], // TODO(describe)
  ['GET', '/api/public/booking/trips/{tripCode}/payment-return', 'Public', 'Get booking trips payment return'], // TODO(describe)
  ['POST', '/api/public/booking/trips/{tripCode}/payment-session', 'Public', 'Create or run booking trips payment session'], // TODO(describe)
  ['GET', '/api/public/booking/vehicle-classes', 'Public', 'Get booking vehicle classes'], // TODO(describe)
  ['GET', '/api/public/booking/vehicle-classes/{vehicleTypeId}', 'Public', 'Get booking vehicle classes'], // TODO(describe)
  ['GET', '/api/public/booking/website-fees', 'Public', 'Get booking website fees'], // TODO(describe)
  ['GET', '/api/public/checkout-handoff/{token}', 'Public', 'Get checkout handoff'], // TODO(describe)
  ['GET', '/api/public/customer-info/{token}', 'Public', 'Get customer info'], // TODO(describe)
  ['POST', '/api/public/customer-info/{token}', 'Public', 'Create or run customer info'], // TODO(describe)
  ['GET', '/api/public/document/{kind}/{token}/{asset}', 'Public', 'Get document'], // TODO(describe)
  ['GET', '/api/public/driver/{token}', 'Public', 'Get driver'], // TODO(describe)
  ['POST', '/api/public/driver/{token}/issues', 'Public', 'Create or run driver issues'], // TODO(describe)
  ['GET', '/api/public/driver/{token}/notifications', 'Public', 'Get driver notifications'], // TODO(describe)
  ['POST', '/api/public/driver/{token}/position', 'Public', 'Create or run driver position'], // TODO(describe)
  ['POST', '/api/public/driver/{token}/requests/{id}/no-show', 'Public', 'Create or run driver requests no show'], // TODO(describe)
  ['POST', '/api/public/driver/{token}/requests/{id}/picked-up', 'Public', 'Create or run driver requests picked up'], // TODO(describe)
  ['GET', '/api/public/issues/respond/{token}', 'Public', 'Get issues respond'], // TODO(describe)
  ['POST', '/api/public/issues/respond/{token}', 'Public', 'Create or run issues respond'], // TODO(describe)
  ['GET', '/api/public/loaner-portal/{token}', 'Public', 'Get loaner portal'], // TODO(describe)
  ['POST', '/api/public/loaner-portal/{token}/extend', 'Public', 'Create or run loaner portal extend'], // TODO(describe)
  ['POST', '/api/public/loaner-portal/{token}/schedule-return', 'Public', 'Create or run loaner portal schedule return'], // TODO(describe)
  ['GET', '/api/public/loaner-signature/{token}', 'Public', 'Get loaner signature'], // TODO(describe)
  ['POST', '/api/public/loaner-signature/{token}/signature', 'Public', 'Create or run loaner signature signature'], // TODO(describe)
  ['POST', '/api/public/loaner/lookup', 'Public', 'Create or run loaner lookup'], // TODO(describe)
  ['POST', '/api/public/loaner/request', 'Public', 'Create or run loaner request'], // TODO(describe)
  ['POST', '/api/public/loaner/reserve', 'Public', 'Create or run loaner reserve'], // TODO(describe)
  ['POST', '/api/public/payment-gateway/authorizenet/webhook', 'Public', 'Create or run payment gateway authorizenet webhook'], // TODO(describe)
  ['GET', '/api/public/payment/{token}', 'Public', 'Get payment'], // TODO(describe)
  ['GET', '/api/public/payment/{token}/confirm', 'Public', 'Get payment confirm'], // TODO(describe)
  ['POST', '/api/public/payment/{token}/confirm', 'Public', 'Create or run payment confirm'], // TODO(describe)
  ['POST', '/api/public/payment/{token}/create-session', 'Public', 'Create or run payment create session'], // TODO(describe)
  ['GET', '/api/public/self-return/{token}', 'Public', 'Get self return'], // TODO(describe)
  ['POST', '/api/public/self-return/{token}/submit', 'Public', 'Create or run self return submit'], // TODO(describe)
  ['POST', '/api/public/self-service/{kind}/{token}/confirm', 'Public', 'Create or run self service confirm'], // TODO(describe)
  ['GET', '/api/public/shuttle/{token}', 'Public', 'Get shuttle'], // TODO(describe)
  ['POST', '/api/public/shuttle/{token}/location', 'Public', 'Create or run shuttle location'], // TODO(describe)
  ['POST', '/api/public/shuttle/{token}/request', 'Public', 'Create or run shuttle request'], // TODO(describe)
  ['GET', '/api/public/signature/{token}', 'Public', 'Get signature'], // TODO(describe)
  ['POST', '/api/public/signature/{token}', 'Public', 'Create or run signature'], // TODO(describe)
  ['GET', '/api/public/store-board/{token}', 'Public', 'Get store board'], // TODO(describe)
  ['POST', '/api/public/telematics/zubie/{tenantId}/webhook', 'Public', 'Create or run telematics zubie webhook'], // TODO(describe)

  // ── Public Booking ────────────────────────────────────────────────────────
  ['GET', '/api/public/booking/host-status', 'Public Booking', 'Get host status'],

  // ── Quotes ────────────────────────────────────────────────────────────────
  ['GET', '/api/quotes', 'Quotes', 'Get quotes'], // TODO(describe)
  ['POST', '/api/quotes', 'Quotes', 'Create or run quotes'], // TODO(describe)
  ['GET', '/api/quotes/{id}', 'Quotes', 'Get quotes'], // TODO(describe)
  ['GET', '/api/quotes/{id}/add-on-options', 'Quotes', 'Get add on options'], // TODO(describe)
  ['PUT', '/api/quotes/{id}/add-ons', 'Quotes', 'Replace add ons'], // TODO(describe)
  ['POST', '/api/quotes/{id}/cancel', 'Quotes', 'Create or run cancel'], // TODO(describe)
  ['PATCH', '/api/quotes/{id}/contact', 'Quotes', 'Update contact'], // TODO(describe)
  ['POST', '/api/quotes/{id}/convert', 'Quotes', 'Create or run convert'], // TODO(describe)
  ['POST', '/api/quotes/{id}/requote', 'Quotes', 'Create or run requote'], // TODO(describe)
  ['GET', '/api/quotes/preview', 'Quotes', 'Get preview'], // TODO(describe)

  // ── Rates ─────────────────────────────────────────────────────────────────
  ['GET', '/api/rates/rental-minimum', 'Rates', 'Get rental minimum'], // TODO(describe)

  // ── Rental Agreements ─────────────────────────────────────────────────────
  ['GET', '/api/rental-agreements', 'Rental Agreements', 'Get rental agreements'], // TODO(describe)
  ['DELETE', '/api/rental-agreements/{id}', 'Rental Agreements', 'Delete rental agreements'], // TODO(describe)
  ['GET', '/api/rental-agreements/{id}', 'Rental Agreements', 'Get rental agreements'], // TODO(describe)
  ['GET', '/api/rental-agreements/{id}/addendums', 'Rental Agreements', 'List agreement addendums'],
  ['POST', '/api/rental-agreements/{id}/addendums', 'Rental Agreements', 'Create agreement addendum'],
  ['GET', '/api/rental-agreements/{id}/addendums/{addendumId}', 'Rental Agreements', 'Get agreement addendum'],
  ['POST', '/api/rental-agreements/{id}/addendums/{addendumId}/notify', 'Rental Agreements', 'Resend addendum signature email'],
  ['GET', '/api/rental-agreements/{id}/addendums/{addendumId}/print', 'Rental Agreements', 'Get addendums print'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/addendums/{addendumId}/signature', 'Rental Agreements', 'Sign addendum on behalf'],
  ['POST', '/api/rental-agreements/{id}/addendums/{addendumId}/void', 'Rental Agreements', 'Void agreement addendum'],
  ['POST', '/api/rental-agreements/{id}/charge-card-on-file', 'Rental Agreements', 'Create or run charge card on file'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/charges', 'Rental Agreements', 'Create or run charges'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/checkin-close', 'Rental Agreements', 'Check-in close with fee engine'],
  ['POST', '/api/rental-agreements/{id}/close', 'Rental Agreements', 'Create or run close'], // TODO(describe)
  ['GET', '/api/rental-agreements/{id}/commission-owner', 'Rental Agreements', 'Get commission owner context'],
  ['POST', '/api/rental-agreements/{id}/commission-owner', 'Rental Agreements', 'Override commission owner'],
  ['POST', '/api/rental-agreements/{id}/credit', 'Rental Agreements', 'Create or run credit'], // TODO(describe)
  ['PUT', '/api/rental-agreements/{id}/customer', 'Rental Agreements', 'Replace customer'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/customer/card-on-file', 'Rental Agreements', 'Create or run customer card on file'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/drivers', 'Rental Agreements', 'Create or run drivers'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/email-agreement', 'Rental Agreements', 'Create or run email agreement'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/finalize', 'Rental Agreements', 'Create or run finalize'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/inspection', 'Rental Agreements', 'Create or run inspection'], // TODO(describe)
  ['GET', '/api/rental-agreements/{id}/inspection-report', 'Rental Agreements', 'Get inspection report'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/payments/{paymentId}/delete', 'Rental Agreements', 'Create or run payments delete'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/payments/{paymentId}/refund', 'Rental Agreements', 'Create or run payments refund'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/payments/{paymentId}/void', 'Rental Agreements', 'Create or run payments void'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/payments/charge-card-on-file', 'Rental Agreements', 'Create or run payments charge card on file'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/payments/manual', 'Rental Agreements', 'Create or run payments manual'], // TODO(describe)
  ['GET', '/api/rental-agreements/{id}/print', 'Rental Agreements', 'Get print'], // TODO(describe)
  ['PUT', '/api/rental-agreements/{id}/rental', 'Rental Agreements', 'Replace rental'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/security-deposit/capture', 'Rental Agreements', 'Create or run security deposit capture'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/security-deposit/release', 'Rental Agreements', 'Create or run security deposit release'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/signature', 'Rental Agreements', 'Create or run signature'], // TODO(describe)
  ['POST', '/api/rental-agreements/{id}/status', 'Rental Agreements', 'Create or run status'], // TODO(describe)
  ['POST', '/api/rental-agreements/start-from-reservation/{reservationId}', 'Rental Agreements', 'Create or run start from reservation'], // TODO(describe)

  // ── Report Damage ─────────────────────────────────────────────────────────
  ['GET', '/api/report-damage/{reservationId}/acknowledgement-statement', 'Report Damage', 'Get acknowledgement statement'], // TODO(describe)
  ['POST', '/api/report-damage/{reservationId}/report-damage', 'Report Damage', 'Create or run report damage'], // TODO(describe)
  ['DELETE', '/api/report-damage/reports/{reportId}', 'Report Damage', 'Delete reports'], // TODO(describe)
  ['PATCH', '/api/report-damage/reports/{reportId}', 'Report Damage', 'Update reports'], // TODO(describe)

  // ── Reports ───────────────────────────────────────────────────────────────
  ['GET', '/api/reports/agent-track-record', 'Reports', 'Agent track record data'],
  ['GET', '/api/reports/agent-track-record/excel', 'Reports', 'Excel export of the agent track record report'], // TODO(describe)
  ['GET', '/api/reports/agent-track-record/pdf', 'Reports', 'PDF of the agent track record report'], // TODO(describe)
  ['GET', '/api/reports/airport-lawa', 'Reports', 'Data for the airport lawa report'], // TODO(describe)
  ['GET', '/api/reports/airport-lawa/excel', 'Reports', 'Excel export of the airport lawa report'], // TODO(describe)
  ['GET', '/api/reports/airport-lawa/pdf', 'Reports', 'PDF of the airport lawa report'], // TODO(describe)
  ['GET', '/api/reports/availability', 'Reports', 'Availability data'],
  ['GET', '/api/reports/availability-forecast', 'Reports', 'Availability forecast data'],
  ['GET', '/api/reports/availability-forecast/excel', 'Reports', 'Excel export of the availability forecast report'], // TODO(describe)
  ['GET', '/api/reports/availability-forecast/pdf', 'Reports', 'PDF of the availability forecast report'], // TODO(describe)
  ['GET', '/api/reports/availability/excel', 'Reports', 'Excel export of the availability report'], // TODO(describe)
  ['GET', '/api/reports/availability/pdf', 'Reports', 'PDF of the availability report'], // TODO(describe)
  ['GET', '/api/reports/cash-flow', 'Reports', 'Data for the cash flow report'], // TODO(describe)
  ['GET', '/api/reports/cash-flow/excel', 'Reports', 'Excel export of the cash flow report'], // TODO(describe)
  ['GET', '/api/reports/cash-flow/pdf', 'Reports', 'PDF of the cash flow report'], // TODO(describe)
  ['GET', '/api/reports/commission', 'Reports', 'Data for the commission report'], // TODO(describe)
  ['GET', '/api/reports/commission-sales-performance', 'Reports', 'Commission sales performance data'],
  ['GET', '/api/reports/commission-sales-performance/excel', 'Reports', 'Excel export of the commission sales performance report'], // TODO(describe)
  ['GET', '/api/reports/commission-sales-performance/pdf', 'Reports', 'PDF of the commission sales performance report'], // TODO(describe)
  ['GET', '/api/reports/commission/excel', 'Reports', 'Excel export of the commission report'], // TODO(describe)
  ['GET', '/api/reports/commission/pdf', 'Reports', 'PDF of the commission report'], // TODO(describe)
  ['GET', '/api/reports/contracts.xlsx', 'Reports', 'Get contracts.xlsx'], // TODO(describe)
  ['GET', '/api/reports/custom', 'Reports', 'Get custom'], // TODO(describe)
  ['POST', '/api/reports/custom', 'Reports', 'Create or run custom'], // TODO(describe)
  ['DELETE', '/api/reports/custom/{id}', 'Reports', 'Delete custom'], // TODO(describe)
  ['GET', '/api/reports/custom/{id}', 'Reports', 'Get custom'], // TODO(describe)
  ['PUT', '/api/reports/custom/{id}', 'Reports', 'Replace custom'], // TODO(describe)
  ['GET', '/api/reports/custom/{id}/excel', 'Reports', 'Get custom excel'], // TODO(describe)
  ['POST', '/api/reports/custom/{id}/run', 'Reports', 'Create or run custom run'], // TODO(describe)
  ['GET', '/api/reports/custom/datasets', 'Reports', 'Get custom datasets'], // TODO(describe)
  ['POST', '/api/reports/custom/run', 'Reports', 'Create or run custom run'], // TODO(describe)
  ['GET', '/api/reports/daily-business', 'Reports', 'Data for the daily business report'], // TODO(describe)
  ['GET', '/api/reports/daily-business/excel', 'Reports', 'Excel export of the daily business report'], // TODO(describe)
  ['GET', '/api/reports/daily-business/pdf', 'Reports', 'PDF of the daily business report'], // TODO(describe)
  ['GET', '/api/reports/dashboard-v2-fleet', 'Reports', 'Get dashboard v2 fleet'], // TODO(describe)
  ['GET', '/api/reports/dashboard-v2-kpis', 'Reports', 'Get dashboard v2 kpis'], // TODO(describe)
  ['GET', '/api/reports/fleet-status', 'Reports', 'Fleet status data'],
  ['GET', '/api/reports/fleet-status/excel', 'Reports', 'Excel export of the fleet status report'], // TODO(describe)
  ['GET', '/api/reports/fleet-status/pdf', 'Reports', 'PDF of the fleet status report'], // TODO(describe)
  ['GET', '/api/reports/fleet-value', 'Reports', 'Fleet value data'],
  ['GET', '/api/reports/fleet-value/excel', 'Reports', 'Excel export of the fleet value report'], // TODO(describe)
  ['GET', '/api/reports/fleet-value/pdf', 'Reports', 'PDF of the fleet value report'], // TODO(describe)
  ['GET', '/api/reports/inventory', 'Reports', 'Inventory utilization report'],
  ['GET', '/api/reports/inventory.xlsx', 'Reports', 'Get inventory.xlsx'], // TODO(describe)
  ['GET', '/api/reports/list', 'Reports', 'List available reports'],
  ['GET', '/api/reports/overview', 'Reports', 'Get overview'], // TODO(describe)
  ['GET', '/api/reports/overview.csv', 'Reports', 'Get overview.csv'], // TODO(describe)
  ['POST', '/api/reports/overview/email', 'Reports', 'Email reports overview'],
  ['GET', '/api/reports/payments-by-day', 'Reports', 'Payments by day data'],
  ['GET', '/api/reports/payments-by-day/excel', 'Reports', 'Excel export of the payments by day report'], // TODO(describe)
  ['GET', '/api/reports/payments-by-day/pdf', 'Reports', 'PDF of the payments by day report'], // TODO(describe)
  ['GET', '/api/reports/pre-paid-reservations', 'Reports', 'Pre-paid reservations data'],
  ['GET', '/api/reports/pre-paid-reservations/excel', 'Reports', 'Excel export of the pre paid reservations report'], // TODO(describe)
  ['GET', '/api/reports/pre-paid-reservations/pdf', 'Reports', 'PDF of the pre paid reservations report'], // TODO(describe)
  ['GET', '/api/reports/rental-status', 'Reports', 'Rental status data'],
  ['GET', '/api/reports/rental-status/excel', 'Reports', 'Excel export of the rental status report'], // TODO(describe)
  ['GET', '/api/reports/rental-status/pdf', 'Reports', 'PDF of the rental status report'], // TODO(describe)
  ['GET', '/api/reports/reservations', 'Reports', 'Reservations report'],
  ['GET', '/api/reports/reservations-by-day', 'Reports', 'Reservations by day data'],
  ['GET', '/api/reports/reservations-by-day/excel', 'Reports', 'Excel export of the reservations by day report'], // TODO(describe)
  ['GET', '/api/reports/reservations-by-day/pdf', 'Reports', 'PDF of the reservations by day report'], // TODO(describe)
  ['GET', '/api/reports/reservations.xlsx', 'Reports', 'Get reservations.xlsx'], // TODO(describe)
  ['GET', '/api/reports/sales', 'Reports', 'Sales data'],
  ['GET', '/api/reports/sales/excel', 'Reports', 'Excel export of the sales report'], // TODO(describe)
  ['GET', '/api/reports/sales/pdf', 'Reports', 'PDF of the sales report'], // TODO(describe)
  ['GET', '/api/reports/services-sold', 'Reports', 'Services-sold report'],
  ['GET', '/api/reports/snapshot', 'Reports', 'Reports landing snapshot'],
  ['GET', '/api/reports/taxes', 'Reports', 'Taxes data'],
  ['GET', '/api/reports/taxes/excel', 'Reports', 'Excel export of the taxes report'], // TODO(describe)
  ['GET', '/api/reports/taxes/pdf', 'Reports', 'PDF of the taxes report'], // TODO(describe)
  ['GET', '/api/reports/today-kpis', 'Reports', 'Get today kpis'], // TODO(describe)
  ['GET', '/api/reports/toll-per-location', 'Reports', 'Toll per location data'],
  ['GET', '/api/reports/toll-per-location/excel', 'Reports', 'Excel export of the toll per location report'], // TODO(describe)
  ['GET', '/api/reports/toll-per-location/pdf', 'Reports', 'PDF of the toll per location report'], // TODO(describe)
  ['GET', '/api/reports/toll-per-vehicle', 'Reports', 'Toll per vehicle data'],
  ['GET', '/api/reports/toll-per-vehicle/excel', 'Reports', 'Excel export of the toll per vehicle report'], // TODO(describe)
  ['GET', '/api/reports/toll-per-vehicle/pdf', 'Reports', 'PDF of the toll per vehicle report'], // TODO(describe)
  ['GET', '/api/reports/unpaid-balance', 'Reports', 'Unpaid balance data'],
  ['GET', '/api/reports/unpaid-balance/excel', 'Reports', 'Excel export of the unpaid balance report'], // TODO(describe)
  ['GET', '/api/reports/unpaid-balance/pdf', 'Reports', 'PDF of the unpaid balance report'], // TODO(describe)
  ['GET', '/api/reports/upcoming-vehicle-sales', 'Reports', 'Upcoming vehicle sales data'],
  ['GET', '/api/reports/upcoming-vehicle-sales/excel', 'Reports', 'Excel export of the upcoming vehicle sales report'], // TODO(describe)
  ['GET', '/api/reports/upcoming-vehicle-sales/pdf', 'Reports', 'PDF of the upcoming vehicle sales report'], // TODO(describe)
  ['GET', '/api/reports/utilization', 'Reports', 'Utilization data'],
  ['GET', '/api/reports/utilization/excel', 'Reports', 'Excel export of the utilization report'], // TODO(describe)
  ['GET', '/api/reports/utilization/pdf', 'Reports', 'PDF of the utilization report'], // TODO(describe)
  ['GET', '/api/reports/vehicle-revenue', 'Reports', 'Per-vehicle revenue report'],
  ['GET', '/api/reports/vehicle-revenue.xlsx', 'Reports', 'Get vehicle revenue.xlsx'], // TODO(describe)

  // ── Reservations ──────────────────────────────────────────────────────────
  ['GET', '/api/reservations', 'Reservations', 'Get reservations'], // TODO(describe)
  ['POST', '/api/reservations', 'Reservations', 'Create or run reservations'], // TODO(describe)
  ['DELETE', '/api/reservations/{id}', 'Reservations', 'Delete reservations'], // TODO(describe)
  ['GET', '/api/reservations/{id}', 'Reservations', 'Get reservations'], // TODO(describe)
  ['PATCH', '/api/reservations/{id}', 'Reservations', 'Update reservations'], // TODO(describe)
  ['GET', '/api/reservations/{id}/additional-drivers', 'Reservations', 'Get additional drivers'], // TODO(describe)
  ['PUT', '/api/reservations/{id}/additional-drivers', 'Reservations', 'Replace additional drivers'], // TODO(describe)
  ['POST', '/api/reservations/{id}/admin-transition', 'Reservations', 'Create or run admin transition'], // TODO(describe)
  ['GET', '/api/reservations/{id}/agreement', 'Reservations', 'Get agreement'], // TODO(describe)
  ['GET', '/api/reservations/{id}/agreement-charges', 'Reservations', 'Get agreement charges'], // TODO(describe)
  ['POST', '/api/reservations/{id}/agreement/credit', 'Reservations', 'Create or run agreement credit'], // TODO(describe)
  ['POST', '/api/reservations/{id}/agreement/customer/card-on-file', 'Reservations', 'Create or run agreement customer card on file'], // TODO(describe)
  ['POST', '/api/reservations/{id}/agreement/payments/charge-card-on-file', 'Reservations', 'Create or run agreement payments charge card on file'], // TODO(describe)
  ['POST', '/api/reservations/{id}/agreement/payments/manual', 'Reservations', 'Create or run agreement payments manual'], // TODO(describe)
  ['POST', '/api/reservations/{id}/agreement/security-deposit/capture', 'Reservations', 'Create or run agreement security deposit capture'], // TODO(describe)
  ['POST', '/api/reservations/{id}/agreement/security-deposit/release', 'Reservations', 'Create or run agreement security deposit release'], // TODO(describe)
  ['POST', '/api/reservations/{id}/agreement/spin/charge-card-on-file', 'Reservations', 'Spin charge card on file'],
  ['POST', '/api/reservations/{id}/agreement/spin/reauth-deposit', 'Reservations', 'Spin reauthorize deposit hold'],
  ['POST', '/api/reservations/{id}/agreement/spin/release-deposit', 'Reservations', 'Spin release deposit hold'],
  ['GET', '/api/reservations/{id}/audit-logs', 'Reservations', 'Get audit logs'], // TODO(describe)
  ['GET', '/api/reservations/{id}/available-services', 'Reservations', 'Get available services'], // TODO(describe)
  ['GET', '/api/reservations/{id}/available-vehicles', 'Reservations', 'Get available vehicles'], // TODO(describe)
  ['POST', '/api/reservations/{id}/charges', 'Reservations', 'Create or run charges'], // TODO(describe)
  ['POST', '/api/reservations/{id}/charges/{chargeId}/void', 'Reservations', 'Create or run charges void'], // TODO(describe)
  ['POST', '/api/reservations/{id}/correct-readings', 'Reservations', 'Create or run correct readings'], // TODO(describe)
  ['GET', '/api/reservations/{id}/display-data', 'Reservations', 'Reservation display payload'],
  ['POST', '/api/reservations/{id}/extend', 'Reservations', 'Extend reservation return date'],
  ['DELETE', '/api/reservations/{id}/extension/{extensionChargeId}', 'Reservations', 'Revert most-recent extension'],
  ['POST', '/api/reservations/{id}/notes', 'Reservations', 'Create or run notes'], // TODO(describe)
  ['GET', '/api/reservations/{id}/payments', 'Reservations', 'Get payments'], // TODO(describe)
  ['POST', '/api/reservations/{id}/payments', 'Reservations', 'Create or run payments'], // TODO(describe)
  ['POST', '/api/reservations/{id}/payments/{paymentId}/delete', 'Reservations', 'Create or run payments delete'], // TODO(describe)
  ['POST', '/api/reservations/{id}/payments/{paymentId}/refund', 'Reservations', 'Create or run payments refund'], // TODO(describe)
  ['POST', '/api/reservations/{id}/payments/{paymentId}/save-card-on-file', 'Reservations', 'Save card on file from payment'],
  ['POST', '/api/reservations/{id}/payments/{paymentId}/void-no-refund', 'Reservations', 'Create or run payments void no refund'], // TODO(describe)
  ['POST', '/api/reservations/{id}/payments/charge-card-on-file', 'Reservations', 'Create or run payments charge card on file'], // TODO(describe)
  ['POST', '/api/reservations/{id}/payments/reconcile-authorizenet', 'Reservations', 'Reconcile Authorize.Net payment'],
  ['POST', '/api/reservations/{id}/precheckin/ready', 'Reservations', 'Mark ready for pickup'],
  ['POST', '/api/reservations/{id}/precheckin/review', 'Reservations', 'Mark pre-checkin reviewed'],
  ['POST', '/api/reservations/{id}/precheckin/staff-complete', 'Reservations', 'Staff completes customer info'],
  ['GET', '/api/reservations/{id}/pricing', 'Reservations', 'Get pricing'], // TODO(describe)
  ['PUT', '/api/reservations/{id}/pricing', 'Reservations', 'Replace pricing'], // TODO(describe)
  ['GET', '/api/reservations/{id}/pricing-options', 'Reservations', 'Reservation pricing options'],
  ['GET', '/api/reservations/{id}/reprice-preview', 'Reservations', 'Get reprice preview'], // TODO(describe)
  ['POST', '/api/reservations/{id}/request-customer-info', 'Reservations', 'Create or run request customer info'], // TODO(describe)
  ['POST', '/api/reservations/{id}/request-payment', 'Reservations', 'Create or run request payment'], // TODO(describe)
  ['POST', '/api/reservations/{id}/request-signature', 'Reservations', 'Create or run request signature'], // TODO(describe)
  ['POST', '/api/reservations/{id}/reschedule', 'Reservations', 'Create or run reschedule'], // TODO(describe)
  ['POST', '/api/reservations/{id}/send-detail-email', 'Reservations', 'Create or run send detail email'], // TODO(describe)
  ['POST', '/api/reservations/{id}/send-request-email', 'Reservations', 'Create or run send request email'], // TODO(describe)
  ['POST', '/api/reservations/{id}/start-rental', 'Reservations', 'Create or run start rental'], // TODO(describe)
  ['POST', '/api/reservations/{id}/swap-vehicle', 'Reservations', 'Swap assigned vehicle'],
  ['POST', '/api/reservations/bulk/import', 'Reservations', 'Create or run bulk import'], // TODO(describe)
  ['POST', '/api/reservations/bulk/parse-file', 'Reservations', 'Create or run bulk parse file'], // TODO(describe)
  ['POST', '/api/reservations/bulk/validate', 'Reservations', 'Create or run bulk validate'], // TODO(describe)
  ['GET', '/api/reservations/create-options', 'Reservations', 'Options for new reservation'],
  ['GET', '/api/reservations/page', 'Reservations', 'Paginated reservation list'],
  ['GET', '/api/reservations/resolve-rate', 'Reservations', 'Resolve daily rate for window'],
  ['GET', '/api/reservations/smart-lookup', 'Reservations', 'Get smart lookup'], // TODO(describe)
  ['GET', '/api/reservations/summary', 'Reservations', 'Reservation dashboard KPI summary'],

  // ── Search ────────────────────────────────────────────────────────────────
  ['GET', '/api/search', 'Search', 'Get search'], // TODO(describe)

  // ── Self Return ───────────────────────────────────────────────────────────
  ['DELETE', '/api/self-return/locations/{locationId}/qr', 'Self Return', 'Delete locations qr'], // TODO(describe)
  ['GET', '/api/self-return/locations/{locationId}/qr', 'Self Return', 'Get locations qr'], // TODO(describe)
  ['POST', '/api/self-return/locations/{locationId}/qr', 'Self Return', 'Create or run locations qr'], // TODO(describe)
  ['POST', '/api/self-return/reservations/{reservationId}/void', 'Self Return', 'Create or run reservations void'], // TODO(describe)

  // ── Settings ──────────────────────────────────────────────────────────────
  ['PUT', '/api/settings/branch-terms', 'Settings', 'Replace branch terms'], // TODO(describe)
  ['GET', '/api/settings/branch-terms-raw', 'Settings', 'Get branch terms raw'], // TODO(describe)
  ['GET', '/api/settings/car-sharing-search-places', 'Settings', 'List car-sharing search place presets'],
  ['POST', '/api/settings/car-sharing-search-places', 'Settings', 'Create car-sharing search place preset'],
  ['DELETE', '/api/settings/car-sharing-search-places/{id}', 'Settings', 'Delete car-sharing search place preset'],
  ['PATCH', '/api/settings/car-sharing-search-places/{id}', 'Settings', 'Update car-sharing search place preset'],
  ['GET', '/api/settings/checkin-audit', 'Settings', 'Get checkin audit'], // TODO(describe)
  ['PUT', '/api/settings/checkin-audit', 'Settings', 'Replace checkin audit'], // TODO(describe)
  ['GET', '/api/settings/checkout-contract', 'Settings', 'Get checkout contract'], // TODO(describe)
  ['PUT', '/api/settings/checkout-contract', 'Settings', 'Replace checkout contract'], // TODO(describe)
  ['GET', '/api/settings/checkout-payment', 'Settings', 'Get checkout payment'], // TODO(describe)
  ['PUT', '/api/settings/checkout-payment', 'Settings', 'Replace checkout payment'], // TODO(describe)
  ['GET', '/api/settings/citation-ocr', 'Settings', 'Get citation OCR config'],
  ['PUT', '/api/settings/citation-ocr', 'Settings', 'Update citation OCR config'],
  ['GET', '/api/settings/copilot-ai', 'Settings', 'Get copilot ai'], // TODO(describe)
  ['PUT', '/api/settings/copilot-ai', 'Settings', 'Replace copilot ai'], // TODO(describe)
  ['GET', '/api/settings/customer-inspection', 'Settings', 'Get customer inspection config'],
  ['PUT', '/api/settings/customer-inspection', 'Settings', 'Update customer inspection config'],
  ['GET', '/api/settings/dashboard-sipps', 'Settings', 'Get dashboard SIPP picker'],
  ['PUT', '/api/settings/dashboard-sipps', 'Settings', 'Update dashboard SIPP picker'],
  ['GET', '/api/settings/email-templates', 'Settings', 'Get email templates'], // TODO(describe)
  ['PUT', '/api/settings/email-templates', 'Settings', 'Replace email templates'], // TODO(describe)
  ['GET', '/api/settings/fleet-rotation', 'Settings', 'Get fleet rotation config'],
  ['PUT', '/api/settings/fleet-rotation', 'Settings', 'Update fleet rotation config'],
  ['GET', '/api/settings/franchises', 'Settings', 'List franchises'],
  ['POST', '/api/settings/franchises', 'Settings', 'Create franchise'],
  ['DELETE', '/api/settings/franchises/{id}', 'Settings', 'Delete franchise'],
  ['GET', '/api/settings/franchises/{id}', 'Settings', 'Get franchise'],
  ['PATCH', '/api/settings/franchises/{id}', 'Settings', 'Update franchise'],
  ['GET', '/api/settings/franchises/active', 'Settings', 'List active franchises'],
  ['GET', '/api/settings/idle-vehicles', 'Settings', 'Get idle vehicles'], // TODO(describe)
  ['PUT', '/api/settings/idle-vehicles', 'Settings', 'Replace idle vehicles'], // TODO(describe)
  ['GET', '/api/settings/insurance-plans', 'Settings', 'Get insurance plans'], // TODO(describe)
  ['PUT', '/api/settings/insurance-plans', 'Settings', 'Replace insurance plans'], // TODO(describe)
  ['GET', '/api/settings/loaner-rates', 'Settings', 'Get loaner rates'], // TODO(describe)
  ['PUT', '/api/settings/loaner-rates', 'Settings', 'Replace loaner rates'], // TODO(describe)
  ['GET', '/api/settings/long-term-email-templates', 'Settings', 'Get long-term email templates'],
  ['PUT', '/api/settings/long-term-email-templates', 'Settings', 'Update long-term email templates'],
  ['GET', '/api/settings/market-excluded-vendors', 'Settings', 'Get excluded competitors'],
  ['PUT', '/api/settings/market-excluded-vendors', 'Settings', 'Update excluded competitors'],
  ['GET', '/api/settings/market-pricing-config', 'Settings', 'List tax-aware pricing configs'],
  ['PUT', '/api/settings/market-pricing-config', 'Settings', 'Upsert tax-aware pricing config'],
  ['DELETE', '/api/settings/market-pricing-config/{locationCode}', 'Settings', 'Delete tax-aware pricing config'],
  ['GET', '/api/settings/payment-capabilities', 'Settings', 'Get payment capabilities'], // TODO(describe)
  ['GET', '/api/settings/payment-gateway', 'Settings', 'Get payment gateway config'],
  ['PUT', '/api/settings/payment-gateway', 'Settings', 'Update payment gateway config'],
  ['POST', '/api/settings/payment-gateway/health-check', 'Settings', 'Check gateway credential readiness'],
  ['POST', '/api/settings/payment-gateway/promote-terminal', 'Settings', 'Create or run payment gateway promote terminal'], // TODO(describe)
  ['POST', '/api/settings/payment-gateway/terminal-check', 'Settings', 'Create or run payment gateway terminal check'], // TODO(describe)
  ['GET', '/api/settings/planner-copilot', 'Settings', 'Get planner copilot config'],
  ['PUT', '/api/settings/planner-copilot', 'Settings', 'Update planner copilot config'],
  ['GET', '/api/settings/planner-copilot/usage', 'Settings', 'Get planner copilot usage'],
  ['GET', '/api/settings/precheckin-auto-email', 'Settings', 'Get precheckin auto email'], // TODO(describe)
  ['PUT', '/api/settings/precheckin-auto-email', 'Settings', 'Replace precheckin auto email'], // TODO(describe)
  ['GET', '/api/settings/precheckin-discount', 'Settings', 'Get pre-checkin discount config'],
  ['PUT', '/api/settings/precheckin-discount', 'Settings', 'Update pre-checkin discount config'],
  ['GET', '/api/settings/rental-agreement', 'Settings', 'Get rental agreement'], // TODO(describe)
  ['PUT', '/api/settings/rental-agreement', 'Settings', 'Replace rental agreement'], // TODO(describe)
  ['GET', '/api/settings/reservation-options', 'Settings', 'Get reservation options'], // TODO(describe)
  ['PUT', '/api/settings/reservation-options', 'Settings', 'Replace reservation options'], // TODO(describe)
  ['GET', '/api/settings/revenue-pricing', 'Settings', 'Get revenue pricing config'],
  ['PUT', '/api/settings/revenue-pricing', 'Settings', 'Update revenue pricing config'],
  ['GET', '/api/settings/review-email', 'Settings', 'Get review email config'],
  ['PUT', '/api/settings/review-email', 'Settings', 'Update review email config'],
  ['GET', '/api/settings/self-service', 'Settings', 'Get self-service config'],
  ['PUT', '/api/settings/self-service', 'Settings', 'Update self-service config'],
  ['GET', '/api/settings/telematics', 'Settings', 'Get telematics config'],
  ['PUT', '/api/settings/telematics', 'Settings', 'Update telematics config'],
  ['GET', '/api/settings/tenant-modules', 'Settings', 'Get tenant module access'],
  ['PUT', '/api/settings/tenant-modules', 'Settings', 'Update tenant module access'],
  ['GET', '/api/settings/terms-coverage', 'Settings', 'Get terms coverage'], // TODO(describe)
  ['GET', '/api/settings/terms-preview', 'Settings', 'Get terms preview'], // TODO(describe)
  ['GET', '/api/settings/two-factor-policy', 'Settings', 'Get two factor policy'], // TODO(describe)
  ['PUT', '/api/settings/two-factor-policy', 'Settings', 'Replace two factor policy'], // TODO(describe)
  ['GET', '/api/settings/users/{userId}/module-access', 'Settings', 'Get user module access'],
  ['PUT', '/api/settings/users/{userId}/module-access', 'Settings', 'Update user module access'],

  // ── Shuttle ───────────────────────────────────────────────────────────────
  ['GET', '/api/shuttle-monitor/alerts', 'Shuttle', 'Geofence alert feed (staff, tenant/location scoped)'],
  ['GET', '/api/shuttle-zones', 'Shuttle', 'List geofence zones/routes (admin, tenant-scoped)'],
  ['POST', '/api/shuttle-zones', 'Shuttle', 'Create a zone/route (synced to the GPS provider; audited)'],
  ['DELETE', '/api/shuttle-zones/{id}', 'Shuttle', 'Delete a zone/route (audited)'],
  ['PUT', '/api/shuttle-zones/{id}', 'Shuttle', 'Update a zone/route (audited)'],
  ['GET', '/api/shuttle-zones/recipients', 'Shuttle', 'Per-location staff alert recipients'],
  ['PUT', '/api/shuttle-zones/recipients', 'Shuttle', 'Set per-location staff alert recipients (audited)'],

  // ── Shuttle Monitor ───────────────────────────────────────────────────────
  ['GET', '/api/shuttle-monitor/driver-shifts', 'Shuttle Monitor', 'Get driver shifts'], // TODO(describe)
  ['POST', '/api/shuttle-monitor/driver-shifts', 'Shuttle Monitor', 'Create or run driver shifts'], // TODO(describe)
  ['DELETE', '/api/shuttle-monitor/driver-shifts/{id}', 'Shuttle Monitor', 'Delete driver shifts'], // TODO(describe)
  ['POST', '/api/shuttle-monitor/driver-shifts/{id}/notify', 'Shuttle Monitor', 'Create or run driver shifts notify'], // TODO(describe)
  ['GET', '/api/shuttle-monitor/enabled', 'Shuttle Monitor', 'Get enabled'], // TODO(describe)
  ['GET', '/api/shuttle-monitor/positions', 'Shuttle Monitor', 'Get positions'], // TODO(describe)

  // ── Shuttle Requests ──────────────────────────────────────────────────────
  ['GET', '/api/shuttle-requests', 'Shuttle Requests', 'Get shuttle requests'], // TODO(describe)
  ['POST', '/api/shuttle-requests', 'Shuttle Requests', 'Create or run shuttle requests'], // TODO(describe)
  ['DELETE', '/api/shuttle-requests/{id}/assign', 'Shuttle Requests', 'Delete assign'], // TODO(describe)
  ['POST', '/api/shuttle-requests/{id}/assign', 'Shuttle Requests', 'Create or run assign'], // TODO(describe)
  ['POST', '/api/shuttle-requests/{id}/cancel', 'Shuttle Requests', 'Create or run cancel'], // TODO(describe)
  ['POST', '/api/shuttle-requests/{id}/complete', 'Shuttle Requests', 'Create or run complete'], // TODO(describe)
  ['POST', '/api/shuttle-requests/{id}/no-show', 'Shuttle Requests', 'Create or run no show'], // TODO(describe)
  ['POST', '/api/shuttle-requests/{id}/notify-delay', 'Shuttle Requests', 'Create or run notify delay'], // TODO(describe)
  ['POST', '/api/shuttle-requests/{id}/picked-up', 'Shuttle Requests', 'Create or run picked up'], // TODO(describe)
  ['POST', '/api/shuttle-requests/{id}/view', 'Shuttle Requests', 'Create or run view'], // TODO(describe)

  // ── Shuttle Tracker ───────────────────────────────────────────────────────
  ['GET', '/api/shuttle-tracker/config', 'Shuttle Tracker', 'Get config'], // TODO(describe)
  ['PUT', '/api/shuttle-tracker/config', 'Shuttle Tracker', 'Replace config'], // TODO(describe)

  // ── Sign ──────────────────────────────────────────────────────────────────
  ['GET', '/api/sign/{token}', 'Sign', 'Get sign'], // TODO(describe)
  ['POST', '/api/sign/{token}/complete', 'Sign', 'Create or run complete'], // TODO(describe)
  ['POST', '/api/sign/{token}/initials', 'Sign', 'Create or run initials'], // TODO(describe)

  // ── SMS ───────────────────────────────────────────────────────────────────
  ['GET', '/api/sms/config', 'SMS', 'Get SMS config status'],
  ['POST', '/api/sms/send', 'SMS', 'Send templated SMS'],
  ['POST', '/api/sms/send-custom', 'SMS', 'Send custom SMS'],
  ['GET', '/api/sms/templates', 'SMS', 'List SMS templates'],

  // ── Store Board ───────────────────────────────────────────────────────────
  ['GET', '/api/store-board/tokens', 'Store Board', 'List kiosk tokens'],
  ['POST', '/api/store-board/tokens', 'Store Board', 'Mint kiosk token'],
  ['POST', '/api/store-board/tokens/{id}/revoke', 'Store Board', 'Revoke kiosk token'],

  // ── Tenants ───────────────────────────────────────────────────────────────
  ['GET', '/api/tenants', 'Tenants', 'Get tenants'], // TODO(describe)
  ['POST', '/api/tenants', 'Tenants', 'Create or run tenants'], // TODO(describe)
  ['PATCH', '/api/tenants/{id}', 'Tenants', 'Update tenants'], // TODO(describe)
  ['GET', '/api/tenants/{id}/admins', 'Tenants', 'Get admins'], // TODO(describe)
  ['POST', '/api/tenants/{id}/admins', 'Tenants', 'Create or run admins'], // TODO(describe)
  ['POST', '/api/tenants/{id}/admins/{userId}/reset-password', 'Tenants', 'Create or run admins reset password'], // TODO(describe)
  ['POST', '/api/tenants/{id}/billing/enroll-link', 'Tenants', 'Create or run billing enroll link'], // TODO(describe)
  ['POST', '/api/tenants/{id}/impersonate', 'Tenants', 'Create or run impersonate'], // TODO(describe)
  ['POST', '/api/tenants/{id}/reset-demo', 'Tenants', 'Create or run reset demo'], // TODO(describe)
  ['GET', '/api/tenants/billing/{tenantId}', 'Tenants', 'Billing detail for one tenant'],
  ['POST', '/api/tenants/billing/{tenantId}/apply-plan', 'Tenants', 'Apply the plan to the tenant entitlements (super-admin)'],
  ['POST', '/api/tenants/billing/{tenantId}/restore', 'Tenants', 'Restore suspended tenant access (super-admin)'],
  ['POST', '/api/tenants/billing/{tenantId}/suspend', 'Tenants', 'Suspend tenant access (super-admin)'],
  ['GET', '/api/tenants/billing/health', 'Tenants', 'Billing health checks'],
  ['GET', '/api/tenants/billing/overview', 'Tenants', 'Billing overview across every tenant'],
  ['POST', '/api/tenants/billing/subscriptions/{subscriptionId}/cancel', 'Tenants', 'Cancel a tenant\'s subscription (super-admin)'],
  ['POST', '/api/tenants/billing/subscriptions/{subscriptionId}/plan-change', 'Tenants', 'Apply a plan change (super-admin)'],
  ['POST', '/api/tenants/billing/subscriptions/{subscriptionId}/plan-change/cancel', 'Tenants', 'Cancel a pending plan change (super-admin)'],
  ['POST', '/api/tenants/billing/subscriptions/{subscriptionId}/plan-change/preview', 'Tenants', 'Preview a plan change and its proration (super-admin)'],
  ['POST', '/api/tenants/billing/subscriptions/{subscriptionId}/refresh', 'Tenants', 'Re-read subscription state from Authorize.Net - a read, never a charge (super-admin)'],
  ['POST', '/api/tenants/billing/subscriptions/{subscriptionId}/revoke-invites', 'Tenants', 'Revoke outstanding enrollment invites (super-admin)'],
  ['POST', '/api/tenants/billing/subscriptions/{subscriptionId}/update-link', 'Tenants', 'Issue a payment-method update link (super-admin)'],
  ['GET', '/api/tenants/plan-catalog', 'Tenants', 'Get tenant plan catalog'],
  ['PUT', '/api/tenants/plan-catalog', 'Tenants', 'Save tenant plan catalog'],

  // ── TL International ──────────────────────────────────────────────────────
  ['POST', '/api/admin/integrations/tl-international/cookie', 'TL International', 'Rotate session cookie'],
  ['GET', '/api/admin/integrations/tl-international/payout-periods', 'TL International', 'List payout periods'],
  ['PUT', '/api/admin/integrations/tl-international/payout-periods/{year}/{month}', 'TL International', 'Record payout period payment'],
  ['GET', '/api/admin/integrations/tl-international/payout-periods/{year}/{month}/reservations', 'TL International', 'Payout period reservations'],
  ['GET', '/api/admin/integrations/tl-international/pending-imports', 'TL International', 'List pending imports'],
  ['POST', '/api/admin/integrations/tl-international/pending-imports/{id}/promote', 'TL International', 'Promote pending import'],
  ['POST', '/api/admin/integrations/tl-international/pending-imports/{id}/reject', 'TL International', 'Reject pending import'],
  ['POST', '/api/admin/integrations/tl-international/run-now', 'TL International', 'Enqueue one-off sync job'],
  ['GET', '/api/admin/integrations/tl-international/runs', 'TL International', 'List recent sync runs'],
  ['GET', '/api/admin/integrations/tl-international/status', 'TL International', 'Integration health summary'],
  ['POST', '/api/admin/integrations/tl-international/test-auth', 'TL International', 'Live auth probe'],

  // ── Tolls ─────────────────────────────────────────────────────────────────
  ['GET', '/api/tolls/alerts', 'Tolls', 'Get alerts'], // TODO(describe)
  ['GET', '/api/tolls/dashboard', 'Tolls', 'Get dashboard'], // TODO(describe)
  ['GET', '/api/tolls/match-config', 'Tolls', 'Get match config'], // TODO(describe)
  ['PUT', '/api/tolls/match-config', 'Tolls', 'Replace match config'], // TODO(describe)
  ['GET', '/api/tolls/provider-account', 'Tolls', 'Get provider account'], // TODO(describe)
  ['PUT', '/api/tolls/provider-account', 'Tolls', 'Replace provider account'], // TODO(describe)
  ['POST', '/api/tolls/provider-account/health-check', 'Tolls', 'Create or run provider account health check'], // TODO(describe)
  ['POST', '/api/tolls/provider-account/live-sync', 'Tolls', 'Create or run provider account live sync'], // TODO(describe)
  ['POST', '/api/tolls/provider-account/mock-sync', 'Tolls', 'Run mock toll sync'],
  ['POST', '/api/tolls/rematch-backfill', 'Tolls', 'Create or run rematch backfill'], // TODO(describe)
  ['GET', '/api/tolls/reservations/{reservationId}', 'Tolls', 'Get reservations'], // TODO(describe)
  ['POST', '/api/tolls/transactions/{id}/acknowledge', 'Tolls', 'Create or run transactions acknowledge'], // TODO(describe)
  ['POST', '/api/tolls/transactions/{id}/confirm-match', 'Tolls', 'Create or run transactions confirm match'], // TODO(describe)
  ['POST', '/api/tolls/transactions/{id}/post-to-reservation', 'Tolls', 'Post toll to reservation'],
  ['POST', '/api/tolls/transactions/{id}/review-action', 'Tolls', 'Create or run transactions review action'], // TODO(describe)
  ['POST', '/api/tolls/transactions/bulk-auto-match', 'Tolls', 'Bulk auto-match pending tolls'],
  ['POST', '/api/tolls/transactions/bulk-confirm', 'Tolls', 'Bulk confirm toll matches'],
  ['GET', '/api/tolls/transactions/export.csv', 'Tolls', 'Get transactions export.csv'], // TODO(describe)
  ['POST', '/api/tolls/transactions/manual-import', 'Tolls', 'Create or run transactions manual import'], // TODO(describe)

  // ── Training ──────────────────────────────────────────────────────────────
  ['POST', '/api/training/practice-session', 'Training', 'Create or run practice session'], // TODO(describe)
  ['GET', '/api/training/progress', 'Training', 'Get progress'], // TODO(describe)
  ['POST', '/api/training/progress/{moduleKey}/arm', 'Training', 'Create or run progress arm'], // TODO(describe)
  ['POST', '/api/training/progress/{moduleKey}/reset', 'Training', 'Create or run progress reset'], // TODO(describe)
  ['POST', '/api/training/progress/{moduleKey}/walkthrough-complete', 'Training', 'Create or run progress walkthrough complete'], // TODO(describe)
  ['GET', '/api/training/team', 'Training', 'Get team'], // TODO(describe)

  // ── Vehicle Types ─────────────────────────────────────────────────────────
  ['GET', '/api/vehicle-types/selectable', 'Vehicle Types', 'Get selectable'], // TODO(describe)

  // ── Vehicles ──────────────────────────────────────────────────────────────
  ['GET', '/api/vehicles', 'Vehicles', 'Get vehicles'], // TODO(describe)
  ['POST', '/api/vehicles', 'Vehicles', 'Create or run vehicles'], // TODO(describe)
  ['DELETE', '/api/vehicles/{id}', 'Vehicles', 'Delete vehicles'], // TODO(describe)
  ['GET', '/api/vehicles/{id}', 'Vehicles', 'Get vehicles'], // TODO(describe)
  ['PATCH', '/api/vehicles/{id}', 'Vehicles', 'Update vehicles'], // TODO(describe)
  ['POST', '/api/vehicles/{id}/availability-blocks', 'Vehicles', 'Create or run availability blocks'], // TODO(describe)
  ['GET', '/api/vehicles/{id}/inventory-photos', 'Vehicles', 'Vehicle inventory photo history'],
  ['POST', '/api/vehicles/{id}/mileage', 'Vehicles', 'Manual odometer correction'],
  ['GET', '/api/vehicles/{id}/registration-document', 'Vehicles', 'Get registration document URL'],
  ['POST', '/api/vehicles/{id}/registration-document', 'Vehicles', 'Save registration document'],
  ['GET', '/api/vehicles/{id}/telematics', 'Vehicles', 'List vehicle telematics'],
  ['POST', '/api/vehicles/{id}/telematics/devices', 'Vehicles', 'Register telematics device'],
  ['POST', '/api/vehicles/{id}/telematics/events', 'Vehicles', 'Ingest manual telematics event'],
  ['POST', '/api/vehicles/availability-blocks/{id}/release', 'Vehicles', 'Create or run availability blocks release'], // TODO(describe)
  ['POST', '/api/vehicles/availability-blocks/import', 'Vehicles', 'Create or run availability blocks import'], // TODO(describe)
  ['POST', '/api/vehicles/availability-blocks/validate', 'Vehicles', 'Create or run availability blocks validate'], // TODO(describe)
  ['POST', '/api/vehicles/bulk-program-category', 'Vehicles', 'Bulk set program category'],
  ['POST', '/api/vehicles/bulk/import', 'Vehicles', 'Create or run bulk import'], // TODO(describe)
  ['POST', '/api/vehicles/bulk/validate', 'Vehicles', 'Create or run bulk validate'], // TODO(describe)
  ['GET', '/api/vehicles/overdue-alerts', 'Vehicles', 'Get overdue alerts'], // TODO(describe)
  ['POST', '/api/vehicles/overdue-alerts/{id}/dismiss', 'Vehicles', 'Create or run overdue alerts dismiss'], // TODO(describe)
  ['GET', '/api/vehicles/telematics/providers', 'Vehicles', 'List telematics providers'],
  ['POST', '/api/vehicles/telematics/voltswitch/sync', 'Vehicles', 'Sync Voltswitch devices'],
  ['POST', '/api/vehicles/telematics/zubie/webhook', 'Vehicles', 'Authed Zubie webhook ingest'],
  ['DELETE', '/api/vehicles/turn-ready/rules', 'Vehicles', 'Delete turn ready rules'], // TODO(describe)
  ['GET', '/api/vehicles/turn-ready/rules', 'Vehicles', 'Get turn ready rules'], // TODO(describe)
  ['PUT', '/api/vehicles/turn-ready/rules', 'Vehicles', 'Replace turn ready rules'], // TODO(describe)
];
