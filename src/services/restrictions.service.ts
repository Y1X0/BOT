/**
 * Tracks who is currently muted/restricted per chat. Telegram's Bot API can't
 * enumerate restricted members, so the bot records them here on mute/restrict and
 * removes them on unmute/unrestrict — powering the list and bulk-lift commands.
 */
import type { Restriction } from '@prisma/client';
import { prisma } from '../core/database';

export type RestrictionKind = 'mute' | 'restrict';

export async function recordRestriction(input: {
  chatId: number | bigint;
  userId: number | bigint;
  kind: RestrictionKind;
  name?: string | null;
  username?: string | null;
  until?: Date | null;
  createdBy?: number | bigint | null;
}): Promise<void> {
  const chatId = BigInt(input.chatId);
  const userId = BigInt(input.userId);
  const data = {
    kind: input.kind,
    name: input.name ?? null,
    username: input.username ?? null,
    until: input.until ?? null,
    createdBy: input.createdBy != null ? BigInt(input.createdBy) : null,
  };
  await prisma.restriction
    .upsert({ where: { chatId_userId: { chatId, userId } }, create: { chatId, userId, ...data }, update: data })
    .catch(() => undefined);
}

export async function clearRestriction(chatId: number | bigint, userId: number | bigint): Promise<void> {
  await prisma.restriction
    .deleteMany({ where: { chatId: BigInt(chatId), userId: BigInt(userId) } })
    .catch(() => undefined);
}

/** Active restrictions of a kind, dropping any whose timer has already elapsed
 *  (Telegram auto-lifts those, so the stale rows are cleaned up lazily). */
export async function listRestrictions(chatId: number | bigint, kind: RestrictionKind): Promise<Restriction[]> {
  const rows = await prisma.restriction
    .findMany({ where: { chatId: BigInt(chatId), kind }, orderBy: { id: 'desc' }, take: 300 })
    .catch(() => [] as Restriction[]);
  const now = Date.now();
  const live: Restriction[] = [];
  const expiredIds: number[] = [];
  for (const r of rows) {
    if (r.until && r.until.getTime() <= now) expiredIds.push(r.id);
    else live.push(r);
  }
  if (expiredIds.length)
    await prisma.restriction.deleteMany({ where: { id: { in: expiredIds } } }).catch(() => undefined);
  return live;
}

export async function clearAllRestrictions(chatId: number | bigint, kind: RestrictionKind): Promise<void> {
  await prisma.restriction.deleteMany({ where: { chatId: BigInt(chatId), kind } }).catch(() => undefined);
}
