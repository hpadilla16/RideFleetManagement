/**
 * Staff 2FA (TOTP) core service — 2026-08-22.
 *
 * Secrets are AES-256-GCM encrypted at rest via lib/integration-crypto (the
 * same helper that protects integration credentials). We NEVER store or return
 * a raw secret from a read path, and NEVER add it to getSessionUser's select.
 * Backup codes are bcrypt-hashed (cost 10) and single-use.
 *
 * Enrollment is two-phase, mirroring how a real authenticator app onboards:
 *   startEnrollment  → writes an UNVERIFIED secret to twoFactorPendingSecret
 *   verifyAndEnable  → on the first valid code, promotes pending → active,
 *                      flips twoFactorEnabled, stamps twoFactorEnrolledAt,
 *                      and issues one-time backup codes.
 * Until verifyAndEnable succeeds the user is NOT enrolled, so a half-finished
 * enrollment can never lock anyone out.
 *
 * `deps.prisma` is injectable so the unit tests can run against a fake without
 * a database — same pattern as authService.issueServiceToken.
 */

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import { prisma } from '../../lib/prisma.js';
import { encrypt, decrypt, isEncryptionConfigured } from '../../lib/integration-crypto.js';

const BACKUP_CODE_SALT_ROUNDS = 10;
const BACKUP_CODE_COUNT = 10;
const DEFAULT_ISSUER = 'Ride Fleet';

// A small step window (±1 = 30s either side) tolerates clock skew between the
// server and the authenticator app without meaningfully widening the attack
// surface. Applied per-verify so we never mutate otplib's global options.
const TOTP_WINDOW = 1;

function totp() {
  // Fresh instance per call so a concurrent verify can't observe another
  // caller's window override. otplib's authenticator is a singleton otherwise.
  return authenticator.clone({ window: TOTP_WINDOW });
}

function requireEncryption() {
  if (!isEncryptionConfigured()) {
    throw new Error('Encryption key (INTEGRATION_ENC_KEY) is not configured — 2FA cannot be used');
  }
}

// 10 groups of easy-to-read codes. Ambiguous chars removed. Format XXXX-XXXX.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateBackupCode() {
  const pick = () => {
    let s = '';
    for (let i = 0; i < 4; i += 1) {
      s += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    }
    return s;
  };
  return `${pick()}-${pick()}`;
}

async function issueBackupCodes(db, userId) {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => generateBackupCode());
  // Replace the whole set: delete any existing rows, then insert fresh hashes.
  await db.twoFactorBackupCode.deleteMany({ where: { userId } });
  for (const code of codes) {
    const codeHash = await bcrypt.hash(code, BACKUP_CODE_SALT_ROUNDS);
    await db.twoFactorBackupCode.create({ data: { userId, codeHash } });
  }
  return codes;
}

