import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { getBalance, claimDaily, topBalances, transfer } from '../../services/economy.service';
import { displayName, resolveTarget } from '../../utils/format';

export const economyPlugin: Plugin = {
  name: 'economy',
  description: 'In-group coin economy: balance, daily reward, leaderboard, transfers',
  commands: [
    { command: 'balance', description: '💰 رصيدك من العملات' },
    { command: 'daily', description: '🎁 المكافأة اليومية' },
    { command: 'top', description: '🏆 الأغنى في الجروب' },
    { command: 'give', description: '💸 تحويل عملات لعضو (بالرد)' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('balance', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const t = ctx.state.t!;
      const balance = await getBalance(ctx.chat.id, ctx.from.id);
      await ctx.reply(t('economy.balance', { name: displayName(ctx.from), balance }));
    });

    bot.command('daily', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const t = ctx.state.t!;
      const result = await claimDaily(ctx.chat.id, ctx.from.id);
      if (result.ok) {
        await ctx.reply(t('economy.daily_ok', { amount: result.amount!, balance: result.balance! }));
      } else {
        await ctx.reply(t('economy.daily_wait', { hours: result.hoursLeft! }));
      }
    });

    bot.command('top', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat) return;
      const t = ctx.state.t!;
      const top = await topBalances(ctx.chat.id, 10);
      if (!top.length) {
        await ctx.reply(t('economy.top_empty'));
        return;
      }
      const list = top
        .map((a, i) => `${medal(i)} ${a.userId} — ${a.balance} 💰`)
        .join('\n');
      await ctx.reply(t('economy.top_header', { list }));
    });

    bot.command('give', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      const amount = Number(ctx.message.text.split(' ').slice(1).join(' ').trim());
      if (!target || !Number.isInteger(amount) || amount <= 0) {
        await ctx.reply(t('economy.give_usage'));
        return;
      }
      if (target.id === ctx.from.id) {
        await ctx.reply(t('economy.give_usage'));
        return;
      }
      const result = await transfer(ctx.chat.id, ctx.from.id, target.id, amount);
      if (!result.ok) {
        await ctx.reply(t('economy.give_insufficient'));
        return;
      }
      await ctx.reply(t('economy.give_ok', { amount, name: displayName(target) }));
    });
  },
};

function enabled(ctx: BotContext): boolean {
  if (!ctx.chat || ctx.chat.type === 'private') return false;
  return ctx.state.settings?.economyEnabled ?? true;
}

function medal(index: number): string {
  return ['🥇', '🥈', '🥉'][index] ?? `${index + 1}.`;
}
