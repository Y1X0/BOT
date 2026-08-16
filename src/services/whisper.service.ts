import type { WhisperMessage } from '@prisma/client';
import { prisma } from '../core/database';

/** Persist a whisper for owner oversight (sender, target, group, content). */
export async function recordWhisper(input: {
  senderId: number | bigint;
  senderName?: string | null;
  targetId: number | bigint;
  targetName?: string | null;
  chatId: number | bigint;
  chatTitle?: string | null;
  text: string;
}): Promise<void> {
  await prisma.whisperMessage
    .create({
      data: {
        senderId: BigInt(input.senderId),
        senderName: input.senderName ?? null,
        targetId: BigInt(input.targetId),
        targetName: input.targetName ?? null,
        chatId: BigInt(input.chatId),
        chatTitle: input.chatTitle ?? null,
        text: input.text,
      },
    })
    .catch(() => undefined);
}

/** Recent whispers for owner oversight, newest first. */
export async function recentWhispers(limit = 80): Promise<WhisperMessage[]> {
  return prisma.whisperMessage.findMany({ orderBy: { id: 'desc' }, take: Math.min(limit, 200) });
}
