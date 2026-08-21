import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import { getTopCommands, flushUsage } from '../../services/usage.service';

/** Owner-only view of which commands people actually use — the number that
 *  turns "what should I keep vs cut?" from a guess into a decision. */
export const usagePlugin: Plugin = {
  name: 'usage',
  description: 'Command usage statistics (owner)',
  commands: [{ command: 'cmdstats', description: '📊 أكثر الأوامر استخداماً (مالك)', staffOnly: true }],

  register(bot: Telegraf<BotContext>) {
    bot.command('cmdstats', requireRole('owner'), async (ctx) => {
      await flushUsage().catch(() => undefined); // persist the current in-memory buffer first
      const top = await getTopCommands(30);
      if (!top.length) return void ctx.reply('📊 ما في بيانات استخدام بعد. استنى لما الناس تستخدم الأوامر.');
      const total = top.reduce((s, t) => s + t.count, 0);
      const lines = top.map((t, i) => `${String(i + 1).padStart(2)}. <code>${t.command}</code> — ${t.count}`);
      await ctx.reply(`📊 <b>أكثر الأوامر استخداماً</b> (أعلى ${top.length})\n\n${lines.join('\n')}\n\nالمجموع: ${total}`, {
        parse_mode: 'HTML',
      });
    });
  },
};
