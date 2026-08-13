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
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "badwordsEnabled" BOOLEAN NOT NULL DEFAULT false',
    // Virtual-pet table (matches Prisma's Postgres DDL so a later db push is a no-op).
    `CREATE TABLE IF NOT EXISTS "Pet" (
      "id" SERIAL NOT NULL,
      "chatId" BIGINT NOT NULL,
      "userId" BIGINT NOT NULL,
      "name" TEXT NOT NULL DEFAULT 'حيوان',
      "species" TEXT NOT NULL DEFAULT '🐶',
      "level" INTEGER NOT NULL DEFAULT 1,
      "xp" INTEGER NOT NULL DEFAULT 0,
      "hunger" INTEGER NOT NULL DEFAULT 80,
      "happiness" INTEGER NOT NULL DEFAULT 80,
      "lastFedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastPlayedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Pet_pkey" PRIMARY KEY ("id")
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS "Pet_chatId_userId_key" ON "Pet"("chatId", "userId")',
    `CREATE TABLE IF NOT EXISTS "SavedEmoji" (
      "userId" BIGINT NOT NULL,
      "items" TEXT NOT NULL DEFAULT '[]',
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SavedEmoji_pkey" PRIMARY KEY ("userId")
    )`,
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
