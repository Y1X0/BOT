import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { requireRole } from '../../utils/permissions';
import { createLogger } from '../../core/logger';
import { formatWeeklyReport, isWeeklyDue, type WeeklyReportData } from './logic';

const log = createLogger('plugin:reports');

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');
const nameOf = (m: { firstName?: string | null; username?: string | null; userId: bigint }) =>
  m.firstName ?? m.username ?? String(m.userId);

/** Build the weekly report data for a chat from current weekly counters. */
async function buildReport(chatId: bigint, title: string): Promise<WeeklyReportData> {
  const [top, active, agg, xpLeader] = await Promise.all([
    prisma.member.findMany({ where: { chatId, weeklyMessages: { gt: 0 } }, orderBy: { weeklyMessages: 'desc' }, take: 5 }),
    prisma.member.count({ where: { chatId, weeklyMessages: { gt: 0 } } }),
    prisma.member.aggregate({ where: { chatId }, _sum: { weeklyMessages: true } }),
    prisma.member.findFirst({ where: { chatId }, orderBy: { xp: 'desc' } }),
  ]);
  return {
    title,
    activeMembers: active,
    weeklyMessages: agg._sum.weeklyMessages ?? 0,
    top: top.map((m) => ({ name: nameOf(m), count: m.weeklyMessages })),
    newXpLeader: xpLeader ? { name: nameOf(xpLeader), xp: xpLeader.xp } : undefined,
  };
}

async function resetWeekly(chatId: bigint): Promise<void> {
  await prisma.member.updateMany({ where: { chatId, weeklyMessages: { gt: 0 } }, data: { weeklyMessages: 0 } });
}

/** Weekly activity report: manual command + opt-in automatic posting. */
export const reportsPlugin: Plugin = {
  name: 'reports',
  description: 'Weekly group activity report (manual + auto)',
  commands: [
    { command: 'weekly', description: '📊 التقرير الأسبوعي الحالي' },
    { command: 'weeklyreport', description: '⚙️ تفعيل/إيقاف التقرير التلقائي', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // Show the current week's report without resetting counters.
    bot.command('weekly', async (ctx) => {
      if (!isGroup(ctx)) return;
      const title = (ctx.chat as { title?: string }).title ?? 'الجروب';
      const data = await buildReport(BigInt(ctx.chat!.id), title);
      await ctx.reply(formatWeeklyReport(data));
    });

    // Toggle automatic weekly posting.
    bot.command('weeklyreport', requireRole('manager'), async (ctx) => {
      if (!isGroup(ctx)) return;
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      const on = arg === 'on' || arg === 'تفعيل';
      const off = arg === 'off' || arg === 'ايقاف' || arg === 'إيقاف';
      if (!on && !off) {
        const cur = ctx.state.settings?.weeklyReportEnabled ? 'مفعّل ✅' : 'متوقف ❌';
        return void ctx.reply(`📊 التقرير الأسبوعي التلقائي: ${cur}\nاستخدم: /weeklyreport on  أو  /weeklyreport off\n(يُرسل كل جمعة ٦م UTC)`);
      }
      await prisma.chatSettings.update({ where: { chatId: BigInt(ctx.chat!.id) }, data: { weeklyReportEnabled: on } });
      await ctx.reply(on ? '📊 تم تفعيل التقرير الأسبوعي التلقائي (كل جمعة).' : '📊 تم إيقاف التقرير الأسبوعي التلقائي.');
    });

    // Hourly ticker → post + reset once a week per enabled chat.
    const interval = setInterval(() => {
      void tickWeekly(bot);
    }, 60 * 60 * 1000);
    interval.unref?.();
  },
};

async function tickWeekly(bot: Telegraf<BotContext>): Promise<void> {
  try {
    const now = new Date();
    const chats = await prisma.chatSettings.findMany({ where: { weeklyReportEnabled: true } });
    for (const c of chats) {
      if (!isWeeklyDue(now, c.lastWeeklyReportAt)) continue;
      const chat = await prisma.chat.findUnique({ where: { id: c.chatId } });
      const data = await buildReport(c.chatId, chat?.title ?? 'الجروب');
      await bot.telegram.sendMessage(Number(c.chatId), formatWeeklyReport(data)).catch(() => undefined);
      await prisma.chatSettings.update({ where: { chatId: c.chatId }, data: { lastWeeklyReportAt: now } });
      await resetWeekly(c.chatId);
    }
  } catch (err) {
    log.warn({ err }, 'weekly report tick failed');
  }
}
