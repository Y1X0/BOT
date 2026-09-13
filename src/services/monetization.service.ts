/**
 * Monetization data layer: premium subscriptions, Stars payment ledger, wallets,
 * referrals and "buy Stars" orders. Prices and referral% are stored in
 * GlobalConfig so the owner can edit them live from the dashboard; env values are
 * only the initial defaults.
 */
import type { PremiumSubscription, StarOrder, StarTransaction, Wallet } from '@prisma/client';
import { prisma } from '../core/database';
import { env } from '../config/env';
import { getGlobal, setGlobal } from './global.service';
import { PLANS, type PlanId, extendExpiry, isActive, planById, referralCommission } from './monetization-logic';

export type SubjectType = 'user' | 'group';

// ── Prices & settings (dashboard-editable) ────────────────────────────────────
export interface Prices {
  week: number;
  month: number;
  year: number;
}

const PRICES_KEY = 'premium_prices';
const REFPCT_KEY = 'referral_percent';

export async function getPrices(): Promise<Prices> {
  const raw = await getGlobal(PRICES_KEY);
  const def: Prices = {
    week: env.PREMIUM_PRICE_WEEK,
    month: env.PREMIUM_PRICE_MONTH,
    year: env.PREMIUM_PRICE_YEAR,
  };
  if (!raw) return def;
  try {
    const p = JSON.parse(raw) as Partial<Prices>;
    return {
      week: Number(p.week) > 0 ? Number(p.week) : def.week,
      month: Number(p.month) > 0 ? Number(p.month) : def.month,
      year: Number(p.year) > 0 ? Number(p.year) : def.year,
    };
  } catch {
    return def;
  }
}

export async function setPrices(p: Prices): Promise<void> {
  await setGlobal(PRICES_KEY, JSON.stringify(p));
}

export async function priceOf(planId: PlanId): Promise<number> {
  const prices = await getPrices();
  return prices[planId];
}

export async function getReferralPercent(): Promise<number> {
  const raw = await getGlobal(REFPCT_KEY);
  const n = raw != null ? Number(raw) : env.REFERRAL_PERCENT;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : env.REFERRAL_PERCENT;
}

export async function setReferralPercent(pct: number): Promise<void> {
  await setGlobal(REFPCT_KEY, String(Math.max(0, Math.min(100, Math.round(pct)))));
}

// ── Premium subscriptions ─────────────────────────────────────────────────────
export async function getPremium(
  subjectType: SubjectType,
  subjectId: bigint | number,
): Promise<PremiumSubscription | null> {
  return prisma.premiumSubscription
    .findUnique({ where: { subjectType_subjectId: { subjectType, subjectId: BigInt(subjectId) } } })
    .catch(() => null);
}

export async function isPremium(subjectType: SubjectType, subjectId: bigint | number): Promise<boolean> {
  const sub = await getPremium(subjectType, subjectId);
  return isActive(sub?.expiresAt);
}

/** Grant/extend a subscription. Returns the resulting row. */
export async function grantPremium(
  subjectType: SubjectType,
  subjectId: bigint | number,
  planId: PlanId,
  opts: { grantedBy?: bigint | number | null } = {},
): Promise<PremiumSubscription> {
  const plan = planById(planId) ?? PLANS[1];
  const id = BigInt(subjectId);
  const existing = await getPremium(subjectType, id);
  const expiresAt = extendExpiry(existing?.expiresAt ?? null, plan.days);
  const grantedBy = opts.grantedBy != null ? BigInt(opts.grantedBy) : null;
  return prisma.premiumSubscription.upsert({
    where: { subjectType_subjectId: { subjectType, subjectId: id } },
    create: { subjectType, subjectId: id, planId, tier: 'premium', expiresAt, grantedBy },
    update: { planId, expiresAt, grantedBy },
  });
}

/** Revoke immediately (owner action). */
export async function revokePremium(subjectType: SubjectType, subjectId: bigint | number): Promise<void> {
  await prisma.premiumSubscription
    .deleteMany({ where: { subjectType, subjectId: BigInt(subjectId) } })
    .catch(() => undefined);
}

export async function listActiveSubscriptions(limit = 200): Promise<PremiumSubscription[]> {
  return prisma.premiumSubscription.findMany({
    where: { expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: 'desc' },
    take: limit,
  });
}

// ── Star payment ledger ───────────────────────────────────────────────────────
export async function recordStarTransaction(input: {
  userId: bigint | number;
  chargeId: string;
  stars: number;
  product: string;
  payload: string;
  chatId?: bigint | number | null;
}): Promise<StarTransaction | null> {
  return prisma.starTransaction
    .create({
      data: {
        userId: BigInt(input.userId),
        chargeId: input.chargeId,
        stars: input.stars,
        product: input.product,
        payload: input.payload,
        chatId: input.chatId != null ? BigInt(input.chatId) : null,
      },
    })
    .catch(() => null); // unique chargeId → ignore a duplicate delivery
}

export async function markRefunded(chargeId: string): Promise<void> {
  await prisma.starTransaction.updateMany({ where: { chargeId }, data: { status: 'refunded' } }).catch(() => undefined);
}

export async function listTransactions(limit = 50): Promise<StarTransaction[]> {
  return prisma.starTransaction.findMany({ orderBy: { id: 'desc' }, take: Math.min(limit, 200) });
}

export interface RevenueSummary {
  totalStars: number;
  paidCount: number;
  refundedStars: number;
  activeUserSubs: number;
  activeGroupSubs: number;
  pendingOrders: number;
  byProduct: { product: string; stars: number; count: number }[];
}

