# Response to the UK–US / Puerto Rico Data Protection & Integration Information Request

**Responding organisation:** ______________________________
**Date of response:** ______________________________
**Prepared by:** ______________________________

> **Status of this document.** This response covers Sections 2, 3 and 4 of the information request.
> Section 5 (contractual documentation) is deliberately not addressed here, as the request itself
> provides that those documents are determined *after* this information has been received and reviewed.
>
> Every technical statement below was verified against the running production system and the source
> code on **23 August 2026**, not from documentation or assumption. Where a control is not in place,
> this document says so plainly rather than describing an intention.

---

## Preliminary clarification: hosting is not in Puerto Rico

The request assumes in several sections that production servers may be located in Puerto Rico, and
asks whether data can subsequently leave Puerto Rico.

**No production system, database, backup or replica is located in Puerto Rico.** All infrastructure
is in the mainland United States (New Jersey and Virginia — see 3.2).

The Puerto Rico connection is corporate, not technical: **International Rental Corp**, TL
International's franchisee, is the Puerto Rico entity. It is a user of the platform, not a hosting
location. We believe this materially narrows the assessment, as the Puerto Rico territorial
questions in 3.2, 3.13 and 3.14 do not arise for data storage or processing.

---

# Section 2 — Proposed data journey

The anticipated flow is:

```
TL (UK) ──[1]──> RFM platform (US: New Jersey + Virginia) ──[2]──> sub-processors (all US)
    ^                                                                        │
    └──────────────────────[3] rental data returned ─────────────────────────┘
```

**[1] Inbound — reservation collection.** The platform retrieves booking records from TL's systems
on a scheduled basis using a delta cursor, over TLS. Records land in a dedicated staging table and
are reviewed before becoming live reservations; unmatched records are held for human review rather
than promoted automatically.

We propose **polling rather than a webhook push**, so that the operational burden of retries,
buffering and failure handling sits with us rather than with TL, and so that the window and field
set transferred are determined and evidenced by us — which supports data minimisation.

**[2] Processing in the US.** Data is stored in the production database and object storage
described in 3.2, and is accessible to the sub-processors listed in 3.4 to the extent stated there.

**[3] Outbound — rental data returned to the UK.** On vehicle collection and on vehicle return, the
platform sends a structured event to TL, followed by the associated rental documents. Every
outbound transmission is recorded in a durable audit table with a content hash, timestamps, TL's
acknowledgement reference, delivery status and retry history (see 3.7 and 3.9).

**Retention within the journey.** The audit record is designed to outlive the personal data it
refers to: payload content is redactable while the proof-of-delivery metadata (hash, timestamps,
acknowledgement reference, status) is retained. This allows us to evidence *that* a specific
document was delivered on a specific date without retaining the customer's data indefinitely.

---

# Section 3 — Information required

## 3.1 Legal entity and contact details

*To be completed by the responding organisation.*

| Item | Response |
|---|---|
| Full legal name of each company receiving, processing, hosting or controlling the data | ______________________________ |
| Registered / business address of each entity | ______________________________ |
| State or territory of incorporation and registration number | ______________________________ |
| Full legal name and address of any Puerto Rico entity involved | ______________________________ |
| Relationship between the mainland US company and the Puerto Rico entity | ______________________________ |
| Authorised contractual signatory — name, title, contact | ______________________________ |
| Privacy / data-protection contact — name, contact | ______________________________ |
| Information-security / technical contact — name, contact | ______________________________ |

---

## 3.2 Servers, databases, hosting and backups

| Question | Response |
|---|---|
| Country/territory and state of production servers | **United States.** Application and API: DigitalOcean, region NYC3, physically located in Clifton, **New Jersey**. |
| Any production servers or databases in Puerto Rico? | **No. None.** |
| Legal entity owning/operating the servers | ______________________________ (infrastructure is leased from the providers named below; no owned hardware) |
| Cloud / hosting providers | DigitalOcean, LLC (compute, managed cache, backup object storage); Supabase, Inc. (managed PostgreSQL and object storage, running on Amazon Web Services) |
| Location of primary database servers | **Amazon Web Services `us-east-1` — Northern Virginia, United States.** PostgreSQL 17.6, managed by Supabase. |
| Location of backup servers and backup storage | DigitalOcean Spaces, region NYC3 (**New Jersey, United States**). Nightly full database dump, **30-day retention**. |
| Location of disaster-recovery and failover systems | Managed by the platform providers within the same US regions. Supabase provides point-in-time recovery within `us-east-1`; no separate customer-operated DR site exists. |
| Is data replicated, mirrored or cached to any other state, territory or country? | **No non-US location.** A managed Redis cache (DigitalOcean, private network, TLS) holds short-lived cached responses and operational data. All replication remains within the US regions named above. |
| Can data initially stored in Puerto Rico leave Puerto Rico? | **Not applicable** — no data is stored in Puerto Rico. |

