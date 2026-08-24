# Sub-processor Data Privacy Framework (DPF) status — research findings

**Checked:** 2026-08-24 · **For:** DDQ 3.15 (“Any hosting or sub-processing provider with such
certification?”) and the DPF column of the sub-processor list.

> **How to use this.** Rows marked ✅ **verified** were confirmed from the provider's own DPF
> statement/policy. Rows marked ⚠️ **to verify** were not confirmed — do **not** state them as
> certified until checked. Authoritative source: the official participant list at
> **https://www.dataprivacyframework.gov/list** (search the company's legal name).
>
> **Certification status changes** (annual re-certification), so re-check before submitting and
> periodically thereafter.

---

## Findings

| Provider | EU–US DPF | **UK Extension** | Status |
|---|---|---|---|
| **Amazon Web Services** (underlies Supabase — holds all personal data) | Yes | **Yes** | ✅ verified |
| **DigitalOcean, LLC** (hosting, cache, backups) | Yes | **Yes** | ✅ verified |
| **Sentry** (Functional Software, Inc.) | Yes | **Yes** | ✅ verified |
| **Google LLC** (Maps) | Yes | **Yes** | ✅ verified |
| **Twilio Inc.** (SMS) | Yes | **Yes** | ✅ verified |
| **Telnyx** (default SMS) | Yes | **Yes** | ✅ verified |
| **Stripe, Inc.** (hosted checkout) | Yes | **Yes** (Active) | ✅ verified |
| **Supabase, Inc.** (database + object storage) | **No** | **No** | ✅ verified — **not** DPF-certified; relies on **EU SCCs + the UK Addendum + a Transfer Impact Assessment** (per their DPA) |
| **OpenAI** | Yes (Active) | *not confirmed* | ⚠️ verify the UK Extension on the DPF list |
| **Anthropic** | Yes (Active) | *not confirmed* | ⚠️ verify the UK Extension on the DPF list |
| **Authorize.Net** (Visa) | — | — | ⚠️ to verify |
| **PayArc** | — | — | ⚠️ to verify |
| **Dejavoo / iPOSpays** | — | — | ⚠️ to verify |
| **MailerSend / Resend** (email) | — | — | ⚠️ to verify |
| **Plivo** (SMS, alternate) | — | — | ⚠️ to verify |
| **Axiom** (security log aggregation) | — | — | ⚠️ to verify |

---

## Suggested wording for DDQ 3.15

> **Any hosting or sub-processing provider with such certification?**
>
> **Yes — several.** The providers underpinning our infrastructure and the majority of personal-data
> processing participate in the EU–U.S. Data Privacy Framework **including the UK Extension**:
> Amazon Web Services (which underlies our managed database and object storage), DigitalOcean,
> Google, Sentry, Stripe, Twilio and Telnyx. Our managed-database provider, Supabase, is **not**
> DPF-certified and instead relies on the EU Standard Contractual Clauses together with the UK
> Addendum and a transfer impact assessment. The remaining providers are being confirmed individually
> against the DPF list.

*(Adjust once the ⚠️ rows are checked. Note the receiving organisation itself is not DPF-certified —
that answer is unchanged.)*

---

## Why this strengthens the response

TL's underlying concern is the **lawful basis for transferring UK personal data to the US**. Even
though the receiving organisation is not DPF-certified, showing that the infrastructure carrying the
data is largely DPF/UK-Extension covered — and that the one significant exception (Supabase) has SCCs
plus the UK Addendum in place — demonstrates the onward-transfer chain is properly covered rather
than unexamined.

---

## Sources

- AWS — https://aws.amazon.com/compliance/eu-us-data-privacy-framework/
- DigitalOcean — https://www.digitalocean.com/legal/privacy-policy
- Sentry — https://sentry.io/privacy/
- Google — https://policies.google.com/privacy/frameworks
- Twilio — https://www.twilio.com/en-us/legal/privacy
- Telnyx — https://telnyx.com/privacy-policy
- Stripe — https://stripe.com/legal/data-privacy-framework
- Supabase (SCCs + UK Addendum) — https://supabase.com/legal/dpa
- Official DPF participant list — https://www.dataprivacyframework.gov/list
