import { prisma } from '../core/database';

/**
 * Command-usage counters. Incremented on the hot path (in memory) and flushed
 * to the DB periodically, so counting costs no DB write per message. Lets the
 * "which features do people actually use?" question be answered with numbers.
 */
const counts = new Map<string, number>();

export function recordCommand(command: string): void {
  if (!command) return;
  counts.set(command, (counts.get(command) ?? 0) + 1);
}

/** Persist buffered counts. On failure the affected increments are dropped
 *  (stats are best-effort, never worth crashing or blocking a request over). */
export async function flushUsage(): Promise<void> {
  if (counts.size === 0) return;
  const entries = [...counts.entries()];
  counts.clear();
  for (const [command, inc] of entries) {
    await prisma.commandStat
      .upsert({
        where: { command },
        create: { command, count: inc },
        update: { count: { increment: inc } },
      })
      .catch(() => undefined);
  }
}

export async function getTopCommands(limit = 30): Promise<{ command: string; count: number }[]> {
  return prisma.commandStat
    .findMany({ orderBy: { count: 'desc' }, take: limit, select: { command: true, count: true } })
    .catch(() => []);
}
