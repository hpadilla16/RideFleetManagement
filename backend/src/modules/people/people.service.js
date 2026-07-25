import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { renderBrandedEmail, resolveEmailBrand } from '../../lib/email-template.js';
import { assertTenantUserCapacity } from '../../lib/tenant-plan-limits.js';
import { cache } from '../../lib/cache.js';
import { globalKey } from '../../lib/cache/tenantKey.js';

// Validate + normalize a user's location scope (Fase 1). Returns:
//   undefined → not provided (don't change on update)
//   null      → empty = ALL locations (no restriction)
//   JSON string of validated Location ids (only ids that belong to the tenant)
async function normalizeLocationIds(raw, tenantId) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const arr = (Array.isArray(raw) ? raw : []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!arr.length) return null;
  const rows = await prisma.location.findMany({
    where: { id: { in: arr }, ...(tenantId ? { tenantId } : {}) },
    select: { id: true }
  });
  const valid = rows.map((r) => r.id);
  return valid.length ? JSON.stringify(valid) : null;
}

// Validate + normalize a user's program scope (2026-07-02). Mirrors
// normalizeLocationIds' undefined contract:
//   undefined  → not provided (don't change on update)
//   null/''    → 'BOTH' (explicit clear = no restriction, the default)
//   valid enum → normalized value
//   anything else → error (don't silently store a value the enum rejects)
function normalizeProgramScope(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return 'BOTH';
  const value = String(raw).trim().toUpperCase();
  if (['RENTAL_ONLY', 'LOANER_ONLY', 'BOTH'].includes(value)) return value;
  throw new Error('programScope must be RENTAL_ONLY, LOANER_ONLY, or BOTH');
}

// JSON string → array of ids for the API ([] = all locations).
function parseLocationIdsArray(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map((x) => String(x)) : []; }
  catch { return []; }
}

const SALT_ROUNDS = 10;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function randomTempPassword() {
  // 2026-07-25: crypto-strong (was Math.random). Same 12-char shape, still
  // satisfies the auth password policy (upper, lower, digit, special). These
  // are one-shot secrets now — mustChangePassword forces replacement on
  // first login — but they travel by email, so they should not be guessable.
  // 64 bits of entropy — these travel by email and exist until first login.
  return `Temp${crypto.randomBytes(8).toString('hex')}!9`;
}

function appBaseUrl() {
  return (process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function roleLabel(role) {
  const normalized = String(role || '').toUpperCase();
  if (normalized === 'ADMIN') return 'Admin';
  if (normalized === 'OPS') return 'Operations';
  if (normalized === 'AGENT') return 'Employee';
  if (normalized === 'SUPER_ADMIN') return 'Super Admin';
  return normalized || 'User';
}

async function sendInviteEmail({ email, fullName, tempPassword, tenantName, role, tenantId = null }) {
  if (!email || !tempPassword) return;
  const loginUrl = `${appBaseUrl()}`;
  const displayName = fullName || email;
  const subject = `${tenantName || 'Ride Fleet'} access invitation`;
  const text = [
    `Hello ${displayName},`,
    '',
    `You now have ${roleLabel(role)} access in ${tenantName || 'Ride Fleet'}.`,
    `Login URL: ${loginUrl}`,
    `Email: ${email}`,
    `Temporary password: ${tempPassword}`,
    '',
    'Please sign in and change your password after your first login.'
  ].join('\n');

  // Fail-open brand resolution — never let theming block the invite.
  let brand;
  try { brand = await resolveEmailBrand({ tenantId }); } catch { brand = undefined; }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bodyHtml = `
    <p>Hello ${esc(displayName)},</p>
    <p>You now have <strong>${esc(roleLabel(role))}</strong> access in <strong>${esc(tenantName || 'Ride Fleet')}</strong>.</p>
    <p><strong>Email:</strong> ${esc(email)}<br /><strong>Temporary password:</strong> ${esc(tempPassword)}</p>
    <p>Please sign in and change your password after your first login.</p>`;
  const { html } = renderBrandedEmail({
    brand,
    heading: 'Your access invitation',
    bodyHtml,
    bodyText: text,
    cta: { label: 'Sign in', url: loginUrl },
    preheader: 'Your account is ready',
  });
  await sendEmail({ to: email, subject, text, html });
}

async function resolveTenant(tenantId) {
  if (!tenantId) throw new Error('tenantId is required');
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, carSharingEnabled: true }
  });
  if (!tenant) throw new Error('Tenant not found');
  return tenant;
}

