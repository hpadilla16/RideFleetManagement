import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { authService } from '../auth/auth.service.js';

const SALT_ROUNDS = 10;

export const tenantsService = {
  list() {
    return prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            users: true,
            locations: true,
            customers: true,
            vehicles: true,
            reservations: true
          }
        }
      }
    });
  },

  async createTenant(data = {}) {
    const name = String(data.name || '').trim();
    const slug = String(data.slug || '').trim().toLowerCase();
    if (!name || !slug) throw new Error('name and slug are required');

    return prisma.tenant.create({
      data: {
        name,
        slug,
        status: String(data.status || 'ACTIVE').toUpperCase(),
        plan: String(data.plan || 'BETA').toUpperCase(),
        carSharingEnabled: !!data.carSharingEnabled,
        dealershipLoanerEnabled: !!data.dealershipLoanerEnabled,
        tollsEnabled: !!data.tollsEnabled
      }
    });
  },

  async updateTenant(id, patch = {}) {
    const data = {};
    if (patch.name !== undefined) data.name = String(patch.name || '').trim();
    if (patch.slug !== undefined) data.slug = String(patch.slug || '').trim().toLowerCase();
    if (patch.status !== undefined) data.status = String(patch.status || '').toUpperCase();
    if (patch.plan !== undefined) data.plan = String(patch.plan || '').toUpperCase();
    if (patch.carSharingEnabled !== undefined) data.carSharingEnabled = !!patch.carSharingEnabled;
    if (patch.dealershipLoanerEnabled !== undefined) data.dealershipLoanerEnabled = !!patch.dealershipLoanerEnabled;
    if (patch.tollsEnabled !== undefined) data.tollsEnabled = !!patch.tollsEnabled;

    return prisma.tenant.update({ where: { id }, data });
  },

  async createTenantAdmin(tenantId, payload = {}) {
    const email = String(payload.email || '').trim().toLowerCase();
    const fullName = String(payload.fullName || '').trim();
    const password = String(payload.password || 'TempPass123!');
    if (!email || !fullName) throw new Error('email and fullName are required');

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        email,
        fullName,
        role: 'ADMIN',
        passwordHash,
        tenant: { connect: { id: tenantId } }
      },
      select: { id: true, email: true, fullName: true, role: true, tenantId: true }
    });

    return { ...user, tempPassword: password };
  },

  listTenantAdmins(tenantId) {
    return prisma.user.findMany({
      where: { tenantId, role: { in: ['ADMIN', 'OPS', 'AGENT'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, fullName: true, role: true, createdAt: true }
    });
  },

  async resetTenantAdminPassword(tenantId, userId, password = 'TempPass123!') {
    const user = await prisma.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new Error('Tenant admin not found');
    const passwordHash = await bcrypt.hash(String(password), SALT_ROUNDS);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    return { ok: true, userId: user.id, email: user.email, tempPassword: password };
  },

  async impersonateTenantAdmin(tenantId, targetUserId) {
    let user = null;
    if (targetUserId) {
      user = await prisma.user.findFirst({ where: { id: targetUserId, tenantId, isActive: true } });
    } else {
      user = await prisma.user.findFirst({ where: { tenantId, role: 'ADMIN', isActive: true }, orderBy: { createdAt: 'asc' } });
      if (!user) user = await prisma.user.findFirst({ where: { tenantId, isActive: true }, orderBy: { createdAt: 'asc' } });
    }
    if (!user) throw new Error('No active tenant user found for impersonation');

    const token = authService.issueTokenForUser(user);
    return {
      token,
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role, tenantId: user.tenantId || null }
    };
  }
};
