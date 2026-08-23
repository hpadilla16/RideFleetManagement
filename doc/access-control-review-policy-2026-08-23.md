# Access Control & Access Review Policy

**Owner:** [responding organisation] · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** annually.

> Readiness deliverable (compliance roadmap). Defines how access is granted, restricted, reviewed and
> revoked. Consistent with DDQ 3.3 and the information-security policy.

---

## 1. Principles

- **Least privilege** — access is granted only to what a role requires.
- **Fail-closed** — a user with no tenant assignment matches zero records, never all.
- **Separation of duties** — money-handling actions require an explicitly granted capability.

## 2. Roles

`SUPER_ADMIN`, `ADMIN`, `OPS`, `AGENT`, enforced as middleware on every route; tenant- and
branch-level scoping further narrows access. A client-supplied filter can only narrow, never widen,
the caller's scope. Machine/service accounts run against a default-deny endpoint allowlist.

## 3. Authentication

- **2FA (TOTP)** enforced for `SUPER_ADMIN` and `ADMIN`.
- Passwords: bcrypt, ≥12 chars, mixed case + digit + symbol; login rate-limited per IP.
- Sessions: 12-hour bearer tokens verified on every request; deactivation, password change or 2FA
  reset revokes sessions within 30 seconds.

## 4. Provisioning & de-provisioning

- Access is granted by an administrator per the role model when a person joins or changes role.
- **On departure or role change, access is revoked promptly** (target: same business day).
- Privileged (SUPER_ADMIN/ADMIN) grants are documented with a reason.

## 5. Access reviews

- **Quarterly access review:** an administrator reviews all active users, their roles, tenant/branch
  scope, and privileged access; anything unnecessary is removed. The review is recorded (who
  reviewed, when, changes made).
- **Privileged access** and service/machine accounts are reviewed each quarter with extra scrutiny.
- Infrastructure/database/SSH credential holders are reviewed on the same cadence.

## 6. Infrastructure & database access

Direct database (provider console/credentials) and host (SSH) access is limited to named
administrators, protected by the cloud firewall (SSH only on the allowed source), and covered by the
same quarterly review. *(Credential holders to be listed by the responding organisation.)*

## 7. Evidence

Access grants and changes are recorded; the administrative audit trail records role and user changes;
quarterly review records are retained as SOC 2 evidence.
