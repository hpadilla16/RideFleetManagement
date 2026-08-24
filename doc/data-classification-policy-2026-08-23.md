# Data Classification Policy

**Owner:** [org] · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** annually.

> Readiness deliverable (compliance roadmap). Defines classification tiers and the handling rules per
> tier, so controls (encryption, access, retention) are applied proportionately.

---

## 1. Classification tiers

| Tier | Definition | Examples |
|---|---|---|
| **Restricted** | Sensitive personal data; disclosure causes real harm | Driving-licence number + images, date of birth, signatures, home address |
| **Confidential** | Personal or business data not for public release | Name, email, telephone, reservation/rental records, payment tokens/last4 |
| **Internal** | Operational data, not personal | System logs (redacted), configuration, telemetry |
| **Public** | Intended for public release | Marketing showcase, public vehicle-class listings |

## 2. Handling rules

| Control | Restricted | Confidential | Internal | Public |
|---|---|---|---|---|
| Encryption in transit | TLS required | TLS required | TLS required | TLS default |
| Encryption at rest | Platform + **field-level (Phase 1)** | Platform | Platform | n/a |
| Access | Least-privilege, role + capability gated | Role gated, tenant-scoped | Role gated | Open |
| Logging of the value | Never (redacted) | Never in bodies | Redacted | n/a |
| Retention | Per retention schedule (identity clock) | Per retention schedule | Rotated | n/a |
| Sharing with sub-processors | Only the minimum required, under DPA | Minimum required | As needed | n/a |

## 3. Notes

- **No PAN/CVV** is stored (payment data stays with the processors) — the highest card-data tier does
  not exist in our systems by design.
- **Passport data** is not collected.
- The asset & data inventory maps each stored data category to its tier.

## 4. Review

Reviewed annually and when a new data category is introduced.
