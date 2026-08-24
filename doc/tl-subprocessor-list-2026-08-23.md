# Sub-processor List

**Owner:** [responding organisation — to be completed]
**Version:** 1.0 · **Effective date:** 2026-08-23 · **Maintained:** updated on any addition or
replacement.

> The maintained standalone sub-processor list requested in Section 4 of the TL International
> information request; formalises Section 3.4 of the DDQ response. **All sub-processors are located in
> the United States. None is located in Puerto Rico.**

---

## Sub-processors

| # | Provider | Service / purpose | Categories of data accessed | Location | DPF status* |
|---|---|---|---|---|---|
| 1 | **DigitalOcean, LLC** | Application/API hosting; managed Redis cache; backup object storage (Spaces) | All data in transit through the application; cached responses; full database backups | US — NYC3 (New Jersey) | ______ |
| 2 | **Supabase, Inc.** (on AWS) | Managed PostgreSQL; object storage for documents and photographs | **All personal data**, incl. identity documents, signatures, inspection photographs | US — `us-east-1` (Virginia) | ______ |
| 3 | **Sentry** | Application error monitoring | Error messages, stack traces, diagnostic context (PII-scrubbed before transmission) | US | ______ |
| 4 | **MailerSend / Resend** | Transactional email | Recipient name, email, reservation details | US | ______ |
| 5 | **Telnyx** (default), **Twilio**, **Plivo** | Transactional SMS | Mobile number, name, reservation references | US | ______ |
| 6 | **Authorize.Net** | Payment processing; stored payment profiles | Cardholder name, billing address, payment token | US | ______ |
| 7 | **Dejavoo / iPOSpays** | Card-present terminal processing | Card data captured **at the terminal**, not by RFM | US | ______ |
| 8 | **PayArc** | Hosted card fields | Cardholder data captured **in the provider's iframe**, not by RFM | US | ______ |
| 9 | **Stripe** | Hosted checkout (customer portal) | Cardholder name, email | US | ______ |
| 10 | **Google** (Maps JavaScript API) | Map rendering on customer-facing tracking pages | The viewer's IP address and page URL, in the viewer's browser | US | ______ |
| 11 | **Anthropic** | OCR of identity documents / citation notices (where a tenant enables it) | Images of driving licences / identity documents and the fields extracted | US | ______ |
| 12 | **OpenAI** | Natural-language search and an operational planning assistant | Free-text queries; reservation context incl. customer names | US | ______ |
| 13 | **Axiom, Inc.** | Security/audit log aggregation (SIEM): centralises the administrative/security audit trail for retention, search and alerting | Administrative/security audit events — staff actor email/role/id, tenant id, IP, user agent, action, target, outcome, timestamp. **No customer personal data.** | US (US data region) | ______ |

*\*DPF status = whether the provider self-certifies under the EU–US Data Privacy Framework; to be
confirmed per provider.*

## Notes

- **Purpose limitation.** Each provider processes data solely to deliver the specific function above,
  under contract, and for no independent purpose of its own. Personal data is **not** used to train
  any provider's AI/ML models.
- **Payment providers (6–9).** RFM never receives, transmits or stores a full card number (PAN) or
  CVV; card data is handled within the processors' own PCI-scoped environments.
- **AI providers (11–12).** Used for document text-extraction and operational tooling within the
  receiving tenant's environment; listed here for completeness.

## Change management

New or replacement sub-processors are added to this list and notified to TL in advance, per the
process agreed in the contractual documentation *(proposed: 30 days' prior written notice with a
right to object — to be agreed)*.
