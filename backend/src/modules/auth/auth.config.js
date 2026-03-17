const INSECURE_DEFAULT_JWT_SECRET = 'dev-secret-change-me';

export function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret || secret === INSECURE_DEFAULT_JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured with a non-default value');
  }
  return secret;
}

export function getJwtExpiresIn() {
  return process.env.JWT_EXPIRES_IN || '12h';
}

export function assertAuthConfig() {
  getJwtSecret();
}

export function isPublicRegisterEnabled() {
  return String(process.env.ALLOW_PUBLIC_REGISTER || '').trim().toLowerCase() === 'true';
}
