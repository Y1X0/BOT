import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import {
  addWarning,
  countWarnings,
  removeWarning,
  resetWarnings,
  logAction,
} from '../../services/moderation.service';
import { addFilter, deleteFilter, listFilters } from '../../services/filters.service';
import {
  muteUser,
  unmuteUser,
  kickUser,
  banUser,
  unbanUser,
  applyWarnAction,
} from '../../utils/moderation-actions';
import { displayName, resolveTarget } from '../../utils/format';
import { parseDuration, formatDuration } from '../../utils/duration';

export const moderationPlugin: Plugin = {
  name: 'moderation',
  description: 'Warnings, mute/kick/ban, word filters, promote',
  commands: [
    { command: 'warn', description: '⚠️ تحذير عضو (بالرد)', staffOnly: true },
    { command: 'unwarn', description: '✅ إزالة تحذير (بالرد)', staffOnly: true },
    { command: 'warns', description: '📊 عرض تحذيرات عضو (بالرد)', staffOnly: true },
    { command: 'mute', description: '🔇 كتم عضو (بالرد)', staffOnly: true },
    { command: 'tmute', description: '⏳ كتم مؤقت: /tmute 30m (بالرد)', staffOnly: true },
    { command: 'unmute', description: '🔊 إلغاء كتم (بالرد)', staffOnly: true },
    { command: 'kick', description: '👢 طرد عضو (بالرد)', staffOnly: true },
    { command: 'ban', description: '🚫 حظر عضو (بالرد)', staffOnly: true },
    { command: 'tban', description: '⏳ حظر مؤقت: /tban 2h (بالرد)', staffOnly: true },
    { command: 'unban', description: '✅ إلغاء حظر (بالرد)', staffOnly: true },
    { command: 'promote', description: '⬆️ ترقية عضو لمشرف (بالرد)', staffOnly: true },
    { command: 'addfilter', description: '🚫 إضافة كلمة ممنوعة', staffOnly: true },
    { command: 'delfilter', description: '➖ حذف كلمة ممنوعة', staffOnly: true },
    { command: 'filters', description: '📋 عرض الكلمات الممنوعة', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // /warn (reply) [reason]
    bot.command('warn', requireRole('moderator'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply(t('mod.warn_usage'));
      if (await isProtected(ctx, target.id)) return void ctx.reply(t('mod.cant_target_admin'));

      const reason = ctx.message.text.split(' ').slice(1).join(' ').trim() || t('mod.warn_reason_default');
      const count = await addWarning(ctx.chat.id, target.id, ctx.from.id, reason);
      const settings = ctx.state.settings!;
      await logAction(ctx.chat.id, 'warn', ctx.from.id, target.id, reason);

      await ctx.reply(
        t('mod.warned', { name: displayName(target), count, max: settings.maxWarnings, reason }),
      );

      if (count >= settings.maxWarnings) {
        const applied = await applyWarnAction(ctx, target.id, settings.warnAction);
        if (applied !== 'none') {
          await resetWarnings(ctx.chat.id, target.id);
          await ctx.reply(t(`mod.action_${applied}`, { name: displayName(target) }));
          await logAction(ctx.chat.id, `auto_${applied}`, ctx.from.id, target.id, 'warn limit');
        }
      }
    });

    bot.command('unwarn', requireRole('moderator'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply(t('mod.need_reply'));
      const count = await removeWarning(ctx.chat.id, target.id);
      await ctx.reply(t('mod.unwarn_done', { name: displayName(target), count }));
    });

    bot.command('warns', requireRole('moderator'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx) ?? ctx.from;
      const count = await countWarnings(ctx.chat.id, target.id);
      if (count === 0) return void ctx.reply(t('mod.warns_none', { name: displayName(target) }));
      await ctx.reply(
        t('mod.warns_list', { name: displayName(target), count, max: ctx.state.settings!.maxWarnings }),
      );
    });

    // Direct actions
    bot.command('mute', requireRole('moderator'), moderationAction('mute'));
    bot.command('unmute', requireRole('moderator'), moderationAction('unmute'));
    bot.command('kick', requireRole('admin'), moderationAction('kick'));
    bot.command('ban', requireRole('admin'), moderationAction('ban'));
    bot.command('unban', requireRole('admin'), moderationAction('unban'));

    // ⏳ Timed mute: /tmute 30m (reply). Auto-unmutes when the duration elapses.
    bot.command('tmute', requireRole('moderator'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('⏳ ردّ على العضو واكتب المدة. مثال: /tmute 30m');
      if (await isProtected(ctx, target.id)) return void ctx.reply(t('mod.cant_target_admin'));
      const secs = parseDuration(ctx.message.text.split(/\s+/)[1]);
      if (!secs) return void ctx.reply('⏳ مدة غير صحيحة. أمثلة: 30m / 2h / 1d');
      const until = Math.floor(Date.now() / 1000) + secs;
      const ok = await muteUser(ctx, target.id, until);
      if (!ok) return void ctx.reply(t('errors.generic'));
      await logAction(ctx.chat.id, 'tmute', ctx.from.id, target.id, `${secs}s`);
      await ctx.reply(`🔇 تم كتم ${displayName(target)} لمدة ${formatDuration(secs)}.`);
    });

    // ⏳ Timed ban: /tban 2h (reply). Telegram auto-unbans when it elapses.
    bot.command('tban', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('⏳ ردّ على العضو واكتب المدة. مثال: /tban 2h');
      if (await isProtected(ctx, target.id)) return void ctx.reply(t('mod.cant_target_admin'));
      const secs = parseDuration(ctx.message.text.split(/\s+/)[1]);
      if (!secs) return void ctx.reply('⏳ مدة غير صحيحة. أمثلة: 30m / 2h / 1d');
      const until = Math.floor(Date.now() / 1000) + secs;
      const ok = await ctx.telegram
        .banChatMember(ctx.chat.id, target.id, until)
        .then(() => true)
        .catch(() => false);
      if (!ok) return void ctx.reply(t('errors.generic'));
      await logAction(ctx.chat.id, 'tban', ctx.from.id, target.id, `${secs}s`);
      await ctx.reply(`🚫 تم حظر ${displayName(target)} لمدة ${formatDuration(secs)}.`);
    });

    // Promote to Telegram admin (owner/admin only).
    bot.command('promote', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply(t('mod.need_reply'));
      try {
        await ctx.telegram.promoteChatMember(ctx.chat.id, target.id, {
          can_delete_messages: true,
          can_restrict_members: true,
          can_pin_messages: true,
          can_invite_users: true,
        });
        await logAction(ctx.chat.id, 'promote', ctx.from.id, target.id);
        await ctx.reply(t('mod.promoted', { name: displayName(target) }));
      } catch {
        await ctx.reply(t('errors.generic'));
      }
    });

    // Word filters
    bot.command('addfilter', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const word = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!word) return void ctx.reply(t('filters.add_usage'));
      await addFilter(ctx.chat.id, word);
      await ctx.reply(t('filters.added', { word }));
    });

    bot.command('delfilter', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const word = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!word) return void ctx.reply(t('filters.add_usage'));
      const ok = await deleteFilter(ctx.chat.id, word);
      await ctx.reply(ok ? t('filters.deleted', { word }) : t('filters.list_empty'));
    });

    bot.command('filters', requireRole('moderator'), async (ctx) => {
      const t = ctx.state.t!;
      const filters = await listFilters(ctx.chat.id);
      if (!filters.length) return void ctx.reply(t('filters.list_empty'));
      const list = filters.map((f) => `• ${f.word} (${f.action})`).join('\n');
      await ctx.reply(t('filters.list_header', { list }));
    });
  },
};

