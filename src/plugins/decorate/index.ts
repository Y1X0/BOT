import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { decorate } from './decorate';

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
      const list = variants.map((v, i) => `${i + 1}. ${v}`).join('\n');
      await ctx.reply(`🎨 زخرفة «${text}»:\n\n${list}\n\nانسخ أي واحدة تعجبك ✨`);
    });
  },
};
