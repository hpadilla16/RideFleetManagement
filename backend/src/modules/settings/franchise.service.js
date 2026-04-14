import { prisma } from '../../lib/prisma.js';
import { ValidationError, NotFoundError } from '../../lib/errors.js';

export const franchiseService = {
  async list({ tenantId }) {
    if (!tenantId) return [];
    return prisma.franchise.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  },

  async listAll({ tenantId }) {
    if (!tenantId) return [];
    return prisma.franchise.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  },

  async getById(id, { tenantId }) {
    const franchise = await prisma.franchise.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
    });
    if (!franchise) throw new NotFoundError('Franchise not found');
    return franchise;
  },

  async create(data, { tenantId }) {
    if (!tenantId) throw new ValidationError('tenantId is required');
    const name = String(data.name || '').trim();
    if (!name) throw new ValidationError('Franchise name is required');
    const code = String(data.code || '').trim().toUpperCase() || name.replace(/[^A-Z0-9]/gi, '_').toUpperCase().slice(0, 20);

    // If setting as default, unset others
    if (data.isDefault) {
      await prisma.franchise.updateMany({
        where: { tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return prisma.franchise.create({
      data: {
        tenantId,
        code,
        name,
        logoUrl: data.logoUrl || null,
        address: data.address || null,
        phone: data.phone || null,
        email: data.email || null,
        termsText: data.termsText || null,
        returnInstructionsText: data.returnInstructionsText || null,
        agreementHtmlTemplate: data.agreementHtmlTemplate || null,
        isDefault: !!data.isDefault,
        isActive: data.isActive !== false,
      },
    });
  },

  async update(id, data, { tenantId }) {
    const franchise = await prisma.franchise.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
    });
    if (!franchise) throw new NotFoundError('Franchise not found');

    // If setting as default, unset others
    if (data.isDefault && !franchise.isDefault) {
      await prisma.franchise.updateMany({
        where: { tenantId: franchise.tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const updateData = {};
    if (data.name !== undefined) updateData.name = String(data.name).trim();
    if (data.code !== undefined) updateData.code = String(data.code).trim().toUpperCase();
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl || null;
    if (data.address !== undefined) updateData.address = data.address || null;
    if (data.phone !== undefined) updateData.phone = data.phone || null;
    if (data.email !== undefined) updateData.email = data.email || null;
    if (data.termsText !== undefined) updateData.termsText = data.termsText || null;
    if (data.returnInstructionsText !== undefined) updateData.returnInstructionsText = data.returnInstructionsText || null;
    if (data.agreementHtmlTemplate !== undefined) updateData.agreementHtmlTemplate = data.agreementHtmlTemplate || null;
    if (data.isDefault !== undefined) updateData.isDefault = !!data.isDefault;
    if (data.isActive !== undefined) updateData.isActive = !!data.isActive;

    return prisma.franchise.update({ where: { id }, data: updateData });
  },

  async delete(id, { tenantId }) {
    const franchise = await prisma.franchise.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
    });
    if (!franchise) throw new NotFoundError('Franchise not found');

    // Check if any reservations use this franchise
    const count = await prisma.reservation.count({ where: { franchiseId: id } });
    if (count > 0) {
      // Soft delete — deactivate instead
      return prisma.franchise.update({ where: { id }, data: { isActive: false } });
    }

    return prisma.franchise.delete({ where: { id } });
  },

  /**
   * Get franchise config for agreement generation.
   * Falls back to tenant defaults if no franchise or franchise has no template.
   */
  async getAgreementConfig(franchiseId, { tenantId }) {
    if (franchiseId) {
      const franchise = await prisma.franchise.findFirst({
        where: { id: franchiseId, tenantId, isActive: true },
      });
      if (franchise) {
        return {
          companyName: franchise.name,
          companyLogoUrl: franchise.logoUrl || '',
          companyAddress: franchise.address || '',
          companyPhone: franchise.phone || '',
          termsText: franchise.termsText || '',
          returnInstructionsText: franchise.returnInstructionsText || '',
          agreementHtmlTemplate: franchise.agreementHtmlTemplate || '',
          franchiseId: franchise.id,
          franchiseCode: franchise.code,
          franchiseName: franchise.name,
        };
      }
    }

    // Fallback: get default franchise for tenant
    if (tenantId) {
      const defaultFranchise = await prisma.franchise.findFirst({
        where: { tenantId, isDefault: true, isActive: true },
      });
      if (defaultFranchise) {
        return {
          companyName: defaultFranchise.name,
          companyLogoUrl: defaultFranchise.logoUrl || '',
          companyAddress: defaultFranchise.address || '',
          companyPhone: defaultFranchise.phone || '',
          termsText: defaultFranchise.termsText || '',
          returnInstructionsText: defaultFranchise.returnInstructionsText || '',
          agreementHtmlTemplate: defaultFranchise.agreementHtmlTemplate || '',
          franchiseId: defaultFranchise.id,
          franchiseCode: defaultFranchise.code,
          franchiseName: defaultFranchise.name,
        };
      }
    }

    // No franchise — return null (caller falls back to tenant settings)
    return null;
  },
};
