import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { authService } from '../auth/auth.service.js';
import {
  assertTenantUserCapacity,
  getTenantPlanCatalog,
  getTenantPlanUsage,
  resolveTenantPlanConfig,
  saveTenantPlanCatalog
} from '../../lib/tenant-plan-limits.js';

const SALT_ROUNDS = 10;

function normalizePrismaTarget(error) {
  const raw = error?.meta?.target;
  if (Array.isArray(raw)) return raw.map((value) => String(value || '').toLowerCase());
  if (typeof raw === 'string') return [raw.toLowerCase()];
  return [];
}

function mapTenantWriteError(error, fallback = 'Unable to save tenant changes') {
  if (error?.code === 'P2002') {
    const target = normalizePrismaTarget(error);
    if (target.includes('email')) {
      throw new Error('A user with that email already exists. Use a different admin email or reset the existing user password.');
    }
    if (target.includes('slug')) {
      throw new Error('That tenant slug is already in use. Choose a different slug.');
    }
  }
  throw new Error(error?.message || fallback);
}

export const tenantsService = {
  async list() {
    const [tenants, catalog] = await Promise.all([
      prisma.tenant.findMany({
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
      }),
      getTenantPlanCatalog()
    ]);

    const usageEntries = await Promise.all(
      tenants.map(async (tenant) => [tenant.id, await getTenantPlanUsage(tenant.id)]),
    );
    const usageByTenantId = new Map(usageEntries);

    return tenants.map((tenant) => {
      const planConfig = resolveTenantPlanConfig(tenant.plan, catalog);
      const planUsage = usageByTenantId.get(tenant.id) || { admins: 0, users: 0, vehicles: 0 };
      return {
        ...tenant,
        planConfig,
        planUsage,
        planStatus: {
          overAdmins: planConfig.maxAdmins != null && planUsage.admins > planConfig.maxAdmins,
          overUsers: planConfig.maxUsers != null && planUsage.users > planConfig.maxUsers,
          overVehicles: planConfig.maxVehicles != null && planUsage.vehicles > planConfig.maxVehicles
        }
      };
    });
  },

  getPlanCatalog() {
    return getTenantPlanCatalog();
  },

  savePlanCatalog(plans = []) {
    return saveTenantPlanCatalog(plans);
  },

  async createTenant(data = {}) {
    const name = String(data.name || '').trim();
    const slug = String(data.slug || '').trim().toLowerCase();
    if (!name || !slug) throw new Error('name and slug are required');
    try {
      return await prisma.tenant.create({
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
    } catch (error) {
      mapTenantWriteError(error, 'Unable to create tenant');
    }
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

    try {
      return await prisma.tenant.update({ where: { id }, data });
    } catch (error) {
      mapTenantWriteError(error, 'Unable to update tenant');
    }
  },

  async createTenantAdmin(tenantId, payload = {}) {
    const email = String(payload.email || '').trim().toLowerCase();
    const fullName = String(payload.fullName || '').trim();
    const password = String(payload.password || 'TempPass123!');
    if (!email || !fullName) throw new Error('email and fullName are required');

    await assertTenantUserCapacity(tenantId, { userDelta: 1, adminDelta: 1 });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    let user;
    try {
      user = await prisma.user.create({
        data: {
          email,
          fullName,
          role: 'ADMIN',
          passwordHash,
          tenant: { connect: { id: tenantId } }
        },
        select: { id: true, email: true, fullName: true, role: true, tenantId: true }
      });
    } catch (error) {
      mapTenantWriteError(error, 'Unable to create tenant admin');
    }

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
