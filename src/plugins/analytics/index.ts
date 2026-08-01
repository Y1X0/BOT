import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import {
  memberCount,
  totalMessages,
  topByMessages,
  topByXp,
} from '../../services/member.service';

export const analyticsPlugin: Plugin = {
  name: 'analytics',
  description: 'Group statistics and activity leaderboards',
  commands: [
    { command: 'stats', description: '📈 إحصائيات الجروب' },
    { command: 'activetop', description: '🏆 الأكثر تفاعلاً' },
    { command: 'groupreport', description: '📊 تقرير الجروب الكامل' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('stats', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const t = ctx.state.t!;
      const [members, messages, top] = await Promise.all([
        memberCount(ctx.chat.id),
        totalMessages(ctx.chat.id),
        topByMessages(ctx.chat.id, 1),
      ]);
      const topUser = top[0]?.firstName ?? top[0]?.username ?? '-';
      await ctx.reply(
        t('stats.header', {
          title: (ctx.chat as { title?: string }).title ?? '',
          members,
          messages,
          topUser,
        }),
      );
    });

    bot.command('activetop', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const t = ctx.state.t!;
      const top = await topByMessages(ctx.chat.id, 10);
      if (!top.length) return void ctx.reply(t('leaderboard.empty'));
      const list = top
        .map((m, i) => `${medal(i)} ${m.firstName ?? m.username ?? m.userId} — ${m.messageCount} 💬`)
        .join('\n');
      await ctx.reply(t('leaderboard.header', { list }));
    });

    bot.command('groupreport', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const title = (ctx.chat as { title?: string }).title ?? 'الجروب';
      const [members, messages, topMsg, topXp] = await Promise.all([
        memberCount(ctx.chat.id),
        totalMessages(ctx.chat.id),
        topByMessages(ctx.chat.id, 3),
        topByXp(ctx.chat.id, 1),
      ]);
      const name = (m?: { firstName?: string | null; username?: string | null; userId?: bigint }) =>
        m?.firstName ?? m?.username ?? (m?.userId ? String(m.userId) : '-');
      const activeList = topMsg.map((m, i) => `${medal(i)} ${name(m)} — ${m.messageCount} 💬`).join('\n') || '-';
      await ctx.reply(
        `📊 تقرير ${title}\n\n` +
          `👥 الأعضاء المسجّلون: ${members}\n` +
          `💬 إجمالي الرسائل: ${messages}\n\n` +
          `🔥 الأكثر نشاطاً:\n${activeList}\n\n` +
          `⬆️ الأعلى خبرة: ${name(topXp[0])} (${topXp[0]?.xp ?? 0} XP)`,
      );
    });
  },
};

function medal(index: number): string {
  return ['🥇', '🥈', '🥉'][index] ?? `${index + 1}.`;
}
