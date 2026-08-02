import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { getMember } from '../../services/member.service';
import { displayName } from '../../utils/format';
import { RANKS, rankForLevel, nextRank } from './logic';

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Automatic rank titles derived from level (list + personal lookup). */
export const ranksPlugin: Plugin = {
  name: 'ranks',
  description: 'Automatic level-based ranks',
  commands: [
    { command: 'ranks', description: '🎖 قائمة الرتب' },
    { command: 'myrank', description: '🏅 رتبتك الحالية' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('ranks', async (ctx) => {
      const list = RANKS.map((r) => `${r.emoji} ${r.name} — من المستوى ${r.minLevel}`).join('\n');
      await ctx.reply(`🎖 رتب الجروب (حسب المستوى):\n${list}`);
    });

    bot.command('myrank', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const m = await getMember(ctx.chat!.id, ctx.from.id);
      const level = m?.level ?? 0;
      const rank = rankForLevel(level);
      const next = nextRank(level);
      let msg = `🏅 ${displayName(ctx.from)}\nالمستوى: ${level}\nرتبتك: ${rank.emoji} ${rank.name}`;
      if (next) msg += `\n⬆️ الرتبة التالية: ${next.emoji} ${next.name} (المستوى ${next.minLevel})`;
      else msg += '\n👑 وصلت لأعلى رتبة!';
      await ctx.reply(msg);
    });
  },
};
