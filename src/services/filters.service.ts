import type { WordFilter } from '@prisma/client';
import { prisma } from '../core/database';

export async function addFilter(
  chatId: number | bigint,
  word: string,
  action: 'delete' | 'warn' | 'mute' = 'delete',
): Promise<void> {
  const cId = BigInt(chatId);
  await prisma.wordFilter.upsert({
    where: { chatId_word: { chatId: cId, word: word.toLowerCase() } },
    create: { chatId: cId, word: word.toLowerCase(), action },
    update: { action },
  });
}

export async function deleteFilter(
  chatId: number | bigint,
  word: string,
): Promise<boolean> {
  try {
    await prisma.wordFilter.delete({
      where: { chatId_word: { chatId: BigInt(chatId), word: word.toLowerCase() } },
    });
    return true;
  } catch {
    return false;
  }
}

export async function listFilters(chatId: number | bigint): Promise<WordFilter[]> {
  return prisma.wordFilter.findMany({ where: { chatId: BigInt(chatId) } });
}

/** Return the first matching banned word (as a WordFilter) or null. */
export async function matchFilter(
  chatId: number | bigint,
  text: string,
): Promise<WordFilter | null> {
  const lower = text.toLowerCase();
  const filters = await prisma.wordFilter.findMany({
    where: { chatId: BigInt(chatId) },
  });
  return filters.find((f) => lower.includes(f.word)) ?? null;
}
