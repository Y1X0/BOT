import type { Member } from '@prisma/client';
import { prisma } from '../core/database';

interface UserLite {
  id: number;
  first_name?: string;
  username?: string;
}

async function ensureMember(chatId: bigint, u: UserLite): Promise<void> {
  await prisma.member.upsert({
    where: { chatId_userId: { chatId, userId: BigInt(u.id) } },
    create: { chatId, userId: BigInt(u.id), firstName: u.first_name ?? null, username: u.username ?? null },
    update: { firstName: u.first_name ?? undefined, username: u.username ?? undefined },
  });
}

export interface MarryResult {
  ok: boolean;
  reason?: 'self' | 'a_married' | 'b_married';
}

export async function marry(chatId: number | bigint, a: UserLite, b: UserLite): Promise<MarryResult> {
  if (a.id === b.id) return { ok: false, reason: 'self' };
  const cId = BigInt(chatId);
  await ensureMember(cId, a);
  await ensureMember(cId, b);

  const [ma, mb] = await Promise.all([
    prisma.member.findUnique({ where: { chatId_userId: { chatId: cId, userId: BigInt(a.id) } } }),
    prisma.member.findUnique({ where: { chatId_userId: { chatId: cId, userId: BigInt(b.id) } } }),
  ]);
  if (ma?.partnerId) return { ok: false, reason: 'a_married' };
  if (mb?.partnerId) return { ok: false, reason: 'b_married' };

  const now = new Date();
  await prisma.$transaction([
    prisma.member.update({ where: { chatId_userId: { chatId: cId, userId: BigInt(a.id) } }, data: { partnerId: BigInt(b.id), marriedAt: now } }),
    prisma.member.update({ where: { chatId_userId: { chatId: cId, userId: BigInt(b.id) } }, data: { partnerId: BigInt(a.id), marriedAt: now } }),
  ]);
  return { ok: true };
}

export async function divorce(chatId: number | bigint, userId: number | bigint): Promise<{ ok: boolean; partnerId?: bigint }> {
  const cId = BigInt(chatId);
  const me = await prisma.member.findUnique({ where: { chatId_userId: { chatId: cId, userId: BigInt(userId) } } });
  if (!me?.partnerId) return { ok: false };
  const partnerId = me.partnerId;
  await prisma.$transaction([
    prisma.member.update({ where: { chatId_userId: { chatId: cId, userId: BigInt(userId) } }, data: { partnerId: null, marriedAt: null } }),
    prisma.member.updateMany({ where: { chatId: cId, userId: partnerId }, data: { partnerId: null, marriedAt: null } }),
  ]);
  return { ok: true, partnerId };
}

export async function getMarriage(chatId: number | bigint, userId: number | bigint): Promise<Member | null> {
  return prisma.member.findUnique({ where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } } });
}

export async function memberName(chatId: number | bigint, userId: bigint): Promise<string> {
  const m = await prisma.member.findUnique({ where: { chatId_userId: { chatId: BigInt(chatId), userId } } });
  return m?.firstName ?? m?.username ?? String(userId);
}

/** Distinct married couples in a chat (each pair once). */
export async function listCouples(chatId: number | bigint): Promise<Array<{ a: Member; bId: bigint }>> {
  const married = await prisma.member.findMany({ where: { chatId: BigInt(chatId), partnerId: { not: null } } });
  const seen = new Set<string>();
  const couples: Array<{ a: Member; bId: bigint }> = [];
  for (const m of married) {
    const key = [m.userId.toString(), m.partnerId!.toString()].sort().join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    couples.push({ a: m, bId: m.partnerId! });
  }
  return couples;
}
