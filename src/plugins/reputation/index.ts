import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { displayName, resolveTarget } from '../../utils/format';
import { isThanks, cooldownLeft } from './logic';

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // one rep per giver→receiver per 6h
const lastRep = new Map<string, number>(); // `${chatId}:${giver}:${receiver}` → epoch ms

async function giveRep(chatId: number, giver: { id: number }, target: { id: number; first_name?: string; username?: string }): Promise<'ok' | 'self' | 'bot' | 'cooldown'> {
  if (target.id === giver.id) return 'self';
  if ((target as { is_bot?: boolean }).is_bot) return 'bot';
  const key = `${chatId}:${giver.id}:${target.id}`;
  if (cooldownLeft(lastRep.get(key), Date.now(), COOLDOWN_MS) > 0) return 'cooldown';
  await prisma.member.upsert({
    where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(target.id) } },
    create: { chatId: BigInt(chatId), userId: BigInt(target.id), firstName: target.first_name ?? null, username: target.username ?? null, rep: 1 },
    update: { rep: { increment: 1 } },
  });
  lastRep.set(key, Date.now());
  return 'ok';
}

/** Reputation / thanks system: earn respect by helping others. */
export const reputationPlugin: Plugin = {
  name: 'reputation',
  description: 'Reputation points via /rep or saying thanks',
  commands: [
    { command: 'rep', description: '🏅 امنح سمعة لعضو (بالرد)' },
    { command: 'myrep', description: '⭐ سمعتك' },
    { command: 'reptop', description: '🏆 الأكثر احتراماً' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('rep', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('🏅 ردّ على رسالة العضو الذي تريد منحه سمعة.');
      const res = await giveRep(ctx.chat!.id, ctx.from, target);
      if (res === 'self') return void ctx.reply('🤦 لا يمكنك منح نفسك سمعة.');
      if (res === 'bot') return void ctx.reply('🤖 البوتات لا تحتاج سمعة.');
      if (res === 'cooldown') return void ctx.reply('⏳ منحت هذا العضو سمعة مؤخراً، جرّب لاحقاً.');
      const m = await prisma.member.findUnique({ where: { chatId_userId: { chatId: BigInt(ctx.chat!.id), userId: BigInt(target.id) } } });
      await ctx.reply(`🏅 +1 سمعة لـ ${displayName(target)}! (المجموع: ${m?.rep ?? 1} ⭐)`);
    });

    bot.command('myrep', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const m = await prisma.member.findUnique({ where: { chatId_userId: { chatId: BigInt(ctx.chat!.id), userId: BigInt(ctx.from.id) } } });
      await ctx.reply(`⭐ سمعتك يا ${displayName(ctx.from)}: ${m?.rep ?? 0}`);
    });

    bot.command('reptop', async (ctx) => {
      if (!isGroup(ctx)) return;
      const top = await prisma.member.findMany({ where: { chatId: BigInt(ctx.chat!.id), rep: { gt: 0 } }, orderBy: { rep: 'desc' }, take: 10 });
      if (!top.length) return void ctx.reply('🏅 لا سمعة بعد. امنح أحداً سمعة بالرد + /rep');
      const list = top.map((m, i) => `${['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`} ${m.firstName ?? m.username ?? m.userId} — ${m.rep} ⭐`).join('\n');
      await ctx.reply(`🏆 الأكثر احتراماً:\n${list}`);
    });

    // Passive: replying with "شكراً/thanks" grants rep (with cooldown).
    bot.on(message('text'), async (ctx, next) => {
      if (!isGroup(ctx) || !ctx.from) return next();
      const reply = (ctx.message as { reply_to_message?: { from?: { id: number; is_bot?: boolean; first_name?: string; username?: string } } }).reply_to_message;
      if (!reply?.from || !isThanks(ctx.message.text)) return next();
      const res = await giveRep(ctx.chat!.id, ctx.from, reply.from);
      if (res === 'ok') await ctx.reply(`🏅 +1 سمعة لـ ${displayName(reply.from)} 🙏`).catch(() => undefined);
      return next(); // never block normal chat
    });
  },
};
