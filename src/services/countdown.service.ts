import type { CountdownEvent } from '@prisma/client';
import { prisma } from '../core/database';

export async function addEvent(chatId: number | bigint, name: string, targetAt: Date): Promise<CountdownEvent> {
  return prisma.countdownEvent.create({ data: { chatId: BigInt(chatId), name, targetAt } });
}

/** Upcoming (and today's) events for a chat, soonest first. */
export async function listEvents(chatId: number | bigint, now: Date = new Date()): Promise<CountdownEvent[]> {
  const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return prisma.countdownEvent.findMany({
    where: { chatId: BigInt(chatId), targetAt: { gte: todayMidnight } },
    orderBy: { targetAt: 'asc' },
    take: 20,
  });
}

export async function deleteEvent(id: number, chatId: number | bigint): Promise<boolean> {
  const res = await prisma.countdownEvent.deleteMany({ where: { id, chatId: BigInt(chatId) } });
  return res.count > 0;
}

/** Events landing today that haven't been announced yet. */
export async function dueToday(now: Date = new Date()): Promise<CountdownEvent[]> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);
  return prisma.countdownEvent.findMany({ where: { announced: false, targetAt: { gte: start, lt: end } } });
}

export async function markAnnounced(id: number): Promise<void> {
  await prisma.countdownEvent.update({ where: { id }, data: { announced: true } });
}
