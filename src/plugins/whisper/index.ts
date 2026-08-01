import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isBotOwner } from '../../utils/permissions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:whisper');

/**
 * "Whisper" (همسة) — a secret message sent into a group via inline mode that
 * only the intended recipient (or everyone, for a public whisper) can reveal.
 * The bot owner can always reveal any whisper.
 *
 * Usage in any chat:  @YourBot @username your secret text
 *                     @YourBot 123456789 your secret text   (by user id)
 *                     @YourBot your text                     (public whisper)
 *
 * Requires inline mode enabled in BotFather (/setinline).
 */
interface Whisper {
  senderId: number;
  targetId?: number;
  targetUsername?: string; // lowercased, no '@'
  text: string;
  groupWide: boolean;
}

// In-memory store (whispers are ephemeral by nature). Bounded to cap memory.
const whispers = new Map<string, Whisper>();
const MAX_WHISPERS = 5000;
let counter = 0;

function put(whisper: Whisper): string {
  const id = `${whisper.senderId.toString(36)}${(counter++).toString(36)}`;
  whispers.set(id, whisper);
  if (whispers.size > MAX_WHISPERS) {
    const oldest = whispers.keys().next().value;
    if (oldest) whispers.delete(oldest);
  }
  return id;
}

export const whisperPlugin: Plugin = {
  name: 'whisper',
  description: 'Secret inline whispers (two-party or group-wide)',
  commands: [{ command: 'whisper', description: '🤫 شرح إرسال همسة سرية' }],

  register(bot: Telegraf<BotContext>) {
    // Help command (the real feature is inline).
    bot.command('whisper', async (ctx) => {
      const uname = ctx.botInfo?.username ?? 'بوتك';
      await ctx.reply(
        '🤫 الهمسة السرية\n\n' +
          `اكتب في أي محادثة:\n` +
          `<code>@${uname} @اسم_المستخدم رسالتك السرية</code>\n\n` +
          'يظهر خيارين:\n' +
          '• 🔒 همسة خاصة — فقط الشخص المذكور يفتحها\n' +
          '• 📢 همسة للكل — أي أحد بالقروب يفتحها\n\n' +
          'يمكنك استخدام آيدي الشخص بدل اسمه.',
        { parse_mode: 'HTML' },
      );
    });

    // Inline query → offer whisper result(s).
    bot.on('inline_query', async (ctx) => {
      const q = ctx.inlineQuery.query.trim();
      if (!q) {
        await ctx.answerInlineQuery(
          [
            {
              type: 'article',
              id: 'whisper-help',
              title: '🤫 كيف أرسل همسة؟',
              description: 'اكتب: @اسم_المستخدم رسالتك السرية',
              input_message_content: {
                message_text: 'لإرسال همسة: اكتب في خانة الرسالة @اسم_البوت ثم @اسم_الشخص ثم رسالتك.',
              },
            },
          ] as never,
          { cache_time: 0, is_personal: true },
        );
        return;
      }

      const parts = q.split(/\s+/);
      const first = parts[0];
      let targetUsername: string | undefined;
      let targetId: number | undefined;
      let message = q;

      if (first.startsWith('@') && first.length > 1) {
        targetUsername = first.slice(1).toLowerCase();
        message = parts.slice(1).join(' ');
      } else if (/^\d{5,}$/.test(first)) {
        targetId = Number(first);
        message = parts.slice(1).join(' ');
      }
      const hasTarget = Boolean(targetUsername || targetId);
      const targetLabel = targetUsername ? `@${targetUsername}` : targetId ? String(targetId) : '';

      const results: unknown[] = [];

      if (hasTarget && message) {
        const id = put({ senderId: ctx.from.id, targetId, targetUsername, text: message, groupWide: false });
        results.push({
          type: 'article',
          id,
          title: `🔒 همسة خاصة إلى ${targetLabel}`,
          description: 'فقط هو من يستطيع فتحها',
          input_message_content: {
            message_text: `🤫 همسة سرية إلى ${escapeHtml(targetLabel)}\nفقط هو من يقدر يفتحها 👇`,
            parse_mode: 'HTML',
          },
          reply_markup: { inline_keyboard: [[{ text: '👀 عرض الهمسة', callback_data: `wh:${id}` }]] },
        });
      }

      // Group-wide option (always available when there is a message body).
      const publicBody = hasTarget ? message : q;
      if (publicBody) {
        const id = put({ senderId: ctx.from.id, text: publicBody, groupWide: true });
        results.push({
          type: 'article',
          id,
          title: '📢 همسة للكل',
          description: 'أي أحد بالقروب يقدر يفتحها',
          input_message_content: {
            message_text: '📢 همسة — اضغط للعرض 👇',
          },
          reply_markup: { inline_keyboard: [[{ text: '👀 عرض الهمسة', callback_data: `wh:${id}` }]] },
        });
      }

      await ctx.answerInlineQuery(results as never, { cache_time: 0, is_personal: true });
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
        w.groupWide ||
        isBotOwner(u.id) ||
        u.id === w.senderId ||
        (w.targetId != null && u.id === w.targetId) ||
        (w.targetUsername != null &&
          u.username != null &&
          u.username.toLowerCase() === w.targetUsername);

      if (allowed) {
        await ctx.answerCbQuery(w.text, { show_alert: true });
        if (isBotOwner(u.id) && u.id !== w.senderId && !w.groupWide) {
          log.info({ ownerId: u.id, senderId: w.senderId }, 'Owner revealed a private whisper');
        }
      } else {
        await ctx.answerCbQuery('🔒 هذه الهمسة ليست لك.', { show_alert: true });
      }
    });
  },
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
