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
  // The DB (Neon free tier) can be briefly unreachable — its compute suspends
  // when idle and takes a few seconds to wake. Retry with backoff to ride that
  // out. If it still can't connect, DON'T throw: let the bot start anyway.
  // Prisma connects lazily per query, so the process stays alive and recovers
  // on its own once the DB is back — far better than a boot crash loop that
  // takes the whole bot offline.
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.$connect();
      logger.info({ provider: env.DATABASE_PROVIDER }, 'Database connected');
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        logger.error(
          { err },
          'Database unreachable after retries — starting anyway; will connect lazily once it recovers',
        );
        return;
      }
      const waitMs = attempt * 3000;
      logger.warn({ err, attempt, waitMs }, 'Database connect failed, retrying');
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
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
    'ALTER TABLE "MessageLog" ADD COLUMN IF NOT EXISTS "replyToName" TEXT',
    'ALTER TABLE "CustomReply" ADD COLUMN IF NOT EXISTS "entities" TEXT',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "idCardTemplate" TEXT',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "idCardEntities" TEXT',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "idCardImage" BOOLEAN NOT NULL DEFAULT true',
    `ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "idCardTheme" TEXT NOT NULL DEFAULT 'auto'`,
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "musicBlocked" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "idCardEnabled" BOOLEAN NOT NULL DEFAULT true',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockPhoto" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockVideo" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockVoice" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockAudio" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockSticker" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockGif" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockDocument" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockContact" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockLocation" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockPoll" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "ChatSettings" ADD COLUMN IF NOT EXISTS "lockVideoNote" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "Chat" ADD COLUMN IF NOT EXISTS "botWelcomedAt" TIMESTAMP(3)',
    `CREATE TABLE IF NOT EXISTS "GlobalConfig" (
      "key" TEXT NOT NULL,
      "value" TEXT NOT NULL,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "GlobalConfig_pkey" PRIMARY KEY ("key")
    )`,
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
    `CREATE TABLE IF NOT EXISTS "WhisperMessage" (
      "id" SERIAL NOT NULL,
      "senderId" BIGINT NOT NULL,
      "senderName" TEXT,
      "targetId" BIGINT NOT NULL,
      "targetName" TEXT,
      "chatId" BIGINT NOT NULL,
      "chatTitle" TEXT,
      "text" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "WhisperMessage_pkey" PRIMARY KEY ("id")
    )`,
    'CREATE INDEX IF NOT EXISTS "WhisperMessage_createdAt_idx" ON "WhisperMessage"("createdAt")',
    `CREATE TABLE IF NOT EXISTS "ChatRole" (
      "chatId" BIGINT NOT NULL,
      "userId" BIGINT NOT NULL,
      "role" TEXT NOT NULL,
      "name" TEXT,
      "assignedBy" BIGINT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ChatRole_pkey" PRIMARY KEY ("chatId", "userId")
    )`,
    'CREATE INDEX IF NOT EXISTS "ChatRole_chatId_idx" ON "ChatRole"("chatId")',
  ];
  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      logger.warn({ err }, 'ensureSchema statement failed (continuing)');
    }
  }

  // UDP LAB experiment table. The model is new, so on a fresh Postgres it is
  // normally created by `prisma db push` at boot. But db push can fail on a Neon
  // cold start (and only runs at boot), which would leave /udp_report and
  // /udp_history with no table until the next restart. This guarantees the table
  // and its indexes exist regardless. The DDL matches Prisma's own Postgres
  // output verbatim (verified with `prisma migrate diff`), so a later `db push`
  // sees it as already in sync — a no-op. Fully idempotent: IF NOT EXISTS never
  // touches an existing table, its columns, or its rows. Best-effort: a failure
  // here is logged clearly and never breaks boot (db push will retry next boot).
  const udpExperimentDdl = [
    `CREATE TABLE IF NOT EXISTS "UdpExperiment" (
      "id" SERIAL NOT NULL,
      "runBy" BIGINT NOT NULL,
      "kind" TEXT NOT NULL,
      "target" TEXT NOT NULL,
      "verdict" TEXT NOT NULL,
      "packetsSent" INTEGER NOT NULL,
      "packetsReceived" INTEGER NOT NULL,
      "lossPct" DOUBLE PRECISION,
      "rttAvgMs" DOUBLE PRECISION,
      "jitterMs" DOUBLE PRECISION,
      "durationMs" INTEGER NOT NULL,
      "metrics" TEXT NOT NULL,
      "startedAt" TIMESTAMP(3) NOT NULL,
      "endedAt" TIMESTAMP(3) NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "UdpExperiment_pkey" PRIMARY KEY ("id")
    )`,
    'CREATE INDEX IF NOT EXISTS "UdpExperiment_runBy_createdAt_idx" ON "UdpExperiment"("runBy", "createdAt")',
    'CREATE INDEX IF NOT EXISTS "UdpExperiment_createdAt_idx" ON "UdpExperiment"("createdAt")',
  ];
  for (const sql of udpExperimentDdl) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      logger.error(
        { err, ddl: sql.slice(0, 48) },
        'ensureSchema: could not ensure UdpExperiment table/index (continuing; prisma db push will retry on next boot)',
      );
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
