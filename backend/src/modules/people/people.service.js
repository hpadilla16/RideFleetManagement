import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { assertTenantUserCapacity } from '../../lib/tenant-plan-limits.js';

const SALT_ROUNDS = 10;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function randomTempPassword() {
  return `Temp${Math.random().toString(36).slice(2, 8)}!9`;
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

async function sendInviteEmail({ email, fullName, tempPassword, tenantName, role }) {
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
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6">
      <h2>Ride Fleet Access</h2>
      <p>Hello ${displayName},</p>
      <p>You now have <strong>${roleLabel(role)}</strong> access in <strong>${tenantName || 'Ride Fleet'}</strong>.</p>
      <p><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
      <p><strong>Email:</strong> ${email}<br /><strong>Temporary password:</strong> ${tempPassword}</p>
      <p>Please sign in and change your password after your first login.</p>
    </div>
  `;
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
  if (['OPS', 'AGENT'].includes(role)) return role;
  return 'AGENT';
}

function mapUserPerson(user) {
  const hasHostProfile = !!user.hostProfile;
  return {
    id: `user:${user.id}`,
    userId: user.id,
    hostProfileId: user.hostProfile?.id || null,
    tenantId: user.tenantId || user.hostProfile?.tenantId || null,
    personType: hasHostProfile ? 'HOST' : (String(user.role || '').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE'),
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
    if (!['ADMIN', 'EMPLOYEE', 'HOST'].includes(personType)) {
      throw new Error('personType must be ADMIN, EMPLOYEE, or HOST');
    }

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
    if ((personType === 'ADMIN' || personType === 'EMPLOYEE') && !email) throw new Error('email is required');

    if (personType === 'ADMIN' || personType === 'EMPLOYEE') {
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
      tempPassword = String(payload.password || randomTempPassword());
      const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
      user = await prisma.user.create({
        data: {
          tenantId,
          createdByUserId: scope?.actorUserId || null,
          email,
          fullName,
          role: allowedRoleForPayload(personType, payload.role),
          passwordHash,
          isActive: true
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
        role: user.role
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
      data: { passwordHash }
    });

    const sendInvite = payload?.sendInvite === false ? false : true;
    if (sendInvite && user.email) {
      await sendInviteEmail({
        email: user.email,
        fullName: user.fullName,
        tempPassword,
        tenantName: user.tenant?.name,
        role: user.role
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
        userPatch.role = allowedRoleForPayload(payload.personType || 'EMPLOYEE', payload.role || user.role);
      } else if (payload.role) {
        userPatch.role = allowedRoleForPayload('HOST', payload.role);
      }

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
