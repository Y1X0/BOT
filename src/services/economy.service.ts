import type { EconomyAccount } from '@prisma/client';
import { prisma } from '../core/database';

const DAILY_REWARD = 100;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function ensureAccount(
  chatId: bigint,
  userId: bigint,
): Promise<EconomyAccount> {
  return prisma.economyAccount.upsert({
    where: { chatId_userId: { chatId, userId } },
    create: { chatId, userId, balance: 0 },
    update: {},
  });
}

export async function getBalance(
  chatId: number | bigint,
  userId: number | bigint,
): Promise<number> {
  const acc = await ensureAccount(BigInt(chatId), BigInt(userId));
  return acc.balance;
}

export async function addCoins(
  chatId: number | bigint,
  userId: number | bigint,
  amount: number,
): Promise<number> {
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  await ensureAccount(cId, uId);
  const updated = await prisma.economyAccount.update({
    where: { chatId_userId: { chatId: cId, userId: uId } },
    data: { balance: { increment: amount } },
  });
  return updated.balance;
}

export interface DailyResult {
  ok: boolean;
  amount?: number;
  balance?: number;
  hoursLeft?: number;
}

export async function claimDaily(
  chatId: number | bigint,
  userId: number | bigint,
  now: Date = new Date(),
): Promise<DailyResult> {
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  const acc = await ensureAccount(cId, uId);

  if (acc.lastDailyAt) {
    const elapsed = now.getTime() - acc.lastDailyAt.getTime();
    if (elapsed < DAILY_COOLDOWN_MS) {
      const hoursLeft = Math.ceil((DAILY_COOLDOWN_MS - elapsed) / (60 * 60 * 1000));
      return { ok: false, hoursLeft };
    }
  }

  const updated = await prisma.economyAccount.update({
    where: { chatId_userId: { chatId: cId, userId: uId } },
    data: { balance: { increment: DAILY_REWARD }, lastDailyAt: now },
  });
  return { ok: true, amount: DAILY_REWARD, balance: updated.balance };
}

export interface TransferResult {
  ok: boolean;
  reason?: 'insufficient';
}

export async function transfer(
  chatId: number | bigint,
  fromUserId: number | bigint,
  toUserId: number | bigint,
  amount: number,
): Promise<TransferResult> {
  const cId = BigInt(chatId);
  const from = BigInt(fromUserId);
  const to = BigInt(toUserId);

  const sender = await ensureAccount(cId, from);
  if (sender.balance < amount) return { ok: false, reason: 'insufficient' };

  await ensureAccount(cId, to);
  await prisma.$transaction([
    prisma.economyAccount.update({
      where: { chatId_userId: { chatId: cId, userId: from } },
      data: { balance: { decrement: amount } },
    }),
    prisma.economyAccount.update({
      where: { chatId_userId: { chatId: cId, userId: to } },
      data: { balance: { increment: amount } },
    }),
  ]);
  return { ok: true };
}

export async function topBalances(
  chatId: number | bigint,
  limit = 10,
): Promise<EconomyAccount[]> {
  return prisma.economyAccount.findMany({
    where: { chatId: BigInt(chatId) },
    orderBy: { balance: 'desc' },
    take: limit,
  });
}
