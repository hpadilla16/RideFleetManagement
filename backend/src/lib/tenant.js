import { isSuperAdmin } from '../middleware/auth.js';

export function tenantWhere(req, extra = {}) {
  if (isSuperAdmin(req?.user)) return { ...extra };
  const tenantId = req?.user?.tenantId || null;
  return { ...extra, tenantId };
}

export function assertTenantAccess(req, row) {
  if (isSuperAdmin(req?.user)) return true;
  return !!row && !!req?.user?.tenantId && row.tenantId === req.user.tenantId;
}
