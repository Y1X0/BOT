import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { recordActivity, getMember, topByXp } from '../../services/member.service';
import { incMissionMessages } from '../../services/missions.service';
import { announceAchievements } from '../../utils/progression';
import { displayName } from '../../utils/format';

const XP_PER_MESSAGE = 5;

/**
 * Passive engagement tracker. Runs early in the message pipeline and always
 * calls next(), so other text handlers (games, replies) still fire.
 * Awards XP for group chatter and announces level-ups.
 */
export const engagementPlugin: Plugin = {
  name: 'engagement',
  description: 'XP / leveling from group activity',
  commands: [
    { command: 'rank', description: '📊 مستواك ونقاط الخبرة' },
    { command: 'levels', description: '🏅 قائمة أعلى المستويات' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.on(message('text'), async (ctx, next) => {
      const chat = ctx.chat;
      const from = ctx.from;
      const text = ctx.message.text;

      // Only track real chatter in groups (skip commands & staffless checks).
      if (
        chat &&
        (chat.type === 'group' || chat.type === 'supergroup') &&
        from &&
        !from.is_bot &&
        !text.startsWith('/') &&
        ctx.state.settings?.xpEnabled
      ) {
        const result = await recordActivity(chat.id, from, XP_PER_MESSAGE);
        if (ctx.state.settings?.economyEnabled) {
          await incMissionMessages(chat.id, from.id).catch(() => undefined);
        }
        // Level-ups are tracked SILENTLY now — no "reached level N" / rank-up
        // spam in chat. Members still see their progress via /rank.
        // Throttled achievement check (on level-up or every 20 messages).
        if (result.leveledUp || result.member.messageCount % 20 === 0) {
          await announceAchievements(ctx);
        }
      }
      return next();
    });

    bot.command('rank', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const t = ctx.state.t!;
      const member = await getMember(ctx.chat.id, ctx.from.id);
      await ctx.reply(
        t('xp.rank', {
          name: displayName(ctx.from),
          level: member?.level ?? 0,
          xp: member?.xp ?? 0,
          messages: member?.messageCount ?? 0,
        }),
      );
    });

    bot.command('levels', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const t = ctx.state.t!;
      const top = await topByXp(ctx.chat.id, 10);
      if (!top.length) {
        await ctx.reply(t('leaderboard.empty'));
        return;
      }
      const list = top
        .map((m, i) => `${medal(i)} ${m.firstName ?? m.username ?? m.userId} — L${m.level} (${m.xp} XP)`)
        .join('\n');
      await ctx.reply(t('leaderboard.header', { list }));
    });
  },
};

function medal(index: number): string {
  return ['🥇', '🥈', '🥉'][index] ?? `${index + 1}.`;
}
