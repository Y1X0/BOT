import type { MusarahaMessage } from '@prisma/client';
import { prisma } from '../core/database';

export async function recordMessage(input: {
  senderId: number | bigint;
  senderName?: string | null;
  recipientId: number | bigint;
  text: string;
  deliveredMsgId?: number | null;
  isReply?: boolean;
}): Promise<void> {
  await prisma.musarahaMessage
    .create({
      data: {
        senderId: BigInt(input.senderId),
        senderName: input.senderName ?? null,
        recipientId: BigInt(input.recipientId),
        text: input.text,
        deliveredMsgId: input.deliveredMsgId ?? null,
        isReply: input.isReply ?? false,
      },
    })
    .catch(() => undefined);
}

/** Resolve who sent the anonymous message that landed at (recipient, msgId). */
export async function senderForDelivered(recipientId: number | bigint, msgId: number): Promise<bigint | null> {
  const row = await prisma.musarahaMessage.findFirst({
    where: { recipientId: BigInt(recipientId), deliveredMsgId: msgId },
    orderBy: { id: 'desc' },
  });
  return row?.senderId ?? null;
}

export async function blockSender(ownerId: number | bigint, senderId: number | bigint): Promise<void> {
  await prisma.musarahaBlock
    .upsert({
      where: { ownerId_senderId: { ownerId: BigInt(ownerId), senderId: BigInt(senderId) } },
      create: { ownerId: BigInt(ownerId), senderId: BigInt(senderId) },
      update: {},
    })
    .catch(() => undefined);
}

export async function isBlocked(ownerId: number | bigint, senderId: number | bigint): Promise<boolean> {
  const n = await prisma.musarahaBlock.count({
    where: { ownerId: BigInt(ownerId), senderId: BigInt(senderId) },
  });
  return n > 0;
}

/** Recent messages for owner oversight (abuse monitoring). */
export async function recentMessages(limit = 30): Promise<MusarahaMessage[]> {
  return prisma.musarahaMessage.findMany({ orderBy: { id: 'desc' }, take: Math.min(limit, 100) });
}
