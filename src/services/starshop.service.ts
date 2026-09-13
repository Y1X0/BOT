/**
 * Stars-reseller orchestration: price a Stars order in TON, create it with a
 * unique payment comment, then (via a poller) detect the TON payment and fulfil
 * it — automatically through Fragment when configured, otherwise by alerting the
 * owner. The buyer's money is never lost: a paid-but-undelivered order stays
 * "paid" and visible in the dashboard until delivered.
 */
import crypto from 'node:crypto';
import type { Telegram } from 'telegraf';
import type { StarOrder } from '@prisma/client';
import { prisma } from '../core/database';
import { env } from '../config/env';
import { logger } from '../core/logger';
import { getGlobal, setGlobal } from './global.service';
import { findPaymentByComment, toNanoTon, fromNanoTon } from './ton.service';
import { autobuyConfigured, buyStars } from './fragment.service';

const log = logger.child({ mod: 'starshop' });
const PRICE_KEY = 'star_price_ton';

export async function getStarPriceTon(): Promise<number> {
  const raw = await getGlobal(PRICE_KEY);
  const n = raw != null ? Number(raw) : env.STAR_PRICE_TON;
  return Number.isFinite(n) && n > 0 ? n : env.STAR_PRICE_TON;
}

export async function setStarPriceTon(n: number): Promise<void> {
  if (Number.isFinite(n) && n > 0) await setGlobal(PRICE_KEY, String(n));
}

export interface Quote {
  stars: number;
  ton: number; // human TON
  nanoTon: bigint;
}

export async function quote(stars: number): Promise<Quote> {
  const price = await getStarPriceTon();
  const ton = Math.round(stars * price * 1e6) / 1e6; // round to 6 dp
  return { stars, ton, nanoTon: toNanoTon(ton.toFixed(9)) };
}

function genPayCode(): string {
  return 'ST' + crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. ST9F3A2B1C
}

export interface NewOrder {
  order: StarOrder;
  ton: number;
  payCode: string;
  address: string;
  expiresMin: number;
}

/** Create a pending TON order. `recipient`/`username` should be the bare handle. */
export async function createTonOrder(input: {
  userId: bigint | number;
  username?: string | null;
  recipient?: string | null;
  stars: number;
}): Promise<NewOrder | { error: string }> {
  const address = env.TON_WALLET_ADDRESS;
  if (!env.STARS_SELL_ENABLED || !address) return { error: 'disabled' };
  if (input.stars < env.STARS_MIN || input.stars > env.STARS_MAX)
    return { error: `range:${env.STARS_MIN}-${env.STARS_MAX}` };
  const q = await quote(input.stars);
  const payCode = genPayCode();
  const expiresAt = new Date(Date.now() + env.ORDER_TTL_MIN * 60_000);
  const recipient = (input.recipient ?? input.username ?? '').replace(/^@/, '') || null;
  const order = await prisma.starOrder.create({
    data: {
      userId: BigInt(input.userId),
      username: input.username ?? null,
      recipient,
      stars: input.stars,
      nanoTon: q.nanoTon.toString(),
      payCode,
      status: 'pending',
      expiresAt,
    },
  });
  return { order, ton: q.ton, payCode, address, expiresMin: env.ORDER_TTL_MIN };
}

/** Attempt to deliver a paid order via Fragment. Mutates status. */
async function fulfil(order: StarOrder, telegram: Telegram): Promise<void> {
  const recipient = (order.recipient ?? order.username ?? '').replace(/^@/, '');
  if (!recipient) {
    await prisma.starOrder.update({ where: { id: order.id }, data: { status: 'paid', note: 'no username to deliver to' } });
    await notifyOwner(telegram, `⚠️ طلب #${order.id} مدفوع لكن بدون @username للتسليم. سلّمه يدوياً.`);
    return;
  }
  if (!autobuyConfigured()) {
    await notifyOwner(
      telegram,
      `🛎 طلب مدفوع #${order.id}: <b>${order.stars}⭐</b> لـ @${recipient}. الشراء التلقائي غير مفعّل — سلّمه من Fragment ثم علّمه «تم» باللوحة.`,
    );
    return; // stays "paid" → manual
  }
  await prisma.starOrder.update({ where: { id: order.id }, data: { status: 'delivering' } });
  const res = await buyStars(recipient, order.stars);
  if (res.ok) {
    await prisma.starOrder.update({
      where: { id: order.id },
      data: { status: 'delivered', deliveredAt: new Date(), fragmentRef: res.ref },
    });
    await telegram
      .sendMessage(order.userId.toString(), `✅ تم شحن <b>${order.stars}⭐</b> نجمة إلى @${recipient}. استمتع! 🌟`, {
        parse_mode: 'HTML',
      })
      .catch(() => undefined);
    log.info({ id: order.id, stars: order.stars }, 'order auto-delivered');
  } else {
    // Payment received but delivery failed → keep as "paid" for manual fulfilment.
    await prisma.starOrder.update({ where: { id: order.id }, data: { status: 'paid', note: res.error } });
    await notifyOwner(
      telegram,
      `❗️ فشل الشراء التلقائي لطلب #${order.id} (${order.stars}⭐ لـ @${recipient}): <code>${res.error}</code>\nالمبلغ مستلم — سلّمه يدوياً من Fragment ثم «تم».`,
    );
  }
}

async function notifyOwner(telegram: Telegram, text: string): Promise<void> {
  for (const owner of env.OWNER_IDS) {
    await telegram.sendMessage(owner.toString(), text, { parse_mode: 'HTML' }).catch(() => undefined);
  }
}

/**
 * One poll tick: expire stale orders, then for each pending order look for its
 * TON payment and fulfil it. Safe to call on an interval. Returns how many were
 * newly paid this tick.
 */
export async function tickOrders(telegram: Telegram): Promise<number> {
  if (!env.STARS_SELL_ENABLED || !env.TON_WALLET_ADDRESS) return 0;
  const now = new Date();
  await prisma.starOrder
    .updateMany({ where: { status: 'pending', expiresAt: { lt: now } }, data: { status: 'expired' } })
    .catch(() => undefined);

  const pending = await prisma.starOrder.findMany({ where: { status: 'pending' }, take: 25 }).catch(() => []);
  let paid = 0;
  for (const order of pending) {
    if (!order.payCode) continue;
    let minNano: bigint;
    try {
      minNano = (BigInt(order.nanoTon) * 99n) / 100n; // allow a 1% tolerance
    } catch {
      continue;
    }
    const payment = await findPaymentByComment(order.payCode, minNano);
    if (!payment) continue;
    await prisma.starOrder
      .update({ where: { id: order.id }, data: { status: 'paid', paidAt: new Date(), txHash: payment.hash } })
      .catch(() => undefined);
    paid++;
    await telegram
      .sendMessage(order.userId.toString(), `💰 تم استلام دفعتك (${fromNanoTon(payment.nanoTon)} TON) لطلب #${order.id}. عم نجهّز نجومك... ⏳`)
      .catch(() => undefined);
    const fresh = await prisma.starOrder.findUnique({ where: { id: order.id } });
    if (fresh) await fulfil(fresh, telegram).catch((err) => log.error({ err, id: order.id }, 'fulfil failed'));
  }
  return paid;
}

/** Retry delivery for a paid order (owner clicks "retry" in the dashboard). */
export async function retryDelivery(id: number, telegram: Telegram): Promise<boolean> {
  const order = await prisma.starOrder.findUnique({ where: { id } });
  if (!order || order.status !== 'paid') return false;
  await fulfil(order, telegram);
  return true;
}
