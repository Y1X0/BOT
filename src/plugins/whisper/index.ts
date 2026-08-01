import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isBotOwner } from '../../utils/permissions';
import { displayName } from '../../utils/format';

/**
 * "Whisper" (همسة) — reply-based, no inline mode required.
 *
 * Flow:
 *   1. Reply to the target's message and type "اهمس" (or /whisper).
 *      - "اهمس نص السر"  → whisper created immediately (trigger msg deleted).
 *      - "اهمس" alone     → bot opens a force-reply box to type the secret.
 *   2. The bot posts a hidden message with a "عرض الهمسة" button.
 *   3. Only the target (or the sender, or the bot owner) can reveal it.
 */
interface Whisper {
  senderId: number;
  targetId: number;
  targetUsername?: string;
  targetName: string;
  text: string;
}

interface Pending {
  senderId: number;
  targetId: number;
  targetUsername?: string;
  targetName: string;
}

const whispers = new Map<string, Whisper>();
const pending = new Map<string, Pending>(); // key: `${chatId}:${promptMsgId}`
const MAX = 5000;
let counter = 0;

function store(w: Whisper): string {
  const id = `${w.senderId.toString(36)}${(counter++).toString(36)}`;
  whispers.set(id, w);
  if (whispers.size > MAX) {
    const oldest = whispers.keys().next().value;
    if (oldest) whispers.delete(oldest);
  }
  return id;
}

type TargetUser = { id: number; first_name?: string; username?: string; is_bot?: boolean };

async function postWhisper(
  ctx: BotContext,
  senderId: number,
  target: { id: number; username?: string; name: string },
  text: string,
): Promise<void> {
  const id = store({
    senderId,
    targetId: target.id,
    targetUsername: target.username?.toLowerCase(),
    targetName: target.name,
    text,
  });
  await ctx.reply(`🤫 همسة سرية إلى ${target.name}\nفقط هو من يقدر يفتحها 👇`, {
    reply_markup: { inline_keyboard: [[{ text: '👀 عرض الهمسة', callback_data: `wh:${id}` }]] },
  });
}

export const whisperPlugin: Plugin = {
  name: 'whisper',
  description: 'Secret reply-based whispers (no inline mode needed)',
  commands: [{ command: 'whisper', description: '🤫 همسة سرية (بالرد على العضو)' }],

  register(bot: Telegraf<BotContext>) {
    // /whisper or "اهمس" — must be a reply to the target member.
    bot.command('whisper', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const replied = (ctx.message as { reply_to_message?: { from?: TargetUser } }).reply_to_message;
      const target = replied?.from;
      if (!target || target.is_bot || target.id === ctx.from.id) {
        await ctx.reply('🤫 ردّ على رسالة الشخص الذي تريد أن تهمس له ثم اكتب: اهمس');
        return;
      }
      const targetName = displayName(target);
      const text = ctx.message.text.split(' ').slice(1).join(' ').trim();

      if (text) {
        // One-shot form: delete the trigger (it holds the secret) then post.
        await ctx.deleteMessage().catch(() => undefined);
        await postWhisper(ctx, ctx.from.id, { id: target.id, username: target.username, name: targetName }, text);
        return;
      }

      // Interactive form: open a force-reply "place to whisper in".
      const prompt = await ctx.reply(`✍️ اكتب همستك لـ ${targetName} بالرد على هذه الرسالة:`, {
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'همستك السرية...' },
        reply_parameters: { message_id: ctx.message.message_id },
      });
      pending.set(`${ctx.chat.id}:${prompt.message_id}`, {
        senderId: ctx.from.id,
        targetId: target.id,
        targetUsername: target.username,
        targetName,
      });
    });

    // Capture the secret when the sender replies to our force-reply prompt.
    bot.on(message('text'), async (ctx, next) => {
      const chat = ctx.chat;
      const from = ctx.from;
      const replied = (ctx.message as { reply_to_message?: { message_id?: number } }).reply_to_message;
      if (!chat || !from || !replied?.message_id) return next();

      const key = `${chat.id}:${replied.message_id}`;
      const p = pending.get(key);
      if (!p || p.senderId !== from.id) return next();

      // This is a whisper secret. Remove it + the prompt, then post the whisper.
      pending.delete(key);
      const secret = ctx.message.text.trim();
      await ctx.deleteMessage().catch(() => undefined); // the secret
      await ctx.telegram.deleteMessage(chat.id, replied.message_id).catch(() => undefined); // the prompt
      if (secret) {
        await postWhisper(
          ctx,
          from.id,
          { id: p.targetId, username: p.targetUsername, name: p.targetName },
          secret,
        );
      }
      return; // consumed
    });

    // Reveal on button press.
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
