import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { decorate } from './decorate';

/** Escape text for Telegram HTML parse mode. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Text decoration command. `/decorate <word>` (or the Arabic alias
 * "زخرفة <word>") replies with a numbered list of stylised variants.
 */
export const decoratePlugin: Plugin = {
  name: 'decorate',
  description: 'Stylise text into decorated Unicode variants',
  commands: [{ command: 'decorate', description: '🎨 زخرفة كلمة: /decorate الكلمة' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('decorate', async (ctx) => {
      const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!text) {
        await ctx.reply('🎨 اكتب الكلمة بعد الأمر.\nمثال: /decorate طاولة\nأو: زخرفة طاولة');
        return;
      }
      if (text.length > 30) {
        await ctx.reply('🎨 الكلمة طويلة، جرّب كلمة أقصر (حتى 30 حرف).');
        return;
      }

      const variants = decorate(text);
      // Each variant is wrapped in a <code> span: tapping it in Telegram
      // copies just that decoration to the clipboard automatically.
      const list = variants.map((v) => `<code>${escapeHtml(v)}</code>`).join('\n');
      await ctx.reply(
        `🎨 زخرفة «${escapeHtml(text)}»:\n\n👆 اضغط على أي زخرفة لنسخها تلقائياً\n\n${list}`,
        { parse_mode: 'HTML' },
      );
    });
  },
};
