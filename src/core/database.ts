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

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
