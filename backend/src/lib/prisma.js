import { PrismaClient } from '@prisma/client';

const logOptions = process.env.NODE_ENV === 'production'
  ? ['error', 'warn']
  : ['error', 'warn'];

export const prisma = new PrismaClient({
  log: logOptions,
  datasources: {
    db: {
      url: process.env.DATABASE_URL
        ? appendPoolParams(process.env.DATABASE_URL)
        : undefined
    }
  }
});

function appendPoolParams(url) {
  const separator = url.includes('?') ? '&' : '?';
  const poolSize = process.env.DATABASE_POOL_SIZE || '20';
  const timeout = process.env.DATABASE_POOL_TIMEOUT || '10';
  // Only append if not already configured in the URL
  if (url.includes('connection_limit=')) return url;
  return `${url}${separator}connection_limit=${poolSize}&pool_timeout=${timeout}`;
}
