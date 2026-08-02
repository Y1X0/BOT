import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { createLogger } from '../../core/logger';
import { parseBirthday, isBirthdayToday, daysUntil } from './logic';

const log = createLogger('plugin:birthday');

// Announce once per chat per day (in-memory; a rare double on redeploy is fine).
const announced = new Set<string>();
const ANNOUNCE_HOUR = 8; // UTC hour to send greetings

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Birthday registration + automatic daily greetings. */
export const birthdayPlugin: Plugin = {
  name: 'birthday',
  description: 'Register birthdays and auto-greet members on their day',
  commands: [
    { command: 'setbirthday', description: '🎂 سجّل ميلادك: /setbirthday 05-08 (يوم-شهر)' },
    { command: 'birthdays', description: '🎉 أعياد الميلاد القادمة' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('setbirthday', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const arg = ctx.message.text.split(/\s+/).slice(1).join(' ');
      const bd = parseBirthday(arg);
      if (!bd) return void ctx.reply('🎂 استخدم: /setbirthday 05-08  (اليوم-الشهر)');
      await prisma.member.upsert({
        where: { chatId_userId: { chatId: BigInt(ctx.chat!.id), userId: BigInt(ctx.from.id) } },
        create: {
          chatId: BigInt(ctx.chat!.id),
          userId: BigInt(ctx.from.id),
          firstName: ctx.from.first_name,
          username: ctx.from.username,
          birthDay: bd.day,
          birthMonth: bd.month,
        },
        update: { birthDay: bd.day, birthMonth: bd.month },
      });
      await ctx.reply(`🎂 تم تسجيل ميلادك: ${bd.day}/${bd.month} — سأهنّئك في يومك! 🎉`);
    });

    bot.command('birthdays', async (ctx) => {
      if (!isGroup(ctx)) return;
      const rows = await prisma.member.findMany({
        where: { chatId: BigInt(ctx.chat!.id), birthDay: { not: null }, birthMonth: { not: null } },
      });
      if (!rows.length) return void ctx.reply('🎂 لا أحد سجّل ميلاده بعد. استخدم /setbirthday 05-08');
      const now = new Date();
      const sorted = rows
        .map((m) => ({ m, d: daysUntil(m.birthDay!, m.birthMonth!, now) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 15);
      const list = sorted
        .map(({ m, d }) => `• ${m.firstName ?? m.username ?? m.userId} — ${m.birthDay}/${m.birthMonth} ${d === 0 ? '🎉 اليوم!' : `(بعد ${d} يوم)`}`)
        .join('\n');
      await ctx.reply(`🎉 أعياد الميلاد القادمة:\n${list}`);
    });

    // Daily greeting ticker (checks each hour, greets once at ANNOUNCE_HOUR).
    const interval = setInterval(() => {
      void tickBirthdays(bot);
    }, 60 * 60 * 1000);
    interval.unref?.();
  },
};

async function tickBirthdays(bot: Telegraf<BotContext>): Promise<void> {
  try {
    const now = new Date();
    if (now.getUTCHours() !== ANNOUNCE_HOUR) return;
    const dayTag = now.toISOString().slice(0, 10);

    const rows = await prisma.member.findMany({
      where: { birthDay: now.getUTCDate(), birthMonth: now.getUTCMonth() + 1 },
    });
    // Group celebrants by chat.
    const byChat = new Map<string, typeof rows>();
    for (const m of rows) {
      if (!isBirthdayToday(m.birthDay!, m.birthMonth!, now)) continue;
      const k = String(m.chatId);
      (byChat.get(k) ?? byChat.set(k, []).get(k)!).push(m);
    }
    for (const [chatId, celebrants] of byChat) {
      const guard = `${chatId}:${dayTag}`;
      if (announced.has(guard)) continue;
      announced.add(guard);
      const names = celebrants
        .map((m) => (m.userId ? `<a href="tg://user?id=${m.userId}">${escapeHtml(m.firstName ?? 'صديقنا')}</a>` : escapeHtml(m.firstName ?? '')))
        .join('، ');
      await bot.telegram
        .sendMessage(Number(chatId), `🎂🎉 عيد ميلاد سعيد ${names}! كل عام وأنتم بخير 🥳`, { parse_mode: 'HTML' })
        .catch(() => undefined);
    }
  } catch (err) {
    log.warn({ err }, 'birthday tick failed');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
