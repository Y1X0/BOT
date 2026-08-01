import type { ScheduledMessage } from '@prisma/client';
import { prisma } from '../core/database';

/** Normalize "8:0" / "8:00" → "08:00"; returns null if invalid. */
export function normalizeTime(input: string): string | null {
  const m = input.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export async function addScheduled(
  chatId: number | bigint,
  time: string,
  text: string,
  createdBy: number | bigint,
): Promise<ScheduledMessage> {
  return prisma.scheduledMessage.create({
    data: { chatId: BigInt(chatId), time, text, createdBy: BigInt(createdBy) },
  });
}

export async function listScheduled(chatId: number | bigint): Promise<ScheduledMessage[]> {
  return prisma.scheduledMessage.findMany({
    where: { chatId: BigInt(chatId) },
    orderBy: { time: 'asc' },
  });
}

export async function deleteScheduled(chatId: number | bigint, id: number): Promise<boolean> {
  const res = await prisma.scheduledMessage.deleteMany({ where: { id, chatId: BigInt(chatId) } });
  return res.count > 0;
}

/** Messages due at `time` that haven't fired yet today (`day`). */
export async function getDue(time: string, day: string): Promise<ScheduledMessage[]> {
  return prisma.scheduledMessage.findMany({
    where: { enabled: true, time, NOT: { lastSent: day } },
  });
}

export async function markSent(id: number, day: string): Promise<void> {
  await prisma.scheduledMessage.update({ where: { id }, data: { lastSent: day } }).catch(() => undefined);
}
