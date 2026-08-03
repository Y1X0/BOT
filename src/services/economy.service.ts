import type { EconomyAccount } from '@prisma/client';
import { prisma } from '../core/database';
import { robOutcome, workReward, crimeOutcome } from './economy-logic';

const DAILY_REWARD = 100;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ROB_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const ROB_MIN_WALLET = 50; // victim must carry at least this in wallet
const WORK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const CRIME_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours

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

// ---- Bank (wallet <-> bank; bank is safe from robbery) ----
export async function getAccountSummary(
  chatId: number | bigint,
  userId: number | bigint,
): Promise<{ balance: number; bank: number }> {
  const acc = await ensureAccount(BigInt(chatId), BigInt(userId));
  return { balance: acc.balance, bank: acc.bank };
}

export interface BankResult {
  ok: boolean;
  balance?: number;
  bank?: number;
}

export async function deposit(
  chatId: number | bigint,
  userId: number | bigint,
  amount: number,
): Promise<BankResult> {
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  const acc = await ensureAccount(cId, uId);
  if (amount <= 0 || acc.balance < amount) return { ok: false };
  const u = await prisma.economyAccount.update({
    where: { chatId_userId: { chatId: cId, userId: uId } },
    data: { balance: { decrement: amount }, bank: { increment: amount } },
  });
  return { ok: true, balance: u.balance, bank: u.bank };
}

export async function withdraw(
  chatId: number | bigint,
  userId: number | bigint,
  amount: number,
): Promise<BankResult> {
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  const acc = await ensureAccount(cId, uId);
  if (amount <= 0 || acc.bank < amount) return { ok: false };
  const u = await prisma.economyAccount.update({
    where: { chatId_userId: { chatId: cId, userId: uId } },
    data: { bank: { decrement: amount }, balance: { increment: amount } },
  });
  return { ok: true, balance: u.balance, bank: u.bank };
}

// ---- Work (cooldown earner) ----
export interface WorkResult {
  ok: boolean;
  amount?: number;
  job?: string;
  balance?: number;
  minutesLeft?: number;
}

export async function claimWork(
  chatId: number | bigint,
  userId: number | bigint,
  now: Date = new Date(),
  rand: () => number = Math.random,
): Promise<WorkResult> {
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  const acc = await ensureAccount(cId, uId);

  if (acc.lastWorkAt) {
    const elapsed = now.getTime() - acc.lastWorkAt.getTime();
    if (elapsed < WORK_COOLDOWN_MS) {
      return { ok: false, minutesLeft: Math.ceil((WORK_COOLDOWN_MS - elapsed) / 60000) };
    }
  }

  const { amount, job } = workReward(rand);
  const updated = await prisma.economyAccount.update({
    where: { chatId_userId: { chatId: cId, userId: uId } },
    data: { balance: { increment: amount }, lastWorkAt: now },
  });
  return { ok: true, amount, job, balance: updated.balance };
}

// ---- Crime (risky cooldown earner) ----
export interface CrimeResult {
  outcome: 'success' | 'fail' | 'cooldown';
  amount?: number;
  story?: string;
  balance?: number;
  minutesLeft?: number;
}

export async function attemptCrime(
  chatId: number | bigint,
  userId: number | bigint,
  now: Date = new Date(),
  rand: () => number = Math.random,
): Promise<CrimeResult> {
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  const acc = await ensureAccount(cId, uId);

  if (acc.lastCrimeAt) {
    const elapsed = now.getTime() - acc.lastCrimeAt.getTime();
    if (elapsed < CRIME_COOLDOWN_MS) {
      return { outcome: 'cooldown', minutesLeft: Math.ceil((CRIME_COOLDOWN_MS - elapsed) / 60000) };
    }
  }

  const decision = crimeOutcome(acc.balance, rand);
  const delta = decision.success ? decision.amount : -Math.min(decision.amount, acc.balance);
  const updated = await prisma.economyAccount.update({
    where: { chatId_userId: { chatId: cId, userId: uId } },
    data: { balance: { increment: delta }, lastCrimeAt: now },
  });
  return {
    outcome: decision.success ? 'success' : 'fail',
    amount: Math.abs(delta),
    story: decision.story,
    balance: updated.balance,
  };
}

// ---- Robbery ----
export interface RobResult {
  outcome: 'success' | 'caught' | 'cooldown' | 'empty' | 'self';
  amount?: number;
  hoursLeft?: number;
}

export async function rob(
  chatId: number | bigint,
  robberId: number | bigint,
  victimId: number | bigint,
  now: Date = new Date(),
  rand: () => number = Math.random,
): Promise<RobResult> {
  const cId = BigInt(chatId);
  const rId = BigInt(robberId);
  const vId = BigInt(victimId);
  if (rId === vId) return { outcome: 'self' };

  const robber = await ensureAccount(cId, rId);
  if (robber.lastRobAt) {
    const elapsed = now.getTime() - robber.lastRobAt.getTime();
    if (elapsed < ROB_COOLDOWN_MS) {
      return { outcome: 'cooldown', hoursLeft: Math.ceil((ROB_COOLDOWN_MS - elapsed) / (60 * 60 * 1000)) };
    }
  }

  const victim = await ensureAccount(cId, vId);
  if (victim.balance < ROB_MIN_WALLET) return { outcome: 'empty' };

  const decision = robOutcome(victim.balance, robber.balance, rand);
  if (decision.success) {
    const amount = Math.min(decision.amount, victim.balance);
    await prisma.$transaction([
      prisma.economyAccount.update({ where: { chatId_userId: { chatId: cId, userId: vId } }, data: { balance: { decrement: amount } } }),
      prisma.economyAccount.update({ where: { chatId_userId: { chatId: cId, userId: rId } }, data: { balance: { increment: amount }, lastRobAt: now } }),
    ]);
    return { outcome: 'success', amount };
  }

  const fine = Math.min(decision.amount, robber.balance);
  await prisma.$transaction([
    prisma.economyAccount.update({ where: { chatId_userId: { chatId: cId, userId: rId } }, data: { balance: { decrement: fine }, lastRobAt: now } }),
    prisma.economyAccount.update({ where: { chatId_userId: { chatId: cId, userId: vId } }, data: { balance: { increment: fine } } }),
  ]);
  return { outcome: 'caught', amount: fine };
}
