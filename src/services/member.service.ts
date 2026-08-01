import type { Member } from '@prisma/client';
import { prisma } from '../core/database';

/**
 * XP required to reach a given level. Simple quadratic curve:
 * level N needs 5 * N^2 + 50 * N + 100 total XP.
 */
export function xpForLevel(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** Compute level from total XP. */
export function levelFromXp(xp: number): number {
  let level = 0;
  while (xp >= xpForLevel(level)) level++;
  return level;
}

export interface XpResult {
  member: Member;
  leveledUp: boolean;
  newLevel: number;
}

/**
 * Record activity for a member: bump message count, add XP, recompute level.
 * Returns whether the member leveled up so callers can announce it.
 */
export async function recordActivity(
  chatId: number | bigint,
  user: { id: number; username?: string; first_name?: string },
  xpGain: number,
): Promise<XpResult> {
  const cId = BigInt(chatId);
  const uId = BigInt(user.id);

  const existing = await prisma.member.findUnique({
    where: { chatId_userId: { chatId: cId, userId: uId } },
  });

  const prevLevel = existing?.level ?? 0;
  const newXp = (existing?.xp ?? 0) + xpGain;
  const newLevel = levelFromXp(newXp);

  const member = await prisma.member.upsert({
    where: { chatId_userId: { chatId: cId, userId: uId } },
    create: {
      chatId: cId,
      userId: uId,
      username: user.username ?? null,
      firstName: user.first_name ?? null,
      messageCount: 1,
      xp: xpGain,
      level: levelFromXp(xpGain),
    },
    update: {
      username: user.username ?? undefined,
      firstName: user.first_name ?? undefined,
      messageCount: { increment: 1 },
      xp: newXp,
      level: newLevel,
      lastSeenAt: new Date(),
    },
  });

  return { member, leveledUp: newLevel > prevLevel, newLevel };
}

/** Record a game win: +XP and +1 gamesWon (no message count). */
export async function recordGameWin(
  chatId: number | bigint,
  user: { id: number; username?: string; first_name?: string },
  xpGain: number,
): Promise<XpResult> {
  const cId = BigInt(chatId);
  const uId = BigInt(user.id);
  const existing = await prisma.member.findUnique({
    where: { chatId_userId: { chatId: cId, userId: uId } },
  });
  const prevLevel = existing?.level ?? 0;
  const newXp = (existing?.xp ?? 0) + xpGain;
  const newLevel = levelFromXp(newXp);

  const member = await prisma.member.upsert({
    where: { chatId_userId: { chatId: cId, userId: uId } },
    create: {
      chatId: cId,
      userId: uId,
      username: user.username ?? null,
      firstName: user.first_name ?? null,
      xp: xpGain,
      level: levelFromXp(xpGain),
      gamesWon: 1,
    },
    update: {
      username: user.username ?? undefined,
      firstName: user.first_name ?? undefined,
      xp: newXp,
      level: newLevel,
      gamesWon: { increment: 1 },
      lastSeenAt: new Date(),
    },
  });
  return { member, leveledUp: newLevel > prevLevel, newLevel };
}

export async function getMember(
  chatId: number | bigint,
  userId: number | bigint,
): Promise<Member | null> {
  return prisma.member.findUnique({
    where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } },
  });
}

export async function topByMessages(chatId: number | bigint, limit = 10): Promise<Member[]> {
  return prisma.member.findMany({
    where: { chatId: BigInt(chatId) },
    orderBy: { messageCount: 'desc' },
    take: limit,
  });
}

export async function topByXp(chatId: number | bigint, limit = 10): Promise<Member[]> {
  return prisma.member.findMany({
    where: { chatId: BigInt(chatId) },
    orderBy: { xp: 'desc' },
    take: limit,
  });
}

export async function memberCount(chatId: number | bigint): Promise<number> {
  return prisma.member.count({ where: { chatId: BigInt(chatId) } });
}

export async function totalMessages(chatId: number | bigint): Promise<number> {
  const agg = await prisma.member.aggregate({
    where: { chatId: BigInt(chatId) },
    _sum: { messageCount: true },
  });
  return agg._sum.messageCount ?? 0;
}
