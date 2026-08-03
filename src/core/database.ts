import { PrismaClient } from '@prisma/client';
import { env, isProd } from '../config/env';
import { logger } from './logger';

/**
 * Singleton Prisma client.
 * Reused across hot-reloads in development to avoid exhausting connections.
 */
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: isProd ? ['error', 'warn'] : ['error', 'warn'],
  });

if (!isProd) {
  global.__prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info({ provider: env.DATABASE_PROVIDER }, 'Database connected');
}

/**
 * Idempotently ensure additive, nullable columns exist on the live Postgres
 * database, so a redeploy can't crash a feature before `prisma db push` runs.
 * SQLite (local dev) is skipped — `db:push` already syncs it. Every statement
 * uses `ADD COLUMN IF NOT EXISTS`, so running it repeatedly is a no-op.
 */
export async function ensureSchema(): Promise<void> {
  if (env.DATABASE_PROVIDER !== 'postgresql') return;
  const statements = [
    'ALTER TABLE "EconomyAccount" ADD COLUMN IF NOT EXISTS "lastWorkAt" TIMESTAMP(3)',
    'ALTER TABLE "EconomyAccount" ADD COLUMN IF NOT EXISTS "lastCrimeAt" TIMESTAMP(3)',
  ];
  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      logger.warn({ err }, 'ensureSchema statement failed (continuing)');
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
