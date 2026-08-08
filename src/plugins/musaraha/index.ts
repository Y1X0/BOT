import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName, senderIdentity } from '../../utils/format';
import { isBotOwner } from '../../utils/permissions';
import { isPromptAllowed } from '../../services/image/safety';
import { recordMessage, senderForDelivered, blockSender, isBlocked, recentMessages } from '../../services/musaraha.service';
import { msPending } from './state';

const BLOCK_WORDS = ['حظر', 'بلوك', 'block'];

/**
 * "Musaraha" (مصارحة) — Sarahah/NGL-style anonymous messages, persisted to the
 * DB so reply-routing and blocks survive restarts. The bot owner can review all
 * messages (they pass through the bot) to police abuse.
 */
export const musarahaPlugin: Plugin = {
  name: 'musaraha',
  description: 'Anonymous messages (Sarahah/NGL style)',
  commands: [
    { command: 'musaraha', description: '💌 رابط المصارحة (استقبل رسائل مجهولة)' },
    { command: 'mslog', description: '🕵️ سجل المصارحة (للمالك)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    const sendLink = async (ctx: BotContext) => {
      const me = senderIdentity(ctx);
      if (!me) return;
      const username = ctx.botInfo?.username;
      if (!username) return void ctx.reply('⚠️ تعذّر تجهيز الرابط الآن، حاول لاحقاً.');
      const link = `https://t.me/${username}?start=s_${me.id}`;
      await ctx.reply(
        `💌 رابط المصارحة الخاص فيك:\n${link}\n\nشاركه في بايو/ستوري، وأي حد يفتحه بيقدر يبعتلك رسالة مجهولة تجيك بالخاص 🤫`,
      );
    };
    bot.command('musaraha', sendLink);

    // Owner-only oversight: recent anonymous messages (sender is de-anonymized
    // to the owner only, for abuse moderation).
    bot.command('mslog', async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      const rows = await recentMessages(25);
      if (!rows.length) return void ctx.reply('🕵️ لا توجد رسائل مصارحة بعد.');
      const lines = rows.map((r) => {
        const who = r.isReply ? '↩️ رد' : '📩';
        return `${who} ${r.senderName ?? r.senderId} (${r.senderId}) → ${r.recipientId}:\n${r.text.slice(0, 80)}`;
      });
      await ctx.reply(`🕵️ آخر رسائل المصارحة:\n\n${lines.join('\n\n')}`);
    });

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

    bot.on(message('text'), async (ctx, next) => {
      if (ctx.chat?.type !== 'private' || !ctx.from) return next();
      const text = ctx.message.text.trim();
      const reply = (ctx.message as { reply_to_message?: { message_id?: number; from?: { id?: number } } }).reply_to_message;

      // 1) Owner replies natively to an anonymous message → reply back, or block.
      if (reply?.message_id != null && reply.from?.id === ctx.botInfo?.id) {
        const senderId = await senderForDelivered(ctx.from.id, reply.message_id);
        if (senderId != null) {
          if (BLOCK_WORDS.includes(text)) {
            await blockSender(ctx.from.id, senderId);
            return void ctx.reply('🚫 تم حظر هذا المرسِل — لن تصلك رسائله المجهولة بعد الآن.');
          }
          if (!text || text.startsWith('/')) return void ctx.reply('❌ اكتب رسالة نصية عادية.');
          if (!isPromptAllowed(text)) return void ctx.reply('🚫 لا يمكن إرسال محتوى مسيء أو غير لائق.');
          const ok = await ctx.telegram
            .sendMessage(Number(senderId), `↩️ ردّ ${displayName(ctx.from)} على رسالتك المجهولة:\n\n${text}`)
            .then(() => true)
            .catch(() => false);
          if (ok) await recordMessage({ senderId: ctx.from.id, senderName: displayName(ctx.from), recipientId: senderId, text, isReply: true });
          return void ctx.reply(ok ? '✅ تم إرسال ردّك!' : '⚠️ تعذّر توصيل الرد.');
        }
      }

      // 2) An anonymous message being composed to a link owner.
      const targetId = msPending.get(ctx.from.id);
      if (!targetId) return next();
      msPending.delete(ctx.from.id);
      if (!text) return void ctx.reply('❌ الرسالة فارغة.');
      if (text.startsWith('/')) return void ctx.reply('❌ اكتب رسالة نصية عادية.');
      if (await isBlocked(targetId, ctx.from.id)) return void ctx.reply('🚫 لا يمكنك إرسال رسائل لهذا الشخص (قام بحظرك).');
      if (!isPromptAllowed(text)) return void ctx.reply('🚫 لا يمكن إرسال محتوى مسيء أو غير لائق عبر المصارحة.');

      const sent = await ctx.telegram
        .sendMessage(
          targetId,
          `📩 وصلتك رسالة مصارحة (مجهولة):\n\n${text}\n\n↩️ للرد: اعمل Reply على هذه الرسالة.\n🚫 للحظر: ردّ عليها بكلمة «حظر».`,
        )
        .catch(() => null);
      await recordMessage({
        senderId: ctx.from.id,
        senderName: displayName(ctx.from),
        recipientId: targetId,
        text,
        deliveredMsgId: sent?.message_id ?? null,
      });
      await ctx.reply(sent ? '✅ تم إرسال رسالتك المجهولة بنجاح!' : '⚠️ تعذّر توصيل الرسالة (قد يكون الطرف لم يبدأ محادثة البوت).');
    });
  },
};
