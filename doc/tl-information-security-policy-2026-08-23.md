# Information Security Policy

**Owner:** [responding organisation — to be completed]
**Version:** 1.0 · **Effective date:** 2026-08-23 · **Review cadence:** at least annually, and on
material change.

> Prepared as the standalone information-security policy requested in Section 4 of the TL
> International information request. It describes controls that are in place today; where a control is
> planned rather than in place, it is marked **(planned)**. It is consistent with Section 3.9 of the
> DDQ response.

---

## 1. Purpose and scope

This policy sets out how the RideFleetManagement (RFM) platform protects the confidentiality,
integrity and availability of the data it processes — including personal data of rental customers —
and the systems that hold it. It applies to all production systems, staff and administrators with
access, and the third-party providers engaged to deliver the service (the sub-processor list).

## 2. Roles and responsibilities

- **Platform operator** — owns this policy, the production environment, access administration and
  incident response.
- **Tenant administrators** — manage their own tenant's staff and data within the access model below.
- All persons with access are responsible for protecting their credentials and for using access only
  as required for their role.

## 3. Access control and authentication

- **Role-based access control** with four roles (`SUPER_ADMIN`, `ADMIN`, `OPS`, `AGENT`) enforced as
  middleware on every route. Tenant scoping is **fail-closed**: a user without a tenant assignment
  matches zero records, never all records. A client-supplied location filter can only narrow, never
  widen, the caller's permitted scope. Money-handling routes require an explicitly granted capability.
- **Two-factor authentication (TOTP)** is enforced for `SUPER_ADMIN` and `ADMIN` accounts, using
  authenticator-app enrolment with encrypted secrets and single-use backup codes.
- **Passwords** are hashed with bcrypt and must be at least 12 characters with mixed case, a digit
  and a symbol. Authentication endpoints are rate-limited per IP address.
- **Sessions** are 12-hour bearer tokens verified against the database on every request. Deactivating
  a user, changing a password or resetting two-factor authentication terminates existing sessions
  within 30 seconds.
- **Least privilege / review** — access is granted per role and reviewed on change; machine/service
  accounts run against a default-deny endpoint allowlist.

## 4. Data protection

- **In transit:** TLS 1.2 / 1.3 only (TLS 1.0/1.1 rejected); HTTP redirects to HTTPS; all outbound
  sub-processor connections use HTTPS. Application/API ports are bound to loopback and reachable only
  through the TLS-terminating reverse proxy.
- **At rest:** managed encryption at rest is provided by the database and storage platform.
  Integration credentials are additionally field-encrypted (AES-256-GCM, random per-write IV).
  Application-level field encryption of customer personal-data columns is **(planned)**.
- **Payment data:** no full card number (PAN) or CVV is received, transmitted or stored by RFM; card
  data is captured on the processor's hosted fields or the physical terminal. PCI DSS SAQ C
  (COMPLIANT, 2026-06-10).
- **Minimisation:** only the data required to fulfil and administer a rental is collected and
  transferred; passport data is not collected.

## 5. Logging, monitoring and audit

- **Request logging** for every API call (request id, method, path, status, duration, client IP,
  user agent, user id, tenant id), with a redaction layer masking personal-data fields; request and
  response bodies are not logged.
- **Administrative / security audit trail** recording authentication and logout, role and user
  changes, password resets, data exports and erasures, and administrative impersonation (which is
  stamped so actions are attributable to the operator, not the tenant's staff).
- **Error monitoring** (Sentry) with a personal-data scrubber applied before transmission and
  alerting on failures. Container logs are size-rotated.
- **Security information and event management (SIEM) / intrusion detection** are **(planned)**.

## 6. Vulnerability and patch management

- Continuous integration runs dependency vulnerability auditing (`npm audit`), automated
  dependency-update pull requests (Dependabot), static application security testing (CodeQL), secret
  scanning over full git history (gitleaks), and container image scanning (Trivy, HIGH/CRITICAL), on
  every push/PR to the main branch plus a weekly sweep. A newly committed secret fails the build; a
  documented path to hard-gating the remaining scanners is defined.
- A **dynamic application security scan** (OWASP ZAP, authenticated) is performed against the running
  application; findings are triaged and remediated. An independent third-party penetration test is
  **(planned)**.

## 7. Secure development

- Changes are made on branches and merged to the production branch after review; an extensive
  automated regression suite (including authorisation, tenant-isolation and money-path guards) runs
  in CI. All database access is parameterised. Input is validated by shared validators that reject
  malformed input. Security response headers are set on every response.

## 8. Network and host security

- A **cloud firewall** fronts the host with a default-deny inbound policy, permitting only the
  required service ports (SSH and HTTP/HTTPS) and denying all other inbound traffic.
- A strict cross-origin (CORS) allowlist applies in production; uploads are validated by file magic
  header with size caps.

## 9. Backup and recovery

- Nightly full database backup, 30-day retention, transmitted over TLS to object storage in the US.
  Client-side (GPG) encryption of the dump before upload is available and can be enabled. The
  database platform provides point-in-time recovery. Scheduled restoration testing on a documented
  cadence is **(planned)**.

## 10. Sub-processors and third parties

Third parties are engaged only to deliver the specific function assigned to each, under contract, and
process data for no independent purpose of their own. All current sub-processors are US-based and are
listed in the maintained sub-processor list. New or replacement sub-processors are notified per the
agreed change process. Personal data is not used to train third-party AI/ML models.

## 11. Data retention and deletion

Retention follows the retention schedule (a two-clock model: identity ~4 years, accounting ~10
years, subject to counsel confirmation). A single customer erasure service covers the master record,
denormalised copies, signature images, staged records and stored files, subject to an explicit
statutory-retention exception. See the retention schedule document.

## 12. Incident response

Security incidents are handled per the incident-response procedure, including detection,
containment, investigation, evidence preservation and notification. See that document for the
escalation contacts and timelines.

## 13. Physical and environmental

Production runs entirely on managed cloud infrastructure (DigitalOcean, Supabase-on-AWS) in the
United States; physical and environmental controls are the providers' responsibility under their
own certifications. RFM operates no owned production hardware.

## 14. Compliance and review

RFM holds no ISO 27001 or SOC 2 certification. This policy is reviewed at least annually and on
material change, and is maintained alongside the retention schedule, incident-response procedure and
sub-processor list.
