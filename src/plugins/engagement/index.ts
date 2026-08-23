import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { recordActivity, getMember, topByXp, xpForLevel, messageRank } from '../../services/member.service';
import { incMissionMessages } from '../../services/missions.service';
import { announceAchievements } from '../../utils/progression';
import { displayName, mention } from '../../utils/format';
import { renderRankCard } from '../../services/card/rank';
import { fetchAvatar } from '../../services/card/avatar';
import { resolveUserRole } from '../../utils/permissions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:engagement');

/** Arabic role label shown on the rank card, opposite LEVEL. */
const ROLE_LABEL: Record<string, string> = {
  founder: '👑 مالك أساسي',
  owner: '⭐ مالك',
  manager: '🔰 مدير',
  admin: '🛡 أدمن',
  vip: '💎 مميّز',
  member: '😊 عضو',
};

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
    { command: 'interaction', description: '💬 تفاعلك وترتيبك بين المتفاعلين' },
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
      const level = member?.level ?? 0;
      const xp = member?.xp ?? 0;
      const messages = member?.messageCount ?? 0;
      // Premium rank card; fall back to text on any failure.
      try {
        const name = displayName(ctx.from);
        const [avatar, role] = await Promise.all([
          fetchAvatar(ctx.telegram, ctx.from.id),
          resolveUserRole(ctx, ctx.from.id).catch(() => 'member' as const),
        ]);
        const img = await renderRankCard({
          name,
          level,
          xp,
          xpFloor: level >= 1 ? xpForLevel(level - 1) : 0,
          xpNext: xpForLevel(level),
          messages,
          avatar,
          rank: ROLE_LABEL[role] ?? ROLE_LABEL.member,
          initial: (name.trim()[0] || '?').toUpperCase(),
          handle: ctx.botInfo?.username ? `@${ctx.botInfo.username}` : undefined,
        });
        await ctx.replyWithPhoto(Input.fromBuffer(img, 'rank.jpg'));
        return;
      } catch (err) {
        log.warn({ err }, 'rank card failed; falling back');
      }
      await ctx.reply(t('xp.rank', { name: displayName(ctx.from), level, xp, messages }));
    });

    // «تفاعلي» → your interaction message count + your rank among members.
    bot.command('interaction', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const { messages, rank, total } = await messageRank(ctx.chat.id, ctx.from.id).catch(() => ({
        messages: 0,
        rank: 0,
        total: 0,
      }));
      const lines = [
        `✦ 📊 <b>تفاعل</b> ${mention(ctx.from)} ✦`,
        '➖➖➖➖➖➖➖',
        `• رسائلك بالتفاعل ↢ <b>${messages}</b>`,
        `• ترتيبك بالمتفاعلين ↢ <b>${rank}</b>${total ? ` من <b>${total}</b>` : ''}`,
      ];
      await ctx.reply(lines.join('\n')).catch(() => undefined);
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
