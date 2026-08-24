# HR / Personnel Security Policy

**Owner:** [org] · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** annually.

> Readiness deliverable (compliance roadmap, risk R14). These are largely **organisation** actions
> that the readiness platform (Vanta) tracks; engineering supports access provisioning/de-provisioning.

---

## 1. Before access is granted (onboarding)

- [ ] **Background check** appropriate to the role, completed and recorded.
- [ ] **Confidentiality / NDA agreement** signed.
- [ ] **Acceptable-use policy** acknowledged.
- [ ] **Security-awareness training** assigned (completed within the first period of employment).
- [ ] Accounts provisioned per the access-control policy (least privilege), **MFA enrolled** (identity
      provider + app-level 2FA for privileged roles).
- [ ] Device meets baseline (disk encryption, screen lock, updates; verified by the Vanta agent for
      admin laptops).

## 2. During employment

- **Annual** security-awareness training and policy re-acknowledgement.
- Access reviewed quarterly (access-control & review policy).
- Report incidents per the incident-response procedure.

## 3. On role change or departure (offboarding)

- [ ] **Access revoked promptly** (target: same business day) — accounts, tokens, SSH/DB credentials,
      third-party integrations.
- [ ] Sessions terminated (deactivation revokes sessions within 30 seconds).
- [ ] Devices/credentials returned or wiped.
- [ ] The offboarding checklist is recorded as evidence.

## 4. Contractors / external support

Contractors with access follow the same controls (background check as appropriate, NDA, least-
privilege access, training) and are tracked in the personnel list. *(Contractor list — to be completed
by the organisation.)*

## 5. Evidence

Signed agreements, training-completion records, background-check records, and on/offboarding checklist
records are the evidence for SOC 2 (tracked in Vanta).
