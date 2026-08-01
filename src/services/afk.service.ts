import type { Member } from '@prisma/client';
import { prisma } from '../core/database';

export async function setAfk(
  chatId: number | bigint,
  user: { id: number; username?: string; first_name?: string },
  reason: string | null,
): Promise<void> {
  const cId = BigInt(chatId);
  const uId = BigInt(user.id);
  await prisma.member.upsert({
    where: { chatId_userId: { chatId: cId, userId: uId } },
    create: {
      chatId: cId,
      userId: uId,
      username: user.username ?? null,
      firstName: user.first_name ?? null,
      afkSince: new Date(),
      afkReason: reason,
    },
    update: { afkSince: new Date(), afkReason: reason },
  });
}

export async function clearAfk(
  chatId: number | bigint,
  userId: number | bigint,
): Promise<void> {
  await prisma.member
    .update({
      where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } },
      data: { afkSince: null, afkReason: null },
    })
    .catch(() => undefined);
}

export async function getAfk(
  chatId: number | bigint,
  userId: number | bigint,
): Promise<Member | null> {
  const member = await prisma.member.findUnique({
    where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } },
  });
  return member?.afkSince ? member : null;
}

export async function getAfkByUsername(
  chatId: number | bigint,
  username: string,
): Promise<Member | null> {
  const member = await prisma.member.findFirst({
    where: {
      chatId: BigInt(chatId),
      username: username.replace(/^@/, ''),
      afkSince: { not: null },
    },
  });
  return member ?? null;
}

/** Human-friendly "away for X" duration in Arabic. */
export function afkDuration(since: Date, now = new Date()): string {
  const mins = Math.floor((now.getTime() - since.getTime()) / 60000);
  if (mins < 1) return 'أقل من دقيقة';
  if (mins < 60) return `${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ساعة`;
  return `${Math.floor(hours / 24)} يوم`;
}