**Backup encryption.** Nightly database dumps are transmitted over TLS to DigitalOcean Spaces and
protected by the provider's storage-level encryption. Client-side (GPG) encryption of the dump prior
to upload, with the key held off the host, is available and can be enabled.

---

## 3.3 Personnel and access

| Question | Response |
|---|---|
| Legal entities and teams that can access personal data | Platform operator staff (administrative), and each tenant's own staff limited to their own tenant's data. To be completed with entity names in 3.1. |
| Countries/states/territories from which staff or contractors may access data | ______________________________ |
| Remote administrative/support access permitted? | Yes — administrative access is remote. |
| Contractors or external support personnel with access? | ______________________________ |
| How access is authorised, restricted and reviewed | Role-based, with four roles (`SUPER_ADMIN`, `ADMIN`, `OPS`, `AGENT`) enforced as middleware at every route. Tenant scoping is **fail-closed**: a user without a tenant assignment matches zero records rather than all records. Branch-level scoping can narrow a user further, and a client-supplied location filter can only ever narrow, never widen, the caller's permitted scope. Money-handling routes require an explicitly granted capability (fail-closed). Machine/service accounts run against a default-deny endpoint allowlist. These properties are covered by automated regression tests that run on every change. |
| Multi-factor authentication for privileged or sensitive access? | **Yes — TOTP two-factor authentication is enforced for `SUPER_ADMIN` and `ADMIN` staff** (authenticator-app enrolment with encrypted secrets and single-use backup codes). Baseline authentication is email and password: passwords are hashed with bcrypt and must be at least 12 characters with mixed case, a digit and a symbol; login is rate-limited per IP address; sessions are 12-hour bearer tokens; deactivating a user, changing a password or resetting two-factor authentication terminates existing sessions within 30 seconds. A secondary screen-lock PIN also exists but is a re-lock of an already-authenticated session, not a second factor. |
| Is individual user, administrator, database and API access logged and auditable? | **Yes — see below** (request-level logging plus a dedicated administrative/security audit trail). |

**Request logging.** Every API request is logged with: request identifier, HTTP method, path,
status code, duration, client IP, user agent, authenticated user ID and tenant ID. **Request and
response bodies are not logged.** A redaction layer masks personal-data field names (name, phone,
email, date of birth, licence number, and others) and truncates embedded images across all log
output.

**Administrative / security audit trail.** The platform maintains a dedicated administrative audit
table, independent of and structurally separate from the reservation-scoped records, that records
security-relevant events: authentication and logout, role changes, user creation and deletion,
password resets, data exports and erasures, and administrative impersonation. Its actor and tenant
references are stored as plain values with no foreign key, so an erasure or tenant teardown never
removes the record that an action occurred.

**Administrative impersonation.** Where the platform operator assumes a tenant administrator's
session for support purposes, the impersonation is written to the audit trail and the session token
carries a marker identifying it as an impersonation, so actions taken during it are attributable to
the operator rather than to the tenant's own employee.

**Database and infrastructure access.** Direct database access via the provider's console or
credentials, and host access via SSH, sit outside application logging. ______________________________
*(to be completed: who holds these credentials and whether provider-side audit logging is enabled)*

---

## 3.4 Sub-processors and third parties

Complete list of third parties that may process, store, transmit or access data. All are US-based.

| Provider | Service / purpose | Categories of data accessed | Location |
|---|---|---|---|
| DigitalOcean, LLC | Application and API hosting; managed Redis cache; backup object storage | All data in transit through the application; cached responses; full database backups | US — NYC3 (New Jersey) |
| Supabase, Inc. (on AWS) | Managed PostgreSQL database; object storage for documents and photographs | **All personal data**, including identity documents, signatures and inspection photographs | US — `us-east-1` (Virginia) |
| Sentry | Application error monitoring | Error messages, stack traces and diagnostic context; may incidentally contain personal data (see gap below) | US |
| MailerSend / Resend | Transactional email | Recipient name, email address, reservation details | US |
| Telnyx (default), Twilio, Plivo | Transactional SMS | Mobile number, name, reservation references | US |
| Authorize.Net | Payment processing and stored payment profiles | Cardholder name, billing address, payment token | US |
| Dejavoo / iPOSpays | Card-present terminal processing | Card data captured **at the terminal**, not by us | US |
| PayArc | Hosted card fields | Cardholder data captured **in the provider's iframe**, not by us | US |
| Stripe | Hosted checkout (customer portal) | Cardholder name, email | US |
| Google (Maps JavaScript API) | Map rendering on customer-facing tracking pages | The viewer's IP address and page URL, in the viewer's browser | US |
| Anthropic | Optical character recognition of identity documents and citation notices, where a tenant enables it | Images of driving licences / identity documents and the fields extracted from them | US |
| OpenAI | Natural-language search and an operational planning assistant | Free-text queries; reservation context including customer names | US |

