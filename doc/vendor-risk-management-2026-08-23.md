# Vendor / Third-Party Risk Management Policy

**Owner:** [responding organisation] · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** annually
and on vendor change.

> Readiness deliverable (compliance roadmap). Defines how third-party providers (sub-processors) are
> assessed, contracted, monitored and off-boarded. Builds on the sub-processor list.

---

## 1. Principle

A third party is engaged only when necessary, is given only the data required for its function, and
is assessed for security and privacy before it processes data.

## 2. Onboarding a new vendor

Before a new sub-processor handles data:

1. **Justify** the need and the minimum data it will access.
2. **Assess** its security posture — obtain its SOC 2 / ISO 27001 report or security documentation;
   confirm data-residency (US, per our requirement) and encryption in transit/at rest.
3. **Contract** — a data-processing agreement (DPA) with confidentiality, security, breach-notice and
   sub-processing terms.
4. **Record** it in the vendor register + sub-processor list, and notify TL per the agreed process.

## 3. Vendor register

| Vendor | Function | Data | Location | Assurance (SOC2/ISO/DPF) | DPA | Last review |
|---|---|---|---|---|---|---|
| DigitalOcean | Hosting / cache / backups | in-transit; cached; backups | US (NJ) | ______ | ______ | ______ |
| Supabase (AWS) | DB + object storage | all personal data | US (VA) | ______ | ______ | ______ |
| Sentry | Error monitoring | scrubbed diagnostics | US | ______ | ______ | ______ |
| MailerSend / Resend | Email | name, email, res. details | US | ______ | ______ | ______ |
| Telnyx / Twilio / Plivo | SMS | mobile, name, refs | US | ______ | ______ | ______ |
| Authorize.Net | Payments | name, billing, token | US | ______ | ______ | ______ |
| Dejavoo / iPOSpays | Card-present | card at terminal | US | ______ | ______ | ______ |
| PayArc | Hosted fields | card in iframe | US | ______ | ______ | ______ |
| Stripe | Hosted checkout | name, email | US | ______ | ______ | ______ |
| Google (Maps) | Map rendering | viewer IP/URL | US | ______ | ______ | ______ |
| Anthropic | OCR | ID images + fields | US | ______ | ______ | ______ |
| OpenAI | NL search / assist | queries + res. context | US | ______ | ______ | ______ |
| Axiom | Security log aggregation / SIEM | audit events (staff email, IP, action) | US | ______ | ______ | ______ |

*(Assurance / DPA / last-review columns to be completed as each vendor's documentation is gathered —
Vanta can automate collection of many of these.)*

## 4. Ongoing monitoring

- **Annual** re-assessment of each vendor's assurance report and any material changes.
- Track vendor security incidents that could affect our data.
- Personal data is **not** used to train any vendor's AI/ML models (contractually confirmed).

## 5. Off-boarding

When a vendor is retired, confirm deletion/return of our data, revoke credentials/integrations, and
update the register + sub-processor list.

## 6. Evidence

The vendor register, collected assurance reports and DPAs, and review records serve as SOC 2 evidence.
