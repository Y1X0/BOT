import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { getBalance, claimDaily, topBalances, transfer, addCoins } from '../../services/economy.service';
import { displayName, resolveTarget } from '../../utils/format';

export const economyPlugin: Plugin = {
  name: 'economy',
  description: 'In-group coin economy: balance, daily reward, leaderboard, transfers',
  commands: [
    { command: 'balance', description: '💰 رصيدك من العملات' },
    { command: 'daily', description: '🎁 المكافأة اليومية' },
    { command: 'top', description: '🏆 الأغنى في الجروب' },
    { command: 'give', description: '💸 تحويل عملات لعضو (بالرد)' },
    { command: 'spin', description: '🎡 عجلة الحظ: /spin 50' },
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

    // 🎡 Wheel of fortune — gamble coins on a random multiplier.
    bot.command('spin', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const bet = Number(ctx.message.text.split(/\s+/)[1] ?? '50');
      if (!Number.isInteger(bet) || bet <= 0) return void ctx.reply('🎡 استخدم: /spin 50');
      if (bet > 100000) return void ctx.reply('🎡 الحد الأقصى للرهان 100000.');
      const balance = await getBalance(ctx.chat.id, ctx.from.id);
      if (balance < bet) return void ctx.reply('❌ رصيدك لا يكفي لهذا الرهان.');

      const roll = Math.random();
      let mult: number;
      let label: string;
      if (roll < 0.45) { mult = 0; label = '💨 خسارة!'; }
      else if (roll < 0.7) { mult = 1.5; label = '✨ ربح x1.5'; }
      else if (roll < 0.9) { mult = 2; label = '🎉 ربح x2'; }
      else if (roll < 0.98) { mult = 3; label = '🔥 ربح x3'; }
      else { mult = 5; label = '💎 جاكبوت x5!'; }

      const payout = Math.floor(bet * mult);
      const net = payout - bet;
      await addCoins(ctx.chat.id, ctx.from.id, net);
      const newBal = await getBalance(ctx.chat.id, ctx.from.id);
      await ctx.reply(
        `🎡 عجلة الحظ\nالرهان: ${bet} 💰\nالنتيجة: ${label}\n${net >= 0 ? `ربحت ${net}` : `خسرت ${-net}`} 💰\nرصيدك: ${newBal} 💰`,
      );
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
