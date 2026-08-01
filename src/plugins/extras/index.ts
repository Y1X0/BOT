import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { pickRandom } from '../../utils/format';
import { JOKES, QUOTES, FACTS, EIGHT_BALL } from './data';

/**
 * Extras: lightweight fun & info commands. No external APIs, no DB — safe to
 * run anywhere. Great "filler" content that makes the bot feel lively.
 */
export const extrasPlugin: Plugin = {
  name: 'extras',
  description: 'Fun & info: jokes, quotes, facts, dice, coin flip, 8ball, choose',
  commands: [
    { command: 'joke', description: '😂 نكتة عشوائية' },
    { command: 'quote', description: '💡 حكمة اليوم' },
    { command: 'fact', description: '🧠 معلومة مفيدة' },
    { command: 'flip', description: '🪙 عملة: صورة أو كتابة' },
    { command: 'dice', description: '🎲 رمي نرد' },
    { command: 'choose', description: '🎯 اختيار عشوائي: /choose أ | ب | ج' },
    { command: '8ball', description: '🎱 الكرة السحرية: /8ball سؤالك' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('joke', async (ctx) => {
      await ctx.reply(pickRandom(JOKES));
    });

    bot.command('quote', async (ctx) => {
      await ctx.reply(pickRandom(QUOTES));
    });

    bot.command('fact', async (ctx) => {
      await ctx.reply(pickRandom(FACTS));
    });

    bot.command('flip', async (ctx) => {
      const result = Math.random() < 0.5 ? 'صورة 👑' : 'كتابة 📝';
      await ctx.reply(`🪙 الطرة: ${result}`);
    });

    // Uses Telegram's native animated dice.
    bot.command('dice', async (ctx) => {
      await ctx.replyWithDice().catch(async () => {
        await ctx.reply(`🎲 ${Math.floor(Math.random() * 6) + 1}`);
      });
    });

    // /choose a | b | c  → bot picks one at random.
    bot.command('choose', async (ctx) => {
      const raw = ctx.message.text.split(' ').slice(1).join(' ');
      const options = raw
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      if (options.length < 2) {
        await ctx.reply('🎯 استخدم: /choose خيار1 | خيار2 | خيار3');
        return;
      }
      await ctx.reply(`🎯 اخترت لك: ${pickRandom(options)}`);
    });

    // /8ball question → magic-8-ball style answer.
    bot.command('8ball', async (ctx) => {
      const question = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!question) {
        await ctx.reply('🎱 اسألني سؤال نعم/لا: /8ball هل سأنجح؟');
        return;
      }
      await ctx.reply(pickRandom(EIGHT_BALL));
    });
  },
};
