import { prisma } from '../core/database';
import { addCoins } from './economy.service';

/** Daily mission definitions. */
export const MISSIONS = {
  messages: { target: 20, reward: 50, label: 'أرسل 20 رسالة' },
  games: { target: 1, reward: 20, label: 'العب لعبة واحدة' },
} as const;

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function ensure(chatId: bigint, userId: bigint, day: string) {
  return prisma.missionProgress.upsert({
    where: { chatId_userId_day: { chatId, userId, day } },
    create: { chatId, userId, day },
    update: {},
  });
}

export async function incMissionMessages(chatId: number | bigint, userId: number | bigint): Promise<void> {
  const day = today();
  await ensure(BigInt(chatId), BigInt(userId), day);
  await prisma.missionProgress.update({
    where: { chatId_userId_day: { chatId: BigInt(chatId), userId: BigInt(userId), day } },
    data: { messages: { increment: 1 } },
  });
}

export async function incMissionGames(chatId: number | bigint, userId: number | bigint): Promise<void> {
  const day = today();
  await ensure(BigInt(chatId), BigInt(userId), day);
  await prisma.missionProgress.update({
    where: { chatId_userId_day: { chatId: BigInt(chatId), userId: BigInt(userId), day } },
    data: { games: { increment: 1 } },
  });
}

export async function getMissions(chatId: number | bigint, userId: number | bigint) {
  const day = today();
  return ensure(BigInt(chatId), BigInt(userId), day);
}

export interface ClaimResult {
  ok: boolean;
  reason?: 'not_ready' | 'already';
  reward?: number;
}

export async function claimMission(
  chatId: number | bigint,
  userId: number | bigint,
  type: 'messages' | 'games',
): Promise<ClaimResult> {
  const day = today();
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  const p = await ensure(cId, uId, day);
  const def = MISSIONS[type];
  const progress = type === 'messages' ? p.messages : p.games;
  const claimed = type === 'messages' ? p.claimedMessages : p.claimedGames;

  if (claimed) return { ok: false, reason: 'already' };
  if (progress < def.target) return { ok: false, reason: 'not_ready' };

  await prisma.missionProgress.update({
    where: { chatId_userId_day: { chatId: cId, userId: uId, day } },
    data: type === 'messages' ? { claimedMessages: true } : { claimedGames: true },
  });
  await addCoins(cId, uId, def.reward);
  return { ok: true, reward: def.reward };
}
