import type { StickerPack } from '@prisma/client';
import { prisma } from '../core/database';

export async function getPack(userId: number | bigint): Promise<StickerPack | null> {
  return prisma.stickerPack.findUnique({ where: { userId: BigInt(userId) } });
}

export async function savePack(userId: number | bigint, name: string, title: string): Promise<void> {
  await prisma.stickerPack.upsert({
    where: { userId: BigInt(userId) },
    create: { userId: BigInt(userId), name, title },
    update: { name, title },
  });
}
