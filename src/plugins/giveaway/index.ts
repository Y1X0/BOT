import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName } from '../../utils/format';
import { pickWinner } from './logic';

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

interface Giveaway {
  prize: string;
  hostId: number;
  participants: Map<number, string>; // userId → display name
}
const giveaways = new Map<string, Giveaway>(); // `${chatId}:${msgId}`

function keyboard(count: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`🎉 اشتراك (${count})`, 'gv:join')],
    [Markup.button.callback('🎲 سحب الفائز', 'gv:draw')],
  ]);
}

/** Giveaways: host starts one, members join via button, host draws a winner. */
export const giveawayPlugin: Plugin = {
  name: 'giveaway',
  description: 'Run giveaways: members join, bot picks a random winner',
  commands: [{ command: 'giveaway', description: '🎉 ابدأ سحب/قرعة: /giveaway الجائزة' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('giveaway', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const prize = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!prize) return void ctx.reply('🎉 اكتب الجائزة:\n/giveaway اشتراك تيليجرام بريميوم');
      const sent = await ctx.reply(
        `🎉 <b>سحب على:</b> ${escapeHtml(prize)}\n\nاضغط الزر للاشتراك! المضيف يضغط «سحب الفائز» لاختيار الرابح 🎲`,
        { parse_mode: 'HTML', ...keyboard(0) },
      );
      giveaways.set(`${ctx.chat!.id}:${sent.message_id}`, { prize, hostId: ctx.from.id, participants: new Map() });
    });

    bot.action('gv:join', async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const g = giveaways.get(key);
      if (!g) return void ctx.answerCbQuery('انتهى هذا السحب.').catch(() => undefined);
      if (g.participants.has(ctx.from.id)) return void ctx.answerCbQuery('أنت مشترك بالفعل ✅').catch(() => undefined);
      g.participants.set(ctx.from.id, displayName(ctx.from));
      await ctx.answerCbQuery('تم اشتراكك! 🎉').catch(() => undefined);
      await ctx.editMessageReplyMarkup(keyboard(g.participants.size).reply_markup).catch(() => undefined);
    });

    bot.action('gv:draw', async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const g = giveaways.get(key);
      if (!g) return void ctx.answerCbQuery('انتهى هذا السحب.').catch(() => undefined);
      if (ctx.from.id !== g.hostId) return void ctx.answerCbQuery('فقط من بدأ السحب يمكنه السحب.', { show_alert: true }).catch(() => undefined);
      const ids = [...g.participants.keys()];
      const winnerId = pickWinner(ids, Math.random);
      await ctx.answerCbQuery().catch(() => undefined);
      if (winnerId === null) {
        await ctx.editMessageText(`🎉 سحب «${escapeHtml(g.prize)}»\n\n❌ لا يوجد مشتركون.`, { parse_mode: 'HTML' }).catch(() => undefined);
      } else {
        const mention = `<a href="tg://user?id=${winnerId}">${escapeHtml(g.participants.get(winnerId) ?? 'الفائز')}</a>`;
        await ctx.editMessageText(
          `🎉🏆 سحب «${escapeHtml(g.prize)}»\n\nالفائز هو: ${mention}\nمبروك! 🥳 (من بين ${ids.length} مشترك)`,
          { parse_mode: 'HTML' },
        ).catch(() => undefined);
      }
      giveaways.delete(key);
    });
  },
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