/** Factory for reply-targeted mute/unmute/kick/ban/unban commands. */
function moderationAction(kind: 'mute' | 'unmute' | 'kick' | 'ban' | 'unban') {
  return async (ctx: BotContext) => {
    const t = ctx.state.t!;
    const target = resolveTarget(ctx);
    if (!target) return void ctx.reply(t('mod.need_reply'));
    if (kind !== 'unban' && kind !== 'unmute' && (await isProtected(ctx, target.id))) {
      return void ctx.reply(t('mod.cant_target_admin'));
    }

    let ok = false;
    if (kind === 'mute') ok = await muteUser(ctx, target.id);
    else if (kind === 'unmute') ok = await unmuteUser(ctx, target.id);
    else if (kind === 'kick') ok = await kickUser(ctx, target.id);
    else if (kind === 'ban') ok = await banUser(ctx, target.id);
    else if (kind === 'unban') ok = await unbanUser(ctx, target.id);

    if (ok && ctx.chat && ctx.from) {
      const replyKey: Record<typeof kind, string> = {
        mute: 'mod.muted',
        unmute: 'mod.unmuted',
        kick: 'mod.kicked',
        ban: 'mod.banned',
        unban: 'mod.unbanned',
      };
      await logAction(ctx.chat.id, kind, ctx.from.id, target.id);
      await ctx.reply(t(replyKey[kind], { name: displayName(target) }));
    } else if (!ok) {
      await ctx.reply(t('errors.generic'));
    }
  };
}

/** True if the target is a chat admin/owner (protected from moderation). */
async function isProtected(ctx: BotContext, userId: number): Promise<boolean> {
  if (!ctx.chat) return false;
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return member.status === 'creator' || member.status === 'administrator';
  } catch {
    return false;
  }
}