**Notes on the two AI providers.** These are used for document text-extraction and operational
tooling within the receiving tenant's own environment; they are listed here for completeness because
the question asks for a complete list of third parties. Data is not shared with them for any
independent purpose of theirs. See 3.16 regarding permitted use.

**Error monitoring.** Error reports sent to the monitoring provider (Sentry) pass through a
personal-data scrubber before transmission — the same class of redaction applied to application logs
— so field values in an error message are masked rather than sent.

**Notification of new or replacement sub-processors.** ______________________________
*(to be agreed — we propose 30 days' prior written notice with a right to object)*

**Data Privacy Framework certification of sub-processors.** ______________________________
*(to be confirmed per provider)*

---

## 3.5 Information received from the UK

| Field | Can we receive it? | Where it lands |
|---|---|---|
| First name | **Yes** | Customer record, first name |
| Last name | **Yes** | Customer record, last name |
| Telephone number | **Yes** | Customer record, telephone (normalised duplicate also stored for matching) |
| Email address | **Yes** | Customer record, email |
| Pickup date/time | **Yes** | Reservation, pickup timestamp (single date-time value) |
| Drop-off date/time | **Yes** | Reservation, return timestamp (single date-time value) |
| Requested vehicle/category | **Yes** | Mapped from an ACRISS code to our vehicle type via a configurable mapping |
| Reservation number / details | **Yes** | Stored as the external reference, unique per source system, and as the reservation's source reference |

**Passport information or images.** **We have no field for passport data of any kind.** The data
model cannot represent a passport number or image. We do not request it and would prefer not to
receive it.

**Driving licence information or images from the UK.** The inbound staging record has **no licence
fields**. Licence details are captured by us at the counter (see 3.6). If TL requires licence data
to be transmitted at booking time, that is new development and — given data minimisation — we would
want a stated purpose and retention period first.

**Additional fields required from the UK, and why.** We would additionally welcome, but do not
require: a **distinct drop-off location** (we currently cannot represent a one-way rental from an
inbound booking — both ends resolve to a single location); a **cancellation or amendment status**
with a version or update timestamp, so that a booking cancelled on TL's side can be reconciled
rather than remaining live; and a **flight number**, which we already stage but do not currently
carry through. Each of these is operational, not marketing.

---

## 3.6 Information collected in the US

Collected directly from the customer by the rental operator:

| Category | Detail | Required? |
|---|---|---|
| Name | First and last name | **Required** to finalise a rental |
| Contact | Telephone (required), email (optional) | Mixed |
| Date of birth | Stored on the customer record and copied to the contract | **Required where the branch enforces age rules**, otherwise optional |
| Address | Street (2 lines), city, state, postal code, country | Optional |
| Driving licence | Number (**required to finalise**), issuing state, expiry | Mixed |
| Driving licence / ID **images** | Front image and reverse image | Captured at kiosk check-out; optional at the counter |
| Insurance document | Uploaded document | Optional |
| Additional drivers | Name, telephone, email, licence number and state, date of birth, address | Optional. **The additional driver's licence image is read in the browser and discarded — only a boolean "image was shown" is stored.** |
| Signature | Handwritten signature captured on screen for terms, declined-insurance acknowledgement, per-section initials, damage acknowledgement and addenda — each with signer name, timestamp and **the signer's IP address** | Required for the relevant document |
| Rental agreement | Generated as a PDF on demand from live data | — |
| Vehicle | Assigned vehicle: registration plate, VIN, make, model, year, colour; mid-rental substitutions recorded | — |
| Collection / return | Contracted and actual timestamps, recorded separately (actual return is distinct from administrative closure) | — |
| Mileage and fuel | Odometer out (**required to finalise**) and in; fuel level out and in; append-only per-vehicle history | Mixed |
| Inspection photographs | Photographs at check-out and check-in, with condition fields (exterior, interior, tyres, lights, windscreen), capture timestamp, capturing user and IP. **No video is supported.** | — |
| Damage records | Damage location on a vehicle diagram, description, photographs, cost estimates, responsible-party assessment | As applicable |
| Incident reports | Report number, narrative, pre-rental condition, condition at return, cited contract clauses, certifying signature, evidence photographs | As applicable |
| Charges | Line items with code, type, quantity, rate, total, tax status | At least one required to finalise |
| Payments and pre-authorisations | Method, amount, status, timestamp, gateway reference; deposit hold identifier, amount, expiry and release/void status | As applicable |
| Tolls and citations | Toll transactions and citations attributed to the rental | As applicable |
| Vehicle telematics | GPS position and odometer, where a vehicle is equipped | As applicable |

**Collected because of a legal requirement.** *[DRAFT for counsel review — a starting assessment for
counsel to confirm or correct; not legal advice.]*

The principal category collected pursuant to a legal requirement is the **driving-licence
verification** performed at the point of rental: confirming a valid licence (licence number, issuing
state/territory and expiry, and in some jurisdictions physical presentation or a scan of the licence)
is required under the applicable state and territorial vehicle-rental and driver-licensing rules,
which differ by jurisdiction. **Date of birth** is collected where a jurisdiction or the operator's
insurer imposes a minimum-age requirement. **Tax and payment-transaction records** are retained to
meet federal and Puerto Rico tax and accounting obligations (see 3.10). All other categories in 3.6
are operational or loss-prevention, not legally compelled. *Counsel to confirm the specific statutes
and the exact data points each compels, per state and territory.*

**Optional / operational.** Email address, physical address, insurance document, flight number,
and photographs beyond the minimum condition record are collected for operational and
loss-prevention purposes rather than legal obligation.

---

## 3.7 Information returned to the UK

| Item requested | Available? | Notes |
|---|---|---|
| Completed rental agreement | **Yes** | Generated as a PDF on demand. We do not currently store an immutable executed copy — the document is re-rendered from live data. If TL requires a byte-identical copy of what the customer signed, a rendered copy can be stored at signature time; we recommend this and note it as integration work. |
| Customer / driver data | **Yes** | Name, contact, address, date of birth, licence number, state and expiry, as held on the contract |
| Additional drivers | **Partially** | Name, contact, licence, date of birth. **No address** is carried onto the contract, and **no licence image** exists (see 3.6). |
| Relevant ID / verification information | **Partially** | Licence number, state and expiry: yes. Identity document images: held, transferable if lawful. A verification *event* stamp currently exists for kiosk check-outs but not for counter check-outs. |
| Signature | **Yes** | With signer name, timestamp and IP address |
| Allocated vehicle | **Yes** | Plate, VIN, make, model, year, colour |
| Collection / return timestamps | **Yes** | Actual return is recorded separately from administrative closure |
| Mileage | **Yes** | Odometer out is guaranteed present; odometer in recorded at check-in |
| Fuel / charge status | **Yes** | Recorded as a fraction; not guaranteed present |
| Additional products / charges | **Yes** | Full line-item detail |
| Payment transaction information | **Yes** | See 3.8 for what is and is not safe to return |
| Pre-authorisation status | **Yes** | Hold identifier, amount, expiry, and whether released, captured or voided |
| Damage / incident information | **Yes** | Including photographs. The incident report is currently produced as print-to-HTML; a dedicated PDF renderer for it is not yet available. |
| Supporting documents | **Yes** | Inspection photographs, damage photographs, incident evidence, customer documents |

**Proposed API method, format and timing.** Two lifecycle events — *collected* and *returned* —
each emitted from the underlying reservation state rather than from the user interface, followed by
document transmission. We propose a manifest step (we declare the documents with type, size and
SHA-256 hash; TL replies with which it wants) followed by individual uploads, so that a failure
affects one document rather than restarting a batch.

**Failed or delayed transmissions.** Events are written to a durable queue in our database, not held
in memory. Retries follow an escalating schedule spanning approximately four days, ordered per
booking so that *returned* can never overtake *collected*. Permanent failures are flagged for human
attention rather than discarded. A reconciliation process independently derives, every five minutes,
any event that should have been sent and was not — so a transmission cannot be permanently lost
because of a software fault, a restart, or a TL outage. **A TL outage of any length causes queue
depth, not data loss, and has no effect on the rental counter.**

**Auditable record.** Yes — see 3.9 and Section 2. For each transmission we retain the content hash,
business and transmission timestamps, TL's acknowledgement reference, delivery status, attempt count
and last error, plus independent read-back verification where TL exposes it.

---

## 3.8 Payment processing and PCI

| Question | Response |
|---|---|
| Payment processor / acquirer and processing entity | Authorize.Net (default), Dejavoo / iPOSpays (card-present terminals), PayArc, Stripe. The merchant of record is ______________________________ |
| Where payment processing and storage take place | Entirely within the named processors' US environments |
| Do your systems receive or store full card numbers (PAN)? | **No.** There is no card-number field anywhere in our user interface. Card data is entered either on the physical terminal or into the processor's own hosted iframe, and never traverses our servers. |
| Is CVV/security-code data ever stored? | **No. It is never received, transmitted or stored by us at any point.** |
| Is payment data tokenised, and by whom? | **Yes, by the processor.** We hold only processor-issued tokens and profile identifiers. |
| Current PCI DSS compliance status and evidence | **PCI DSS Self-Assessment Questionnaire C (v4.0.1), assessed COMPLIANT on 10 June 2026**, via SecurityMetrics (an Approved Scanning Vendor), with a passing external vulnerability scan on the same date. A signed SAQ C and Attestation of Compliance (AOC) are available as evidence. The lowest-scope posture applies because no PAN or CVV is received, transmitted or stored by us (see below). |
| What payment/transaction information will be returned to the UK | Amount, currency, method, status, timestamp, gateway reference, authorisation code, card brand, card type (debit/credit), last four digits, expiry month/year, deposit hold amount and status |
| Confirmation that unnecessary full card credentials will not be returned or stored on UK servers | **Confirmed.** We could not return a PAN or CVV even if asked, because we do not hold them. We will additionally **not** return payment tokens or processor profile identifiers, since those are live payment credentials capable of initiating a charge. |

**One disclosure made proactively.** The card-present terminal's response includes the card BIN and
first four digits alongside the last four. These values cross our API boundary in the response but
are **not persisted** — only brand, type and last four are stored. We raise it because an assessor
will ask.

**One cleanup item we are addressing.** Our published internal API documentation contains an
example schema showing a card number and CVV for an endpoint that **does not exist and never
accepted such data** — the live endpoint accepts only processor profile identifiers and rejects
anything else. The stale example is being removed.

---

## 3.9 Technical and organisational security measures

| Measure | Status |
|---|---|
| Encryption in transit | **TLS 1.2 and TLS 1.3 only** — TLS 1.0 and 1.1 are rejected. Verified 23 Aug 2026; cipher suites `ECDHE-ECDSA-AES256-GCM-SHA384` (1.2) and `TLS_AES_256_GCM_SHA384` (1.3). HTTP redirects to HTTPS, and all outbound sub-processor connections use HTTPS. The application and API container ports are bound to loopback only, so the API is reachable solely through the TLS-terminating reverse proxy and never on a public address. |
| Encryption at rest | Provided by the database and storage platform (managed encryption at rest). Integration credentials are additionally encrypted at the field level with AES-256-GCM and a random per-write initialisation vector. Customer personal-data columns (for example licence number, date of birth, address, signature images) rely on the platform's storage-level encryption rather than application-level field encryption. |
| API authentication and authorisation | Bearer tokens (HS256), 12-hour lifetime for staff, verified against the database on every request. Layered role, module and capability gates as described in 3.3. Customer-facing document links use 192-bit random, database-expiry-enforced tokens. |
| User authentication, privileged access, MFA | TOTP two-factor authentication enforced for privileged accounts; see 3.3. |
| Role-based / least-privilege access | Implemented and regression-tested. See 3.3. |
| API, application, database and administrative logging | Request-level logging with PII redaction, plus a dedicated administrative/security audit trail (authentication, role and user changes, exports, erasures, impersonation). Container logs are size-rotated (10 MB × 5 per service). See 3.3. |
| Credential, secret, certificate and key management | Secrets are held as environment variables on the host, and no secrets are committed to source control (verified continuously by automated secret scanning over full git history). The field-encryption key is a single static key held off-repository; a dedicated key-management service / vault and automated key rotation are not currently in place. TLS certificates are issued by Let's Encrypt with automated renewal. |
| Security monitoring and alerting | Application error monitoring with alerting. A security information and event management (SIEM) system and network intrusion detection are not currently in place. |
| Vulnerability scanning and remediation | **Automated, report-first.** Continuous integration now runs, in a dedicated workflow separate from the functional/authorisation gates: dependency vulnerability auditing (`npm audit`, backend and frontend), automated dependency-update pull requests (Dependabot), static application security testing (CodeQL, JavaScript/TypeScript), secret scanning over full git history (gitleaks), and container image scanning of the production images (Trivy, HIGH/CRITICAL). These run on every push and pull request to the main branch, plus a weekly scheduled sweep. The posture is report-first — findings are surfaced and triaged rather than blocking merges — **with one live gate today: a newly committed secret fails the build.** A documented path to hard-gating the remainder (critical fixable direct-dependency vulnerabilities, new CodeQL alerts on the change under review, and fixable HIGH/CRITICAL container findings) is defined. Evidence: `doc/security-scanning-2026-08-22.md`. A formal, tracked remediation SLA and the promotion of the remaining scanners from warn to hard-gate are being finalised. |
| Penetration / security testing | A **dynamic application security scan** (OWASP ZAP — passive baseline plus an authenticated, OpenAPI-driven active scan) was performed against the running application. It found **no high-severity or exploitable issues** and confirmed multi-tenant isolation (no cross-tenant data access); the low- and medium-severity observations were addressed and re-verified. Evidence: `doc/dast-2026-08-23.md`. An independent third-party penetration test has not yet been commissioned, and this scanning is not presented as a substitute for one. |
| Backup security and restoration testing | Nightly full database backup, 30-day retention, transmitted over TLS. Client-side (GPG) encryption of the dump before upload is available and can be enabled. Scheduled restoration testing on a documented cadence is not yet in place. |
| Incident-response procedures | A formal written procedure is in preparation; see 3.11. |
| Security certifications or independent assurance | **None held.** No ISO 27001, no SOC 2. |
| Additional | Rate limiting at three layers (per-IP on authentication endpoints, per-tenant, and per-IP on customer-facing endpoints). Strict cross-origin allowlist in production. Upload validation by file magic header with size caps. All database access is parameterised. Security response headers are set on every response (`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`), with anti-clickjacking headers on server-rendered pages, and the framework fingerprint header is suppressed. Input validation is centralised in shared validators that return 400 on malformed input. A cloud firewall fronts the host with a **default-deny inbound policy**, permitting only the required service ports (SSH and HTTP/HTTPS) and denying all other inbound traffic, complementing the loopback-only application port binding described above. |

---

## 3.10 Retention, return and deletion

The platform implements a **configuration-driven retention regime** with a two-clock model, applied
by a scheduled sweep and backed by per-record purge markers in the data model:

- an **identity clock** — direct identifiers are removed after the claims-limitation period
  (approximately four years), and
- an **accounting clock** — the remaining transactional record is anonymised and retained for the
  tax and financial-records period (ten years).

The regime ships in a conservative mode and will be configured to the schedule agreed for the TL
integration before live UK data flows. A 30-day backup rotation and a short cleanup of a transient
user-interface table also apply.

| Category | Retention under the configured schedule | Basis |
|---|---|---|
| Reservation data | Identifiers removed at the identity clock; anonymised transactional record kept to the accounting clock | Claims-limitation / tax |
| Customer personal data | Identity clock (~4 years) | Claims-limitation period |
| Passport information / images | **Not applicable** — not collected | — |
| Driving licence information / images | Identity clock (~4 years), then removed / minimised | Claims-limitation; data minimisation |
| Rental agreements and signatures | Identity clock for personal data; accounting clock for the financial record | Contractual limitation / tax |
| Payment / transaction information | Accounting clock (10 years), anonymised | Tax and chargeback requirements |
| Vehicle / damage records and photographs | Claims-limitation period | Claims |
| API / system / security logs | Container logs size-rotated; audit trail aged under the sweep | Policy |
| Database backups | **30 days** | Company policy |

**Whether each period is policy or legal requirement.** *[DRAFT for counsel review — candidate
attribution for counsel to confirm or correct; not legal advice.]*

| Category | Proposed basis | Candidate authority |
|---|---|---|
| Tax / financial and payment-transaction records | **Legal** | Federal and Puerto Rico (Hacienda) tax and accounting record-keeping — candidate ~10 years |
| Rental-agreement / contract records (personal-data portion) | **Legal — limitation-based** | Contract claims-limitation period — candidate ~4 years (PR Civil Code / Act 55-2020) |
| Damage / personal-injury / incident claims | **Legal — limitation-based** | Tort / personal-injury limitation period — candidate ~1 year in PR, longer in some states |
| Driving-licence and identity data / images | **Policy — minimise** | No long statutory hold identified; retained for the rental and any live claim, then deleted / minimised |
| Database backups (30 days); transient UI cleanup | **Policy** | Company policy |
| API / system / security logs; audit trail | **Policy** | Operational-security policy |

The platform's two-clock model (identity ~4 years, accounting ~10 years) is built to implement
whichever schedule counsel confirms. *Counsel to confirm each period and its authority.*

**Ability to securely delete, anonymise or return data.** The platform provides a **single customer
erasure service** that, in one operation, covers the master customer record, its denormalised copies
on contracts and additional-driver records, signature images, staged inbound records and the
underlying stored document and photograph files. It applies an explicit statutory-retention
exception set — the accounting minimum described above — rather than leaving it implicit.
Administrative deletion of a customer who has reservations is handled correctly: a referential
conflict returns an accurate conflict response rather than a misleading "not found". The erasure
endpoint is disabled by default and will be enabled, under the agreed retention schedule, for the TL
integration. Deletion does not automatically propagate to sub-processors; where a sub-processor holds
a copy, deletion is requested from that processor.

**Deletion from backups.** Backups are full database snapshots on a 30-day rotation. An erasure
performed today is superseded from all backup media **within 30 days**. We cannot selectively
excise a record from an existing snapshot, and we would rather state that plainly than imply
otherwise.

---

## 3.11 Personal data breaches and incident management

A formal written incident-response procedure is in preparation and will be provided. In the interim,
security-relevant events are captured by the administrative audit trail and the error-monitoring and
alerting described in 3.3 and 3.9, which support detection, investigation and evidence preservation.

| Item | Response |
|---|---|
| Incident and breach-response procedure | To be provided — in preparation |
| 24/7 or escalation contact for an incident involving your data | ______________________________ |
| Proposed maximum notification timeframe after becoming aware | We propose **24 hours** from becoming aware, to give TL adequate margin within its own regulatory deadline. |
| Investigation, containment, remediation, evidence preservation | To be documented in the procedure above |
| Applicable federal, state and Puerto Rico breach-notification obligations | *[DRAFT for counsel review — not legal advice.]* Likely applicable: the data-breach notification statute of each US state in which an affected individual resides (all 50 states have one; thresholds and timing vary); the **Puerto Rico** data-security / breach-notification regime (notification to affected individuals and to the PR Department of Consumer Affairs / DACO); and federal sectoral obligations engaged by the data involved (e.g. the FTC Act, and GLBA where financial data applies). Where affected individuals are UK data subjects, TL's own UK GDPR deadlines (72 hours to the ICO) are also engaged — the reason we propose 24-hour notification to TL above. *Counsel to confirm the specific statutes, thresholds and deadlines.* |

---

## 3.12 Data subject / customer rights

| Right | Current capability |
|---|---|
| Access | **A per-subject data export is available**, assembling the data held about an individual across the tables that hold it into a single structured record. |
| Correction | **Yes.** Customer records are editable through the administrative interface. |
| Deletion | **Yes** — via the customer erasure service; see 3.10. |
| Restriction | Not implemented as a distinct restriction flag; a subject's data can be erased or their account de-activated. |
| Provision of copies / portability | Served by the per-subject export above — structured and machine-readable. |

**How data can be searched and exported for an individual.** Customers are searchable by name,
telephone and email. Documents are retrievable individually as short-lived signed links.

**Escalation of requests received directly by us.** We propose that any request concerning
UK-originating data received by us is acknowledged and referred to TL within **two business days**,
with the substantive response coordinated between the parties according to the roles agreed in the
contractual documentation.

The per-subject export described above assembles every table holding that person's data into a
single structured record.

---

## 3.13 US / Puerto Rico legal and regulatory requirements

*[DRAFT for counsel review — a starting assessment for counsel to confirm, correct or replace; not
legal advice. We would rather have counsel confirm the applicable set than assert one.]*

| Area | Candidate assessment |
|---|---|
| Vehicle-rental statutes | State / territorial rental-industry rules (permitted charges, required disclosures, damage / loss handling) apply per operating location. |
| Driver licensing / identity verification at rental | A valid-licence check at the point of rental is required; the data points and any scan / retention rules differ by jurisdiction (see 3.6). |
| Data-breach notification | State breach-notification statutes plus the Puerto Rico regime (see 3.11). |
| Payment-card (PCI) obligations | Contractual PCI DSS obligations with the card brands / acquirer; current status SAQ C (see 3.8). |
| Tax / accounting retention | Federal and PR (Hacienda) record-keeping — candidate ~10 years (see 3.10). |
| Toll / traffic-citation processing | State / territorial toll-authority and citation-processing rules governing attribution and pass-through of charges to the renter. |

*Counsel to confirm the applicable set and the specific requirements in each area.*

---

## 3.14 International and onward transfers

| Question | Response |
|---|---|
| Will UK-originating information transfer from Puerto Rico to the mainland US or vice versa? | **Not applicable.** No data is stored or processed in Puerto Rico. Users of the platform located in Puerto Rico access systems hosted in the mainland United States. |
| Will it be transferred outside the United States or its territories? | **No.** All processing, storage, backup and sub-processing occurs within the United States. |
| Every group company, processor, sub-processor or third party to which it may be disclosed | The complete list is in 3.4. Group companies: ______________________________ |
| Any remote access from outside the United States / Puerto Rico | ______________________________ |
| For every onward transfer: recipient, location, purpose, data categories, safeguards | See 3.4 for recipient, location, purpose and data categories. Contractual safeguards with each provider: ______________________________ |

---

## 3.15 Data Privacy Framework status

| Question | Response |
|---|---|
| EU–US Data Privacy Framework certification? | **No. The receiving organisation is not certified.** |
| UK Extension? | **No.** The UK Extension cannot be held independently; it is elected as part of an EU–US DPF self-certification, which we have not undertaken. |
| Any parent, subsidiary or associated company with such certification? | ______________________________ |
| Any hosting or sub-processing provider with such certification? | ______________________________ *(to be confirmed per provider in 3.4)* |

We confirm we are not relying on the UK–US Data Bridge, and we understand an alternative transfer
mechanism will be required.

---

## 3.16 Permitted use of customer information

**Confirmed.** UK-originating personal data will be used only to fulfil and administer the rental,
provide the agreed services, address legitimate fraud and security risks, and comply with applicable
legal obligations.

**Confirmed.** Without TL's prior written authorisation, UK-originating personal data will not be
sold, rented, or commercially shared with unrelated third parties; will not be used for unrelated
marketing, profiling or data mining; will not be used to train artificial intelligence or machine
learning models; and will not be combined with unrelated databases for another commercial purpose.

The third-party services listed in 3.4 process data solely to deliver the specific function
described against each entry, under contract, and for no independent purpose of their own.

---

# Section 4 — Documents and evidence requested

| Document | Status |
|---|---|
| Current privacy policy / data protection policy | **Exists** — published on the platform. Being reviewed against the requirements of this request before submission. |
| Current information-security policy or security overview | **Provided** — as a standalone information-security policy, consistent with Section 3.9. |
| Current sub-processor list | **Provided** — Section 3.4 above, and as a standalone maintained sub-processor list. |
| Data-retention schedule / policy | **Provided** — as a standalone data-retention schedule; formalises Section 3.10. |
| Data-breach / incident-response procedure | **Provided** — as a standalone incident-response procedure; formalises Section 3.11. |
| PCI DSS evidence | **Available** — PCI DSS SAQ C (v4.0.1) with Attestation of Compliance, assessed COMPLIANT 10 June 2026 via SecurityMetrics; see 3.8. |
| Security certifications or independent audit / assurance reports | No ISO 27001 or SOC 2 is held. A dynamic application security scan report is available (see 3.9); an independent penetration-test report is not. |
| Network / data-flow or architecture diagram | **Provided** — a standalone architecture and data-flow diagram showing the systems in 3.2, the sub-processors in 3.4, and the inbound/outbound flows in Section 2. |
| API security / integration documentation for the collect-and-push process | **In preparation** — will be produced jointly, once TL provides the API details listed below. |

---

# What we need from TL to complete the design

These block technical design and are therefore on the critical path alongside the assessment:

1. Base URLs for production and a test environment; authentication method; who issues credentials
   and how they are rotated.
2. Whether the booking feed carries amendments and cancellations, with what status vocabulary, and
   whether each booking carries a monotonic update timestamp or version for delta retrieval.
3. Whether "returned and the rental completed" means the vehicle is back or the balance is settled —
   and whether both warrant separate events.
4. Endpoints and payload shapes for the collected and returned events; the idempotency key header
   and its behaviour on replay; which response codes mean retry and which mean never retry; and
   whether a read-back endpoint exists so we can independently verify delivery.
5. Document upload: transport format, maximum size, accepted media types, whether a manifest and
   deduplication step is supported, and which documents are mandatory. **Specifically: do you want
   to receive customer identity and licence images at all?** Under data minimisation we would prefer
   not to transmit them without a stated lawful basis and retention period on your side.
6. Whether US hosting as described in 3.2 is acceptable, or whether UK/EU data residency is
   required. Residency would be a separate infrastructure programme and we need to know before we
   design, not after.
7. A test environment with sample bookings, and **your** acceptance criteria for go-live.
8. Rate limits, maintenance windows, and versioning and deprecation policy.

---

# Our position on sequencing

We accept that live UK personal data must not flow until the assessment is complete and the
contractual, transfer and technical safeguards are approved and in place.

We propose to begin development immediately against **synthetic test data only**, with that
constraint enforced technically rather than by policy: the integration defaults to disabled, a
sandbox mode refuses to connect to any host outside an explicit allowlist, and live mode refuses to
start unless the required contractual attestations are recorded in configuration. We would rather
make the constraint impossible to breach than rely on remembering it.

The items noted above as in preparation — the standalone information-security policy, the retention
schedule document, the incident-response procedure, and the architecture / data-flow diagram — are
being progressed in parallel.
