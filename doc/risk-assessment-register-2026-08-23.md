# Information Security Risk Assessment & Register

**Owner:** [responding organisation] · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** at least
quarterly, and on material change.

> First deliverable of the compliance roadmap's readiness set (see
> `compliance-roadmap-soc2-2026-08-23.md`). Establishes the risk methodology and the initial risk
> register with treatment plans and owners.

---

## 1. Methodology

Each risk is scored **Likelihood (1–3)** × **Impact (1–3)** → **rating 1–9**:

- **Likelihood:** 1 Low · 2 Medium · 3 High
- **Impact:** 1 Minor · 2 Moderate · 3 Severe (breach of personal data, outage, or legal exposure)
- **Rating:** 1–3 Low · 4–6 Medium · **7–9 High**

Treatment options: **Mitigate** (add/strengthen a control), **Accept** (documented, within appetite),
**Transfer** (insurance/contract), **Avoid** (stop the activity). Risk appetite: no High residual
risk to personal data is accepted without a time-bound treatment plan.

## 2. Risk register

| # | Risk | L | I | Rating | Treatment | Owner | Status |
|---|---|---|---|---|---|---|---|
| R1 | Credential compromise of a privileged account | 2 | 3 | 6 Med | 2FA enforced for ADMIN/SUPER_ADMIN; bcrypt; rate-limit; 30s session revocation | Eng | **Mitigated** |
| R2 | Cross-tenant data access (BOLA/IDOR) | 2 | 3 | 6 Med | Fail-closed tenant scoping; regression + DAST verified no cross-tenant access | Eng | **Mitigated** |
| R3 | Web-app vulnerability (injection/XSS/authz) leads to data exposure | 2 | 3 | 6 Med | Parameterised queries; input validation; CI SAST/secret/dep scans; DAST; security headers | Eng | **Mitigated (ongoing)** |
| R4 | Personal data at rest exposed if the DB/storage layer is compromised | 1 | 3 | 3 Low | Platform encryption at rest **+ application-level field encryption (AES-256-GCM) of licence/DOB/street-address/signatures** | Eng | **Mitigated** |
| R5 | Static field-encryption key exposure (no rotation/KMS) | 2 | 2 | 4 Med | **AWS KMS envelope encryption — DEK stored only KMS-wrapped, unwrapped in memory at boot, never plaintext on host; version tag supports rotation** | Eng | **Mitigated** |
| R6 | Sub-processor breach exposes data held by a third party | 2 | 3 | 6 Med | Minimisation; US-only vetted providers; **vendor risk assessments + DPAs (planned)** | [org] | Treatment planned |
| R7 | Data loss / ransomware | 1 | 3 | 3 Low | Nightly backups (30d) + platform PITR; **scheduled restoration testing (planned)** | Eng | Treatment planned |
| R8 | Undetected security event (no SIEM) | 2 | 2 | 4 Med | Audit trail + error monitoring/alerting; **security events centralised to a log-management/SIEM platform (US region)**; extended retention + alert-rule tuning pending | Eng | **Mitigated** (retention/alerting tuning ongoing) |
| R9 | Administrative impersonation misuse | 1 | 3 | 3 Low | Impersonation recorded + session-stamped in audit trail | Eng | **Mitigated** |
| R10 | Payment/card data exposure | 1 | 3 | 3 Low | No PAN/CVV stored; processor-hosted capture; PCI SAQ C | Eng/[org] | **Mitigated** |
| R11 | Public network exposure / misconfiguration | 1 | 3 | 3 Low | Loopback binding; default-deny cloud firewall; TLS 1.2/1.3 only | Eng | **Mitigated** |
| R12 | Availability / outage | 2 | 2 | 4 Med | Zero-downtime deploys; health gating; managed platform; **BC/DR plan documented**; scheduled restoration testing pending | Eng | Partial |
| R13 | No independent assurance (undetected control gaps) | 2 | 2 | 4 Med | CI scanning + DAST; **SOC 2 Type II programme + external pen test (planned)** | [org] | In programme |
| R14 | Insider error / lack of access review | 2 | 2 | 4 Med | RBAC least-privilege; **scheduled access reviews + security training (planned)** | [org] | Treatment planned |
| R15 | Improper/over-long retention of personal data | 2 | 2 | 4 Med | Retention schedule (two-clock) + erasure service; **activation + counsel-confirmed schedule (planned)** | Eng/[org] | Treatment planned |

## 3. Treatment summary

- **Already mitigated (residual Low):** R1, R2, R3, R4, R5, R8, R9, R10, R11.
- **Treatment planned (time-bound in the roadmap):** R6, R7, R12, R13, R14, R15.
- No High residual risk is currently accepted; each planned item maps to a phase in the compliance
  roadmap.

## 4. Review

This register is reviewed at least quarterly, after any incident, and whenever a new system,
sub-processor or material change is introduced. New risks are added with a treatment plan and owner.
