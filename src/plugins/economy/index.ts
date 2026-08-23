import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import {
  getBalance,
  claimDaily,
  topBalances,
  transfer,
  addCoins,
  getAccountSummary,
  deposit,
  withdraw,
  rob,
  claimWork,
  attemptCrime,
} from '../../services/economy.service';
import { spinSlots } from '../../services/economy-logic';
import { displayName, resolveTarget } from '../../utils/format';
import { escapeHtml } from '../../locales';

const esc = (s: string | undefined | null): string => escapeHtml(String(s ?? ''));

export const economyPlugin: Plugin = {
  name: 'economy',
  description: 'In-group coin economy: balance, daily reward, leaderboard, transfers',
  commands: [
    { command: 'balance', description: '💰 رصيدك من العملات' },
    { command: 'daily', description: '🎁 المكافأة اليومية' },
    { command: 'top', description: '🏆 الأغنى في الجروب' },
    { command: 'give', description: '💸 تحويل عملات لعضو (بالرد)' },
    { command: 'spin', description: '🎡 عجلة الحظ: /spin 50' },
    { command: 'bank', description: '🏦 عرض المحفظة والبنك' },
    { command: 'deposit', description: '🏦 إيداع في البنك: /deposit 100' },
    { command: 'withdraw', description: '🏦 سحب من البنك: /withdraw 100' },
    { command: 'rob', description: '🥷 سرقة عضو (بالرد)' },
    { command: 'slots', description: '🎰 ماكينة الحظ: /slots 50' },
    { command: 'work', description: '💼 اشتغل واكسب عملات (كل ساعة)' },
    { command: 'crime', description: '🦹 جريمة: ربح كبير بمخاطرة (كل 3 ساعات)' },
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

    // 🏦 Bank summary.
    bot.command('bank', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const s = await getAccountSummary(ctx.chat.id, ctx.from.id);
      await ctx.reply(`🏦 <b>${esc(displayName(ctx.from))}</b>\n💵 المحفظة: <b>${s.balance}</b> 💰\n🔒 البنك: <b>${s.bank}</b> 💰\n<i>(الأموال في البنك آمنة من السرقة)</i>`);
    });

    // 🏦 Deposit / withdraw (support "all"/"الكل").
    bot.command('deposit', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const s = await getAccountSummary(ctx.chat.id, ctx.from.id);
      const amount = parseAmount(ctx.message.text, s.balance);
      if (amount === null) return void ctx.reply('🏦 استخدم: /deposit 100  أو  /deposit الكل');
      const r = await deposit(ctx.chat.id, ctx.from.id, amount);
      if (!r.ok) return void ctx.reply('❌ رصيد المحفظة لا يكفي.');
      await ctx.reply(`🏦 <b>أودعت ${amount}</b> 💰\n💵 المحفظة: ${r.balance} | 🔒 البنك: ${r.bank}`);
    });

    bot.command('withdraw', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const s = await getAccountSummary(ctx.chat.id, ctx.from.id);
      const amount = parseAmount(ctx.message.text, s.bank);
      if (amount === null) return void ctx.reply('🏦 استخدم: /withdraw 100  أو  /withdraw الكل');
      const r = await withdraw(ctx.chat.id, ctx.from.id, amount);
      if (!r.ok) return void ctx.reply('❌ رصيد البنك لا يكفي.');
      await ctx.reply(`🏦 <b>سحبت ${amount}</b> 💰\n💵 المحفظة: ${r.balance} | 🔒 البنك: ${r.bank}`);
    });

    // 🥷 Rob another member (reply to them).
    bot.command('rob', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('🥷 ردّ على رسالة العضو الذي تريد سرقته.');
      const r = await rob(ctx.chat.id, ctx.from.id, target.id);
      switch (r.outcome) {
        case 'self': return void ctx.reply('🤦 لا يمكنك سرقة نفسك.');
        case 'cooldown': return void ctx.reply(`⏳ انتظر ${r.hoursLeft} ساعة قبل محاولة سرقة أخرى.`);
        case 'empty': return void ctx.reply('💸 محفظة الضحية شبه فارغة — لا شيء لتسرقه.');
        case 'success': return void ctx.reply(`🥷 <b>نجحت السرقة!</b> أخذت <b>${r.amount}</b> 💰 من <b>${esc(displayName(target))}</b> 😈`);
        case 'caught': return void ctx.reply(`🚨 <b>تم ضبطك!</b> دفعت غرامة <b>${r.amount}</b> 💰 لـ <b>${esc(displayName(target))}</b> 😅`);
      }
    });

    // 🎰 Slot machine.
    bot.command('slots', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const bet = Number(ctx.message.text.split(/\s+/)[1] ?? '50');
      if (!Number.isInteger(bet) || bet <= 0) return void ctx.reply('🎰 استخدم: /slots 50');
      if (bet > 100000) return void ctx.reply('🎰 الحد الأقصى للرهان 100000.');
      const balance = await getBalance(ctx.chat.id, ctx.from.id);
      if (balance < bet) return void ctx.reply('❌ رصيدك لا يكفي لهذا الرهان.');
      const { reels, mult } = spinSlots(Math.random);
      const net = Math.floor(bet * mult) - bet;
      await addCoins(ctx.chat.id, ctx.from.id, net);
      const newBal = await getBalance(ctx.chat.id, ctx.from.id);
      const verdict = mult >= 5 ? '💎 جاكبوت!' : mult > 1 ? '🎉 ربح!' : mult === 1.5 ? '✨ زوج!' : '💨 خسارة';
      await ctx.reply(`🎰 [ ${reels.join(' | ')} ]\n<b>${esc(verdict)}</b>\n${net >= 0 ? `ربحت <b>${net}</b>` : `خسرت <b>${-net}</b>`} 💰\nرصيدك: ${newBal} 💰`);
    });

    // 💼 Work — earn coins on a 1-hour cooldown.
    bot.command('work', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const r = await claimWork(ctx.chat.id, ctx.from.id);
      if (!r.ok) return void ctx.reply(`⏳ تعبت! ارتاح ${fmtWait(r.minutesLeft!)} قبل ما تشتغل مرة ثانية.`);
      await ctx.reply(`💼 <b>${esc(r.job)}</b>\nكسبت <b>${r.amount}</b> 💰\nرصيدك: ${r.balance} 💰`);
    });

    // 🦹 Crime — high risk / high reward on a 3-hour cooldown.
    bot.command('crime', async (ctx) => {
      if (!enabled(ctx) || !ctx.chat || !ctx.from) return;
      const r = await attemptCrime(ctx.chat.id, ctx.from.id);
      if (r.outcome === 'cooldown') return void ctx.reply(`⏳ الوضع حامي! اختبِ ${fmtWait(r.minutesLeft!)} قبل الجريمة القادمة.`);
      if (r.outcome === 'success') {
        await ctx.reply(`🦹 <b>${esc(r.story)}</b>\n✅ نجحت! غنمت <b>${r.amount}</b> 💰\nرصيدك: ${r.balance} 💰`);
      } else {
        await ctx.reply(`🚨 <b>${esc(r.story)}</b>\n❌ فشلت! دفعت غرامة <b>${r.amount}</b> 💰\nرصيدك: ${r.balance} 💰`);
      }
    });
  },
};

/** Format a wait in minutes as "X دقيقة" or "X ساعة و Y دقيقة". */
function fmtWait(minutes: number): string {
  if (minutes < 60) return `${minutes} دقيقة`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ساعة و ${m} دقيقة` : `${h} ساعة`;
}

/** Parse a coin amount from a command, supporting "all"/"الكل"/"كامل". */
function parseAmount(text: string, max: number): number | null {
  const raw = text.split(/\s+/)[1]?.trim();
  if (!raw) return null;
  if (['all', 'الكل', 'كامل', 'كله'].includes(raw)) return max > 0 ? max : null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function enabled(ctx: BotContext): boolean {
  if (!ctx.chat || ctx.chat.type === 'private') return false;
  return ctx.state.settings?.economyEnabled ?? true;
}

function medal(index: number): string {
  return ['🥇', '🥈', '🥉'][index] ?? `${index + 1}.`;
}
