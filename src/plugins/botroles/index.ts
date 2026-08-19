import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole, invalidateRole } from '../../utils/permissions';
import { resolveTarget, displayName } from '../../utils/format';
import { setChatRole, removeChatRole, listChatRoles, type AssignableRole } from '../../services/roles.service';

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Human badge for each rank, used in confirmations and the /roles list. */
const BADGE: Record<string, string> = {
  owner: '👑 مالك',
  admin: '🔰 أدمن بوت',
  moderator: '🛡 مشرف',
  vip: '⭐ مميز',
  member: '👤 عضو',
};

/**
 * Custom bot ranks (رتب البوت) — internal to the bot, independent of Telegram's
 * own admin. A holder gets bot-command permissions even without being a Telegram
 * admin. Assigned by reply, only by an admin/owner. 'owner' is never assignable
 * (it belongs to the group creator and the bot owner).
 */
export const botRolesPlugin: Plugin = {
  name: 'botroles',
  description: 'Custom in-bot ranks (admin/moderator/vip) assignable by reply',
  commands: [
    { command: 'radmin', description: '🔰 رفع أدمن بوت (بالرد)', staffOnly: true },
    { command: 'rmod', description: '🛡 رفع مشرف (بالرد)', staffOnly: true },
    { command: 'rvip', description: '⭐ رفع مميّز (بالرد)', staffOnly: true },
    { command: 'unrank', description: '🗑 سحب الرتبة (بالرد)', staffOnly: true },
    { command: 'roles', description: '📋 قائمة رتب البوت' },
  ],

  register(bot: Telegraf<BotContext>) {
    const assign = (role: AssignableRole) => async (ctx: BotContext) => {
      if (!isGroup(ctx) || !ctx.chat) return;
      const target = resolveTarget(ctx);
      if (!target) {
        await ctx.reply('↩️ ردّ على رسالة الشخص اللي بدك تعطيه الرتبة.');
        return;
      }
      if ((target as { is_bot?: boolean }).is_bot) {
        await ctx.reply('🤖 ما بينفع تعطي رتبة لبوت.');
        return;
      }
      const name = displayName(target);
      await setChatRole(ctx.chat.id, target.id, role, name, ctx.from?.id ?? null);
      invalidateRole(ctx.chat.id, target.id); // pick up the new rank immediately
      await ctx.reply(`✅ صار ${name} الآن ${BADGE[role]} في هالجروب.\nالرتبة محفوظة بالبوت وبتعطيه صلاحياته حتى لو مش أدمن بتيليجرام.`);
    };

    bot.command('radmin', requireRole('admin'), assign('admin'));
    bot.command('rmod', requireRole('admin'), assign('moderator'));
    bot.command('rvip', requireRole('admin'), assign('vip'));

    bot.command('unrank', requireRole('admin'), async (ctx) => {
      if (!isGroup(ctx) || !ctx.chat) return;
      const target = resolveTarget(ctx);
      if (!target) {
        await ctx.reply('↩️ ردّ على رسالة الشخص اللي بدك تسحب رتبته.');
        return;
      }
      const removed = await removeChatRole(ctx.chat.id, target.id);
      invalidateRole(ctx.chat.id, target.id); // drop the cached rank immediately
      await ctx.reply(
        removed
          ? `🗑 تم سحب رتبة ${displayName(target)} في هالجروب.`
          : `ℹ️ ${displayName(target)} ما عنده رتبة بوت أصلاً.`,
      );
    });

    bot.command('roles', async (ctx) => {
      if (!isGroup(ctx) || !ctx.chat) return;
      const roles = await listChatRoles(ctx.chat.id);
      if (!roles.length) {
        await ctx.reply('📋 ما في رتب بوت معيّنة بهالجروب.\nللتعيين: ردّ على العضو واكتب «رفع مشرف بوت» أو «رفع أدمن بوت» أو «رفع مميز».');
        return;
      }
      // Sort by rank strength for a tidy list.
      const order: Record<string, number> = { admin: 0, moderator: 1, vip: 2 };
      roles.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9));
      const lines = roles.map((r) => `${BADGE[r.role] ?? r.role} — ${r.name ?? r.userId}`).join('\n');
      await ctx.reply(`📋 رتب البوت في هالجروب:\n\n${lines}`);
    });
  },
};