export const twoFactorService = {
  /**
   * Begin enrollment: generate a secret, store it ENCRYPTED as the pending
   * secret, and return the otpauth URI + a QR data URL for the app to render.
   * Overwrites any prior pending secret (restarting enrollment is safe).
   */
  async startEnrollment(userId, email, issuer = DEFAULT_ISSUER, deps = {}) {
    requireEncryption();
    const db = deps.prisma || prisma;
    const secret = authenticator.generateSecret();
    const otpauthUri = authenticator.keyuri(String(email || 'user'), String(issuer || DEFAULT_ISSUER), secret);
    await db.user.update({
      where: { id: userId },
      data: { twoFactorPendingSecret: encrypt(secret) }
    });
    // qrcode is already a dependency; imported lazily so this module doesn't
    // pull it in for the verify-only login path.
    const QR = (await import('qrcode')).default;
    const qrDataUrl = await QR.toDataURL(otpauthUri);
    return { otpauthUri, qrDataUrl, secret };
  },

  /**
   * Verify a code against the PENDING secret and, on success, promote it to the
   * active secret + flip the flags + issue one-time backup codes. Returns the
   * plaintext backup codes (shown exactly once).
   */
  async verifyAndEnable(userId, code, deps = {}) {
    requireEncryption();
    const db = deps.prisma || prisma;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, twoFactorPendingSecret: true }
    });
    if (!user) throw new Error('User not found');
    if (!user.twoFactorPendingSecret) throw new Error('No pending 2FA enrollment — start enrollment first');

    let secret;
    try {
      secret = decrypt(user.twoFactorPendingSecret);
    } catch {
      throw new Error('Pending 2FA secret is unreadable — restart enrollment');
    }

    const ok = totp().check(String(code || '').replace(/\s+/g, ''), secret);
    if (!ok) {
      const err = new Error('Invalid authentication code');
      err.code = 'INVALID_2FA_CODE';
      throw err;
    }

    await db.user.update({
      where: { id: userId },
      data: {
        twoFactorSecret: encrypt(secret),
        twoFactorPendingSecret: null,
        twoFactorEnabled: true,
        twoFactorEnrolledAt: new Date()
      }
    });
    const backupCodes = await issueBackupCodes(db, userId);
    return { enabled: true, backupCodes };
  },

  /**
   * Verify a live TOTP code against the ACTIVE secret. Returns boolean.
   * Used by the login verify step. Never throws on a wrong code — returns false.
   */
  async verifyCode(userId, code, deps = {}) {
    const db = deps.prisma || prisma;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { twoFactorSecret: true, twoFactorEnabled: true }
    });
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) return false;
    let secret;
    try {
      secret = decrypt(user.twoFactorSecret);
    } catch {
      return false;
    }
    return totp().check(String(code || '').replace(/\s+/g, ''), secret);
  },

  /**
   * Consume a backup code: bcrypt-compare against the user's UNUSED codes and,
   * on the first match, atomically claim it (single-use). Returns boolean.
   *
   * ATOMIC CLAIM (QA, 2026-08-22): the claim is an
   *   updateMany({ where: { id, usedAt: null }, data: { usedAt } })
   * guarded on usedAt:null, and we count `count === 1` as the win. A plain
   * update({ where: { id } }) would stamp the row unconditionally, so two
   * concurrent requests presenting the SAME code could both match the same
   * still-unused row and both succeed. With the conditional updateMany, exactly
   * one request flips usedAt null→now (count 1) and the loser sees count 0 —
   * it keeps scanning (the code is spent) and ultimately returns false.
   */
  async consumeBackupCode(userId, code, deps = {}) {
    const db = deps.prisma || prisma;
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return false;
    const rows = await db.twoFactorBackupCode.findMany({
      where: { userId, usedAt: null }
    });
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      const match = await bcrypt.compare(normalized, row.codeHash);
      if (match) {
        // eslint-disable-next-line no-await-in-loop
        const claim = await db.twoFactorBackupCode.updateMany({
          where: { id: row.id, usedAt: null },
          data: { usedAt: new Date() }
        });
        // count === 1 → we won the race; 0 → another request already spent this
        // exact code between our read and our write, so it is NOT a valid use.
        return claim.count === 1;
      }
    }
    return false;
  },

  /**
   * Regenerate the backup-code set (invalidates all prior codes). Requires the
   * user to already be enrolled. Returns fresh plaintext codes (shown once).
   */
  async regenerateBackupCodes(userId, deps = {}) {
    const db = deps.prisma || prisma;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true }
    });
    if (!user || !user.twoFactorEnabled) throw new Error('2FA is not enabled for this user');
    const backupCodes = await issueBackupCodes(db, userId);
    return { backupCodes };
  },

  /**
   * Disable 2FA entirely: clear the active + pending secrets, the flags, and
   * every backup code. Used both by self-service disable and by an admin reset
   * (which then re-forces enrollment if policy still requires it).
   */
  async disableFor(userId, deps = {}) {
    const db = deps.prisma || prisma;
    await db.twoFactorBackupCode.deleteMany({ where: { userId } });
    await db.user.update({
      where: { id: userId },
      data: {
        twoFactorSecret: null,
        twoFactorPendingSecret: null,
        twoFactorEnabled: false,
        twoFactorEnrolledAt: null
      }
    });
    return { enabled: false };
  },

  /**
   * Read-only status for the UI. NEVER returns any secret.
   */
  async status(userId, deps = {}) {
    const db = deps.prisma || prisma;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true, twoFactorEnrolledAt: true, twoFactorPendingSecret: true }
    });
    if (!user) throw new Error('User not found');
    const backupCodesRemaining = await db.twoFactorBackupCode.count({
      where: { userId, usedAt: null }
    });
    return {
      enabled: !!user.twoFactorEnabled,
      enrolledAt: user.twoFactorEnrolledAt || null,
      pendingEnrollment: !!user.twoFactorPendingSecret && !user.twoFactorEnabled,
      backupCodesRemaining
    };
  }
};

export default twoFactorService;
