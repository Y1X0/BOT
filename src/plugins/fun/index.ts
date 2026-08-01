import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { pickRandom, displayName, resolveTarget } from '../../utils/format';
import { TRUTHS, DARES, WOULD_YOU_RATHER } from './data';

/**
 * Social fun commands: rate, ship, truth/dare, would-you-rather.
 * All randomized, self-contained, and light-hearted.
 */
export const funPlugin: Plugin = {
  name: 'fun',
  description: 'Social games: rate, ship, truth, dare, would-you-rather',
  commands: [
    { command: 'rate', description: '⭐️ تقييم عشوائي: /rate شيء' },
    { command: 'ship', description: '💞 نسبة التوافق (بالرد على عضو)' },
    { command: 'truth', description: '🤫 سؤال صراحة' },
    { command: 'dare', description: '🔥 تحدي' },
    { command: 'wyr', description: '🤔 لو خيّروك' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('rate', async (ctx) => {
      const thing = ctx.message.text.split(' ').slice(1).join(' ').trim() || 'أنت';
      const score = Math.floor(Math.random() * 11); // 0..10
      const stars = '⭐️'.repeat(score) || '💤';
      await ctx.reply(`⭐️ تقييمي لـ «${thing}»: ${score}/10\n${stars}`);
    });

    // /ship (reply to someone) → compatibility between sender and target.
    bot.command('ship', async (ctx) => {
      const target = resolveTarget(ctx);
      if (!target || !ctx.from) {
        await ctx.reply('💞 ردّ على رسالة العضو الذي تريد قياس توافقك معه.');
        return;
      }
      const percent = Math.floor(Math.random() * 101);
      const bar = compatibilityBar(percent);
      await ctx.reply(
        `💞 نسبة التوافق بين ${displayName(ctx.from)} و ${displayName(target)}:\n${bar} ${percent}%\n${verdict(percent)}`,
      );
    });

    bot.command('truth', async (ctx) => {
      await ctx.reply(`🤫 ${pickRandom(TRUTHS)}`);
    });

    bot.command('dare', async (ctx) => {
      await ctx.reply(`🔥 ${pickRandom(DARES)}`);
    });

    bot.command('wyr', async (ctx) => {
      await ctx.reply(`🤔 ${pickRandom(WOULD_YOU_RATHER)}`);
    });
  },
};

function compatibilityBar(percent: number): string {
  const filled = Math.round(percent / 10);
  return '❤️'.repeat(filled) + '🤍'.repeat(10 - filled);
}

function verdict(percent: number): string {
  if (percent >= 80) return 'توافق رائع! 😍';
  if (percent >= 50) return 'فيه أمل 😊';
  if (percent >= 20) return 'يحتاج شغل 😅';
  return 'كل واحد بطريقه 😂';
}
