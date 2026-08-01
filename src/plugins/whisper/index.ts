import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isBotOwner } from '../../utils/permissions';
import { displayName } from '../../utils/format';
import {
  whispers,
  pendingTokens,
  dmPending,
  storeWhisper,
  makeToken,
} from './state';

/**
 * "Whisper" (همسة) — the secret is typed in the bot's DM, never in the group,
 * so it can't leak. Flow:
 *   1. Reply to the target in the group and type "اهمس" (or /whisper).
 *   2. Bot posts a message with a button that deep-links to its DM.
 *   3. Sender taps it, types the secret privately in DM.
 *   4. Bot posts the hidden whisper into the group; only the target, the
 *      sender, or the bot owner can reveal it.
 */
type TargetUser = { id: number; first_name?: string; username?: string; is_bot?: boolean };

export const whisperPlugin: Plugin = {
  name: 'whisper',
  description: 'Secret whispers with the secret entered privately in DM',
  commands: [{ command: 'whisper', description: '🤫 همسة سرية (بالرد على العضو)' }],

  register(bot: Telegraf<BotContext>) {
    // Step 1: /whisper or "اهمس" as a reply to the target in a group.
    bot.command('whisper', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const replied = (ctx.message as { reply_to_message?: { from?: TargetUser } }).reply_to_message;
      const target = replied?.from;
      if (!target || target.is_bot || target.id === ctx.from.id) {
        await ctx.reply('🤫 ردّ على رسالة الشخص الذي تريد أن تهمس له ثم اكتب: اهمس');
        return;
      }

      const username = ctx.botInfo?.username;
      if (!username) {
        await ctx.reply('⚠️ تعذّر تجهيز الهمسة الآن، حاول لاحقاً.');
        return;
      }

      const targetName = displayName(target);
      // Delete the trigger (in case the user typed a secret after "اهمس").
      await ctx.deleteMessage().catch(() => undefined);

      const token = makeToken(ctx.from.id);
      const prompt = await ctx.reply(
        `🤫 ${displayName(ctx.from)} يريد أن يهمس لـ ${targetName}\nاضغط الزر لكتابة همستك بالخاص 👇`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: '✍️ اكتب همستك', url: `https://t.me/${username}?start=w_${token}` }]],
          },
        },
      );

      pendingTokens.set(token, {
        senderId: ctx.from.id,
        targetId: target.id,
        targetUsername: target.username?.toLowerCase(),
        targetName,
        chatId: ctx.chat.id,
        promptMsgId: prompt.message_id,
      });
    });

    // Step 3a: DM /start with the whisper token → ask for the secret.
    bot.start(async (ctx, next) => {
      const payload = ctx.startPayload;
      if (!payload || !payload.startsWith('w_')) return next();
      const token = payload.slice(2);
      const p = pendingTokens.get(token);
      if (!p) {
        await ctx.reply('⌛ انتهت صلاحية هذه الهمسة.');
        return;
      }
      if (ctx.from?.id !== p.senderId) {
        await ctx.reply('🔒 هذه الهمسة ليست لك.');
        return;
      }
      dmPending.set(ctx.from.id, token);
      await ctx.reply(`✍️ اكتب همستك لـ ${p.targetName} الآن وأرسلها كرسالة عادية:`);
    });

    // Step 3b: DM text = the secret. Post the hidden whisper to the group.
    bot.on(message('text'), async (ctx, next) => {
      if (ctx.chat?.type !== 'private' || !ctx.from) return next();
      const token = dmPending.get(ctx.from.id);
      if (!token) return next();

      dmPending.delete(ctx.from.id);
      const p = pendingTokens.get(token);
      pendingTokens.delete(token);
      if (!p) {
        await ctx.reply('⌛ انتهت صلاحية هذه الهمسة.');
        return;
      }

      const secret = ctx.message.text.trim();
      if (!secret) {
        await ctx.reply('❌ الهمسة فارغة.');
        return;
      }

      const id = storeWhisper({
        senderId: p.senderId,
        targetId: p.targetId,
        targetUsername: p.targetUsername,
        targetName: p.targetName,
        text: secret,
      });

      await ctx.telegram
        .sendMessage(p.chatId, `🤫 همسة سرية إلى ${p.targetName}\nفقط هو من يقدر يفتحها 👇`, {
          reply_markup: { inline_keyboard: [[{ text: '👀 عرض الهمسة', callback_data: `wh:${id}` }]] },
        })
        .catch(() => undefined);

      // Clean up the group prompt and confirm privately.
      await ctx.telegram.deleteMessage(p.chatId, p.promptMsgId).catch(() => undefined);
      await ctx.reply('✅ تم إرسال همستك للقروب بسرية.');
    });

    // Step 4: reveal on button press.
    bot.action(/^wh:(.+)$/, async (ctx) => {
      const id = ctx.match[1];
      const w = whispers.get(id);
      if (!w) {
        await ctx.answerCbQuery('⌛ انتهت الهمسة أو غير موجودة.', { show_alert: true });
        return;
      }
      const u = ctx.from;
      const allowed =
        isBotOwner(u.id) ||
        u.id === w.senderId ||
        u.id === w.targetId ||
        (w.targetUsername != null &&
          u.username != null &&
          u.username.toLowerCase() === w.targetUsername);

      await ctx.answerCbQuery(allowed ? w.text : '🔒 هذه الهمسة ليست لك.', { show_alert: true });
    });
  },
};
