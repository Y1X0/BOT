import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { displayName, resolveTarget, pickRandom } from '../../utils/format';
import { COMPLIMENTS, FORTUNES, PERSONAS, LOVE_MESSAGES } from './data';
import { dailyIndex, dayKey } from './logic';

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Social/fun commands: compliment, daily fortune, daily persona, soulmate. */
export const socialPlugin: Plugin = {
  name: 'social',
  description: 'Compliments, daily fortune & persona, soulmate pairing',
  commands: [
    { command: 'compliment', description: '🌸 مجاملة لطيفة (بالرد أو لنفسك)' },
    { command: 'fortune', description: '🔮 حظك اليوم' },
    { command: 'persona', description: '🎭 من أنت اليوم؟' },
    { command: 'soulmate', description: '💞 توأم روحك في الجروب اليوم' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('compliment', async (ctx) => {
      if (!ctx.from) return;
      const target = resolveTarget(ctx) ?? ctx.from;
      await ctx.reply(`🌸 ${displayName(target)}: أنت ${pickRandom(COMPLIMENTS)}`);
    });

    // Deterministic per user per day, so it stays stable if re-run.
    bot.command('fortune', async (ctx) => {
      if (!ctx.from) return;
      const seed = `${ctx.from.id}:${dayKey(new Date())}`;
      await ctx.reply(`🔮 حظك اليوم يا ${displayName(ctx.from)}:\n${FORTUNES[dailyIndex(seed, FORTUNES.length)]}`);
    });

    bot.command('persona', async (ctx) => {
      if (!ctx.from) return;
      const seed = `persona:${ctx.from.id}:${dayKey(new Date())}`;
      await ctx.reply(`🎭 ${displayName(ctx.from)}، أنت اليوم:\n${PERSONAS[dailyIndex(seed, PERSONAS.length)]}`);
    });

    // Pick a stable "soulmate" from the group's tracked members for today.
    bot.command('soulmate', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const members = await prisma.member.findMany({
        where: { chatId: BigInt(ctx.chat!.id), userId: { not: BigInt(ctx.from.id) } },
        orderBy: { userId: 'asc' }, // stable order for deterministic pick
        take: 500,
      });
      if (!members.length) return void ctx.reply('💞 لا يوجد أعضاء كفاية بعد لإيجاد توأم روحك.');
      const seed = `soul:${ctx.from.id}:${dayKey(new Date())}`;
      const m = members[dailyIndex(seed, members.length)];
      const name = m.firstName ?? m.username ?? String(m.userId);
      await ctx.reply(`💞 توأم روحك اليوم يا ${displayName(ctx.from)} هو:\n✨ ${name}\n${pickRandom(LOVE_MESSAGES)}`);
    });
  },
};