export async function revenueSummary(): Promise<RevenueSummary> {
  const now = new Date();
  const [paid, refunded, byProduct, userSubs, groupSubs, pending] = await Promise.all([
    prisma.starTransaction.aggregate({ where: { status: 'paid' }, _sum: { stars: true }, _count: { _all: true } }),
    prisma.starTransaction.aggregate({ where: { status: 'refunded' }, _sum: { stars: true } }),
    prisma.starTransaction.groupBy({
      by: ['product'],
      where: { status: 'paid' },
      _sum: { stars: true },
      _count: { _all: true },
    }),
    prisma.premiumSubscription.count({ where: { subjectType: 'user', expiresAt: { gt: now } } }),
    prisma.premiumSubscription.count({ where: { subjectType: 'group', expiresAt: { gt: now } } }),
    prisma.starOrder.count({ where: { status: { in: ['pending', 'paid'] } } }),
  ]);
  return {
    totalStars: paid._sum.stars ?? 0,
    paidCount: paid._count._all ?? 0,
    refundedStars: refunded._sum.stars ?? 0,
    activeUserSubs: userSubs,
    activeGroupSubs: groupSubs,
    pendingOrders: pending,
    byProduct: byProduct
      .map((p) => ({ product: p.product, stars: p._sum.stars ?? 0, count: p._count._all ?? 0 }))
      .sort((a, b) => b.stars - a.stars),
  };
}

// ── Wallet (referral earnings) ────────────────────────────────────────────────
export async function getWallet(userId: bigint | number): Promise<Wallet> {
  const id = BigInt(userId);
  return prisma.wallet.upsert({ where: { userId: id }, create: { userId: id }, update: {} });
}

export async function addCredits(userId: bigint | number, amount: number): Promise<number> {
  if (amount <= 0) return (await getWallet(userId)).credits;
  const id = BigInt(userId);
  await prisma.wallet.upsert({
    where: { userId: id },
    create: { userId: id, credits: amount, totalEarned: amount },
    update: { credits: { increment: amount }, totalEarned: { increment: amount } },
  });
  return (await getWallet(id)).credits;
}

// ── Referrals ─────────────────────────────────────────────────────────────────
export async function getReferrer(referredId: bigint | number): Promise<bigint | null> {
  const row = await prisma.referral.findUnique({ where: { referredId: BigInt(referredId) } }).catch(() => null);
  return row?.referrerId ?? null;
}

/** Attribute a new user to a referrer. No-op if already attributed or self. */
export async function setReferrer(referredId: bigint | number, referrerId: bigint | number): Promise<boolean> {
  const rid = BigInt(referredId);
  const ref = BigInt(referrerId);
  if (rid === ref) return false;
  const existing = await getReferrer(rid);
  if (existing != null) return false;
  try {
    await prisma.referral.create({ data: { referredId: rid, referrerId: ref } });
    return true;
  } catch {
    return false; // race: created between check and insert
  }
}

/** Credit a referral commission when a referred user pays. Returns credits paid. */
export async function payReferralCommission(
  buyerId: bigint | number,
  stars: number,
): Promise<{ referrerId: bigint; credits: number } | null> {
  const referrerId = await getReferrer(buyerId);
  if (referrerId == null) return null;
  const pct = await getReferralPercent();
  const credits = referralCommission(stars, pct);
  if (credits <= 0) return null;
  await addCredits(referrerId, credits);
  await prisma.referral
    .update({ where: { referredId: BigInt(buyerId) }, data: { rewarded: { increment: credits } } })
    .catch(() => undefined);
  return { referrerId, credits };
}

export interface ReferralStats {
  count: number;
  totalEarned: number;
  credits: number;
}

export async function referralStats(referrerId: bigint | number): Promise<ReferralStats> {
  const id = BigInt(referrerId);
  const [count, wallet] = await Promise.all([
    prisma.referral.count({ where: { referrerId: id } }),
    getWallet(id),
  ]);
  return { count, totalEarned: wallet.totalEarned, credits: wallet.credits };
}

/** Top referrers by lifetime earnings (for the dashboard). */
export async function topReferrers(limit = 10): Promise<{ userId: string; count: number }[]> {
  const rows = await prisma.referral.groupBy({
    by: ['referrerId'],
    _count: { _all: true },
    orderBy: { _count: { referrerId: 'desc' } },
    take: limit,
  });
  return rows.map((r) => ({ userId: r.referrerId.toString(), count: r._count._all }));
}

// ── Buy-Stars orders (Phase 2, manual fulfilment) ─────────────────────────────
export async function createStarOrder(input: {
  userId: bigint | number;
  username?: string | null;
  stars: number;
  note?: string | null;
  paidStars?: number;
  status?: string;
}): Promise<StarOrder> {
  return prisma.starOrder.create({
    data: {
      userId: BigInt(input.userId),
      username: input.username ?? null,
      stars: input.stars,
      note: input.note ?? null,
      paidStars: input.paidStars ?? 0,
      status: input.status ?? 'pending',
    },
  });
}

export async function listStarOrders(status?: string, limit = 100): Promise<StarOrder[]> {
  return prisma.starOrder.findMany({
    where: status ? { status } : undefined,
    orderBy: { id: 'desc' },
    take: Math.min(limit, 300),
  });
}

export async function setStarOrderStatus(id: number, status: string): Promise<void> {
  await prisma.starOrder.updateMany({ where: { id }, data: { status } }).catch(() => undefined);
}
