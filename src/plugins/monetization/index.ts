import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { escapeHtml } from '../../locales';
import { mention } from '../../utils/format';
import { isBotOwner } from '../../utils/permissions';
import { logger as log } from '../../core/logger';
import {
  PLANS,
  type PlanId,
  daysLeft,
  parseReferralPayload,
  planById,
} from '../../services/monetization-logic';
import {
  getPremium,
  getPrices,
  getReferralPercent,
  getWallet,
  grantPremium,
  payReferralCommission,
  priceOf,
  recordStarTransaction,
  referralStats,
  revokePremium,
  setReferrer,
  type SubjectType,
} from '../../services/monetization.service';
import { createTonOrder, quote, tickOrders } from '../../services/starshop.service';

const esc = (s: string | undefined | null): string => escapeHtml(String(s ?? ''));
const enabled = (): boolean => env.PAYMENTS_ENABLED;
const DISABLED_MSG = '🛒 نظام الاشتراكات غير مفعّل حالياً.';

// Invoice payload: prem:<subjectType>:<planId>:<subjectId>. For a USER sub the
// encoded id is ignored on payment (the actual payer becomes the subject), so a
// shared group button still grants premium to whoever paid.
function premiumPayload(subjectType: SubjectType, planId: PlanId, subjectId: bigint | number | string): string {
  return `prem:${subjectType}:${planId}:${subjectId}`;
}

function parsePremiumPayload(payload: string): { subjectType: SubjectType; planId: PlanId; subjectId: string } | null {
  const m = /^prem:(user|group):(week|month|year):(-?\d{1,20})$/.exec(payload);
  if (!m) return null;
  return { subjectType: m[1] as SubjectType, planId: m[2] as PlanId, subjectId: m[3] };
}

