import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';

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
  const loginUrl = `${appBaseUrl()}/login`;
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
    displayName: user.hostProfile?.displayName || user.fullName || user.email,
    fullName: user.fullName || null,
    legalName: user.hostProfile?.legalName || null,
    email: user.email || user.hostProfile?.email || null,
    phone: user.hostProfile?.phone || null,
    status: user.isActive ? 'ACTIVE' : 'INACTIVE',
    hasLogin: true,
    payoutEnabled: !!user.hostProfile?.payoutEnabled,
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
    displayName: host.displayName,
    fullName: null,
    legalName: host.legalName || null,
    email: host.email || null,
    phone: host.phone || null,
    status: host.status || 'ACTIVE',
    hasLogin: false,
    payoutEnabled: !!host.payoutEnabled,
    createdAt: host.createdAt
  };
}

export const peopleService = {
  async listPeople(scope = {}) {
    const where = scope?.tenantId ? { tenantId: scope.tenantId } : undefined;
    const [users, hosts] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: [{ fullName: 'asc' }, { email: 'asc' }],
        include: {
          hostProfile: true
        }
      }),
      prisma.hostProfile.findMany({
        where: {
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
          userId: null
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
  }
};
