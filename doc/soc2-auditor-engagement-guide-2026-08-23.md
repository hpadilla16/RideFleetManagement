# SOC 2 Auditor (CPA firm) — Engagement Guide

**Date:** 2026-08-23 · **Context:** readiness platform selected = **Vanta**.

> A SOC 2 report can only be issued by an **independent licensed CPA firm** (AICPA). The readiness
> platform (Vanta) prepares and continuously collects the evidence; the CPA firm performs the audit
> and issues the report. This guide is the practical path to engaging one.

---

## 1. The easy path: use Vanta's auditor network

Vanta partners with a marketplace of **vetted SOC 2 audit firms** and pipes your collected evidence
straight to them. This is the lowest-friction route:

1. Complete Vanta onboarding and connect the integrations (cloud, code, HR, etc.) so evidence
   auto-collects.
2. In Vanta, request auditor quotes from its partner network (they know the Vanta workflow, so the
   audit is faster and cheaper).
3. Pick a firm, sign the engagement letter, and schedule the audit window.

You can also bring your **own** CPA firm — Vanta still feeds them evidence — but a Vanta-network firm
is usually the fastest first SOC 2.

## 2. What to look for in the firm

- **Licensed CPA firm** that performs SOC 2 attestations (ask for their peer-review status).
- **Experience with SaaS / your stack** (cloud-hosted, multi-tenant).
- **Vanta (or your platform) experience** — cuts audit time materially.
- **Clear scope**: Type I vs Type II, and which Trust Services Criteria (see §4).
- **References** and turnaround time.

## 3. Questions to ask each firm

- Do you do SOC 2 **Type II**, and how long is your typical observation window?
- Do you work inside **Vanta**? Can you consume its evidence directly?
- What's the all-in cost, and what's included (readiness review? the report? a bridge letter later)?
- Timeline from kickoff to issued report?
- Who signs the report, and what's their CPA licensure?

## 4. Scope decisions (yours to make before signing)

- **Type I first, then Type II?** Type I (point-in-time) can be issued in ~2–3 months as an interim
  proof while the Type II observation window runs. Recommended.
- **Trust Services Criteria:** **Security** is mandatory. Optionally add **Availability**,
  **Confidentiality**, **Privacy**, **Processing Integrity**. Recommendation for a first report:
  **Security only** (add others later); Confidentiality/Privacy are natural next additions given the
  personal data involved.
- **Observation window:** 3 months (minimum useful) to 6–12 months. Start at 3.

## 5. Rough budget & timeline (plan, confirm with quotes)

- **Vanta subscription:** annual SaaS fee (tiered by company size).
- **CPA audit:** a first SOC 2 Type II from a Vanta-network firm is typically a few thousand to low
  five figures USD, depending on scope and firm.
- **Timeline:** readiness (Phase 0–1) ~1–3 months → observation window 3 months → report. First
  Type II report realistically ~6–9 months out; a Type I interim in ~2–3.

## 6. Action checklist

- [ ] Start Vanta onboarding; connect integrations so evidence auto-collects.
- [ ] Assign an internal owner (the "security/compliance lead") — required by the auditor.
- [ ] Decide scope: Type I→II, Security criterion, 3-month window.
- [ ] Request 2–3 auditor quotes via Vanta's network.
- [ ] Compare on experience + Vanta-fit + cost + timeline; sign the engagement letter.
- [ ] Schedule the readiness review, then the audit window.

*The audit engagement itself (contract, fees) is an organisation decision; engineering provides the
evidence and the readiness document set.*
