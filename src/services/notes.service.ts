import type { Note } from '@prisma/client';
import { prisma } from '../core/database';

export async function saveNote(
  chatId: number | bigint,
  name: string,
  content: string,
  createdBy: number | bigint,
): Promise<void> {
  const cId = BigInt(chatId);
  await prisma.note.upsert({
    where: { chatId_name: { chatId: cId, name: name.toLowerCase() } },
    create: { chatId: cId, name: name.toLowerCase(), content, createdBy: BigInt(createdBy) },
    update: { content },
  });
}

export async function getNote(
  chatId: number | bigint,
  name: string,
): Promise<Note | null> {
  return prisma.note.findUnique({
    where: { chatId_name: { chatId: BigInt(chatId), name: name.toLowerCase() } },
  });
}

export async function deleteNote(
  chatId: number | bigint,
  name: string,
): Promise<boolean> {
  try {
    await prisma.note.delete({
      where: { chatId_name: { chatId: BigInt(chatId), name: name.toLowerCase() } },
    });
    return true;
  } catch {
    return false;
  }
}

export async function listNotes(chatId: number | bigint): Promise<Note[]> {
  return prisma.note.findMany({
    where: { chatId: BigInt(chatId) },
    orderBy: { name: 'asc' },
  });
}