async function plansKeyboard(subjectType: SubjectType, subjectId: bigint | number) {
  const prices = await getPrices();
  const rows = PLANS.map((p) => [
    Markup.button.callback(`${p.label} — ⭐ ${prices[p.id]}`, `mon:buy:${subjectType}:${p.id}:${subjectId}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

function statusLine(label: string, expiresAt: Date | null | undefined): string {
  const left = daysLeft(expiresAt);
  return left > 0 ? `${label}: 💎 <b>مفعّل</b> (باقي ${left} يوم)` : `${label}: ⚪️ غير مشترك`;
}

export const monetizationPlugin: Plugin = {
  name: 'monetization',
  description: 'Premium subscriptions, referral rewards and Stars payments',
  commands: [
    { command: 'premium', description: '💎 الاشتراك المميّز' },
    { command: 'referral', description: '🔗 رابط الإحالة وأرباحك' },
    { command: 'wallet', description: '👛 محفظتك (أرباح الإحالة)' },
    { command: 'buystars', description: '⭐ اطلب شحن نجوم' },
    { command: 'grantpremium', description: '🎁 منح اشتراك مميّز (مالك)', staffOnly: true },
    { command: 'revokepremium', description: '🚫 إلغاء اشتراك مميّز (مالك)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // ── /premium — status + plans ──────────────────────────────────────────
    bot.command('premium', async (ctx) => {
      if (!enabled()) return void ctx.reply(DISABLED_MSG);
      if (!ctx.from) return;
      const inGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
      const prices = await getPrices();
      const userSub = await getPremium('user', ctx.from.id);

      const lines = ['💎 <b>الاشتراك المميّز</b>', ''];
      lines.push(statusLine('اشتراكك', userSub?.expiresAt));
      if (inGroup && ctx.chat) {
        const groupSub = await getPremium('group', ctx.chat.id);
        lines.push(statusLine('اشتراك الجروب', groupSub?.expiresAt));
      }
      lines.push('', '💠 <b>المزايا:</b> شارة مميّزة، أولوية، مزايا إضافية بالجروب.');
      lines.push('', `الأسعار: أسبوع ⭐${prices.week} · شهر ⭐${prices.month} · سنة ⭐${prices.year}`);
      lines.push('👇 اختر مدة الاشتراك (الدفع بنجوم تيليجرام):');

      // In a group the buttons buy premium FOR THE GROUP (needs the buyer to pay);
      // in private they buy it for the user.
      const subjectType: SubjectType = inGroup ? 'group' : 'user';
      const subjectId = inGroup && ctx.chat ? ctx.chat.id : ctx.from.id;
      await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        ...(await plansKeyboard(subjectType, subjectId)),
      });
    });

    // ── Buy button → send a Stars invoice ──────────────────────────────────
    bot.action(/^mon:buy:(user|group):(week|month|year):(-?\d{1,20})$/, async (ctx) => {
      if (!enabled()) return void ctx.answerCbQuery(DISABLED_MSG, { show_alert: true }).catch(() => undefined);
      const subjectType = ctx.match[1] as SubjectType;
      const planId = ctx.match[2] as PlanId;
      const subjectId = ctx.match[3];
      const plan = planById(planId);
      if (!plan) return void ctx.answerCbQuery('خطة غير معروفة').catch(() => undefined);
      const stars = await priceOf(planId);
      await ctx.answerCbQuery().catch(() => undefined);

      const title = `اشتراك مميّز — ${plan.label}`;
      const description =
        subjectType === 'group'
          ? `تفعيل المزايا المميّزة لهذا الجروب لمدة ${plan.label}.`
          : `تفعيل الاشتراك المميّز لحسابك لمدة ${plan.label}.`;
      try {
        await ctx.telegram.sendInvoice(ctx.chat!.id, {
          title,
          description,
          payload: premiumPayload(subjectType, planId, subjectId),
          provider_token: '', // Telegram Stars → empty provider token
          currency: 'XTR',
          prices: [{ label: title, amount: stars }],
        } as never);
      } catch (err) {
        log.warn({ err }, 'sendInvoice failed');
        await ctx.reply('⚠️ تعذّر إنشاء الفاتورة الآن، جرّب لاحقاً.').catch(() => undefined);
      }
    });

    // ── Pre-checkout: always approve (digital goods, nothing to validate) ───
    bot.on('pre_checkout_query', async (ctx) => {
      await ctx.answerPreCheckoutQuery(true).catch(() => undefined);
    });

    // ── Successful payment: grant premium, record it, pay referral ─────────
    bot.on(message('successful_payment'), async (ctx, next) => {
      const sp = ctx.message.successful_payment;
      if (!sp || sp.currency !== 'XTR') return next();
      const parsed = parsePremiumPayload(sp.invoice_payload);
      if (!parsed || !ctx.from) return next();

      // For a user sub, the payer IS the subject (a shared group button still
      // rewards whoever paid). For a group sub, the encoded chat id is the subject.
      const subjectId = parsed.subjectType === 'user' ? BigInt(ctx.from.id) : BigInt(parsed.subjectId);
      const stars = sp.total_amount; // XTR amount == number of Stars

      await grantPremium(parsed.subjectType, subjectId, parsed.planId).catch((err) =>
        log.error({ err }, 'grantPremium failed after payment'),
      );
      await recordStarTransaction({
        userId: ctx.from.id,
        chargeId: sp.telegram_payment_charge_id,
        stars,
        product: `premium:${parsed.subjectType}:${parsed.planId}`,
        payload: sp.invoice_payload,
        chatId: parsed.subjectType === 'group' ? subjectId : null,
      });

      const plan = planById(parsed.planId);
      const target = parsed.subjectType === 'group' ? 'هذا الجروب' : 'حسابك';
      await ctx
        .reply(`✅ <b>تم تفعيل الاشتراك المميّز</b> 💎\nلـ ${target} لمدة ${plan?.label ?? ''}. شكراً لدعمك! 🌟`)
        .catch(() => undefined);

      // Referral commission to whoever invited the payer.
      const reward = await payReferralCommission(ctx.from.id, stars).catch(() => null);
      if (reward) {
        await ctx.telegram
          .sendMessage(
            reward.referrerId.toString(),
            `🎉 ربحت <b>${reward.credits}</b> نقطة إحالة من اشتراك أحد من دعوتهم! (👛 /wallet)`,
            { parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      }
    });

    // ── /referral — link + stats ───────────────────────────────────────────
    bot.command('referral', async (ctx) => {
      if (!enabled()) return void ctx.reply(DISABLED_MSG);
      if (!ctx.from) return;
      const username = ctx.botInfo?.username;
      if (!username) return void ctx.reply('⚠️ غير متاح الآن.');
      const link = `https://t.me/${username}?start=ref_${ctx.from.id}`;
      const [stats, pct] = await Promise.all([referralStats(ctx.from.id), getReferralPercent()]);
      await ctx.reply(
        [
          '🔗 <b>نظام الإحالة</b>',
          '',
          `شارك رابطك، وكل من يشترك عن طريقك تربح <b>${pct}%</b> من قيمة اشتراكه نقاطاً في محفظتك.`,
          '',
          `👥 من دعوتهم: <b>${stats.count}</b>`,
          `💰 إجمالي أرباحك: <b>${stats.totalEarned}</b> نقطة`,
          `👛 رصيدك الحالي: <b>${stats.credits}</b> نقطة`,
          '',
          '🔗 رابطك:',
          `<code>${esc(link)}</code>`,
        ].join('\n'),
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url('📤 شارك الرابط', `https://t.me/share/url?url=${encodeURIComponent(link)}`)]]) },
      );
    });

    // ── /wallet — referral credits ─────────────────────────────────────────
    bot.command('wallet', async (ctx) => {
      if (!enabled()) return void ctx.reply(DISABLED_MSG);
      if (!ctx.from) return;
      const w = await getWallet(ctx.from.id);
      await ctx.reply(
        [
          `👛 <b>محفظة</b> ${mention(ctx.from)}`,
          '',
          `الرصيد القابل للاستخدام: <b>${w.credits}</b> نقطة`,
          `إجمالي ما ربحته: <b>${w.totalEarned}</b> نقطة`,
          '',
          '💡 النقاط تُجمع من الإحالة. للسحب تواصل مع المالك.',
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
    });

    // ── /buystars — buy Stars, paid in TON (auto-detected & auto-delivered) ─
    const starsAvailable = (): boolean => env.STARS_SELL_ENABLED && !!env.TON_WALLET_ADDRESS;

    bot.command('buystars', async (ctx) => {
      if (!starsAvailable()) return void ctx.reply('⭐ خدمة شراء النجوم غير مفعّلة حالياً.');
      // A quick price hint using a sample package.
      const q = await quote(100);
      await ctx.reply(
        [
          '⭐ <b>شراء نجوم تيليجرام</b> (دفع بـ TON)',
          '',
          `السعر التقريبي: <b>100⭐ ≈ ${q.ton} TON</b>`,
          'اختر الباقة، وسيظهر لك عنوان الدفع فوراً. التسليم تلقائي بعد الدفع 🚀',
          '',
          'ملاحظة: لازم يكون عندك <b>@username</b> عام لاستلام النجوم.',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⭐ 100', 'mon:stars:100'), Markup.button.callback('⭐ 150', 'mon:stars:150')],
            [Markup.button.callback('⭐ 250', 'mon:stars:250'), Markup.button.callback('⭐ 500', 'mon:stars:500')],
            [Markup.button.callback('⭐ 1000', 'mon:stars:1000')],
          ]),
        },
      );
    });

    bot.action(/^mon:stars:(\d{2,6})$/, async (ctx) => {
      if (!starsAvailable())
        return void ctx.answerCbQuery('الخدمة غير مفعّلة', { show_alert: true }).catch(() => undefined);
      if (!ctx.from) return;
      await ctx.answerCbQuery().catch(() => undefined);
      if (!ctx.from.username) {
        return void ctx
          .reply('⚠️ لازم تضبط <b>@username</b> عام لحسابك أول (إعدادات تيليجرام) عشان نقدر نوصّلك النجوم، بعدها جرّب.', {
            parse_mode: 'HTML',
          })
          .catch(() => undefined);
      }
      const stars = parseInt(ctx.match[1], 10);
      const r = await createTonOrder({ userId: ctx.from.id, username: ctx.from.username, stars });
      if ('error' in r) {
        const msg =
          r.error === 'disabled'
            ? 'الخدمة غير مفعّلة حالياً.'
            : r.error.startsWith('range')
              ? `الكمية لازم تكون ضمن الحدود المسموحة (${r.error.slice(6)}).`
              : 'تعذّر إنشاء الطلب.';
        return void ctx.reply('⚠️ ' + msg).catch(() => undefined);
      }
      await ctx
        .reply(
          [
            `🧾 <b>طلب #${r.order.id}</b> — <b>${stars}⭐</b> لـ @${esc(ctx.from.username)}`,
            '',
            `1️⃣ أرسل بالضبط: <b>${r.ton} TON</b>`,
            `2️⃣ إلى العنوان:`,
            `<code>${esc(r.address)}</code>`,
            `3️⃣ <b>مهم جداً</b> — ضع هذا التعليق (Comment/Memo) مع التحويل:`,
            `<code>${esc(r.payCode)}</code>`,
            '',
            `⏱ لديك ${r.expiresMin} دقيقة. بعد الدفع، التسليم <b>تلقائي</b> خلال دقائق — لا تغلق شيئاً.`,
          ].join('\n'),
          { parse_mode: 'HTML' },
        )
        .catch(() => undefined);
    });

    // ── Owner: grant / revoke premium manually ─────────────────────────────
    bot.command('grantpremium', async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      const args = ctx.message.text.split(/\s+/).slice(1);
      const planId = (args.find((a) => ['week', 'month', 'year'].includes(a)) as PlanId) || 'month';
      const replied = (ctx.message as { reply_to_message?: { from?: { id: number } } }).reply_to_message;
      const idArg = args.find((a) => /^-?\d{3,20}$/.test(a));
      let subjectType: SubjectType = 'user';
      let subjectId: bigint | null = null;
      if (replied?.from) {
        subjectId = BigInt(replied.from.id);
      } else if (idArg) {
        subjectId = BigInt(idArg);
        if (subjectId < 0n) subjectType = 'group';
      } else if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
        subjectType = 'group';
        subjectId = BigInt(ctx.chat.id);
      }
      if (subjectId == null)
        return void ctx.reply('الاستخدام: بالرد على العضو، أو <code>/grantpremium &lt;id&gt; month</code>', {
          parse_mode: 'HTML',
        });
      const sub = await grantPremium(subjectType, subjectId, planId, { grantedBy: ctx.from.id });
      await ctx.reply(
        `✅ منحت اشتراكاً مميّزاً (${planById(planId)?.label}) لـ ${subjectType === 'group' ? 'الجروب' : 'المستخدم'} <code>${subjectId}</code>.\nينتهي: ${sub.expiresAt.toISOString().slice(0, 10)}`,
        { parse_mode: 'HTML' },
      );
    });

    bot.command('revokepremium', async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      const args = ctx.message.text.split(/\s+/).slice(1);
      const replied = (ctx.message as { reply_to_message?: { from?: { id: number } } }).reply_to_message;
      const idArg = args.find((a) => /^-?\d{3,20}$/.test(a));
      let subjectType: SubjectType = 'user';
      let subjectId: bigint | null = null;
      if (replied?.from) subjectId = BigInt(replied.from.id);
      else if (idArg) {
        subjectId = BigInt(idArg);
        if (subjectId < 0n) subjectType = 'group';
      } else if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
        subjectType = 'group';
        subjectId = BigInt(ctx.chat.id);
      }
      if (subjectId == null) return void ctx.reply('حدّد المستخدم (بالرد) أو المعرّف.');
      await revokePremium(subjectType, subjectId);
      await ctx.reply(`🚫 ألغيت الاشتراك المميّز لـ <code>${subjectId}</code>.`, { parse_mode: 'HTML' });
    });

    // ── Referral attribution on /start ref_<id> ────────────────────────────
    bot.start(async (ctx, next) => {
      const refId = parseReferralPayload(ctx.startPayload);
      if (refId == null) return next(); // not a referral link → let other start handlers run
      if (ctx.from && refId !== BigInt(ctx.from.id)) {
        const ok = await setReferrer(ctx.from.id, refId).catch(() => false);
        if (ok) {
          await ctx.telegram
            .sendMessage(refId.toString(), `🎉 انضم مستخدم جديد عبر رابط إحالتك! (👥 /referral)`)
            .catch(() => undefined);
        }
      }
      await ctx.reply('👋 أهلاً فيك! اكتب /premium لمشاهدة الاشتراك المميّز.').catch(() => undefined);
    });

    // ── TON payment poller: detect paid orders and auto-deliver ────────────
    // Runs only when the Stars shop is enabled. A single-flight guard prevents
    // overlapping ticks; each tick is best-effort and never throws.
    if (env.STARS_SELL_ENABLED && env.TON_WALLET_ADDRESS) {
      let ticking = false;
      setInterval(() => {
        if (ticking) return;
        ticking = true;
        void tickOrders(bot.telegram)
          .catch((err) => log.warn({ err }, 'tickOrders failed'))
          .finally(() => {
            ticking = false;
          });
      }, 25_000).unref?.();
      log.info('stars-shop TON payment poller started');
    }
  },
};
