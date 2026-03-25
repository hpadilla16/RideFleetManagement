import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { getJwtExpiresIn, getJwtSecret } from './auth.config.js';
import { getEffectiveModuleAccessForUser } from '../../lib/module-access.js';

const LOCK_PIN_SALT_ROUNDS = 10;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, tenantId: user.tenantId || null },
    getJwtSecret(),
    { expiresIn: getJwtExpiresIn() }
  );
}

async function buildSessionUser(user) {
  if (!user) return null;
  const moduleAccess = await getEffectiveModuleAccessForUser(user);
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    tenantId: user.tenantId || null,
    createdByUserId: user.createdByUserId || null,
    hostProfileId: user.hostProfileId || user.hostProfile?.id || null,
    moduleAccess: moduleAccess.effective,
    tenantModuleAccess: moduleAccess.tenantConfig,
    userModuleAccess: moduleAccess.userConfig
  };
}

export const authService = {
  issueTokenForUser(user) {
    return signToken(user);
  },

  async getSessionUser(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        tenantId: true,
        createdByUserId: true,
        isActive: true,
        hostProfile: { select: { id: true } }
      }
    });
    if (!user || !user.isActive) return null;
    return buildSessionUser(user);
  },

  async register({ email, password, fullName, tenantId }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) throw new Error('Email already registered');

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        fullName,
        role: 'AGENT',
        tenantId: tenantId || null
      }
    });

    const token = signToken(user);
    return { token, user: await buildSessionUser(user) };
  },

  async login({ email, password }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { hostProfile: { select: { id: true } } }
    });
    if (!user || !user.isActive) throw new Error('Invalid credentials');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new Error('Invalid credentials');

    const token = signToken(user);
    return { token, user: await buildSessionUser(user) };
  },

  async listUsers(scope = {}) {
    const rows = await prisma.user.findMany({
      where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
      orderBy: [{ role: 'asc' }, { fullName: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        tenantId: true,
        createdByUserId: true,
        lockPinHash: true,
        lockPinUpdatedAt: true
      }
    });

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      fullName: row.fullName,
      name: row.fullName,
      role: row.role,
      isActive: row.isActive,
      tenantId: row.tenantId || null,
      createdByUserId: row.createdByUserId || null,
      hasLockPin: !!row.lockPinHash,
      lockPinUpdatedAt: row.lockPinUpdatedAt || null
    }));
  },

  async setLockPin(userId, pin, scope = {}) {
    const normalizedPin = String(pin || '').trim();
    if (normalizedPin.length < 4) throw new Error('PIN must be at least 4 characters');

    const current = await prisma.user.findFirst({
      where: { id: userId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!current) throw new Error('User not found');

    const lockPinHash = await bcrypt.hash(normalizedPin, LOCK_PIN_SALT_ROUNDS);
    await prisma.user.update({
      where: { id: userId },
      data: { lockPinHash, lockPinUpdatedAt: new Date() }
    });

    return { ok: true, hasPin: true };
  },

  async verifyLockPin(userId, pin, scope = {}) {
    const user = await prisma.user.findFirst({
      where: { id: userId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { lockPinHash: true, lockPinUpdatedAt: true }
    });
    if (!user) throw new Error('User not found');
    if (!user.lockPinHash) throw new Error('PIN not set');

    const ok = await bcrypt.compare(String(pin || ''), user.lockPinHash);
    if (!ok) throw new Error('Invalid PIN');
    return { ok: true, hasPin: true, lockPinUpdatedAt: user.lockPinUpdatedAt || null };
  },

  async resetLockPin(userId, scope = {}) {
    const current = await prisma.user.findFirst({
      where: { id: userId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!current) throw new Error('User not found');

    await prisma.user.update({
      where: { id: userId },
      data: { lockPinHash: null, lockPinUpdatedAt: null }
    });

    return { ok: true, hasPin: false };
  },

  async lockPinStatus(userId, scope = {}) {
    const user = await prisma.user.findFirst({
      where: { id: userId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { lockPinHash: true, lockPinUpdatedAt: true }
    });
    if (!user) throw new Error('User not found');
    return { hasPin: !!user.lockPinHash, lockPinUpdatedAt: user.lockPinUpdatedAt || null };
  }
};
