import { prisma } from '../core/database';

export async function addWarning(
  chatId: number | bigint,
  userId: number | bigint,
  issuedBy: number | bigint,
  reason?: string,
): Promise<number> {
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  await prisma.warning.create({
    data: { chatId: cId, userId: uId, issuedBy: BigInt(issuedBy), reason: reason ?? null },
  });
  return prisma.warning.count({ where: { chatId: cId, userId: uId } });
}

export async function countWarnings(
  chatId: number | bigint,
  userId: number | bigint,
): Promise<number> {
  return prisma.warning.count({
    where: { chatId: BigInt(chatId), userId: BigInt(userId) },
  });
}

/** Remove the most recent warning; returns remaining count. */
export async function removeWarning(
  chatId: number | bigint,
  userId: number | bigint,
): Promise<number> {
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  const latest = await prisma.warning.findFirst({
    where: { chatId: cId, userId: uId },
    orderBy: { createdAt: 'desc' },
  });
  if (latest) await prisma.warning.delete({ where: { id: latest.id } });
  return prisma.warning.count({ where: { chatId: cId, userId: uId } });
}

export async function resetWarnings(
  chatId: number | bigint,
  userId: number | bigint,
): Promise<void> {
  await prisma.warning.deleteMany({
    where: { chatId: BigInt(chatId), userId: BigInt(userId) },
  });
}

export async function logAction(
  chatId: number | bigint,
  action: string,
  actorId: number | bigint,
  targetId?: number | bigint,
  details?: string,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      chatId: BigInt(chatId),
      action,
      actorId: BigInt(actorId),
      targetId: targetId != null ? BigInt(targetId) : null,
      details: details ?? null,
    },
  });
}
