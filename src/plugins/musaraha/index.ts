import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName } from '../../utils/format';
import { isPromptAllowed } from '../../services/image/safety';
import { msPending, msReplyPending, replyRoutes, makeReplyToken } from './state';

/**
 * "Musaraha" (مصارحة) — Sarahah/NGL-style anonymous messages.
 *   1. A user gets a personal link (t.me/bot?start=s_<id>).
 *   2. They share it; anyone who opens it can type a message.
 *   3. The bot delivers it anonymously to that user's DM.
 * Consent-based (you invite messages by sharing your own link). A light content
 * check blocks clearly abusive/explicit text.
 */
export const musarahaPlugin: Plugin = {
  name: 'musaraha',
  description: 'Anonymous messages (Sarahah/NGL style)',
  commands: [{ command: 'musaraha', description: '💌 رابط المصارحة (استقبل رسائل مجهولة)' }],

  register(bot: Telegraf<BotContext>) {
    const sendLink = async (ctx: BotContext) => {
      if (!ctx.from) return;
      const username = ctx.botInfo?.username;
      if (!username) return void ctx.reply('⚠️ تعذّر تجهيز الرابط الآن، حاول لاحقاً.');
      const link = `https://t.me/${username}?start=s_${ctx.from.id}`;
      await ctx.reply(
        `💌 رابط المصارحة الخاص فيك:\n${link}\n\nشاركه في بايو/ستوري، وأي حد يفتحه بيقدر يبعتلك رسالة مجهولة تجيك بالخاص 🤫`,
      );
    };
    bot.command('musaraha', sendLink);

    // Opening someone's link → start composing an anonymous message to them.
    bot.start(async (ctx, next) => {
      const payload = ctx.startPayload;
      if (!payload || !payload.startsWith('s_')) return next();
      const targetId = Number(payload.slice(2));
      if (!targetId || !ctx.from) return void ctx.reply('❌ رابط غير صالح.');
      if (targetId === ctx.from.id) {
        return void ctx.reply('💌 هذا رابطك أنت! شاركه مع أصدقائك ليرسلوا لك رسائل مجهولة.');
      }
      msPending.set(ctx.from.id, targetId);
      await ctx.reply('✍️ اكتب رسالتك المجهولة الآن وأرسلها — لن يعرف الطرف الآخر من أنت 🤫');
    });

    // The link owner taps "reply" → start composing a NAMED reply to the sender.
    bot.action(/^ms:reply:(.+)$/, async (ctx) => {
      const route = replyRoutes.get(ctx.match[1]);
      if (!route) return void ctx.answerCbQuery('⌛ انتهت صلاحية الرد.').catch(() => undefined);
      if (ctx.from.id !== route.ownerId) return void ctx.answerCbQuery('🔒 هذا الرد ليس لك.').catch(() => undefined);
      msReplyPending.set(ctx.from.id, route.senderId);
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.reply('✍️ اكتب ردّك الآن — سيظهر باسمك (لأنها مصارحتك أنت):').catch(() => undefined);
    });

    bot.on(message('text'), async (ctx, next) => {
      if (ctx.chat?.type !== 'private' || !ctx.from) return next();
      const text = ctx.message.text.trim();

      // 1) A named reply from the link owner back to the anonymous sender.
      const replyTo = msReplyPending.get(ctx.from.id);
      if (replyTo) {
        msReplyPending.delete(ctx.from.id);
        if (!text || text.startsWith('/')) return void ctx.reply('❌ اكتب رسالة نصية عادية.');
        if (!isPromptAllowed(text)) return void ctx.reply('🚫 لا يمكن إرسال محتوى مسيء أو غير لائق.');
        const ok = await ctx.telegram
          .sendMessage(replyTo, `↩️ ردّ ${displayName(ctx.from)} على رسالتك المجهولة:\n\n${text}`)
          .then(() => true)
          .catch(() => false);
        return void ctx.reply(ok ? '✅ تم إرسال ردّك!' : '⚠️ تعذّر توصيل الرد.');
      }

      // 2) An anonymous message being composed to a link owner.
      const targetId = msPending.get(ctx.from.id);
      if (!targetId) return next();
      msPending.delete(ctx.from.id);
      if (!text) return void ctx.reply('❌ الرسالة فارغة.');
      if (text.startsWith('/')) return void ctx.reply('❌ اكتب رسالة نصية عادية.');
      if (!isPromptAllowed(text)) return void ctx.reply('🚫 لا يمكن إرسال محتوى مسيء أو غير لائق عبر المصارحة.');

      const token = makeReplyToken();
      replyRoutes.set(token, { senderId: ctx.from.id, ownerId: targetId });
      const ok = await ctx.telegram
        .sendMessage(targetId, `📩 وصلتك رسالة مصارحة (مجهولة):\n\n${text}`, {
          reply_markup: { inline_keyboard: [[{ text: '↩️ رد', callback_data: `ms:reply:${token}` }]] },
        })
        .then(() => true)
        .catch(() => false);
      await ctx.reply(ok ? '✅ تم إرسال رسالتك المجهولة بنجاح!' : '⚠️ تعذّر توصيل الرسالة (قد يكون الطرف لم يبدأ محادثة البوت).');
    });
  },
};
