import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { EIGHTBALL, parseChoices, pick } from './logic';

/** Quick decision tools: magic 8-ball and random chooser. */
export const decidePlugin: Plugin = {
  name: 'decide',
  description: 'Magic 8-ball and random chooser',
  commands: [
    { command: '8ball', description: '🎱 اسأل الكرة السحرية سؤال نعم/لا' },
    { command: 'choose', description: '🎯 اختر عشوائياً: /choose قهوة او شاي' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('8ball', async (ctx) => {
      const q = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!q) return void ctx.reply('🎱 اسأل الكرة سؤالاً:\n/8ball هل سأنجح؟');
      await ctx.reply(`🎱 ${pick(EIGHTBALL, Math.random)}`);
    });

    bot.command('choose', async (ctx) => {
      const raw = ctx.message.text.split(' ').slice(1).join(' ').trim();
      const options = parseChoices(raw);
      if (options.length < 2) return void ctx.reply('🎯 اكتب خيارين أو أكثر:\n/choose قهوة او شاي او عصير');
      await ctx.reply(`🎯 اخترت: ${pick(options, Math.random)}`);
    });
  },
};