function allowedRoleForPayload(personType, requestedRole) {
  const type = String(personType || '').toUpperCase();
  const role = String(requestedRole || '').toUpperCase();
  if (type === 'ADMIN') return 'ADMIN';
  if (type === 'HOST') return role === 'OPS' ? 'OPS' : 'AGENT';
  // Virtual agents (LAX #4) are always AGENT: the kind drives commission
  // resolution, never authorization.
  if (type === 'VIRTUAL_AGENT') return 'AGENT';
  // Internal (employee) users: honor an explicitly requested ADMIN/OPS/AGENT.
  // Previously ADMIN fell through to AGENT here, so promoting a staff member to
  // ADMIN via the People module silently downgraded to AGENT. SUPER_ADMIN is
  // intentionally NOT assignable through this tenant-scoped module.
  if (['ADMIN', 'OPS', 'AGENT'].includes(role)) return role;
  return 'AGENT';
}

function mapUserPerson(user) {
  const hasHostProfile = !!user.hostProfile;
  return {
    id: `user:${user.id}`,
    userId: user.id,
    hostProfileId: user.hostProfile?.id || null,
    tenantId: user.tenantId || user.hostProfile?.tenantId || null,
    personType: hasHostProfile
      ? 'HOST'
      : String(user.personKind || '').toUpperCase() === 'VIRTUAL_AGENT'
        ? 'VIRTUAL_AGENT'
        : (String(user.role || '').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE'),
    accessRole: user.role,
    createdByUserId: user.createdByUserId || user.hostProfile?.createdByUserId || null,
    createdByName: user.createdByUser?.fullName || user.hostProfile?.createdByUser?.fullName || null,
    tenantName: user.tenant?.name || user.hostProfile?.tenant?.name || null,
    displayName: user.hostProfile?.displayName || user.fullName || user.email,
    fullName: user.fullName || null,
    legalName: user.hostProfile?.legalName || null,
    email: user.email || user.hostProfile?.email || null,
    phone: user.hostProfile?.phone || null,
    status: user.isActive ? 'ACTIVE' : 'INACTIVE',
    hasLogin: true,
    payoutProvider: user.hostProfile?.payoutProvider || null,
    payoutAccountRef: user.hostProfile?.payoutAccountRef || null,
    payoutEnabled: !!user.hostProfile?.payoutEnabled,
    notes: user.hostProfile?.notes || null,
    // [] = ALL locations (no restriction). Only meaningful for ADMIN/EMPLOYEE.
    locationIds: parseLocationIdsArray(user.locationIds),
    // Program visibility (2026-07-02). BOTH = no restriction (default);
    // ADMIN accounts bypass regardless (see lib/tenant-scope userProgramScope).
    programScope: user.programScope || 'BOTH',
    createdAt: user.createdAt
  };
}

function mapHostOnlyPerson(host) {
  return {
    id: `host:${host.id}`,
    userId: null,
    hostProfileId: host.id,
    tenantId: host.tenantId || null,
    personType: 'HOST',
    accessRole: null,
    createdByUserId: host.createdByUserId || null,
    createdByName: host.createdByUser?.fullName || null,
    tenantName: host.tenant?.name || null,
    displayName: host.displayName,
    fullName: null,
    legalName: host.legalName || null,
    email: host.email || null,
    phone: host.phone || null,
    status: host.status || 'ACTIVE',
    hasLogin: false,
    payoutProvider: host.payoutProvider || null,
    payoutAccountRef: host.payoutAccountRef || null,
    payoutEnabled: !!host.payoutEnabled,
    notes: host.notes || null,
    createdAt: host.createdAt
  };
}

function canTenantAdminManageRecord(scope = {}, target = {}) {
  const actorRole = String(scope?.actorRole || '').toUpperCase();
  if (actorRole === 'SUPER_ADMIN') return true;
  if (actorRole !== 'ADMIN') return true;
  const actorUserId = scope?.actorUserId || null;
  if (!actorUserId) return false;
  if (target?.id && target.id === actorUserId) return true;
  return target?.createdByUserId === actorUserId;
}

function countsAsInternalUser(user = {}) {
  return !user?.hostProfile && !!user?.isActive && ['ADMIN', 'OPS', 'AGENT'].includes(String(user?.role || '').toUpperCase());
}

function countsAsInternalAdmin(user = {}) {
  return countsAsInternalUser(user) && String(user?.role || '').toUpperCase() === 'ADMIN';
}

export const peopleService = {
  async listPeople(scope = {}) {
    const where = scope?.tenantId ? { tenantId: scope.tenantId } : undefined;
    const [users, hosts] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: [{ fullName: 'asc' }, { email: 'asc' }],
        include: {
          tenant: { select: { id: true, name: true } },
          createdByUser: { select: { id: true, fullName: true } },
          hostProfile: {
            include: {
              tenant: { select: { id: true, name: true } },
              createdByUser: { select: { id: true, fullName: true } }
            }
          }
        }
      }),
      prisma.hostProfile.findMany({
        where: {
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
          userId: null
        },
        include: {
          tenant: { select: { id: true, name: true } },
          createdByUser: { select: { id: true, fullName: true } }
        },
        orderBy: [{ displayName: 'asc' }]
      })
    ]);

    return [
      ...users.map(mapUserPerson),
      ...hosts.map(mapHostOnlyPerson)
    ];
  },

  async createPerson(payload = {}, scope = {}) {
    const personType = String(payload.personType || '').trim().toUpperCase();
    if (!['ADMIN', 'EMPLOYEE', 'HOST', 'VIRTUAL_AGENT'].includes(personType)) {
      throw new Error('personType must be ADMIN, EMPLOYEE, HOST, or VIRTUAL_AGENT');
    }
    // Virtual agents are employees for every capacity/email/login rule below.
    const isEmployeeKind = personType === 'ADMIN' || personType === 'EMPLOYEE' || personType === 'VIRTUAL_AGENT';

    const tenantId = scope?.tenantId || payload?.tenantId || null;
    const tenant = await resolveTenant(tenantId);

    const enableLogin = personType === 'HOST'
      ? !!payload.enableLogin
      : payload.enableLogin === false ? false : true;
    const sendInvite = !!payload.sendInvite;

    const email = normalizeEmail(payload.email);
    const fullName = String(payload.fullName || payload.displayName || '').trim();
    const phone = String(payload.phone || '').trim() || null;
    const legalName = String(payload.legalName || '').trim() || null;

    if (!fullName) throw new Error('fullName or displayName is required');
    if (enableLogin && !email) throw new Error('email is required when login is enabled');
    if (isEmployeeKind && !email) throw new Error('email is required');

    if (isEmployeeKind) {
      await assertTenantUserCapacity(tenantId, {
        userDelta: 1,
        adminDelta: personType === 'ADMIN' ? 1 : 0
      });
    }

    let user = null;
    let tempPassword = null;

    if (email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) throw new Error('Email already registered');
    }

    if (enableLogin) {
      const locationIdsValue = await normalizeLocationIds(payload.locationIds, tenantId);
      const programScopeValue = normalizeProgramScope(payload.programScope);
      tempPassword = String(payload.password || randomTempPassword());
      const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
      user = await prisma.user.create({
        data: {
          tenantId,
          createdByUserId: scope?.actorUserId || null,
          email,
          fullName,
          role: allowedRoleForPayload(personType, payload.role),
          // LAX #4: the kind is persisted (the ADMIN/EMPLOYEE/HOST triad is
          // derived); VIRTUAL_AGENT drives commission-plan resolution.
          personKind: personType === 'VIRTUAL_AGENT' ? 'VIRTUAL_AGENT' : 'STANDARD',
          passwordHash,
          // First-login onboarding (2026-07-25): the creator knows this
          // password (temp OR admin-typed), so the user must replace it.
          // Covers the People UI, tenant admins, and seed scripts in one place.
          mustChangePassword: true,
          isActive: true,
          ...(locationIdsValue !== undefined ? { locationIds: locationIdsValue } : {}),
          ...(programScopeValue !== undefined ? { programScope: programScopeValue } : {})
        }
      });
    }

    let hostProfile = null;
    if (personType === 'HOST') {
      hostProfile = await prisma.hostProfile.create({
        data: {
          tenantId,
          userId: user?.id || null,
          createdByUserId: scope?.actorUserId || null,
          displayName: String(payload.displayName || fullName).trim(),
          legalName,
          email: email || null,
          phone,
          status: String(payload.status || 'ACTIVE').trim().toUpperCase(),
          payoutProvider: payload.payoutProvider ? String(payload.payoutProvider).trim() : null,
          payoutAccountRef: payload.payoutAccountRef ? String(payload.payoutAccountRef).trim() : null,
          payoutEnabled: !!payload.payoutEnabled,
          notes: payload.notes ? String(payload.notes).trim() : null
        }
      });
    }

    if (sendInvite && enableLogin && user?.email) {
      await sendInviteEmail({
        email: user.email,
        fullName: user.fullName,
        tempPassword,
        tenantName: tenant.name,
        role: user.role,
        tenantId: tenant.id
      });
    }

    return {
      ok: true,
      person: user ? mapUserPerson({ ...user, hostProfile }) : mapHostOnlyPerson(hostProfile),
      tempPassword: enableLogin ? tempPassword : null,
      inviteSent: !!(sendInvite && enableLogin && user?.email)
    };
  },

  async resetPassword(userId, payload = {}, scope = {}) {
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      include: {
        tenant: { select: { id: true, name: true } }
      }
    });
    if (!user) throw new Error('User not found');
    if (!canTenantAdminManageRecord(scope, { id: user.id, createdByUserId: user.createdByUserId })) {
      throw new Error('Tenant admins can only manage users they created');
    }

    const tempPassword = String(payload.password || randomTempPassword());
    const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      // First-login onboarding (2026-07-25): an admin reset is a temp
      // password again — re-arm the forced change. Session cache busted so
      // an open session on this worker gates immediately, not after the TTL.
      data: { passwordHash, mustChangePassword: true }
    });
    cache.del(globalKey('session', user.id));

    const sendInvite = payload?.sendInvite === false ? false : true;
    if (sendInvite && user.email) {
      await sendInviteEmail({
        email: user.email,
        fullName: user.fullName,
        tempPassword,
        tenantName: user.tenant?.name,
        role: user.role,
        tenantId: user.tenant?.id || user.tenantId || null
      });
    }

    return {
      ok: true,
      userId: user.id,
      email: user.email,
      tempPassword,
      inviteSent: !!(sendInvite && user.email)
    };
  },

  async updatePerson(personId, payload = {}, scope = {}) {
    const [kind, rawId] = String(personId || '').split(':');
    if (!kind || !rawId) throw new Error('Invalid person id');

    if (kind === 'user') {
      const user = await prisma.user.findFirst({
        where: {
          id: rawId,
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
        },
        include: {
          createdByUser: { select: { id: true, fullName: true } },
          hostProfile: true
        }
      });
      if (!user) throw new Error('Person not found');
      if (!canTenantAdminManageRecord(scope, { id: user.id, createdByUserId: user.createdByUserId })) {
        throw new Error('Tenant admins can only manage users they created');
      }

      const email = payload.email ? normalizeEmail(payload.email) : user.email;
      if (email !== user.email) {
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing && existing.id !== user.id) throw new Error('Email already registered');
      }

      const nextTenantId = scope?.tenantId || payload?.tenantId || user.tenantId || user.hostProfile?.tenantId || null;
      const tenant = nextTenantId ? await resolveTenant(nextTenantId) : null;

      const userPatch = {
        tenantId: nextTenantId,
        email,
        fullName: String(payload.fullName || payload.displayName || user.fullName || '').trim() || user.fullName,
        isActive: payload.status ? String(payload.status).toUpperCase() === 'ACTIVE' : user.isActive
      };

      if (!user.hostProfile) {
        // QA M2: the "virtual agents are ALWAYS AGENT" invariant derives from
        // the STORED personKind, never the client-sent personType — a PATCH
        // claiming personType EMPLOYEE + role ADMIN on a VIRTUAL_AGENT row
        // must not mint an admin that still earns under VA commission math.
        const storedKind = String(user.personKind || '').toUpperCase() === 'VIRTUAL_AGENT'
          ? 'VIRTUAL_AGENT'
          : (payload.personType || 'EMPLOYEE');
        userPatch.role = allowedRoleForPayload(storedKind, payload.role || user.role);
      } else if (payload.role) {
        userPatch.role = allowedRoleForPayload('HOST', payload.role);
      }

      const locationIdsValue = await normalizeLocationIds(payload.locationIds, nextTenantId);
      if (locationIdsValue !== undefined) userPatch.locationIds = locationIdsValue;

      // Program visibility (2026-07-02): same undefined = "don't change" contract.
      const programScopeValue = normalizeProgramScope(payload.programScope);
      if (programScopeValue !== undefined) userPatch.programScope = programScopeValue;

      const currentUsageShape = {
        hostProfile: user.hostProfile,
        isActive: user.isActive,
        role: user.role
      };
      const nextUsageShape = {
        hostProfile: user.hostProfile,
        isActive: userPatch.isActive,
        role: userPatch.role || user.role
      };
      const userDelta = (countsAsInternalUser(nextUsageShape) ? 1 : 0) - (countsAsInternalUser(currentUsageShape) ? 1 : 0);
      const adminDelta = (countsAsInternalAdmin(nextUsageShape) ? 1 : 0) - (countsAsInternalAdmin(currentUsageShape) ? 1 : 0);
      if (userDelta > 0 || adminDelta > 0) {
        await assertTenantUserCapacity(nextTenantId, { userDelta, adminDelta });
      }

      let hostPatch = null;
      if (user.hostProfile) {
        hostPatch = {
          tenantId: nextTenantId,
          displayName: String(payload.displayName || user.hostProfile.displayName || user.fullName || '').trim() || user.hostProfile.displayName,
          legalName: payload.legalName !== undefined ? (String(payload.legalName || '').trim() || null) : user.hostProfile.legalName,
          email: email || null,
          phone: payload.phone !== undefined ? (String(payload.phone || '').trim() || null) : user.hostProfile.phone,
          status: payload.status ? String(payload.status).toUpperCase() : user.hostProfile.status,
          payoutProvider: payload.payoutProvider !== undefined ? (String(payload.payoutProvider || '').trim() || null) : user.hostProfile.payoutProvider,
          payoutAccountRef: payload.payoutAccountRef !== undefined ? (String(payload.payoutAccountRef || '').trim() || null) : user.hostProfile.payoutAccountRef,
          payoutEnabled: payload.payoutEnabled !== undefined ? !!payload.payoutEnabled : !!user.hostProfile.payoutEnabled,
          notes: payload.notes !== undefined ? (String(payload.notes || '').trim() || null) : user.hostProfile.notes
        };
      }

      const updated = await prisma.$transaction(async (tx) => {
        const nextUser = await tx.user.update({
          where: { id: user.id },
          data: userPatch
        });

        let nextHost = null;
        if (user.hostProfile && hostPatch) {
          nextHost = await tx.hostProfile.update({
            where: { id: user.hostProfile.id },
            data: hostPatch
          });
        }

        return tx.user.findUnique({
          where: { id: nextUser.id },
          include: {
            tenant: { select: { id: true, name: true } },
            createdByUser: { select: { id: true, fullName: true } },
            hostProfile: {
              include: {
                tenant: { select: { id: true, name: true } },
                createdByUser: { select: { id: true, fullName: true } }
              }
            }
          }
        });
      });

      // Location/program scope (or role/tenant) changed → drop the cached session
      // so the new locationIds/programScope take effect on the user's next
      // request (Fase 2 enforcement; program scoping 2026-07-02).
      cache.del(globalKey('session', user.id));

      return {
        ok: true,
        tenantName: tenant?.name || null,
        person: mapUserPerson(updated)
      };
    }

    if (kind === 'host') {
      const host = await prisma.hostProfile.findFirst({
        where: {
          id: rawId,
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
        },
        include: {
          tenant: { select: { id: true, name: true } },
          createdByUser: { select: { id: true, fullName: true } }
        }
      });
      if (!host) throw new Error('Person not found');
      if (!canTenantAdminManageRecord(scope, { id: host.userId || null, createdByUserId: host.createdByUserId })) {
        throw new Error('Tenant admins can only manage users they created');
      }

      const nextTenantId = scope?.tenantId || payload?.tenantId || host.tenantId || null;
      const tenant = nextTenantId ? await resolveTenant(nextTenantId) : null;

      const updated = await prisma.hostProfile.update({
        where: { id: host.id },
        data: {
          tenantId: nextTenantId,
          displayName: String(payload.displayName || host.displayName || '').trim() || host.displayName,
          legalName: payload.legalName !== undefined ? (String(payload.legalName || '').trim() || null) : host.legalName,
          email: payload.email !== undefined ? (normalizeEmail(payload.email) || null) : host.email,
          phone: payload.phone !== undefined ? (String(payload.phone || '').trim() || null) : host.phone,
          status: payload.status ? String(payload.status).toUpperCase() : host.status,
          payoutProvider: payload.payoutProvider !== undefined ? (String(payload.payoutProvider || '').trim() || null) : host.payoutProvider,
          payoutAccountRef: payload.payoutAccountRef !== undefined ? (String(payload.payoutAccountRef || '').trim() || null) : host.payoutAccountRef,
          payoutEnabled: payload.payoutEnabled !== undefined ? !!payload.payoutEnabled : !!host.payoutEnabled,
          notes: payload.notes !== undefined ? (String(payload.notes || '').trim() || null) : host.notes
        },
        include: {
          tenant: { select: { id: true, name: true } },
          createdByUser: { select: { id: true, fullName: true } }
        }
      });

      return {
        ok: true,
        tenantName: tenant?.name || null,
        person: mapHostOnlyPerson(updated)
      };
    }

    throw new Error('Unsupported person type');
  }
};

export const _internal = { allowedRoleForPayload };
