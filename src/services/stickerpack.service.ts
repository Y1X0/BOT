import type { StickerPack } from '@prisma/client';
import { prisma } from '../core/database';

export type PackKind = 'regular' | 'emoji' | 'video';

export async function getPack(userId: number | bigint, kind: PackKind): Promise<StickerPack | null> {
  return prisma.stickerPack.findUnique({ where: { userId_kind: { userId: BigInt(userId), kind } } });
}

export async function savePack(userId: number | bigint, kind: PackKind, name: string, title: string): Promise<void> {
  await prisma.stickerPack.upsert({
    where: { userId_kind: { userId: BigInt(userId), kind } },
    create: { userId: BigInt(userId), kind, name, title },
    update: { name, title },
  });
}
