import type { MessageLog } from '@prisma/client';
import { prisma } from '../core/database';

export interface LogInput {
  chatId: bigint;
  chatTitle?: string | null;
  userId: bigint;
  userName?: string | null;
  messageId: number;
  type: string;
  text?: string | null;
  fileId?: string | null;
  flagged?: boolean;
}

export async function logMessage(input: LogInput): Promise<void> {
  await prisma.messageLog.create({ data: { ...input } }).catch(() => undefined);
}

export interface LogFilter {
  chatId?: string;
  userId?: string;
  type?: string;
  q?: string;
  flagged?: boolean;
  limit?: number;
  before?: number; // id cursor for pagination
}

export async function queryLogs(f: LogFilter): Promise<MessageLog[]> {
  return prisma.messageLog.findMany({
    where: {
      chatId: f.chatId ? BigInt(f.chatId) : undefined,
      userId: f.userId ? BigInt(f.userId) : undefined,
      type: f.type || undefined,
      flagged: f.flagged || undefined,
      text: f.q ? { contains: f.q } : undefined,
      id: f.before ? { lt: f.before } : undefined,
    },
    orderBy: { id: 'desc' },
    take: Math.min(f.limit ?? 50, 200),
  });
}

const MEDIA_TYPES = ['photo', 'video', 'audio', 'voice', 'animation', 'sticker', 'document'];

export async function queryMedia(chatId?: string, type?: string, limit = 50): Promise<MessageLog[]> {
  return prisma.messageLog.findMany({
    where: {
      chatId: chatId ? BigInt(chatId) : undefined,
      type: type && MEDIA_TYPES.includes(type) ? type : { in: MEDIA_TYPES },
    },
    orderBy: { id: 'desc' },
    take: Math.min(limit, 200),
  });
}

/** Aggregate analytics from logged messages. */
export async function logAnalytics(): Promise<{
  topGroups: { chatId: string; title: string; count: number }[];
  topUsers: { userId: string; name: string; count: number }[];
  topTypes: { type: string; count: number }[];
  topWords: { word: string; count: number }[];
}> {
  const [groups, users, types, texts] = await Promise.all([
    prisma.messageLog.groupBy({ by: ['chatId', 'chatTitle'], _count: { _all: true }, orderBy: { _count: { chatId: 'desc' } }, take: 10 }),
    prisma.messageLog.groupBy({ by: ['userId', 'userName'], _count: { _all: true }, orderBy: { _count: { userId: 'desc' } }, take: 10 }),
    prisma.messageLog.groupBy({ by: ['type'], _count: { _all: true }, orderBy: { _count: { type: 'desc' } }, take: 12 }),
    prisma.messageLog.findMany({ where: { type: 'text', text: { not: null } }, select: { text: true }, orderBy: { id: 'desc' }, take: 2000 }),
  ]);

  const wordCounts = new Map<string, number>();
  for (const row of texts) {
    for (const w of (row.text ?? '').toLowerCase().split(/[\s.,!؟?،]+/)) {
      if (w.length < 3) continue;
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }
  const topWords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word, count]) => ({ word, count }));

  return {
    topGroups: groups.map((g) => ({ chatId: g.chatId.toString(), title: g.chatTitle ?? '-', count: g._count._all })),
    topUsers: users.map((u) => ({ userId: u.userId.toString(), name: u.userName ?? '-', count: u._count._all })),
    topTypes: types.map((t) => ({ type: t.type, count: t._count._all })),
    topWords,
  };
}

export async function cleanupOldLogs(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000);
  const res = await prisma.messageLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}
