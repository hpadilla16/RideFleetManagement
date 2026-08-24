# Brief for the Ride website team — update the public Security page

**Date:** 2026-08-24 · **From:** Engineering · **Goal:** refresh the public Security page to reflect
the security work completed on the RideFleetManagement platform.

> **Read this first.** Everything in the "Approved claims" section below is **verified and true today**
> — you can publish it. Everything in the "Do NOT claim" section is **false today** and must not
> appear in any form, including softened marketing phrasing. A public security page is a
> representation customers and partners rely on; an inaccurate claim is a liability, not a nice-to-have.
> When in doubt, ask Engineering before publishing.

---

## What changed (context)

We completed a substantial security programme driven by an enterprise partner's due-diligence review.
The Security page should now reflect a materially stronger posture.

---

## ✅ Approved claims — verified true, safe to publish

Use these as the source of truth. Rephrase for tone, but **do not strengthen the meaning**.

### Data protection & encryption
- All data is encrypted **in transit** using **TLS 1.2 and 1.3** (older, weaker protocols are
  rejected), with HTTP Strict Transport Security enforced.
- Data is encrypted **at rest**.
- The **most sensitive personal data** — driver's licence numbers, dates of birth, street addresses and
  signatures — receives **additional application-level encryption (AES-256)**, so it is never stored in
  readable form in our database.
- Encryption keys are **managed through a dedicated key-management service** and are not stored in
  plain text on our servers.

### Payments
- **PCI DSS compliant** — validated under **SAQ C (v4.0.1)**, most recently **June 2026**, through an
  Approved Scanning Vendor.
- **We never store full card numbers or security codes (CVV).** Card data is captured directly by our
  payment processors — on their hosted payment fields or the physical card terminal — and never
  touches our servers. We hold only processor-issued tokens and the last four digits.

### Access control
- **Two-factor authentication (2FA)** is **enforced for all staff accounts** on the platform.
- **Role-based access control** with least-privilege roles, enforced on every request.
- **Strict account separation** — each company's data is isolated from every other company's, enforced
  at the data layer and verified by automated testing.
- Strong password requirements, rate-limited logins, and **sessions revoked within 30 seconds** when
  an account is deactivated or its password is changed.

### Monitoring & auditing
- A dedicated **security audit trail** records administrative and security-relevant activity —
  sign-ins, permission changes, data exports and administrative access.
- Security events are **centralised into a dedicated log-management platform** with alerting.
- Application error monitoring, with personal data automatically scrubbed before it leaves our systems.

### Testing & vulnerability management
- **Automated security scanning on every code change**: dependency vulnerability scanning, static
  application security testing, secret scanning, and container image scanning.
- **Dynamic security testing** performed against the running application — **no high-severity or
  exploitable issues were identified**, and account isolation was verified.
- A documented vulnerability-management policy with defined remediation targets.

### Infrastructure & availability
- Hosted entirely in the **United States** with reputable cloud providers. *(Optional detail if you
  want it: application infrastructure in New Jersey; primary database in Northern Virginia.)*
- A **default-deny cloud firewall** — only the services required to run the product are reachable.
- Application services are **not directly exposed to the public internet**; all traffic passes through
  a secured, TLS-terminating gateway.
- **Nightly encrypted backups** with 30-day retention, plus point-in-time recovery.
- **Zero-downtime deployments** with automated health checks.

### Privacy & data rights
- Customers can request a **complete export of the personal data** we hold about them.
- We support **secure deletion / erasure** of personal data, subject to legally required retention.
- A published **data-retention schedule** governs how long each category of data is kept.
- A documented **incident-response procedure** with a commitment to prompt notification.

### Governance
- Documented **information-security policy**, **access-control policy**, **change-management policy**,
  **vendor risk-management policy** and **business-continuity plan**.
- A maintained **list of sub-processors**.

---

## ❌ Do NOT claim — these are NOT true today

Publishing any of these would be inaccurate:

- ❌ **"SOC 2 certified" / "SOC 2 compliant" / "SOC 2 audited"** — we are **not**. A SOC 2 Type II
  programme is *under way* but no report exists.
- ❌ **"ISO 27001 certified"** — we are not, and it is not in progress.
- ❌ **"Penetration tested" / "third-party security audit"** — no independent penetration test has been
  performed. (We do automated and dynamic scanning — that is what may be claimed, in those words.)
- ❌ **"HIPAA compliant"**, **"GDPR certified"** — not applicable / not a thing.
- ❌ **"Bank-level / military-grade encryption"** — meaningless marketing phrasing; say what we
  actually use (TLS 1.2/1.3, AES-256).
- ❌ **"All data is encrypted end-to-end"** — inaccurate as stated. Use the wording in the approved
  section.
- ❌ **"Zero breaches ever" / absolute guarantees** ("your data is 100% safe", "unhackable") — never
  make absolute security promises.
- ❌ Any **specific internal detail**: server names, IP addresses, exact software versions, key names,
  vendor account identifiers, or internal architecture specifics.

### If you want to mention the SOC 2 work

The only acceptable phrasing is future/progress-framed and must not imply a report exists — e.g.:
> "We are pursuing SOC 2 Type II attestation; our compliance programme is under way."

Prefer to **omit it entirely** until the report is issued. Ask Engineering before publishing any
version of this line.

---

## Tone & structure suggestions

- Group by theme (Encryption · Access control · Payments · Monitoring · Privacy · Infrastructure) —
  the order above works well.
- Plain language over jargon; a customer should understand each bullet.
- Add a **"last updated: August 2026"** line — security pages age badly without one.
- Consider a **contact for security concerns** (e.g. a `security@` address) so researchers can report
  issues responsibly. *(Confirm with Hector that the mailbox exists and is monitored before publishing
  it.)*

---

## Before publishing

Send the drafted copy back to Engineering for a factual accuracy check. This is a partner-facing
representation — it is worth the extra round-trip.
