import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName, resolveTarget } from '../../utils/format';
import { marry, divorce, getMarriage, memberName, listCouples } from '../../services/marriage.service';
import { marriedDuration } from './logic';

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

interface Proposal {
  proposerId: number;
  proposerName: string;
  targetId: number;
  targetName: string;
}
const proposals = new Map<string, Proposal>(); // `${chatId}:${msgId}`

/** Fun in-group marriage system: propose (with consent), divorce, list couples. */
export const marriagePlugin: Plugin = {
  name: 'marriage',
  description: 'Fun marriage system: propose, accept, divorce, couples list',
  commands: [
    { command: 'marry', description: '💍 اطلب الزواج (بالرد على عضو)' },
    { command: 'divorce', description: '💔 طلاق' },
    { command: 'marriage', description: '❤️ حالة زواجك' },
    { command: 'couples', description: '👩‍❤️‍👨 أزواج الجروب' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('marry', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('💍 ردّ على رسالة الشخص الذي تريد الزواج منه.');
      if (target.id === ctx.from.id) return void ctx.reply('🤦 لا يمكنك الزواج من نفسك.');
      if ((target as { is_bot?: boolean }).is_bot) return void ctx.reply('🤖 لا يمكن الزواج من بوت.');

      // Pre-check both are single.
      const [me, them] = await Promise.all([
        getMarriage(ctx.chat!.id, ctx.from.id),
        getMarriage(ctx.chat!.id, target.id),
      ]);
      if (me?.partnerId) return void ctx.reply('❤️ أنت متزوج بالفعل! استخدم /divorce أولاً.');
      if (them?.partnerId) return void ctx.reply(`💔 ${displayName(target)} مرتبط بالفعل.`);

      const sent = await ctx.reply(
        `💍 ${displayName(ctx.from)} يطلب الزواج من ${displayName(target)}!\nهل توافق؟`,
        Markup.inlineKeyboard([
          [Markup.button.callback('💚 موافق', 'marry:yes'), Markup.button.callback('💔 رفض', 'marry:no')],
        ]),
      );
      proposals.set(`${ctx.chat!.id}:${sent.message_id}`, {
        proposerId: ctx.from.id,
        proposerName: displayName(ctx.from),
        targetId: target.id,
        targetName: displayName(target),
      });
    });

    bot.action(/^marry:(yes|no)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const p = proposals.get(key);
      if (!p) return void ctx.answerCbQuery('انتهى هذا الطلب.').catch(() => undefined);
      if (ctx.from.id !== p.targetId) return void ctx.answerCbQuery('هذا الطلب ليس موجهاً لك 💕', { show_alert: true }).catch(() => undefined);

      if (ctx.match[1] === 'no') {
        proposals.delete(key);
        await ctx.answerCbQuery('رفضت الطلب.').catch(() => undefined);
        await ctx.editMessageText(`💔 ${p.targetName} رفض طلب ${p.proposerName}.`).catch(() => undefined);
        return;
      }

      const res = await marry(ctx.chat!.id, { id: p.proposerId, first_name: p.proposerName }, { id: p.targetId, first_name: p.targetName });
      proposals.delete(key);
      await ctx.answerCbQuery().catch(() => undefined);
      if (!res.ok) {
        const why = res.reason === 'a_married' ? `${p.proposerName} متزوج بالفعل` : res.reason === 'b_married' ? `${p.targetName} متزوج بالفعل` : 'تعذّر الزواج';
        return void ctx.editMessageText(`💔 ${why}.`).catch(() => undefined);
      }
      await ctx.editMessageText(`🎉💍 مبروك! ${p.proposerName} و ${p.targetName} تزوّجا الآن! 💕`).catch(() => undefined);
    });

    bot.command('divorce', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const current = await getMarriage(ctx.chat!.id, ctx.from.id);
      if (!current?.partnerId) return void ctx.reply('💔 أنت لست متزوجاً.');
      const partnerName = await memberName(ctx.chat!.id, current.partnerId);
      await divorce(ctx.chat!.id, ctx.from.id);
      await ctx.reply(`💔 ${displayName(ctx.from)} و ${partnerName} انفصلا. نتمنى لكما التوفيق.`);
    });

    bot.command('marriage', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const m = await getMarriage(ctx.chat!.id, ctx.from.id);
      if (!m?.partnerId || !m.marriedAt) return void ctx.reply('❤️ أنت أعزب حالياً. استخدم /marry بالرد على شخص.');
      const partnerName = await memberName(ctx.chat!.id, m.partnerId);
      await ctx.reply(`❤️ ${displayName(ctx.from)} متزوج من ${partnerName}\n⏳ منذ: ${marriedDuration(m.marriedAt, new Date())}`);
    });

    bot.command('couples', async (ctx) => {
      if (!isGroup(ctx)) return;
      const couples = await listCouples(ctx.chat!.id);
      if (!couples.length) return void ctx.reply('👩‍❤️‍👨 لا يوجد أزواج بعد. كن أول من يتزوج بـ /marry!');
      const lines = await Promise.all(
        couples.slice(0, 20).map(async (c) => {
          const aName = c.a.firstName ?? c.a.username ?? String(c.a.userId);
          const bName = await memberName(ctx.chat!.id, c.bId);
          return `💑 ${aName} ❤️ ${bName}`;
        }),
      );
      await ctx.reply(`👩‍❤️‍👨 أزواج الجروب:\n${lines.join('\n')}`);
    });
  },
};
