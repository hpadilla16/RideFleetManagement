# Cover email — transmitting the DDQ response to TL International

**Draft, 2026-08-24.** Fill the bracketed fields (sender identity ties to DDQ 3.1). Send with the DDQ
response + the Section 4 documents attached.

---

**To:** [TL International contact]
**From:** [Your name / title / entity]
**Subject:** Response to your Data Protection & Integration Information Request — RideFleetManagement

---

Dear [name],

Thank you for your data protection and integration information request. Please find attached our
completed response, covering **Sections 2, 3 and 4** of your request, together with the supporting
documents you asked for.

Every technical statement in the response was **verified against our running production system and
source code**, not drawn from documentation or assumption. Where a control is not yet in place, we say
so plainly.

**What is included:**

- **DDQ response** (Sections 2–4) — the proposed data journey, the information you require, and the
  documents/evidence requested.
- **Information-security policy**
- **Data-retention schedule**
- **Incident-response procedure**
- **Sub-processor list**
- **Architecture / data-flow diagram**
- **PCI DSS evidence** — SAQ C (v4.0.1), Attestation of Compliance

**A few points we would highlight:**

- **Hosting is entirely in the mainland United States** (New Jersey and Virginia); no production
  system, database, backup or replica is located in Puerto Rico. The Puerto Rico connection is
  corporate (a franchisee that uses the platform), not a hosting location.
- We have implemented a substantial set of security measures — including two-factor authentication for
  privileged accounts, an administrative/security audit trail, application-level field encryption of
  the most sensitive personal data with AWS KMS-managed keys, a default-deny cloud firewall, HSTS,
  centralised security-log aggregation, and an automated vulnerability-scanning and dynamic-scan
  programme (no high-severity or exploitable findings; multi-tenant isolation verified).
- We are pursuing an independent **SOC 2 Type II** attestation; that programme is under way.

**On sequencing:** we accept that live UK personal data must not flow until the assessment is complete
and the contractual, transfer and technical safeguards are approved. We propose to begin development
immediately against **synthetic test data only**, enforced technically rather than by policy.

**To complete the integration design**, we will need the API details set out at the end of the
response (base URLs, authentication, the booking-feed and event contracts, document upload, and your
acceptance criteria). We would welcome a working session on those once you have reviewed this response.

We are happy to discuss any part of this, or to provide further detail.

Kind regards,

[Your name]
[Title]
[Entity]
[Contact]
